// One omp run executed on a replica node, seen by the primary's agent manager as an RpcTransport:
// stdin/stdout travel as run.* messages over the node's member channel, the run's folders are
// synced down before omp starts (sync scope `run:<runKey>`) and back up while it runs. Survives a
// short node disconnect (NODE_LOST_GRACE_MS): stdout is replayed and unacknowledged stdin resent.
import path from "node:path";
import type { RpcExitInfo, RpcFrame, RpcTransport, RpcTransportHandlers } from "@/lib/agent/rpc";
import { authRunEnv, buildAuthPack, nodeAuthDir } from "@/lib/cluster/auth-pack";
import { buildOmpAgentPack } from "@/lib/cluster/omp-runtime";
import { canonicalPath, mirrorPath } from "@/lib/cluster/paths";
import type { ClusterChannel } from "@/lib/cluster/protocol";
import { gitCommonDirs, PathMap, type SyncEndpoint } from "@/lib/cluster/sync";
import { dataDir } from "@/lib/files";
import {
  NODE_LOST_CODE,
  NODE_LOST_GRACE_MS,
  type NodePaths,
  type RemoteRunState,
  type RunExitMsg,
  type RunStartMsg,
  type SyncFolderSpec,
  type SyncKind,
  type WireMessage,
} from "@/lib/cluster/types";

/** How long a flush barrier (agent_end, host tool call) waits for the node's upstream sync. */
const FLUSH_TIMEOUT_MS = 60_000;
/** stderr kept for the exit report when the node never sends its own. */
const STDERR_TAIL_CHARS = 8 * 1024;
/** Frames whose handling reads files the run wrote: dispatched only after an upstream flush. */
const FLUSHED_FRAMES: Record<string, true> = { agent_end: true, host_tool_call: true };
/** Largest chunked frame reassembled for path mapping (OmpRpcProcess's own default cap). */
const MAX_CHUNKED_FRAME_BYTES = 64 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** What the manager asks a node to run. Every path is a primary path. */
export interface RemoteRunSpec {
  runKey: string;
  taskId: string;
  args: string[];
  cwd: string;
  /** Forwardable environment only (provider keys, MCP values); never PATH/HOME/server secrets. */
  env: Record<string, string>;
  /** Synced down before omp starts and back up while it runs. */
  folders: { path: string; kind: SyncKind }[];
  /** Small generated files (the run config) written on the node before omp starts. */
  files: { path: string; content: string }[];
}

/** Where a remote run executes; `totals()` is the node's latest process-tree reading of it. */
export interface RemoteRunInfo {
  nodeId: string;
  nodeName: string;
  totals(): { memoryBytes: number; cpuSeconds: number } | null;
}

/** The node's live member session (null while it is offline). */
export interface RemoteNodeSession {
  channel: ClusterChannel;
  endpoint: SyncEndpoint;
  paths: NodePaths;
}

/** How a transport reaches its node; provided by lib/cluster/primary.ts. */
export interface RemoteRunLink {
  nodeId: string;
  nodeName: string;
  session(): RemoteNodeSession | null;
  /** The primary's omp binary the node must run, by checksum; null = the node's own `omp`. */
  ompBinary(): Promise<{ sha256: string; version: string } | null>;
  /** Called once, right before the exit is reported. */
  onFinished(): void;
}

/** An RpcTransport whose omp process runs on a replica node. */
export class RemoteRunTransport implements RpcTransport {
  readonly pid = undefined;
  readonly runKey: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly remote: RemoteRunInfo;
  private handlers: RpcTransportHandlers | null = null;
  private map: PathMap | null = null;
  /** Folders the node may push back (null until the run was prepared). */
  private upstream: SyncFolderSpec[] | null = null;
  /** `run.start` went out on the node's channel. */
  private dispatched = false;
  private started = false;
  private finished = false;
  private inputOpen = true;
  private outSeq = 0;
  private inSeq = 0;
  /** stdin chunks the node has not acknowledged yet (node.status `inSeq`), resent after a reconnect. */
  private unacked: { seq: number; data: string }[] = [];
  /** A signal that could not be delivered while the node was offline. */
  private pendingSignal: NodeJS.Signals | null = null;
  /** stdout after the last newline: omp frames are mapped back to primary paths whole. */
  private partialLine = "";
  /** Reassembles chunked frames so the paths inside them are mapped back too. */
  private readonly frames = new ChunkedFrames((text) => this.toPrimary(text));
  private stderrTail = "";
  private latestTotals: { memoryBytes: number; cpuSeconds: number } | null = null;
  private graceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly link: RemoteRunLink,
    private readonly spec: RemoteRunSpec,
  ) {
    this.runKey = spec.runKey;
    this.taskId = spec.taskId;
    this.nodeId = link.nodeId;
    this.remote = { nodeId: link.nodeId, nodeName: link.nodeName, totals: () => this.latestTotals };
  }

  get stdinOpen(): boolean {
    return this.inputOpen && !this.finished;
  }

  /** `run.start` was sent: the node knows this run (a reconnect that does not report it lost it). */
  get launched(): boolean {
    return this.dispatched;
  }

  start(handlers: RpcTransportHandlers): void {
    this.handlers = handlers;
    // Deferred: an immediate failure must not report `exit` before the caller attached its listeners.
    queueMicrotask(() => void this.launch());
  }

  write(data: string): boolean {
    if (!this.stdinOpen) return false;
    const chunk = { seq: ++this.inSeq, data };
    this.unacked.push(chunk);
    if (this.started) this.sendInput(chunk);
    return true;
  }

  end(): void {
    if (!this.stdinOpen) return;
    this.inputOpen = false;
    if (this.started) this.send({ t: "run.end", runKey: this.runKey });
  }

  signal(signal: NodeJS.Signals): void {
    if (this.finished) return;
    if (!this.started) {
      // Still preparing or syncing: give up the launch; the node drops what it got.
      this.send({ t: "run.kill", runKey: this.runKey });
      this.finish({ code: null, signal, stderr: this.stderrTail });
      return;
    }
    this.pendingSignal = this.send({ t: "run.signal", runKey: this.runKey, signal }) ? null : signal;
  }

  setRef(): void {
    // Nothing local keeps the event loop alive for a remote run.
  }

  gate(frame: RpcFrame): Promise<void> | null {
    if (!Object.hasOwn(FLUSHED_FRAMES, frame.type) || !this.started || this.finished) return null;
    const session = this.link.session();
    if (!session) return null;
    return session.channel.request({ t: "run.flush", runKey: this.runKey }, FLUSH_TIMEOUT_MS).then(
      () => undefined,
      () => undefined,
    );
  }

  /** Specs the node may push upstream for this run's scope; null once it ended or before it was prepared. */
  upstreamFolders(): SyncFolderSpec[] | null {
    return this.finished ? null : this.upstream;
  }

  /** A run.* message of this run from its node. */
  handle(msg: WireMessage): void {
    if (this.finished) return;
    switch (msg.t) {
      case "run.started":
        this.markStarted();
        break;
      case "run.out":
        if (typeof msg.seq === "number" && typeof msg.data === "string") this.onStdout(msg.seq, msg.data);
        break;
      case "run.err":
        if (typeof msg.data === "string") this.onStderr(msg.data);
        break;
      case "run.exit":
        this.onExit(msg as RunExitMsg);
        break;
    }
  }

  /** The node's latest reading of this run (node.status). */
  updateStatus(entry: { memoryBytes: number; cpuSeconds: number; inSeq: number }): void {
    this.latestTotals = { memoryBytes: entry.memoryBytes, cpuSeconds: entry.cpuSeconds };
    this.acknowledge(entry.inSeq);
  }

  /** The node's channel closed: wait NODE_LOST_GRACE_MS for it to come back, then give up. */
  detach(): void {
    if (this.finished || this.graceTimer) return;
    this.graceTimer = setTimeout(() => this.lost(`Node ${this.link.nodeName} went offline`), NODE_LOST_GRACE_MS);
    this.graceTimer.unref();
  }

  /** The node re-registered still hosting this run: replay its stdout and resend unacknowledged stdin. */
  attach(state: RemoteRunState): void {
    if (this.finished) return;
    this.clearGrace();
    this.acknowledge(state.inSeq);
    this.send({ t: "run.resume", runKey: this.runKey, outSeq: this.outSeq });
    if (this.started || state.alive) this.markStarted(true);
  }

  /** The node is gone for good (or the primary stops): end the run with the NODE_LOST_CODE error. */
  lost(message: string): void {
    this.fail(Object.assign(new Error(message), { code: NODE_LOST_CODE }), false);
  }

  private async launch(): Promise<void> {
    let prepared: { start: RunStartMsg; folders: SyncFolderSpec[]; map: PathMap };
    try {
      const session = this.link.session();
      if (!session) return this.lost(`Node ${this.link.nodeName} is offline`);
      prepared = await this.prepare(session.paths);
    } catch (err) {
      return this.fail(err instanceof Error ? err : new Error(String(err)), false);
    }
    if (this.finished) return;
    const session = this.link.session();
    if (!session) return this.lost(`Node ${this.link.nodeName} is offline`);
    this.map = prepared.map;
    this.upstream = prepared.folders.filter((f) => f.upstream);
    if (!session.channel.send(prepared.start)) return this.lost(`Node ${this.link.nodeName} is offline`);
    this.dispatched = true;
    try {
      await session.endpoint.push(`run:${this.runKey}`, prepared.folders, prepared.map);
    } catch (err) {
      if (this.finished) return;
      if (session.channel.closed) return this.lost(`Node ${this.link.nodeName} went offline while the run was starting`);
      const reason = err instanceof Error ? err.message : String(err);
      this.fail(new Error(`Syncing the card's files to ${this.link.nodeName} failed: ${reason}`), true);
    }
  }

  /** The run.start message, its sync folders and the path map, for a node with `paths`. */
  private async prepare(paths: NodePaths): Promise<{ start: RunStartMsg; folders: SyncFolderSpec[]; map: PathMap }> {
    const [pack, auth, omp, gitDirs] = await Promise.all([
      buildOmpAgentPack(),
      buildAuthPack(),
      this.link.ompBinary(),
      gitCommonDirs(this.spec.folders.map((f) => path.resolve(f.path))),
    ]);
    const authDir = nodeAuthDir(paths.dataDir);
    // A primary promoted from a replica runs on its mirror copies: the node's copy is keyed by the canonical path.
    const toMirror = (p: string): [string, string] => [path.resolve(p), mirrorPath(canonicalPath(p), paths.mirrorRoot)];
    const folders: SyncFolderSpec[] = [
      ...this.spec.folders.map((f, i) => folderSpec(`folder-${i}`, toMirror(f.path), f.kind, true)),
      ...gitDirs.map((dir, i) => folderSpec(`git-${i}`, toMirror(dir), "raw", true)),
      folderSpec("omp-agent", [path.resolve(pack), paths.ompAgentDir], "raw", false),
      folderSpec("auth", [path.resolve(auth.dir), authDir], "raw", false),
    ];
    // The node's copy of this server's data dir (replicated card/board files, workspaces) is the
    // shortest pair, so every more specific folder above wins the longest-prefix mapping.
    const map = new PathMap([
      ...folders.map((f): [string, string] => [f.primaryPath, f.nodePath]),
      ...this.spec.files.map((f) => toMirror(f.path)),
      [path.resolve(dataDir()), paths.dataDir],
    ]);
    const env = Object.fromEntries(Object.entries(this.spec.env).map(([k, v]) => [k, map.toNode(v)]));
    const start: RunStartMsg = {
      t: "run.start",
      runKey: this.runKey,
      taskId: this.taskId,
      args: this.spec.args.map((arg) => map.toNode(arg)),
      cwd: map.pathToNode(path.resolve(this.spec.cwd)),
      env: { ...env, ...authRunEnv(authDir, auth), PI_CODING_AGENT_DIR: paths.ompAgentDir },
      files: this.spec.files.map((f) => ({ path: map.pathToNode(path.resolve(f.path)), content: map.toNode(f.content) })),
      folders,
      omp,
    };
    return { start, folders, map };
  }

  /** omp runs on the node (or did before a reconnect): deliver stdin held so far. */
  private markStarted(force = false): void {
    if (this.finished || (this.started && !force)) return;
    this.started = true;
    for (const chunk of this.unacked) this.sendInput(chunk);
    if (!this.inputOpen) this.send({ t: "run.end", runKey: this.runKey });
    if (this.pendingSignal) this.signal(this.pendingSignal);
  }

  private sendInput(chunk: { seq: number; data: string }): void {
    const data = this.map ? this.map.toNode(chunk.data) : chunk.data;
    this.send({ t: "run.in", runKey: this.runKey, seq: chunk.seq, data });
  }

  private acknowledge(inSeq: number): void {
    while (this.unacked.length > 0 && this.unacked[0].seq <= inSeq) this.unacked.shift();
  }

  private onStdout(seq: number, data: string): void {
    if (seq <= this.outSeq) return; // replayed after a reconnect
    this.outSeq = seq;
    const text = this.partialLine + data;
    const cut = text.lastIndexOf("\n") + 1;
    this.partialLine = text.slice(cut);
    if (cut === 0) return;
    let out = "";
    for (const line of text.slice(0, cut).split(/(?<=\n)/)) out += this.frames.line(line);
    if (out) this.handlers?.stdout(out);
  }

  private onStderr(data: string): void {
    const text = this.toPrimary(data);
    this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS);
    this.handlers?.stderr(text);
  }

  private onExit(msg: RunExitMsg): void {
    const error = msg.error ?? (this.started ? null : `omp exited on ${this.link.nodeName} before it started`);
    this.finish({
      code: typeof msg.code === "number" ? msg.code : null,
      signal: typeof msg.signal === "string" ? (msg.signal as NodeJS.Signals) : null,
      error: error ? new Error(error) : undefined,
      stderr: typeof msg.stderr === "string" ? this.toPrimary(msg.stderr) : this.stderrTail,
    });
  }

  private fail(error: NodeJS.ErrnoException, killOnNode: boolean): void {
    if (this.finished) return;
    if (killOnNode) this.send({ t: "run.kill", runKey: this.runKey });
    this.finish({ code: null, signal: null, error, stderr: this.stderrTail });
  }

  private finish(info: RpcExitInfo): void {
    if (this.finished) return;
    this.finished = true;
    this.clearGrace();
    this.unacked = [];
    this.link.session()?.endpoint.dropScope(`run:${this.runKey}`);
    this.link.onFinished();
    const rest = this.frames.release() + (this.partialLine ? this.toPrimary(this.partialLine) : "");
    this.partialLine = "";
    if (rest) this.handlers?.stdout(rest);
    this.handlers?.stdoutEnd();
    this.handlers?.exit(info);
  }

  private clearGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private toPrimary(text: string): string {
    return this.map ? this.map.toPrimary(text) : text;
  }

  private send(msg: WireMessage): boolean {
    return this.link.session()?.channel.send(msg) ?? false;
  }
}

function folderSpec(id: string, [primaryPath, nodePath]: [string, string], kind: SyncKind, upstream: boolean): SyncFolderSpec {
  return { id, primaryPath, nodePath, kind, upstream };
}

/** One `rpc_chunk` stdout frame (omp protocol v2: a large frame split into base64 parts). */
interface ChunkFrame {
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

/** A `rpc_chunk` line: its fields, "malformed" when they are invalid, null for any other line. */
function parseChunkLine(line: string): ChunkFrame | "malformed" | null {
  if (!line.includes('"rpc_chunk"')) return null;
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof frame !== "object" || frame === null || !("type" in frame) || frame.type !== "rpc_chunk") return null;
  const { chunkId, index, count, byteLength, data } = frame as Record<string, unknown>;
  const counts = [index, count, byteLength].every((n) => Number.isInteger(n) && (n as number) >= 0);
  if (typeof chunkId !== "string" || !chunkId || !counts || (count as number) < 1 || typeof data !== "string") {
    return "malformed";
  }
  return { chunkId, index: index as number, count: count as number, byteLength: byteLength as number, data };
}

/**
 * Maps the paths inside chunked stdout frames back to primary paths: a complete, valid
 * `rpc_chunk` sequence is reassembled, mapped and emitted as one ordinary JSON line. Anything
 * malformed passes through unchanged, so OmpRpcProcess reports the protocol error itself.
 */
class ChunkedFrames {
  private pending: (Omit<ChunkFrame, "index" | "data"> & { next: number; size: number; parts: Buffer[]; lines: string[] }) | null =
    null;

  constructor(private readonly toPrimary: (text: string) => string) {}

  /** What to emit for one complete stdout line (newline included): "" while a sequence is incomplete. */
  line(line: string): string {
    const chunk = parseChunkLine(line);
    if (chunk === null) return this.release() + this.toPrimary(line);
    if (chunk === "malformed") return this.release() + line;
    let state = this.pending;
    if (
      state &&
      (state.chunkId !== chunk.chunkId ||
        state.count !== chunk.count ||
        state.byteLength !== chunk.byteLength ||
        state.next !== chunk.index)
    ) {
      const broken = this.release();
      // A new sequence may legitimately start right here.
      return chunk.index === 0 && state.chunkId !== chunk.chunkId ? broken + this.line(line) : broken + line;
    }
    if (!state) {
      if (chunk.index !== 0 || chunk.byteLength > MAX_CHUNKED_FRAME_BYTES) return line;
      const { chunkId, count, byteLength } = chunk;
      state = this.pending = { chunkId, count, byteLength, next: 0, size: 0, parts: [], lines: [] };
    }
    state.lines.push(line);
    if (!BASE64.test(chunk.data) || chunk.data.length % 4 !== 0) return this.release();
    const bytes = Buffer.from(chunk.data, "base64");
    state.size += bytes.length;
    if (state.size > state.byteLength) return this.release();
    state.parts.push(bytes);
    state.next += 1;
    if (state.next < state.count) return "";
    this.pending = null;
    return this.decode(state.parts, state.size === state.byteLength) ?? state.lines.join("");
  }

  /** The original lines of an unfinished sequence (to pass through unchanged); "" when none. */
  release(): string {
    const lines = this.pending?.lines.join("") ?? "";
    this.pending = null;
    return lines;
  }

  /** The reassembled frame as one mapped JSON line; null when it is not a valid UTF-8 JSON object frame. */
  private decode(parts: Buffer[], complete: boolean): string | null {
    if (!complete) return null;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
      const frame: unknown = JSON.parse(text);
      if (typeof frame !== "object" || frame === null || !("type" in frame) || typeof frame.type !== "string") return null;
    } catch {
      return null;
    }
    // Raw newlines in valid JSON are whitespace between tokens: the frame stays a single line.
    return `${this.toPrimary(text).replace(/[\r\n]+/g, " ")}\n`;
  }
}
