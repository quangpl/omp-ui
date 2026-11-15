// The cluster channel: a TCP connection between two nodes with length-prefixed frames, a
// mutual HMAC challenge-response on the shared join token, then AES-256-GCM encrypted frames
// (HKDF-derived per-direction keys, counter IVs). On top: JSON messages routed by `t` prefix,
// binary frames (file chunks), request/reply via `rid`, and an automatic heartbeat that measures
// latency and closes silent channels. Only node: built-ins (runs unchanged on any Node 24 node).
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import net, { type Socket } from "node:net";
import { performance } from "node:perf_hooks";

import type { ClusterRole } from "@/lib/types";
import {
  CHANNEL_IDLE_TIMEOUT_MS,
  CLUSTER_PROTOCOL_VERSION,
  HEARTBEAT_MS,
  type BinaryHeader,
  type ChannelPurpose,
  type WireMessage,
} from "@/lib/cluster/types";

/** Largest frame body accepted or sent once authenticated. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** Largest frame body accepted before authentication (handshake messages are tiny). */
const HANDSHAKE_MAX_FRAME_BYTES = 64 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** drain() waits while more than this is queued on the socket. */
const WRITE_HIGH_WATER_BYTES = 8 * 1024 * 1024;
/** After close(), how long a graceful socket end may take before the socket is destroyed. */
const CLOSE_GRACE_MS = 2_000;
const KEEPALIVE_DELAY_MS = 30_000;
const NONCE_BYTES = 32;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const KIND_JSON = 0;
const KIND_BINARY = 1;
const PURPOSES: readonly ChannelPurpose[] = ["member", "probe", "test"];
const ROLES: readonly ClusterRole[] = ["standalone", "primary", "replica"];
const MAX_ID_LENGTH = 256;

/** An authenticated, encrypted connection to another node. */
export interface ClusterChannel {
  /** Random, for logs. */
  readonly id: string;
  readonly remote: { host: string; port: number };
  /** The other node, from the handshake (client hello / server identity). */
  readonly peer: { nodeId: string; name: string };
  readonly closed: boolean;
  /** Round-trip time of the latest automatic heartbeat (null until the first pong). */
  readonly latencyMs: number | null;
  /** Queue a JSON message; false once closed. Throws RangeError beyond the 16 MiB frame limit. */
  send(msg: WireMessage): boolean;
  /** Queue a binary frame (header JSON + raw payload); false once closed. Throws RangeError beyond 16 MiB. */
  sendBinary(header: BinaryHeader, data: Uint8Array): boolean;
  /** Resolves when the socket write buffer is below its high-water mark (or the channel closed). */
  drain(): Promise<void>;
  /** Handle messages whose `t` starts with `prefix` ("" = all). Returns the unsubscribe function. */
  on(prefix: string, handler: (msg: WireMessage) => void): () => void;
  /** Handle binary frames whose header `t` starts with `prefix` ("" = all). */
  onBinary(prefix: string, handler: (h: BinaryHeader, data: Buffer) => void): () => void;
  /** Called once with the close reason; immediately when already closed. */
  onClose(handler: (reason: string) => void): () => void;
  /**
   * Send `msg` with a fresh `rid` and resolve with the first message carrying that rid (handlers
   * still see it). Rejects on timeout (default 30 s) or when the channel closes.
   */
  request<T extends WireMessage = WireMessage>(msg: WireMessage, timeoutMs?: number): Promise<T>;
  /** Send `msg` as the reply to `to` (with `to.rid`). */
  reply(to: WireMessage, msg: WireMessage): boolean;
  /** Close the channel; onClose handlers get `reason` (default "closed"). */
  close(reason?: string): void;
}

/** What a connecting node says about itself (plaintext, before authentication). */
export interface HelloInfo {
  nodeId: string;
  name: string;
  purpose: ChannelPurpose;
}

/** What a listening node says about itself in its challenge. */
export interface ServerIdentity {
  nodeId: string;
  name: string;
  role: ClusterRole;
  term: number;
}

/** Heartbeat timing of a channel; the defaults are HEARTBEAT_MS / CHANNEL_IDLE_TIMEOUT_MS (tests shrink them). */
export interface ChannelTiming {
  heartbeatMs?: number;
  idleTimeoutMs?: number;
}

export interface ConnectChannelOptions extends ChannelTiming {
  host: string;
  port: number;
  token: string;
  hello: HelloInfo;
  /** Connect + handshake deadline (default 10 s). */
  timeoutMs?: number;
}

export interface ListenChannelsOptions extends ChannelTiming {
  port: number;
  /** Default "0.0.0.0". */
  host?: string;
  /** Read per connection (token rotation); null refuses every handshake. */
  token: () => string | null;
  /** Read per connection. */
  identity: () => ServerIdentity;
  onChannel: (channel: ClusterChannel, hello: HelloInfo) => void;
  /** A connection presented a different token (or this node has none). */
  onAuthFailure?: (remote: { host: string; port: number }, reason: string) => void;
  /** Handshake deadline per connection (default 10 s). */
  handshakeTimeoutMs?: number;
}

export interface ChannelListener {
  readonly port: number;
  /** Stop listening and close every connection this listener accepted (handshaking or established). */
  close(): Promise<void>;
}

/** The other node does not share our cluster token (or refuses cluster connections). */
export class ClusterAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClusterAuthError";
  }
}

/** A new random join token: "omc_" + base64url(32 random bytes). */
export function generateClusterToken(): string {
  return `omc_${randomBytes(32).toString("base64url")}`;
}

// --- Framing ----------------------------------------------------------------------------------

/**
 * A socket speaking u32 BE length-prefixed frames. Reports each complete frame body to `onFrame`
 * (read per frame, so a handshake can hand the rest of a buffer over to the channel) and the end
 * of the connection once to `onEnd`.
 */
class FrameSocket {
  onFrame: (body: Buffer) => void = () => {};
  onEnd: (reason: string) => void = () => {};
  /** Largest acceptable incoming frame body; raised after the handshake. */
  maxFrame = HANDSHAKE_MAX_FRAME_BYTES;
  /** performance.now() of the latest received bytes. */
  lastRx = performance.now();
  private chunks: Buffer[] = [];
  private size = 0;
  private ended = false;
  /** A tick-end uncork is scheduled (see write). */
  private corked = false;

  constructor(readonly socket: Socket) {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, KEEPALIVE_DELAY_MS);
    socket.on("data", (chunk: Buffer) => this.push(chunk));
    socket.on("error", (err) => this.end(`error: ${err.message}`));
    socket.on("end", () => this.end("closed"));
    socket.on("close", () => this.end("closed"));
  }

  get writable(): boolean {
    return !this.ended && !this.socket.destroyed && !this.socket.writableEnded;
  }

  /**
   * Queue one frame made of `parts` (body = their concatenation). The socket is corked from the
   * first frame of an event-loop turn until the next tick, so a burst of sends leaves in one writev.
   */
  write(parts: Buffer[]): boolean {
    if (!this.writable) return false;
    const head = Buffer.allocUnsafe(4);
    head.writeUInt32BE(parts.reduce((sum, p) => sum + p.length, 0));
    if (!this.corked) {
      this.corked = true;
      this.socket.cork();
      process.nextTick(() => {
        this.corked = false;
        this.socket.uncork();
      });
    }
    this.socket.write(head);
    for (const part of parts) if (part.length > 0) this.socket.write(part);
    return true;
  }

  /** Write one plaintext JSON frame (handshake only). */
  writeJson(msg: object): boolean {
    return this.write([Buffer.from(JSON.stringify(msg), "utf8")]);
  }

  /** End the connection from our side (flushing queued writes); no onEnd call. */
  shutdown(): void {
    this.ended = true;
    this.chunks = [];
    this.size = 0;
    if (this.socket.destroyed) return;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), CLOSE_GRACE_MS).unref();
  }

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.chunks = [];
    this.size = 0;
    this.socket.destroy();
    this.onEnd(reason);
  }

  private push(chunk: Buffer): void {
    if (this.ended) return;
    this.lastRx = performance.now();
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (!this.ended && this.size >= 4) {
      if (this.chunks[0].length < 4) this.chunks = [Buffer.concat(this.chunks, this.size)];
      const length = this.chunks[0].readUInt32BE(0);
      if (length > this.maxFrame) return this.end("error: frame too large");
      if (this.size < 4 + length) return;
      const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size);
      const rest = all.subarray(4 + length);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.size = rest.length;
      this.onFrame(all.subarray(4, 4 + length));
    }
  }
}

// --- Handshake helpers ------------------------------------------------------------------------

/** Plaintext `{t:"error"}` codes: `proto` = version mismatch, `auth` = token mismatch / refused. */
type HandshakeErrorCode = "proto" | "auth";

function parseJson(body: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/** Decodes a base64 nonce of exactly NONCE_BYTES bytes. */
function decodeNonce(value: unknown): Buffer | null {
  if (typeof value !== "string") return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === NONCE_BYTES && bytes.toString("base64") === value ? bytes : null;
}

function proof(token: string, side: "s" | "c", clientNonce: string, serverNonce: string): Buffer {
  return createHmac("sha256", token).update(`${side}|${clientNonce}|${serverNonce}`).digest();
}

function proofMatches(expected: Buffer, received: unknown): boolean {
  if (typeof received !== "string") return false;
  const bytes = Buffer.from(received, "base64");
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}

interface DirectionKeys {
  send: Buffer;
  recv: Buffer;
}

function deriveKeys(token: string, clientNonce: Buffer, serverNonce: Buffer, side: "client" | "server"): DirectionKeys {
  const salt = Buffer.concat([clientNonce, serverNonce]);
  const key = (info: string) => Buffer.from(hkdfSync("sha256", token, salt, info, KEY_BYTES));
  const c2s = key("omp-ui cluster c2s");
  const s2c = key("omp-ui cluster s2c");
  return side === "client" ? { send: c2s, recv: s2c } : { send: s2c, recv: c2s };
}

/** GCM IVs of one direction: 4 zero bytes + u64 BE frame counter from 0 (createCipheriv copies the buffer). */
class FrameIvs {
  private readonly iv = Buffer.alloc(12);
  /** Frames sent so far; a double stays exact far beyond any channel's lifetime (2^53). */
  private counter = 0;

  next(): Buffer {
    this.iv.writeUInt32BE(Math.floor(this.counter / 0x1_0000_0000), 4);
    this.iv.writeUInt32BE(this.counter % 0x1_0000_0000, 8);
    this.counter += 1;
    return this.iv;
  }
}

/** "::ffff:10.0.0.2" → "10.0.0.2". */
function normalizeHost(address: string | undefined): string {
  if (!address) return "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

// --- Channel ----------------------------------------------------------------------------------

type Decoded = { kind: "json"; msg: WireMessage } | { kind: "binary"; header: BinaryHeader; data: Buffer };

function decodePlaintext(plain: Buffer): Decoded | null {
  if (plain.length < 1) return null;
  if (plain[0] === KIND_JSON) {
    const msg = parseJson(plain.subarray(1));
    return msg && typeof msg.t === "string" ? { kind: "json", msg: msg as WireMessage } : null;
  }
  if (plain[0] !== KIND_BINARY || plain.length < 5) return null;
  const headerLength = plain.readUInt32BE(1);
  if (headerLength > plain.length - 5) return null;
  const header = parseJson(plain.subarray(5, 5 + headerLength));
  if (!header || typeof header.t !== "string") return null;
  return { kind: "binary", header: header as BinaryHeader, data: plain.subarray(5 + headerLength) };
}

interface PendingRequest {
  resolve(msg: WireMessage): void;
  reject(err: Error): void;
}

interface Route<H> {
  prefix: string;
  handler: H;
}

class Channel implements ClusterChannel {
  readonly id = randomBytes(6).toString("hex");
  private reason: string | null = null;
  private latency: number | null = null;
  private readonly sendIvs = new FrameIvs();
  private readonly recvIvs = new FrameIvs();
  private readonly routes = new Set<Route<(msg: WireMessage) => void>>();
  private readonly binaryRoutes = new Set<Route<(h: BinaryHeader, data: Buffer) => void>>();
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private pingSeq = 0;
  private lastPing: { id: number; at: number } | null = null;
  private readonly heartbeat: NodeJS.Timeout;
  private readonly idleTimeoutMs: number;

  constructor(
    private readonly frames: FrameSocket,
    readonly remote: { host: string; port: number },
    readonly peer: { nodeId: string; name: string },
    private readonly keys: DirectionKeys,
    timing: ChannelTiming,
  ) {
    this.idleTimeoutMs = timing.idleTimeoutMs ?? CHANNEL_IDLE_TIMEOUT_MS;
    frames.maxFrame = MAX_FRAME_BYTES;
    frames.onFrame = (body) => this.receive(body);
    frames.onEnd = (reason) => this.finish(reason);
    this.heartbeat = setInterval(() => this.tick(), timing.heartbeatMs ?? HEARTBEAT_MS);
    this.heartbeat.unref();
    this.ping();
  }

  get closed(): boolean {
    return this.reason !== null;
  }

  get latencyMs(): number | null {
    return this.latency;
  }

  send(msg: WireMessage): boolean {
    if (this.reason !== null) return false;
    const json = JSON.stringify(msg);
    const plain = Buffer.allocUnsafe(1 + Buffer.byteLength(json));
    plain[0] = KIND_JSON;
    plain.write(json, 1, "utf8");
    return this.seal([plain]);
  }

  sendBinary(header: BinaryHeader, data: Uint8Array): boolean {
    if (this.reason !== null) return false;
    const json = JSON.stringify(header);
    const headerLength = Buffer.byteLength(json);
    const prefix = Buffer.allocUnsafe(5 + headerLength);
    prefix[0] = KIND_BINARY;
    prefix.writeUInt32BE(headerLength, 1);
    prefix.write(json, 5, "utf8");
    return this.seal([prefix, Buffer.from(data.buffer, data.byteOffset, data.byteLength)]);
  }

  drain(): Promise<void> {
    const socket = this.frames.socket;
    if (this.reason !== null || socket.writableLength < WRITE_HIGH_WATER_BYTES) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const done = () => {
      socket.off("drain", done);
      offClose();
      resolve();
    };
    socket.on("drain", done);
    const offClose = this.onClose(done);
    return promise;
  }

  on(prefix: string, handler: (msg: WireMessage) => void): () => void {
    const route = { prefix, handler };
    this.routes.add(route);
    return () => this.routes.delete(route);
  }

  onBinary(prefix: string, handler: (h: BinaryHeader, data: Buffer) => void): () => void {
    const route = { prefix, handler };
    this.binaryRoutes.add(route);
    return () => this.binaryRoutes.delete(route);
  }

  onClose(handler: (reason: string) => void): () => void {
    if (this.reason !== null) {
      handler(this.reason);
      return () => {};
    }
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  request<T extends WireMessage = WireMessage>(msg: WireMessage, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.reason !== null) return Promise.reject(new Error(`Cluster channel closed: ${this.reason}`));
    const rid = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      this.pending.delete(rid);
      reject(new Error(`No reply to ${msg.t} from ${this.peer.name} within ${timeoutMs} ms`));
    }, timeoutMs);
    this.pending.set(rid, {
      resolve: (reply) => {
        clearTimeout(timer);
        resolve(reply as T);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    this.send({ ...msg, rid });
    return promise;
  }

  reply(to: WireMessage, msg: WireMessage): boolean {
    return this.send(to.rid === undefined ? msg : { ...msg, rid: to.rid });
  }

  close(reason = "closed"): void {
    if (this.reason !== null) return;
    this.frames.shutdown();
    this.finish(reason);
  }

  /** Encrypt `parts` (the plaintext, concatenated) into one frame: ciphertext parts + tag, no copies. */
  private seal(parts: Buffer[]): boolean {
    const length = parts.reduce((sum, p) => sum + p.length, 0) + TAG_BYTES;
    if (length > MAX_FRAME_BYTES) throw new RangeError(`Cluster frame of ${length} bytes exceeds ${MAX_FRAME_BYTES}`);
    const cipher = createCipheriv("aes-256-gcm", this.keys.send, this.sendIvs.next());
    const out = parts.map((part) => cipher.update(part));
    cipher.final();
    out.push(cipher.getAuthTag());
    return this.frames.write(out);
  }

  private open(body: Buffer): Buffer | null {
    if (body.length < TAG_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", this.keys.recv, this.recvIvs.next());
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    try {
      const plain = decipher.update(body.subarray(0, body.length - TAG_BYTES));
      decipher.final();
      return plain;
    } catch {
      return null;
    }
  }

  private receive(body: Buffer): void {
    const plain = this.open(body);
    const decoded = plain && decodePlaintext(plain);
    if (!decoded) return this.close("bad frame");
    if (decoded.kind === "json") this.dispatch(decoded.msg);
    else this.dispatchBinary(decoded.header, decoded.data);
  }

  private dispatch(msg: WireMessage): void {
    if (msg.t.startsWith("~")) return this.heartbeatMessage(msg);
    if (typeof msg.rid === "string") {
      const pending = this.pending.get(msg.rid);
      if (pending) {
        this.pending.delete(msg.rid);
        pending.resolve(msg);
      }
    }
    for (const route of [...this.routes]) {
      if (msg.t.startsWith(route.prefix)) this.invoke(msg.t, () => route.handler(msg));
    }
  }

  private dispatchBinary(header: BinaryHeader, data: Buffer): void {
    for (const route of [...this.binaryRoutes]) {
      if (header.t.startsWith(route.prefix)) this.invoke(header.t, () => route.handler(header, data));
    }
  }

  /** A throwing handler must not break the read loop of the socket. */
  private invoke(type: string, call: () => void): void {
    try {
      call();
    } catch (err) {
      console.error(`[cluster] channel ${this.id} (${this.peer.name}): handler for ${type} failed:`, err);
    }
  }

  private heartbeatMessage(msg: WireMessage): void {
    if (msg.t === "~ping") {
      this.send({ t: "~pong", id: msg.id });
    } else if (msg.t === "~pong" && this.lastPing && msg.id === this.lastPing.id) {
      this.latency = Math.round((performance.now() - this.lastPing.at) * 10) / 10;
      this.lastPing = null;
    }
  }

  private tick(): void {
    if (performance.now() - this.frames.lastRx > this.idleTimeoutMs) return this.close("timeout");
    this.ping();
  }

  private ping(): void {
    this.lastPing = { id: ++this.pingSeq, at: performance.now() };
    this.send({ t: "~ping", id: this.lastPing.id });
  }

  private finish(reason: string): void {
    if (this.reason !== null) return;
    this.reason = reason;
    clearInterval(this.heartbeat);
    const err = new Error(`Cluster channel closed: ${reason}`);
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
    const handlers = [...this.closeHandlers];
    this.closeHandlers.clear();
    for (const handler of handlers) this.invoke("close", () => handler(reason));
  }
}

// --- Client -----------------------------------------------------------------------------------

/**
 * Connect to a node's cluster port and authenticate with `token`. Rejects with ClusterAuthError
 * when the tokens differ (either side's proof fails) or the node refuses cluster connections,
 * with a plain Error on network failures, version mismatch or timeout.
 */
export function connectChannel(
  opts: ConnectChannelOptions,
): Promise<{ channel: ClusterChannel; server: ServerIdentity }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ channel: ClusterChannel; server: ServerIdentity }>();
  const where = `${opts.host}:${opts.port}`;
  const clientNonce = randomBytes(NONCE_BYTES);
  const clientNonceB64 = clientNonce.toString("base64");
  const frames = new FrameSocket(net.connect({ host: opts.host, port: opts.port }));
  let settled = false;
  const timer = setTimeout(
    () => fail(new Error(`Timed out connecting to the cluster port at ${where}`)),
    opts.timeoutMs ?? HANDSHAKE_TIMEOUT_MS,
  );

  function fail(err: Error): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    frames.shutdown();
    reject(err);
  }

  frames.onEnd = (reason) =>
    fail(
      new Error(
        reason === "closed"
          ? `${where} closed the connection during the handshake`
          : `Cannot reach ${where}: ${reason.replace(/^error: /, "")}`,
      ),
    );
  frames.socket.once("connect", () =>
    frames.writeJson({
      t: "hello",
      proto: CLUSTER_PROTOCOL_VERSION,
      nonce: clientNonceB64,
      nodeId: opts.hello.nodeId,
      name: opts.hello.name,
      purpose: opts.hello.purpose,
    }),
  );
  frames.onFrame = (body) => {
    const msg = parseJson(body);
    if (msg?.t === "error") {
      const message = typeof msg.message === "string" ? msg.message : "handshake refused";
      return fail(msg.code === "auth" ? new ClusterAuthError(`${where}: ${message}`) : new Error(`${where}: ${message}`));
    }
    if (msg?.t !== "challenge") return fail(new Error(`${where} is not an omp-ui cluster port`));
    if (msg.proto !== CLUSTER_PROTOCOL_VERSION) {
      return fail(new Error(`${where} speaks cluster protocol ${String(msg.proto)}, this node ${CLUSTER_PROTOCOL_VERSION}`));
    }
    const serverNonce = decodeNonce(msg.nonce);
    const role = msg.role as ClusterRole;
    if (!serverNonce || !isId(msg.nodeId) || !isId(msg.name) || !ROLES.includes(role) || !Number.isFinite(msg.term)) {
      return fail(new Error(`${where} sent a malformed challenge`));
    }
    const serverNonceB64 = msg.nonce as string;
    if (!proofMatches(proof(opts.token, "s", clientNonceB64, serverNonceB64), msg.proof)) {
      // Tell the server why we leave so it can report the token mismatch (onAuthFailure).
      frames.writeJson({ t: "error", code: "auth", message: "server proof rejected" });
      return fail(new ClusterAuthError(`Authentication with ${where} failed: the cluster tokens do not match`));
    }
    frames.writeJson({ t: "auth", proof: proof(opts.token, "c", clientNonceB64, serverNonceB64).toString("base64") });
    settled = true;
    clearTimeout(timer);
    const server: ServerIdentity = { nodeId: msg.nodeId, name: msg.name, role, term: msg.term as number };
    const channel = new Channel(
      frames,
      { host: opts.host, port: opts.port },
      { nodeId: server.nodeId, name: server.name },
      deriveKeys(opts.token, clientNonce, serverNonce, "client"),
      opts,
    );
    resolve({ channel, server });
  };
  return promise;
}

// --- Server -----------------------------------------------------------------------------------

/** A validated client hello plus the handshake fields the server needs. */
interface ParsedHello extends HelloInfo {
  proto: unknown;
  nonce: Buffer;
  nonceB64: string;
}

/** Validates a client hello; null when malformed. */
function parseHello(msg: Record<string, unknown> | null): ParsedHello | null {
  if (msg?.t !== "hello") return null;
  const nonce = decodeNonce(msg.nonce);
  const purpose = msg.purpose as ChannelPurpose;
  if (!nonce || !isId(msg.nodeId) || !isId(msg.name) || !PURPOSES.includes(purpose)) return null;
  return { nodeId: msg.nodeId, name: msg.name, purpose, proto: msg.proto, nonce, nonceB64: msg.nonce as string };
}

/** Run the server side of the handshake on an accepted socket; `onChannel` gets the authenticated channel. */
function acceptConnection(
  socket: Socket,
  opts: ListenChannelsOptions,
  track: { sockets: Set<Socket>; channels: Set<Channel> },
): void {
  const frames = new FrameSocket(socket);
  const remote = { host: normalizeHost(socket.remoteAddress), port: socket.remotePort ?? 0 };
  track.sockets.add(socket);
  const timer = setTimeout(() => refuse(), opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
  let hello: ParsedHello | null = null;
  let token: string | null = null;
  let serverNonce: Buffer | null = null;

  function stop(): void {
    clearTimeout(timer);
    track.sockets.delete(socket);
  }
  function refuse(error?: { code: HandshakeErrorCode; message: string }, authFailure?: string): void {
    stop();
    if (error) frames.writeJson({ t: "error", ...error });
    frames.shutdown();
    if (authFailure) opts.onAuthFailure?.(remote, authFailure);
  }

  frames.onEnd = stop;
  frames.onFrame = (body) => {
    const msg = parseJson(body);
    if (!hello) return onHello(msg);
    if (msg?.t === "error" && msg.code === "auth") {
      return refuse(undefined, `${hello.name} (${remote.host}) has a different cluster token`);
    }
    if (msg?.t !== "auth" || !token || !serverNonce) return refuse();
    const serverNonceB64 = serverNonce.toString("base64");
    if (!proofMatches(proof(token, "c", hello.nonceB64, serverNonceB64), msg.proof)) {
      return refuse(undefined, `${hello.name} (${remote.host}) failed to prove the cluster token`);
    }
    stop();
    const channel = new Channel(
      frames,
      remote,
      { nodeId: hello.nodeId, name: hello.name },
      deriveKeys(token, hello.nonce, serverNonce, "server"),
      opts,
    );
    track.channels.add(channel);
    channel.onClose(() => track.channels.delete(channel));
    opts.onChannel(channel, { nodeId: hello.nodeId, name: hello.name, purpose: hello.purpose });
  };

  function onHello(msg: Record<string, unknown> | null): void {
    hello = parseHello(msg);
    if (!hello) return refuse();
    if (hello.proto !== CLUSTER_PROTOCOL_VERSION) {
      return refuse({
        code: "proto",
        message: `cluster protocol ${String(hello.proto)} is not supported (this node speaks ${CLUSTER_PROTOCOL_VERSION})`,
      });
    }
    token = opts.token();
    if (!token) {
      return refuse(
        { code: "auth", message: "this node does not accept cluster connections" },
        `${hello.name} (${remote.host}) connected but this node has no cluster token`,
      );
    }
    const identity = opts.identity();
    serverNonce = randomBytes(NONCE_BYTES);
    const serverNonceB64 = serverNonce.toString("base64");
    frames.writeJson({
      t: "challenge",
      proto: CLUSTER_PROTOCOL_VERSION,
      nonce: serverNonceB64,
      proof: proof(token, "s", hello.nonceB64, serverNonceB64).toString("base64"),
      nodeId: identity.nodeId,
      name: identity.name,
      role: identity.role,
      term: identity.term,
    });
  }
}

/** Listen for cluster channels on `port` (0 = ephemeral, see `listener.port`). */
export function listenChannels(opts: ListenChannelsOptions): Promise<ChannelListener> {
  const track = { sockets: new Set<Socket>(), channels: new Set<Channel>() };
  const server = net.createServer((socket) => acceptConnection(socket, opts, track));
  const { promise, resolve, reject } = Promise.withResolvers<ChannelListener>();
  server.once("error", reject);
  server.listen(opts.port, opts.host ?? "0.0.0.0", () => {
    server.off("error", reject);
    server.on("error", (err) => console.error("[cluster] listener error:", err));
    const address = server.address();
    resolve({
      port: typeof address === "object" && address ? address.port : opts.port,
      close() {
        const closed = Promise.withResolvers<void>();
        server.close(() => closed.resolve());
        for (const socket of track.sockets) socket.destroy();
        for (const channel of track.channels) channel.close();
        return closed.promise;
      },
    });
  });
  return promise;
}
