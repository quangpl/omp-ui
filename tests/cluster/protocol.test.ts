// Cluster channel protocol (lib/cluster/protocol.ts): handshake + authentication, encrypted JSON and
// binary frames, request/reply, prefix routing, heartbeat/idle handling and close propagation, over
// real loopback TCP. Raw sockets play misbehaving peers by speaking the wire format by hand.
import { createHmac, randomBytes } from "node:crypto";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  ClusterAuthError,
  connectChannel,
  generateClusterToken,
  listenChannels,
  type ChannelListener,
  type ClusterChannel,
  type ConnectChannelOptions,
  type HelloInfo,
  type ListenChannelsOptions,
  type ServerIdentity,
} from "@/lib/cluster/protocol";
import { CLUSTER_PROTOCOL_VERSION, type BinaryHeader, type WireMessage } from "@/lib/cluster/types";

const HOST = "127.0.0.1";
const TOKEN = generateClusterToken();
const SERVER: ServerIdentity = { nodeId: "node-server", name: "Server", role: "primary", term: 3 };
const CLIENT_HELLO: HelloInfo = { nodeId: "node-client", name: "Client", purpose: "member" };

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** FIFO whose `next()` waits for the next pushed item. */
class Queue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(item: T) => void> = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  next(): Promise<T> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift() as T);
    const { promise, resolve } = Promise.withResolvers<T>();
    this.waiters.push(resolve);
    return promise;
  }
}

interface Accepted {
  channel: ClusterChannel;
  hello: HelloInfo;
}

async function startServer(
  overrides: Partial<ListenChannelsOptions> = {},
): Promise<{ listener: ChannelListener; accepted: Queue<Accepted> }> {
  const accepted = new Queue<Accepted>();
  const listener = await listenChannels({
    port: 0,
    host: HOST,
    token: () => TOKEN,
    identity: () => SERVER,
    onChannel: (channel, hello) => accepted.push({ channel, hello }),
    ...overrides,
  });
  cleanups.push(() => listener.close());
  return { listener, accepted };
}

async function connect(
  port: number,
  overrides: Partial<ConnectChannelOptions> = {},
): Promise<{ channel: ClusterChannel; server: ServerIdentity }> {
  const result = await connectChannel({ host: HOST, port, token: TOKEN, hello: CLIENT_HELLO, ...overrides });
  cleanups.push(() => result.channel.close());
  return result;
}

/** A connected client channel and the server's end of it. */
async function connectedPair(
  serverOverrides: Partial<ListenChannelsOptions> = {},
  clientOverrides: Partial<ConnectChannelOptions> = {},
): Promise<{ client: ClusterChannel; server: ClusterChannel; port: number }> {
  const { listener, accepted } = await startServer(serverOverrides);
  const { channel } = await connect(listener.port, clientOverrides);
  const { channel: server } = await accepted.next();
  return { client: channel, server, port: listener.port };
}

function closeReason(channel: ClusterChannel): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  channel.onClose(resolve);
  return promise;
}

function nextMessage(channel: ClusterChannel, prefix: string): Promise<WireMessage> {
  const { promise, resolve } = Promise.withResolvers<WireMessage>();
  const off = channel.on(prefix, (msg) => {
    off();
    resolve(msg);
  });
  return promise;
}

function hmac(token: string, text: string): string {
  return createHmac("sha256", token).update(text).digest("base64");
}

/** A plain TCP peer that reads and writes length-prefixed frames by hand. */
class RawPeer {
  readonly frames = new Queue<Buffer>();
  readonly closed: Promise<void>;
  private pending = Buffer.alloc(0);

  constructor(readonly socket: net.Socket) {
    const closed = Promise.withResolvers<void>();
    this.closed = closed.promise;
    socket.on("close", () => closed.resolve());
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.pending.length >= 4 && this.pending.length >= 4 + this.pending.readUInt32BE(0)) {
        const length = this.pending.readUInt32BE(0);
        this.frames.push(this.pending.subarray(4, 4 + length));
        this.pending = this.pending.subarray(4 + length);
      }
    });
    cleanups.push(() => socket.destroy());
  }

  static async connect(port: number): Promise<RawPeer> {
    const socket = net.connect({ host: HOST, port });
    const connected = Promise.withResolvers<void>();
    socket.once("connect", () => connected.resolve());
    socket.once("error", connected.reject);
    await connected.promise;
    return new RawPeer(socket);
  }

  async nextJson(): Promise<Record<string, unknown>> {
    return JSON.parse((await this.frames.next()).toString("utf8")) as Record<string, unknown>;
  }

  sendRaw(body: Buffer): void {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    this.socket.write(Buffer.concat([head, body]));
  }

  sendJson(msg: object): void {
    this.sendRaw(Buffer.from(JSON.stringify(msg), "utf8"));
  }
}

/** Completes the client handshake by hand (checking the server's proof), then leaves the socket to the test. */
async function rawAuthenticated(port: number): Promise<RawPeer> {
  const peer = await RawPeer.connect(port);
  const clientNonce = randomBytes(32).toString("base64");
  peer.sendJson({ t: "hello", proto: CLUSTER_PROTOCOL_VERSION, nonce: clientNonce, nodeId: "raw", name: "Raw", purpose: "test" });
  const challenge = await peer.nextJson();
  expect(challenge).toMatchObject({ t: "challenge", proto: CLUSTER_PROTOCOL_VERSION, ...SERVER });
  expect(challenge.proof).toBe(hmac(TOKEN, `s|${clientNonce}|${String(challenge.nonce)}`));
  peer.sendJson({ t: "auth", proof: hmac(TOKEN, `c|${clientNonce}|${String(challenge.nonce)}`) });
  return peer;
}

/** A plain TCP server whose connections are handed to `onPeer`. */
async function rawServer(onPeer: (peer: RawPeer) => void): Promise<number> {
  const server = net.createServer((socket) => onPeer(new RawPeer(socket)));
  const listening = Promise.withResolvers<void>();
  server.listen(0, HOST, () => listening.resolve());
  await listening.promise;
  cleanups.push(() => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    return closed.promise;
  });
  return (server.address() as net.AddressInfo).port;
}

describe("generateClusterToken", () => {
  it("returns omc_ + base64url of 32 random bytes", () => {
    const token = generateClusterToken();
    expect(token).toMatch(/^omc_[A-Za-z0-9_-]{43}$/);
    expect(generateClusterToken()).not.toBe(token);
  });
});

describe("handshake", () => {
  it("authenticates both sides and exchanges identities", async () => {
    const { listener, accepted } = await startServer();
    const { channel, server } = await connect(listener.port);
    const { channel: serverSide, hello } = await accepted.next();

    expect(server).toEqual(SERVER);
    expect(channel.peer).toEqual({ nodeId: SERVER.nodeId, name: SERVER.name });
    expect(channel.remote).toEqual({ host: HOST, port: listener.port });
    expect(channel.closed).toBe(false);
    expect(hello).toEqual(CLIENT_HELLO);
    expect(serverSide.peer).toEqual({ nodeId: CLIENT_HELLO.nodeId, name: CLIENT_HELLO.name });
    expect(serverSide.remote.host).toBe(HOST);
    expect(serverSide.id).not.toBe(channel.id);
  });

  it("rejects a wrong token on both sides", async () => {
    const failures: string[] = [];
    const failed = Promise.withResolvers<void>();
    const { listener } = await startServer({
      onAuthFailure: (remote, reason) => {
        expect(remote.host).toBe(HOST);
        failures.push(reason);
        failed.resolve();
      },
      onChannel: () => {
        throw new Error("no channel expected");
      },
    });

    await expect(connect(listener.port, { token: generateClusterToken() })).rejects.toBeInstanceOf(ClusterAuthError);
    await failed.promise;
    expect(failures).toHaveLength(1);
  });

  it("reads the token per connection (rotation)", async () => {
    let token = TOKEN;
    const { listener } = await startServer({ token: () => token });
    await connect(listener.port);

    token = generateClusterToken();
    await expect(connect(listener.port)).rejects.toBeInstanceOf(ClusterAuthError);
    await expect(connect(listener.port, { token })).resolves.toMatchObject({ server: SERVER });
  });

  it("refuses every handshake while the node has no token", async () => {
    const failed = Promise.withResolvers<string>();
    const { listener } = await startServer({ token: () => null, onAuthFailure: (_remote, reason) => failed.resolve(reason) });

    await expect(connect(listener.port)).rejects.toBeInstanceOf(ClusterAuthError);
    await expect(failed.promise).resolves.toEqual(expect.any(String));
  });

  it("does not trust a server that cannot prove the token", async () => {
    const clientReply = Promise.withResolvers<Record<string, unknown>>();
    const port = await rawServer(async (peer) => {
      const hello = await peer.nextJson();
      const nonce = randomBytes(32).toString("base64");
      peer.sendJson({
        t: "challenge",
        proto: CLUSTER_PROTOCOL_VERSION,
        nonce,
        proof: hmac("omc_impostor", `s|${String(hello.nonce)}|${nonce}`),
        ...SERVER,
      });
      clientReply.resolve(await peer.nextJson());
    });

    await expect(connect(port)).rejects.toBeInstanceOf(ClusterAuthError);
    expect(await clientReply.promise).toMatchObject({ t: "error", code: "auth" });
  });

  it("answers a protocol version mismatch with a plaintext error", async () => {
    const { listener } = await startServer();
    const peer = await RawPeer.connect(listener.port);
    peer.sendJson({ t: "hello", proto: 999, nonce: randomBytes(32).toString("base64"), nodeId: "x", name: "X", purpose: "probe" });

    expect(await peer.nextJson()).toMatchObject({ t: "error", code: "proto" });
    await peer.closed;
  });

  it("drops a connection that never completes the handshake", async () => {
    let channels = 0;
    const { listener } = await startServer({ handshakeTimeoutMs: 100, onChannel: () => channels++ });
    const peer = await RawPeer.connect(listener.port);

    await peer.closed;
    expect(channels).toBe(0);
  });

  it("drops oversized frames before authentication", async () => {
    const { listener } = await startServer();
    const peer = await RawPeer.connect(listener.port);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(1024 * 1024);
    peer.socket.write(head);

    await peer.closed;
  });

  it("gives up on a silent server after timeoutMs", async () => {
    const port = await rawServer(() => {});
    const error = await connect(port, { timeoutMs: 100 }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ClusterAuthError);
  });

  it("rejects when nothing listens", async () => {
    const port = await rawServer(() => {});
    await cleanups.pop()?.();
    await expect(connect(port)).rejects.toThrow(/Cannot reach/);
  });
});

describe("messages", () => {
  it("round-trips JSON and binary frames in order, including 5 MiB payloads", async () => {
    const { client, server } = await connectedPair();
    const seen: string[] = [];
    const blob = randomBytes(5 * 1024 * 1024);
    const received = Promise.withResolvers<{ header: BinaryHeader; data: Buffer }>();
    const after = nextMessage(server, "x.after");
    server.on("", (msg) => seen.push(msg.t));
    server.onBinary("sync.", (header, data) => {
      seen.push(header.t);
      received.resolve({ header, data });
    });

    expect(client.send({ t: "x.before", n: 1, nested: { ok: true } })).toBe(true);
    expect(client.sendBinary({ t: "sync.file", path: "a/b.txt" }, blob)).toBe(true);
    client.send({ t: "x.after" });
    await client.drain();

    const { header, data } = await received.promise;
    expect(header).toEqual({ t: "sync.file", path: "a/b.txt" });
    expect(data.length).toBe(blob.length);
    expect(Buffer.compare(data, blob)).toBe(0);
    await after;
    expect(seen).toEqual(["x.before", "sync.file", "x.after"]);
  });

  it("sends binary views with an offset (server → client)", async () => {
    const { client, server } = await connectedPair();
    const received = Promise.withResolvers<Buffer>();
    client.onBinary("tiny", (_header, data) => received.resolve(data));

    server.sendBinary({ t: "tiny" }, new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4));

    expect([...(await received.promise)]).toEqual([1, 2, 3]);
  });

  it("correlates request and reply by rid", async () => {
    const { client, server } = await connectedPair();
    server.on("echo", (msg) => server.reply(msg, { t: "echo.reply", value: msg.value }));

    const reply = await client.request<WireMessage & { value: number }>({ t: "echo", value: 42 });

    expect(reply).toMatchObject({ t: "echo.reply", value: 42, rid: expect.any(String) });
    await expect(client.request({ t: "nobody.listens" }, 50)).rejects.toThrow(/No reply/);
  });

  it("routes by t prefix and stops after unsubscribe", async () => {
    const { client, server } = await connectedPair();
    const runs: string[] = [];
    const syncs: string[] = [];
    const all: string[] = [];
    const offRun = client.on("run.", (msg) => runs.push(msg.t));
    client.on("sync.", (msg) => syncs.push(msg.t));
    client.on("", (msg) => all.push(msg.t));

    let done = nextMessage(client, "done");
    server.send({ t: "run.out" });
    server.send({ t: "sync.ack" });
    server.send({ t: "other" });
    server.send({ t: "done" });
    await done;
    expect(runs).toEqual(["run.out"]);
    expect(syncs).toEqual(["sync.ack"]);
    expect(all).toEqual(["run.out", "sync.ack", "other", "done"]);

    offRun();
    done = nextMessage(client, "done");
    server.send({ t: "run.exit" });
    server.send({ t: "done" });
    await done;
    expect(runs).toEqual(["run.out"]);
  });
});

describe("lifecycle", () => {
  it("propagates close to the other side exactly once", async () => {
    const { client, server } = await connectedPair();
    const clientReasons: string[] = [];
    client.onClose((reason) => clientReasons.push(reason));
    const serverReason = closeReason(server);
    const pending = server.request({ t: "never.answered" });

    client.close("bye");
    client.close("again");

    expect(clientReasons).toEqual(["bye"]);
    expect(client.closed).toBe(true);
    expect(client.send({ t: "late" })).toBe(false);
    expect(await serverReason).toBe("closed");
    expect(server.closed).toBe(true);
    await expect(pending).rejects.toThrow(/closed/);

    const late: string[] = [];
    client.onClose((reason) => late.push(reason));
    expect(late).toEqual(["bye"]);
    expect(clientReasons).toEqual(["bye"]);
  });

  it("closes accepted channels when the listener closes", async () => {
    const { listener, accepted } = await startServer();
    const { channel } = await connect(listener.port);
    await accepted.next();
    const reason = closeReason(channel);

    await listener.close();

    expect(await reason).toBe("closed");
  });

  it("keeps a live channel open and measures latency, hiding heartbeat messages", async () => {
    const timing = { heartbeatMs: 20, idleTimeoutMs: 150 };
    const { client, server } = await connectedPair(timing, timing);
    const seen: string[] = [];
    client.on("", (msg) => seen.push(msg.t));
    server.on("", (msg) => seen.push(msg.t));

    // Real sockets and performance.now(): the heartbeat must outlive several idle windows in real time.
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(client.closed).toBe(false);
    expect(server.closed).toBe(false);
    expect(client.latencyMs).toEqual(expect.any(Number));
    expect(server.latencyMs).toEqual(expect.any(Number));
    expect(seen).toEqual([]);
  });

  it("closes a channel whose peer goes silent with reason timeout", async () => {
    const { listener, accepted } = await startServer({ heartbeatMs: 20, idleTimeoutMs: 150 });
    const peer = await rawAuthenticated(listener.port);
    const { channel } = await accepted.next();

    expect(await closeReason(channel)).toBe("timeout");
    await peer.closed;
  });

  it("closes with 'bad frame' when a frame does not decrypt", async () => {
    const { listener, accepted } = await startServer();
    const peer = await rawAuthenticated(listener.port);
    const { channel } = await accepted.next();
    const reason = closeReason(channel);

    peer.sendRaw(randomBytes(64));

    expect(await reason).toBe("bad frame");
  });

  it("closes with a protocol error on frames above 16 MiB", async () => {
    const { listener, accepted } = await startServer();
    const peer = await rawAuthenticated(listener.port);
    const { channel } = await accepted.next();
    const reason = closeReason(channel);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(16 * 1024 * 1024 + 1);

    peer.socket.write(head);

    expect(await reason).toMatch(/^error: /);
  });
});
