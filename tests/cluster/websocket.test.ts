// The cluster channel over a WebSocket on the web port (lib/cluster/websocket.ts) and the
// TCP → WebSocket fallback of dialPeer (lib/cluster/dial.ts), against a real http server on
// loopback whose upgrades are routed to a real channel listener.
import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { dialPeer } from "@/lib/cluster/dial";
import {
  ClusterAuthError,
  connectChannel,
  generateClusterToken,
  listenChannels,
  type ChannelListener,
  type ClusterChannel,
  type HelloInfo,
  type ServerIdentity,
} from "@/lib/cluster/protocol";
import type { BinaryHeader, WireMessage } from "@/lib/cluster/types";
import { CLUSTER_WS_PATH, attachClusterUpgrade, clusterWsUrl } from "@/lib/cluster/websocket";

const HOST = "127.0.0.1";
const TOKEN = generateClusterToken();
const SERVER: ServerIdentity = { nodeId: "node-server", name: "Server", role: "primary", term: 3 };
const CLIENT_HELLO: HelloInfo = { nodeId: "node-client", name: "Client", purpose: "member" };

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: net.Server, port: number): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(port, HOST, resolve);
  await promise;
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server has no port");
  return address.port;
}

function closeServer(server: net.Server): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  return promise;
}

/** A listening http server on loopback; every connection is destroyed on cleanup (upgraded ones too). */
async function startHttp(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const port = await listen(server, 0);
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
  });
  return { server, port };
}

/** An http server + channel listener with cluster upgrades routed to it; `accepted` gets server channels. */
async function startNode(token = TOKEN): Promise<{
  http: http.Server;
  httpPort: number;
  listener: ChannelListener;
  accepted: Promise<ClusterChannel>;
}> {
  const { server, port } = await startHttp();
  const accepted = Promise.withResolvers<ClusterChannel>();
  const listener = await listenChannels({
    port: 0,
    host: HOST,
    token: () => token,
    identity: () => SERVER,
    onChannel: (channel) => accepted.resolve(channel),
  });
  cleanups.push(() => listener.close());
  expect(attachClusterUpgrade((stream, remote) => listener.accept(stream, remote))).toBeGreaterThanOrEqual(1);
  cleanups.push(() => attachClusterUpgrade(null));
  return { http: server, httpPort: port, listener, accepted: accepted.promise };
}

function wsUrl(port: number): string {
  return `ws://${HOST}:${port}${CLUSTER_WS_PATH}`;
}

function track(channel: ClusterChannel): ClusterChannel {
  cleanups.push(() => channel.close());
  return channel;
}

function nextMessage(channel: ClusterChannel, prefix: string): Promise<WireMessage> {
  const { promise, resolve } = Promise.withResolvers<WireMessage>();
  const off = channel.on(prefix, (msg) => {
    off();
    resolve(msg);
  });
  return promise;
}

function nextBinary(channel: ClusterChannel, prefix: string): Promise<{ header: BinaryHeader; data: Buffer }> {
  const { promise, resolve } = Promise.withResolvers<{ header: BinaryHeader; data: Buffer }>();
  const off = channel.onBinary(prefix, (header, data) => {
    off();
    resolve({ header, data });
  });
  return promise;
}

/** A TCP port nothing listens on (bound once, then released). */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server, 0);
  await closeServer(server);
  return port;
}

describe("clusterWsUrl", () => {
  it("maps http(s) to ws(s) and keeps a base path", () => {
    expect(clusterWsUrl("https://a.quang.asia")).toBe(`wss://a.quang.asia${CLUSTER_WS_PATH}`);
    expect(clusterWsUrl("http://10.0.0.2:3000/")).toBe(`ws://10.0.0.2:3000${CLUSTER_WS_PATH}`);
    expect(clusterWsUrl("https://example.com/omp/?x=1")).toBe(`wss://example.com/omp${CLUSTER_WS_PATH}`);
  });
});

describe("cluster channel over a WebSocket", () => {
  it("authenticates and carries JSON, a 5 MiB binary frame both ways and request/reply", async () => {
    const node = await startNode();
    const { channel: client, server: identity } = await connectChannel({
      url: wsUrl(node.httpPort),
      token: TOKEN,
      hello: CLIENT_HELLO,
    });
    track(client);
    const server = track(await node.accepted);
    expect(identity).toEqual(SERVER);
    expect(client.peer).toEqual({ nodeId: SERVER.nodeId, name: SERVER.name });
    expect(server.peer).toEqual({ nodeId: CLIENT_HELLO.nodeId, name: CLIENT_HELLO.name });
    expect(server.remote.host).toBe(HOST);
    expect(client.remote).toEqual({ host: HOST, port: node.httpPort });

    const json = nextMessage(server, "note");
    expect(client.send({ t: "note", text: "hello", n: 42 })).toBe(true);
    expect(await json).toMatchObject({ t: "note", text: "hello", n: 42 });

    const payload = randomBytes(5 * 1024 * 1024);
    server.onBinary("file.", (header, data) => server.sendBinary({ ...header, t: "file.echo" }, data));
    const echoed = nextBinary(client, "file.echo");
    expect(client.sendBinary({ t: "file.chunk", id: "f1", offset: 0 }, payload)).toBe(true);
    await client.drain();
    const { header, data } = await echoed;
    expect(header).toMatchObject({ t: "file.echo", id: "f1", offset: 0 });
    expect(data.equals(payload)).toBe(true);

    server.on("echo", (msg) => server.reply(msg, { t: "echo.reply", value: msg.value }));
    const reply = await client.request({ t: "echo", value: "ping" });
    expect(reply).toMatchObject({ t: "echo.reply", value: "ping" });

    const closed = Promise.withResolvers<string>();
    server.onClose(closed.resolve);
    client.close("done");
    expect(await closed.promise).toBe("closed");
  });

  it("rejects a different token with ClusterAuthError", async () => {
    const node = await startNode();
    const attempt = connectChannel({ url: wsUrl(node.httpPort), token: generateClusterToken(), hello: CLIENT_HELLO });
    await expect(attempt).rejects.toBeInstanceOf(ClusterAuthError);
  });

  it("answers 503 once the cluster channel is detached", async () => {
    const node = await startNode();
    attachClusterUpgrade(null);
    const attempt = connectChannel({ url: wsUrl(node.httpPort), token: TOKEN, hello: CLIENT_HELLO, timeoutMs: 3_000 });
    await expect(attempt).rejects.toThrow();
    await expect(attempt).rejects.not.toBeInstanceOf(ClusterAuthError);
  });

  it("leaves other upgrade paths to their listeners", async () => {
    const node = await startNode();
    const seen = Promise.withResolvers<string>();
    node.http.on("upgrade", (req: http.IncomingMessage, socket: Duplex) => {
      if (req.url !== "/other") return;
      seen.resolve(req.url);
      socket.end("HTTP/1.1 418 I'm a teapot\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    const socket = net.connect({ host: HOST, port: node.httpPort });
    cleanups.push(() => socket.destroy());
    let response = "";
    const ended = Promise.withResolvers<void>();
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("latin1");
    });
    socket.on("end", () => ended.resolve());
    socket.on("error", () => ended.resolve());
    socket.write(
      "GET /other HTTP/1.1\r\n" +
        `Host: ${HOST}:${node.httpPort}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n` +
        "Sec-WebSocket-Version: 13\r\n\r\n",
    );
    expect(await seen.promise).toBe("/other");
    await ended.promise;
    expect(response.startsWith("HTTP/1.1 418")).toBe(true);
    expect(response).not.toContain("HTTP/1.1 101");
    expect(response.match(/HTTP\/1\.1 /g)).toHaveLength(1);
  });
});

describe("dialPeer", () => {
  it("falls back to the WebSocket when the cluster port is closed and remembers it", async () => {
    const node = await startNode();
    const port = await closedPort();
    const target = { host: HOST, port, httpUrl: `http://${HOST}:${node.httpPort}` };

    const first = await dialPeer(target, { token: TOKEN, hello: CLIENT_HELLO, timeoutMs: 3_000 });
    track(first.channel);
    expect(first.via).toBe("ws");
    expect(first.server).toEqual(SERVER);

    // Something now answers on the TCP port: a second dial that went to TCP first would hit it.
    let tcpConnections = 0;
    const decoy = net.createServer((socket) => {
      tcpConnections++;
      socket.destroy();
    });
    await listen(decoy, port);
    cleanups.push(() => closeServer(decoy));

    const second = await dialPeer(target, { token: TOKEN, hello: CLIENT_HELLO, timeoutMs: 3_000 });
    track(second.channel);
    expect(second.via).toBe("ws");
    expect(tcpConnections).toBe(0);
  });

  it("does not fall back on a token mismatch", async () => {
    const node = await startNode();
    const target = { host: HOST, port: node.listener.port, httpUrl: `http://${HOST}:${node.httpPort}` };
    const attempt = dialPeer(target, { token: generateClusterToken(), hello: CLIENT_HELLO, timeoutMs: 3_000 });
    await expect(attempt).rejects.toBeInstanceOf(ClusterAuthError);
  });

  it("names both attempts when neither transport works", async () => {
    const port = await closedPort();
    const httpPort = await closedPort();
    const attempt = dialPeer(
      { host: HOST, port, httpUrl: `http://${HOST}:${httpPort}` },
      { token: TOKEN, hello: CLIENT_HELLO, timeoutMs: 3_000 },
    );
    await expect(attempt).rejects.toThrow(/over TCP: .*; over the WebSocket ws:\/\//);
  });
});
