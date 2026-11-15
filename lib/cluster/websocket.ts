// The cluster channel over a WebSocket on the web port (`wss://<node>/api/v1/cluster/ws`), for
// nodes published only through an HTTP(S) proxy or tunnel (e.g. cloudflared) where the raw TCP
// cluster port is unreachable. A minimal RFC 6455 server hooks the 'upgrade' event of this
// process's http servers; the client is Node's global WebSocket. Both ends are exposed as byte
// Duplex streams so lib/cluster/protocol.ts runs its frames, handshake and encryption unchanged
// on top. Only node: built-ins.
import { createHash } from "node:crypto";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import net from "node:net";
import { Duplex } from "node:stream";

export const CLUSTER_WS_PATH = "/api/v1/cluster/ws";

/** RFC 6455 handshake GUID (Sec-WebSocket-Accept = base64(sha1(key + GUID))). */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/**
 * Largest received message (reassembled from its fragments). Our clients send at most
 * SEND_MESSAGE_BYTES per message; the cap keeps what an unauthenticated peer can make the server
 * buffer per connection small (the channel handshake itself allows 64 KiB frames before auth).
 */
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
/** Outgoing writes are cut into binary messages of at most this size (the byte stream does not care). */
const SEND_MESSAGE_BYTES = 1024 * 1024;
/** The client waits while more than this is queued on its WebSocket. */
const CLIENT_HIGH_WATER_BYTES = 8 * 1024 * 1024;
/** Poll interval of the client's bufferedAmount (the WebSocket API has no drain event). */
const CLIENT_DRAIN_POLL_MS = 5;
/** After our close frame, how long the peer may take before the socket is destroyed. */
const CLOSE_GRACE_MS = 2_000;
/** Longest frame header: 2 bytes + 64-bit length + mask key. */
const MAX_HEADER_BYTES = 14;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_UNSUPPORTED_DATA = 1003;
const CLOSE_TOO_BIG = 1009;

type OnStream = (stream: Duplex, remote: { host: string; port: number }) => void;

const g = globalThis as unknown as {
  /** http servers whose 'upgrade' event is hooked (once each) and the handler they call now. */
  __ompUiClusterUpgrade?: { servers: WeakSet<object>; onStream: OnStream | null };
};

// --- Helpers ----------------------------------------------------------------------------------

/** http(s)://host[:port][/base] → ws(s)://host[:port][/base]/api/v1/cluster/ws. */
export function clusterWsUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${CLUSTER_WS_PATH}`;
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  return url.toString();
}

/** Cuts `chunks` into messages of at most SEND_MESSAGE_BYTES (subarrays, no copies). */
function splitMessages(chunks: Buffer[]): Buffer[][] {
  const messages: Buffer[][] = [];
  let current: Buffer[] = [];
  let size = 0;
  for (let chunk of chunks) {
    while (chunk.length > 0) {
      const take = Math.min(chunk.length, SEND_MESSAGE_BYTES - size);
      current.push(take === chunk.length ? chunk : chunk.subarray(0, take));
      size += take;
      chunk = chunk.subarray(take);
      if (size === SEND_MESSAGE_BYTES) {
        messages.push(current);
        current = [];
        size = 0;
      }
    }
  }
  if (size > 0) messages.push(current);
  return messages;
}

/** Header of an unmasked server frame with FIN set. */
function frameHeader(opcode: number, length: number): Buffer {
  let header: Buffer;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length < 0x10000) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return header;
}

/** "::ffff:10.0.0.2" → "10.0.0.2". */
function normalizeHost(address: string | undefined): string {
  if (!address) return "unknown";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

/**
 * Where an upgrade came from. Behind a local proxy or tunnel (the socket's own peer is loopback)
 * the client address is taken from `cf-connecting-ip`, else the first `x-forwarded-for` entry;
 * headers are never trusted on a direct connection.
 */
function clientAddress(req: IncomingMessage): { host: string; port: number } {
  const own = { host: normalizeHost(req.socket.remoteAddress), port: req.socket.remotePort ?? 0 };
  if (own.host !== "::1" && !own.host.startsWith("127.")) return own;
  const cf = req.headers["cf-connecting-ip"];
  const forwarded = req.headers["x-forwarded-for"];
  const candidate = (typeof cf === "string" ? cf : (typeof forwarded === "string" ? forwarded : "").split(",")[0]).trim();
  return net.isIP(candidate) ? { host: normalizeHost(candidate), port: 0 } : own;
}

// --- Server -----------------------------------------------------------------------------------

/** The server end of an accepted WebSocket as a byte stream (binary messages in, binary messages out). */
class ServerWebSocket extends Duplex {
  private chunks: Buffer[] = [];
  private size = 0;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private inMessage = false;
  private closeSent = false;

  constructor(
    private readonly socket: Duplex,
    head: Buffer,
  ) {
    super();
    if (socket instanceof net.Socket) {
      socket.setNoDelay(true);
      socket.setTimeout(0);
    }
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (err) => this.destroy(err));
    socket.on("end", () => this.destroy(new Error("connection lost")));
    socket.on("close", () => this.destroy(new Error("connection lost")));
    if (head.length > 0) this.receive(head);
  }

  override _read(): void {
    this.socket.resume();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writeMessages([chunk], callback);
  }

  override _writev(chunks: Array<{ chunk: Buffer }>, callback: (error?: Error | null) => void): void {
    this.writeMessages(
      chunks.map((c) => c.chunk),
      callback,
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    // The socket ends once the peer answers with its close frame (see onClose) or _destroy runs.
    this.sendClose(CLOSE_NORMAL);
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.chunks = [];
    this.fragments = [];
    if (!this.socket.destroyed) {
      this.sendClose(CLOSE_NORMAL);
      this.socket.end();
      setTimeout(() => this.socket.destroy(), CLOSE_GRACE_MS).unref();
    }
    callback(error);
  }

  private writeMessages(chunks: Buffer[], callback: (error?: Error | null) => void): void {
    if (this.closeSent || !this.socket.writable) return callback(new Error("WebSocket closed"));
    let ok = true;
    this.socket.cork();
    for (const parts of splitMessages(chunks)) ok = this.sendFrame(OP_BINARY, parts);
    this.socket.uncork();
    if (ok) return callback();
    const done = () => {
      this.socket.off("drain", done);
      this.socket.off("close", done);
      callback();
    };
    this.socket.on("drain", done);
    this.socket.on("close", done);
  }

  /** Write one frame; false when the socket asks to wait for 'drain'. */
  private sendFrame(opcode: number, parts: Buffer[]): boolean {
    let ok = this.socket.write(
      frameHeader(
        opcode,
        parts.reduce((sum, p) => sum + p.length, 0),
      ),
    );
    for (const part of parts) if (part.length > 0) ok = this.socket.write(part);
    return ok;
  }

  private sendClose(code: number): void {
    if (this.closeSent || this.socket.destroyed || !this.socket.writable) return;
    this.closeSent = true;
    const payload = Buffer.allocUnsafe(2);
    payload.writeUInt16BE(code);
    this.sendFrame(OP_CLOSE, [payload]);
  }

  /** Protocol violation: close with `code` and fail the stream. */
  private fail(code: number, reason: string): void {
    this.sendClose(code);
    this.socket.end();
    this.destroy(new Error(`WebSocket protocol error: ${reason}`));
  }

  private receive(chunk: Buffer): void {
    if (this.destroyed) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (!this.destroyed && this.size >= 2) {
      if (this.chunks[0].length < MAX_HEADER_BYTES && this.chunks.length > 1) {
        this.chunks = [Buffer.concat(this.chunks, this.size)];
      }
      const buf = this.chunks[0];
      const len7 = buf[1] & 0x7f;
      const headerBytes = 2 + (len7 === 126 ? 2 : len7 === 127 ? 8 : 0) + 4;
      if (buf.length < headerBytes) return;
      if (buf[0] & 0x70) return this.fail(CLOSE_PROTOCOL_ERROR, "reserved bits set");
      if (!(buf[1] & 0x80)) return this.fail(CLOSE_PROTOCOL_ERROR, "unmasked client frame");
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      let length = len7;
      if (len7 === 126) length = buf.readUInt16BE(2);
      else if (len7 === 127) {
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) return this.fail(CLOSE_TOO_BIG, "message too large");
        length = Number(big);
      }
      if (opcode >= 0x8 && (!fin || length > 125)) return this.fail(CLOSE_PROTOCOL_ERROR, "invalid control frame");
      if (opcode < 0x8 && this.fragmentBytes + length > MAX_MESSAGE_BYTES) {
        return this.fail(CLOSE_TOO_BIG, "message too large");
      }
      const total = headerBytes + length;
      if (this.size < total) return;
      const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size);
      const rest = all.subarray(total);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.size = rest.length;
      const payload = all.subarray(headerBytes, total);
      for (let i = 0; i < payload.length; i++) payload[i] ^= all[headerBytes - 4 + (i & 3)];
      this.frame(opcode, fin, payload);
    }
  }

  private frame(opcode: number, fin: boolean, payload: Buffer): void {
    switch (opcode) {
      case OP_CONTINUATION:
        if (!this.inMessage) return this.fail(CLOSE_PROTOCOL_ERROR, "unexpected continuation frame");
        return this.fragment(fin, payload);
      case OP_BINARY:
        if (this.inMessage) return this.fail(CLOSE_PROTOCOL_ERROR, "expected a continuation frame");
        this.inMessage = true;
        return this.fragment(fin, payload);
      case OP_TEXT:
        return this.fail(CLOSE_UNSUPPORTED_DATA, "text messages are not supported");
      case OP_CLOSE:
        return this.onClose(payload);
      case OP_PING:
        if (!this.closeSent) this.sendFrame(OP_PONG, [payload]);
        return;
      case OP_PONG:
        return;
      default:
        return this.fail(CLOSE_PROTOCOL_ERROR, `unknown opcode ${opcode}`);
    }
  }

  private fragment(fin: boolean, payload: Buffer): void {
    if (payload.length > 0) {
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
    }
    if (!fin) return;
    const message =
      this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments, this.fragmentBytes);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.inMessage = false;
    if (message.length > 0 && !this.push(message)) this.socket.pause();
  }

  /** The peer's close frame: answer it (unless we started the close), end the TCP side, end the stream. */
  private onClose(payload: Buffer): void {
    if (payload.length === 1) return this.fail(CLOSE_PROTOCOL_ERROR, "malformed close frame");
    this.sendClose(CLOSE_NORMAL);
    this.socket.end();
    this.destroy();
  }
}

function rejectUpgrade(socket: Duplex, status: string, extraHeaders = ""): void {
  socket.on("error", () => {});
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n${extraHeaders}\r\n`);
  socket.once("finish", () => socket.destroy());
}

function handleUpgrade(server: http.Server, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const path = (req.url ?? "").split("?", 1)[0];
  if (path !== CLUSTER_WS_PATH) {
    // Another listener's upgrade; answer only when nobody else is there to (the socket would hang).
    if (server.listenerCount("upgrade") <= 1) rejectUpgrade(socket, "404 Not Found");
    return;
  }
  const onStream = g.__ompUiClusterUpgrade?.onStream ?? null;
  if (!onStream) return rejectUpgrade(socket, "503 Service Unavailable");
  const connection = (req.headers.connection ?? "").toLowerCase().split(",");
  const key = req.headers["sec-websocket-key"];
  if (
    req.method !== "GET" ||
    req.headers.upgrade?.toLowerCase() !== "websocket" ||
    !connection.some((token) => token.trim() === "upgrade") ||
    typeof key !== "string" ||
    Buffer.from(key, "base64").length !== 16
  ) {
    return rejectUpgrade(socket, "400 Bad Request");
  }
  if (req.headers["sec-websocket-version"] !== "13") {
    return rejectUpgrade(socket, "426 Upgrade Required", "Sec-WebSocket-Version: 13\r\n");
  }
  const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  onStream(new ServerWebSocket(socket, head), clientAddress(req));
}

/** The listening http(s) servers of this process. */
function httpServers(): http.Server[] {
  // Undocumented but stable Node API (no public way to enumerate listening servers).
  const internals = process as unknown as { _getActiveHandles?: () => unknown[] };
  const getHandles = internals._getActiveHandles;
  if (typeof getHandles !== "function") return [];
  return getHandles
    .call(process)
    .filter(
      (handle): handle is http.Server =>
        (handle instanceof http.Server || handle instanceof https.Server) && handle.listening,
    );
}

/**
 * Route WebSocket upgrades of CLUSTER_WS_PATH on every listening http server of this process to
 * `onStream` (each server is hooked once; the hook always calls the latest `onStream`); null →
 * such upgrades are answered 503. Other upgrade paths are left to their listeners. Returns how
 * many listening servers are hooked.
 */
export function attachClusterUpgrade(onStream: OnStream | null): number {
  const state = (g.__ompUiClusterUpgrade ??= { servers: new WeakSet(), onStream: null });
  state.onStream = onStream;
  let hooked = 0;
  for (const server of httpServers()) {
    if (!state.servers.has(server)) {
      if (!onStream) continue;
      state.servers.add(server);
      server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) =>
        handleUpgrade(server, req, socket, head),
      );
    }
    hooked++;
  }
  return hooked;
}

// --- Client -----------------------------------------------------------------------------------

/** An open client WebSocket as a byte stream (binary messages in, binary messages out). */
class ClientWebSocket extends Duplex {
  constructor(private readonly ws: WebSocket) {
    super();
    ws.addEventListener("message", (event: MessageEvent) => {
      if (this.destroyed) return;
      if (event.data instanceof ArrayBuffer) this.push(Buffer.from(event.data));
      else this.destroy(new Error("unexpected text message"));
    });
    ws.addEventListener("error", (event: Event) => {
      const message = "message" in event && typeof event.message === "string" ? event.message : "";
      this.destroy(new Error(message || "WebSocket error"));
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      this.destroy(event.wasClean ? undefined : new Error(`WebSocket closed abnormally (code ${event.code})`));
    });
  }

  override _read(): void {
    // Messages are pushed as they arrive; the WebSocket API cannot pause.
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.sendMessages([chunk], callback);
  }

  override _writev(chunks: Array<{ chunk: Buffer }>, callback: (error?: Error | null) => void): void {
    this.sendMessages(
      chunks.map((c) => c.chunk),
      callback,
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.closeSocket();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.closeSocket();
    callback(error);
  }

  private closeSocket(): void {
    if (this.ws.readyState !== WebSocket.CONNECTING && this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.close(CLOSE_NORMAL);
    } catch {
      // already closing
    }
  }

  private sendMessages(chunks: Buffer[], callback: (error?: Error | null) => void): void {
    if (this.ws.readyState !== WebSocket.OPEN) return callback(new Error("WebSocket closed"));
    for (const parts of splitMessages(chunks)) {
      const message = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      // Buffer is a Uint8Array view; the lib type only rejects SharedArrayBuffer-backed views, which this never is.
      this.ws.send(message as Uint8Array<ArrayBuffer>);
    }
    const wait = () => {
      if (this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount <= CLIENT_HIGH_WATER_BYTES) return callback();
      setTimeout(wait, CLIENT_DRAIN_POLL_MS);
    };
    wait();
  }
}

/** Open a WebSocket to `url` (ws: or wss:) and expose it as a byte Duplex; rejects after `timeoutMs`. */
export function webSocketStream(url: string, timeoutMs: number): Promise<Duplex> {
  const { promise, resolve, reject } = Promise.withResolvers<Duplex>();
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
  ws.binaryType = "arraybuffer";
  let settled = false;
  const timer = setTimeout(() => fail(new Error(`Timed out opening the WebSocket at ${url}`)), timeoutMs);

  function fail(err: Error): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      ws.close();
    } catch {
      // already closing
    }
    reject(err);
  }

  ws.addEventListener("open", () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(new ClientWebSocket(ws));
  });
  ws.addEventListener("error", (event: Event) => {
    const message = "message" in event && typeof event.message === "string" ? event.message : "";
    fail(new Error(`WebSocket ${url} failed${message ? `: ${message}` : ""}`));
  });
  ws.addEventListener("close", (event: CloseEvent) => {
    fail(new Error(`WebSocket ${url} closed before opening (code ${event.code})`));
  });
  return promise;
}
