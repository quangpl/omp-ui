import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

/** Any JSON object read from omp's stdout. */
export interface RpcFrame {
  type: string;
  [key: string]: unknown;
}

/** A command written to omp's stdin. `id` is generated when omitted. */
export interface RpcCommand {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

export interface RpcExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be spawned (e.g. ENOENT) or the transport broke. */
  error?: NodeJS.ErrnoException;
  /** Last ~8KB of stderr. */
  stderr: string;
}

export interface OmpRpcOptions {
  /** omp executable path or name on PATH. */
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Answer extension `confirm` dialogs with `confirmed: true` (yolo); otherwise cancel them. */
  autoConfirm: boolean;
  /** Default timeout for non-prompt commands (ms). */
  commandTimeoutMs?: number;
}

export interface SendOptions {
  /** Overrides the default; 0 disables. `prompt` never times out unless set explicitly. */
  timeoutMs?: number;
}

type RpcEvents = {
  /** Every logical stdout frame (after chunk reassembly), including responses. */
  frame: [RpcFrame];
  /** Transport problems that dropped a logical frame (bad chunk sequence, unparsable payload). */
  protocolError: [string];
  /** Emitted exactly once. */
  exit: [RpcExitInfo];
};

interface Pending {
  command: string;
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

interface ChunkState {
  chunkId: string;
  count: number;
  byteLength: number;
  next: number;
  parts: Buffer[];
  size: number;
}

const STDERR_LIMIT = 8 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const CLOSE_GRACE_MS = 5_000;
const TERM_GRACE_MS = 3_000;

/** Error carrying omp's failure `code` (if any) from a `success: false` response. */
export class RpcCommandError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RpcCommandError";
  }
}

/**
 * One `omp --mode rpc` subprocess speaking newline-delimited JSON on stdin/stdout.
 * Handles response correlation, protocol v2 negotiation + `rpc_chunk` reassembly, and
 * auto-answers `extension_ui_request` dialogs (a headless host cannot show them).
 */
export class OmpRpcProcess extends EventEmitter<RpcEvents> {
  readonly command: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly autoConfirm: boolean;
  private readonly commandTimeoutMs: number;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrTail = "";
  private chunk: ChunkState | null = null;
  private maxReassembledBytes = DEFAULT_MAX_REASSEMBLED_BYTES;
  private readonly readyPromise: Promise<void>;
  private readonly resolveReady: () => void;
  private readonly rejectReady: (error: Error) => void;
  private readySeen = false;
  private exitInfo: RpcExitInfo | null = null;
  private readonly exitPromise: Promise<RpcExitInfo>;
  private readonly resolveExit: (info: RpcExitInfo) => void;

  constructor(options: OmpRpcOptions) {
    super();
    this.command = options.command;
    this.autoConfirm = options.autoConfirm;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const ready = Promise.withResolvers<void>();
    this.readyPromise = ready.promise;
    this.resolveReady = ready.resolve;
    this.rejectReady = ready.reject;
    // Callers that never await waitReady() must not trigger unhandled rejections.
    this.readyPromise.catch(() => undefined);
    const exit = Promise.withResolvers<RpcExitInfo>();
    this.exitPromise = exit.promise;
    this.resolveExit = exit.resolve;

    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    liveProcesses().add(this);
    registerShutdownHooks();

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (data: string) => this.onStdout(data));
    this.child.stdout.on("end", () => this.flushStdout());
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (data: string) => {
      this.stderrTail = (this.stderrTail + data).slice(-STDERR_LIMIT);
    });
    // EPIPE after the child died is reported via 'close'; never crash the server on it.
    this.child.stdin.on("error", () => undefined);
    this.child.on("error", (error: NodeJS.ErrnoException) => {
      if (this.child.pid === undefined) {
        this.finish({ code: null, signal: null, error, stderr: this.stderrTail });
      }
    });
    this.child.on("close", (code, signal) => {
      this.finish({ code, signal, stderr: this.stderrTail });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get exited(): boolean {
    return this.exitInfo !== null;
  }

  /** Last ~8KB of stderr output. */
  get stderr(): string {
    return this.stderrTail;
  }

  /** Resolves once `ready` was received (and protocol v2 negotiated when supported). */
  waitReady(timeoutMs: number): Promise<void> {
    if (this.readySeen || this.exitInfo) return this.readyPromise;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      reject(new Error(`omp did not become ready within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    this.readyPromise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: Error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
    return promise;
  }

  /** Resolves when the process has exited. */
  waitExit(): Promise<RpcExitInfo> {
    return this.exitPromise;
  }

  /**
   * Send a command and resolve with its `response`. Rejects on `success: false`,
   * on process exit, and on timeout (non-prompt commands by default).
   */
  send(command: RpcCommand, options: SendOptions = {}): Promise<RpcResponse> {
    if (this.exitInfo) {
      return Promise.reject(new Error(`omp process has exited (${describeExit(this.exitInfo)})`));
    }
    const id = command.id ?? `${command.type}-${this.nextId++}`;
    const timeoutMs =
      options.timeoutMs ?? (command.type === "prompt" ? 0 : this.commandTimeoutMs);
    const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
    const entry: Pending = { command: command.type, resolve, reject, timer: undefined };
    if (timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`omp did not answer "${command.type}" within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    }
    this.pending.set(id, entry);
    if (!this.write({ ...command, id })) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      reject(new Error("omp stdin is closed"));
    }
    return promise;
  }

  /** Graceful shutdown: end stdin, wait 5s, SIGTERM, wait 3s, SIGKILL. */
  async close(): Promise<void> {
    if (this.exitInfo) return;
    if (!this.child.stdin.writableEnded) this.child.stdin.end();
    if (await this.exitWithin(CLOSE_GRACE_MS)) return;
    this.signal("SIGTERM");
    if (await this.exitWithin(TERM_GRACE_MS)) return;
    this.signal("SIGKILL");
    await this.exitPromise;
  }

  /** Immediate termination. */
  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    this.signal(signal);
  }

  private signal(signal: NodeJS.Signals): void {
    if (this.exitInfo || this.child.pid === undefined) return;
    try {
      this.child.kill(signal);
    } catch {
      // Already gone.
    }
  }

  private exitWithin(ms: number): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => resolve(false), ms);
    void this.exitPromise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
    return promise;
  }

  private write(payload: object): boolean {
    if (this.exitInfo || this.child.stdin.writableEnded || this.child.stdin.destroyed) return false;
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return true;
  }

  private onStdout(data: string): void {
    this.stdoutBuffer += data;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.onLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private flushStdout(): void {
    if (!this.stdoutBuffer) return;
    const rest = this.stdoutBuffer;
    this.stdoutBuffer = "";
    this.onLine(rest);
  }

  private onLine(raw: string): void {
    const line = raw.trim();
    if (!line.startsWith("{")) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (!isFrame(frame)) return;
    if (frame.type === "rpc_chunk") {
      this.onChunk(frame);
      return;
    }
    if (this.chunk) {
      this.protocolError(
        `chunk sequence ${this.chunk.chunkId} interrupted by a "${frame.type}" frame`,
      );
      this.chunk = null;
    }
    this.dispatch(frame);
  }

  private onChunk(frame: RpcFrame): void {
    const { chunkId, index, count, byteLength, data } = frame;
    if (
      typeof chunkId !== "string" ||
      !chunkId ||
      !isNonNegativeInt(index) ||
      !isNonNegativeInt(count) ||
      count < 1 ||
      !isNonNegativeInt(byteLength) ||
      typeof data !== "string"
    ) {
      this.protocolError("malformed rpc_chunk frame");
      this.chunk = null;
      return;
    }
    let state = this.chunk;
    if (!state) {
      if (index !== 0) {
        this.protocolError(`chunk sequence ${chunkId} started at index ${index}`);
        return;
      }
      if (byteLength > this.maxReassembledBytes) {
        this.protocolError(`chunk sequence ${chunkId} exceeds ${this.maxReassembledBytes} bytes`);
        return;
      }
      state = { chunkId, count, byteLength, next: 0, parts: [], size: 0 };
      this.chunk = state;
    } else if (
      state.chunkId !== chunkId ||
      state.count !== count ||
      state.byteLength !== byteLength ||
      state.next !== index
    ) {
      this.protocolError(`chunk sequence ${state.chunkId} broken at index ${index}`);
      this.chunk = null;
      // A new sequence may legitimately start right here.
      if (index === 0 && state.chunkId !== chunkId) this.onChunk(frame);
      return;
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) {
      this.protocolError(`chunk sequence ${chunkId} has invalid base64 at index ${index}`);
      this.chunk = null;
      return;
    }
    const bytes = Buffer.from(data, "base64");
    state.size += bytes.length;
    if (state.size > state.byteLength || state.size > this.maxReassembledBytes) {
      this.protocolError(`chunk sequence ${chunkId} exceeds its declared byteLength`);
      this.chunk = null;
      return;
    }
    state.parts.push(bytes);
    state.next += 1;
    if (state.next < state.count) return;

    this.chunk = null;
    if (state.size !== state.byteLength) {
      this.protocolError(
        `chunk sequence ${chunkId} has ${state.size} bytes, expected ${state.byteLength}`,
      );
      return;
    }
    let parsed: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(state.parts));
      parsed = JSON.parse(text);
    } catch {
      this.protocolError(`chunk sequence ${chunkId} is not valid UTF-8 JSON`);
      return;
    }
    if (!isFrame(parsed)) {
      this.protocolError(`chunk sequence ${chunkId} is not a JSON object frame`);
      return;
    }
    this.dispatch(parsed);
  }

  private dispatch(frame: RpcFrame): void {
    switch (frame.type) {
      case "ready":
        this.onReady(frame);
        break;
      case "response":
        this.onResponse(frame as unknown as RpcResponse);
        break;
      case "extension_ui_request":
        this.onUiRequest(frame);
        break;
    }
    this.emit("frame", frame);
  }

  private onReady(frame: RpcFrame): void {
    if (this.readySeen) return;
    this.readySeen = true;
    if (isNonNegativeInt(frame.maxReassembledFrameBytes) && frame.maxReassembledFrameBytes > 0) {
      this.maxReassembledBytes = frame.maxReassembledFrameBytes;
    }
    const supported = Array.isArray(frame.supportedProtocolVersions)
      ? frame.supportedProtocolVersions
      : [];
    if (!supported.includes(2)) {
      this.resolveReady();
      return;
    }
    // v1 stays active if negotiation fails; that is still a usable transport.
    // On exit, finish() has already rejected readiness and this resolve is a no-op.
    const settle = () => this.resolveReady();
    this.send({ type: "negotiate_protocol", protocolVersion: 2 }).then(settle, settle);
  }

  private onResponse(response: RpcResponse): void {
    if (typeof response.id !== "string") return;
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.success) {
      entry.resolve(response);
    } else {
      entry.reject(
        new RpcCommandError(
          response.error || `omp rejected "${entry.command}"`,
          entry.command,
          response.code,
        ),
      );
    }
  }

  private onUiRequest(frame: RpcFrame): void {
    const id = frame.id;
    if (typeof id !== "string") return;
    switch (frame.method) {
      case "confirm":
        this.write(
          this.autoConfirm
            ? { type: "extension_ui_response", id, confirmed: true }
            : { type: "extension_ui_response", id, cancelled: true },
        );
        break;
      case "select":
      case "input":
      case "editor":
        this.write({ type: "extension_ui_response", id, cancelled: true });
        break;
      default:
        // Fire-and-forget presentation methods (notify, setStatus, setWidget, ...) need no reply.
        break;
    }
  }

  private protocolError(message: string): void {
    this.emit("protocolError", message);
  }

  private finish(info: RpcExitInfo): void {
    if (this.exitInfo) return;
    this.flushStdout();
    this.exitInfo = info;
    liveProcesses().delete(this);
    const error = new Error(`omp process exited (${describeExit(info)})`);
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    // No-op once ready has resolved; otherwise unblocks waitReady() (including mid-negotiation).
    this.rejectReady(info.error ?? new Error(`omp exited before it was ready (${describeExit(info)})`));
    this.resolveExit(info);
    this.emit("exit", info);
  }
}

/** Human-readable exit description including the stderr tail. */
export function describeExit(info: RpcExitInfo): string {
  const parts: string[] = [];
  if (info.error) parts.push(info.error.message);
  else if (info.signal) parts.push(`signal ${info.signal}`);
  else parts.push(`code ${info.code ?? "unknown"}`);
  const stderr = info.stderr.trim();
  if (stderr) parts.push(stderr.slice(-1000));
  return parts.join(": ");
}

function isFrame(value: unknown): value is RpcFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// --- Process-wide child tracking: kill every omp child when the server goes down. ---

const g = globalThis as unknown as {
  __ompUiRpcProcesses?: Set<OmpRpcProcess>;
  __ompUiRpcHooks?: boolean;
};

function liveProcesses(): Set<OmpRpcProcess> {
  return (g.__ompUiRpcProcesses ??= new Set());
}

/** Synchronously signal every live omp child. */
export function killAllOmpProcesses(signal: NodeJS.Signals = "SIGTERM"): void {
  for (const proc of liveProcesses()) proc.kill(signal);
}

function registerShutdownHooks(): void {
  if (g.__ompUiRpcHooks) return;
  g.__ompUiRpcHooks = true;
  process.on("exit", () => killAllOmpProcesses("SIGTERM"));
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const handler = () => {
      killAllOmpProcesses("SIGTERM");
      // Our listener suppressed Node's default "exit on signal". If nobody else handles the
      // signal, re-raise it so the default behaviour still applies.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    process.once(signal, handler);
  }
}
