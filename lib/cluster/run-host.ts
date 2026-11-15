// Replica side of remote runs: hosts the omp processes the primary dispatches to this node. One
// long-lived host per process (globalThis) outlives member channels: omp keeps running while the
// primary is unreachable, stdout is buffered with sequence numbers and replayed on `run.resume`,
// and the upstream sync baselines of every run survive the reconnect.
//
// A start: the primary sends `run.start`, then pushes sync scope `run:<runKey>` down; once that
// push is applied the host writes the run's files, spawns omp and answers `run.started`. While omp
// runs, upstream folders are pushed back every RUN_SYNC_INTERVAL_MS and on `run.flush`; on exit a
// final push precedes `run.exit`.
//
// Runs on one node can share folders (a board's workdir without worktrees, the git common dir of
// worktree boards, the omp agent dir). A folder another hosted run already claimed is left out of
// the newcomer's down push — it is present and live, like a workdir two local runs share — so the
// newcomer never resets files a running omp is working on.
import { mkdir, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import path from "node:path";

import { listProcesses, treeTotals } from "@/lib/agent/resources";
import { spawnTransport, type RpcTransport } from "@/lib/agent/rpc";
import { childEnv } from "@/lib/child-env";
import { ensureOmpBinary } from "@/lib/cluster/omp-runtime";
import { clusterDir } from "@/lib/cluster/paths";
import type { ClusterChannel } from "@/lib/cluster/protocol";
import { replicationIdle } from "@/lib/cluster/replication";
import { PathMap, scanFolder, SyncBaselines, type SyncEndpoint } from "@/lib/cluster/sync";
import {
  RUN_OUTPUT_BUFFER_BYTES,
  RUN_SYNC_INTERVAL_MS,
  type NodeStatusMsg,
  type RemoteRunState,
  type RunExitMsg,
  type RunFlushMsg,
  type RunInMsg,
  type RunResumeMsg,
  type RunSignalMsg,
  type RunStartMsg,
  type SyncFolderSpec,
  type WelcomeMsg,
  type WireMessage,
} from "@/lib/cluster/types";

const SCOPE_PREFIX = "run:";
/** stderr kept for the exit report. */
const STDERR_LIMIT = 8 * 1024;
const RUN_KEY_PATTERN = /^[\w.:-]{1,200}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const OVERFLOW_ERROR = "output buffer overflow";

/** What the host needs to know about the primary of the current member channel. */
export interface RunHostContext {
  /** The primary's web server (omp binary downloads). */
  primaryHttpUrl: string;
  /** The primary's omp binary as `welcome` announced it; its size completes RunStartMsg.omp. */
  omp: WelcomeMsg["omp"];
}

interface OutChunk {
  seq: number;
  data: string;
  bytes: number;
}

type ExitInfo = Pick<RunExitMsg, "code" | "signal" | "error">;

/** A folder of a run left out of its down push because another hosted run claimed it (or an overlapping one). */
interface SharedFolder {
  spec: SyncFolderSpec;
  owner: HostedRun;
  ownerFolder: SyncFolderSpec;
}

interface HostedRun {
  readonly start: RunStartMsg;
  readonly scope: string;
  /** `syncing`: waiting for the down push; `starting`: binary and files being prepared. */
  phase: "syncing" | "starting" | "running" | "exited";
  /** The run's down push asked for its folders: from now on other runs leave them alone. */
  claimed: boolean;
  /** Folders this run uses but another run claimed first (excluded from its down push). */
  shared: SharedFolder[];
  /** Settles once the run's down push was applied (or the run ended without one). */
  downSynced: PromiseWithResolvers<void>;
  transport: RpcTransport | null;
  /** Output goes to the current channel; false from a disconnect until the primary's `run.resume`. */
  live: boolean;
  startedSent: boolean;
  /** Last stdout chunk sequence number produced. */
  outSeq: number;
  /** stdout of the current tick, sent as one `run.out`. */
  pending: string;
  flushScheduled: boolean;
  /** Recent `run.out` chunks (consecutive seqs, at most RUN_OUTPUT_BUFFER_BYTES) for replay. */
  chunks: OutChunk[];
  chunkBytes: number;
  stderrTail: string;
  /** Last stdin chunk sequence number received in order. */
  inSeq: number;
  /** stdin chunks received ahead of a gap, by seq. */
  inbox: Map<number, string>;
  /** In-order stdin received before omp started. */
  backlog: string[];
  stdinEnded: boolean;
  exit: ExitInfo | null;
  /** Overrides the exit's own error (output buffer overflow). */
  failure: string | null;
  /** Killed by the primary (`run.kill`) or the host shut down: nothing is reported any more. */
  forgotten: boolean;
  syncTimer: NodeJS.Timeout | undefined;
  /** The latest upstream push in flight. */
  pushing: Promise<string | null> | null;
  finishing: boolean;
}

interface HostSession {
  channel: ClusterChannel;
  endpoint: SyncEndpoint;
  dispose(): void;
}

/** Hosts the runs of this node; see runHost(). */
export class RunHost {
  /** Upstream sync baselines of every hosted run; outlive channels so reconnects diff from the last sync. */
  readonly baselines = new SyncBaselines();
  private readonly runs = new Map<string, HostedRun>();
  private session: HostSession | null = null;
  /** Context of the latest primary (kept across disconnects for runs still being prepared). */
  private context: RunHostContext | null = null;

  constructor() {
    // A run must never outlive the server that reports it.
    process.on("exit", () => this.killAll("SIGTERM"));
  }

  /** Serve `run.*` messages and `run:` sync scopes of a freshly welcomed member channel. */
  attach(channel: ClusterChannel, endpoint: SyncEndpoint, context: RunHostContext): void {
    this.detach();
    this.context = context;
    const offRun = channel.on("run.", (msg) => this.handle(msg));
    const offSync = endpoint.receive(SCOPE_PREFIX, {
      folders: (scope) => {
        const run = this.runs.get(scope.slice(SCOPE_PREFIX.length));
        if (!run || run.forgotten || run.phase === "exited") return null;
        if (!run.claimed) {
          run.claimed = true;
          run.shared = this.sharedFolders(run);
        }
        const excluded = new Set(run.shared.map((shared) => shared.spec.id));
        return run.start.folders.filter((folder) => !excluded.has(folder.id));
      },
      onApplied: (scope) => {
        const run = this.runs.get(scope.slice(SCOPE_PREFIX.length));
        if (run?.phase === "syncing") void this.launch(run);
      },
    });
    this.session = {
      channel,
      endpoint,
      dispose: () => {
        offRun();
        offSync();
      },
    };
  }

  /** The channel is gone: runs keep going and buffer their output until `run.resume`. */
  detach(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.dispose();
    for (const run of this.runs.values()) {
      run.live = false;
      if (run.phase === "syncing") {
        this.exited(run, { code: null, signal: null, error: "The connection to the primary was lost before omp started" });
      }
    }
  }

  /** Kill every hosted run and forget it (the node leaves the replica role). */
  shutdown(): void {
    this.detach();
    this.killAll("SIGTERM");
    for (const run of this.runs.values()) this.forget(run);
  }

  /** What `register` reports, so the primary can resume the runs. */
  states(): RemoteRunState[] {
    return [...this.runs.values()].map((run) => ({
      runKey: run.start.runKey,
      outSeq: run.outSeq,
      inSeq: run.inSeq,
      alive: run.phase !== "exited",
    }));
  }

  /** Runs not finished yet (they hold a slot). */
  activeCount(): number {
    let count = 0;
    for (const run of this.runs.values()) if (run.phase !== "exited") count += 1;
    return count;
  }

  /** Cards of the runs not finished yet. */
  taskIds(): string[] {
    return [...this.runs.values()].filter((run) => run.phase !== "exited").map((run) => run.start.taskId);
  }

  /** Node paths of every hosted run's folders, from its `run.start` on (replication must not overwrite them). */
  busyPaths(): Set<string> {
    const paths = new Set<string>();
    for (const run of this.runs.values()) for (const folder of run.start.folders) paths.add(folder.nodePath);
    return paths;
  }

  /** Per-run process-tree totals and stdin progress for `node.status`. */
  async usage(): Promise<NodeStatusMsg["runs"]> {
    const pids: number[] = [];
    for (const run of this.runs.values()) {
      const pid = run.phase === "running" ? run.transport?.pid : undefined;
      if (pid !== undefined) pids.push(pid);
    }
    const list = pids.length > 0 ? await listProcesses() : null;
    const totals = list ? treeTotals(list, pids) : new Map<number, { memoryBytes: number; cpuSeconds: number }>();
    const usage: NodeStatusMsg["runs"] = {};
    for (const run of this.runs.values()) {
      const pid = run.transport?.pid;
      const tree = pid === undefined ? undefined : totals.get(pid);
      usage[run.start.runKey] = {
        memoryBytes: tree?.memoryBytes ?? 0,
        cpuSeconds: tree?.cpuSeconds ?? 0,
        inSeq: run.inSeq,
      };
    }
    return usage;
  }

  private handle(msg: WireMessage): void {
    if (msg.t === "run.start") {
      this.accept(msg as RunStartMsg);
      return;
    }
    const run = typeof msg.runKey === "string" ? this.runs.get(msg.runKey) : undefined;
    switch (msg.t) {
      case "run.in":
        if (run) this.stdin(run, msg as RunInMsg);
        return;
      case "run.end":
        if (run) this.endStdin(run);
        return;
      case "run.signal":
        if (run) this.signal(run, (msg as RunSignalMsg).signal);
        return;
      case "run.kill":
        if (run) this.kill(run);
        return;
      case "run.flush":
        void this.flush(run, msg as RunFlushMsg);
        return;
      case "run.resume":
        void this.resume(run, msg as RunResumeMsg);
        return;
    }
  }

  private accept(msg: RunStartMsg): void {
    const problem = invalidStart(msg);
    if (problem) {
      this.send({ t: "run.exit", runKey: String(msg.runKey), code: null, signal: null, error: `Rejected run.start: ${problem}`, stderr: "" });
      return;
    }
    if (this.runs.has(msg.runKey)) return;
    this.runs.set(msg.runKey, {
      start: msg,
      scope: SCOPE_PREFIX + msg.runKey,
      phase: "syncing",
      claimed: false,
      shared: [],
      downSynced: Promise.withResolvers<void>(),
      transport: null,
      live: true,
      startedSent: false,
      outSeq: 0,
      pending: "",
      flushScheduled: false,
      chunks: [],
      chunkBytes: 0,
      stderrTail: "",
      inSeq: 0,
      inbox: new Map(),
      backlog: [],
      stdinEnded: false,
      exit: null,
      failure: null,
      forgotten: false,
      syncTimer: undefined,
      pushing: null,
      finishing: false,
    });
  }

  /** Folders of `run` that overlap a folder another hosted run already claimed. */
  private sharedFolders(run: HostedRun): SharedFolder[] {
    const shared: SharedFolder[] = [];
    for (const spec of run.start.folders) {
      for (const owner of this.runs.values()) {
        const ownerFolder =
          owner !== run && owner.claimed
            ? owner.start.folders.find((folder) => pathsOverlap(folder.nodePath, spec.nodePath))
            : undefined;
        if (ownerFolder) {
          shared.push({ spec, owner, ownerFolder });
          break;
        }
      }
    }
    return shared;
  }

  /**
   * The down push was applied: wait until the shared folders are in place and no replication push
   * is being applied (one begun before run.start could still delete the run's files), seed the
   * baselines of shared folders, get the binary, write the run's files and spawn omp.
   */
  private async launch(run: HostedRun): Promise<void> {
    run.phase = "starting";
    run.downSynced.resolve();
    try {
      await Promise.all(run.shared.map((shared) => shared.owner.downSynced.promise));
      await replicationIdle();
      await this.seedSharedBaselines(run);
      const command = await this.ompCommand(run.start);
      for (const file of run.start.files) {
        await mkdir(path.dirname(file.path), { recursive: true });
        await writeFile(file.path, file.content, { mode: 0o600 });
      }
      await mkdir(run.start.cwd, { recursive: true });
      if (run.phase === "starting" && !run.forgotten) this.spawn(run, command);
    } catch (err) {
      this.exited(run, { code: null, signal: null, error: `omp could not start: ${errorMessage(err)}` });
    }
  }

  /**
   * Upstream baselines of the shared folders (their down push skipped them): the owner's baseline of
   * the same folder when it has one, else the folder as it is now. Later up pushes thus still report
   * deletions.
   */
  private async seedSharedBaselines(run: HostedRun): Promise<void> {
    for (const { spec, owner, ownerFolder } of run.shared) {
      if (!spec.upstream || this.baselines.get(run.scope, spec.id)) continue;
      const sameFolder = ownerFolder.nodePath === spec.nodePath && ownerFolder.kind === spec.kind;
      const base = sameFolder ? this.baselines.get(owner.scope, ownerFolder.id) : undefined;
      this.baselines.set(run.scope, spec.id, base ? base.values() : await scanFolder(spec.nodePath, spec.kind));
    }
  }

  /**
   * The primary's binary (by checksum) when the run asks for it and it was built for this machine,
   * else `omp` from PATH (a foreign platform's binary is never downloaded or spawned).
   */
  private ompCommand(start: RunStartMsg): Promise<string> {
    const context = this.context;
    const primaryOmp = context?.omp;
    if (!start.omp || !context || primaryOmp?.platform !== process.platform || primaryOmp.arch !== process.arch) {
      return Promise.resolve("omp");
    }
    const size = primaryOmp.sha256 === start.omp.sha256 ? primaryOmp.size : 0;
    return ensureOmpBinary(context.primaryHttpUrl, { sha256: start.omp.sha256, version: start.omp.version, size });
  }

  private spawn(run: HostedRun, command: string): void {
    const { start } = run;
    const transport = spawnTransport(command, start.args, start.cwd, childEnv(start.env));
    run.transport = transport;
    transport.start({
      stdout: (data) => this.stdout(run, data),
      stdoutEnd: () => this.flushOut(run),
      stderr: (data) => this.stderr(run, data),
      exit: (info) =>
        this.exited(run, { code: info.code, signal: info.signal, error: info.error ? errorMessage(info.error) : null }),
    });
    // Spawn failures (ENOENT, …) arrive through `exit`.
    if (transport.pid === undefined) return;
    run.phase = "running";
    for (const data of run.backlog) transport.write(data);
    run.backlog = [];
    if (run.stdinEnded) transport.end();
    this.sendStarted(run);
    run.syncTimer = setInterval(() => {
      if (run.live && !run.pushing) void this.pushUp(run);
    }, RUN_SYNC_INTERVAL_MS);
  }

  private sendStarted(run: HostedRun): void {
    const pid = run.transport?.pid;
    if (run.startedSent || pid === undefined || !run.live) return;
    run.startedSent = this.send({ t: "run.started", runKey: run.start.runKey, pid });
  }

  private stdout(run: HostedRun, data: string): void {
    if (run.failure) return;
    run.pending += data;
    if (run.flushScheduled) return;
    run.flushScheduled = true;
    setImmediate(() => {
      run.flushScheduled = false;
      this.flushOut(run);
    });
  }

  /** Turn the tick's stdout into one numbered chunk: buffered for replay, sent when live. */
  private flushOut(run: HostedRun): void {
    if (!run.pending) return;
    const data = run.pending;
    run.pending = "";
    const chunk: OutChunk = { seq: ++run.outSeq, data, bytes: Buffer.byteLength(data) };
    run.chunks.push(chunk);
    run.chunkBytes += chunk.bytes;
    if (run.live) this.send({ t: "run.out", runKey: run.start.runKey, seq: chunk.seq, data });
    this.trimOutput(run);
  }

  /** Keep the buffer bounded; dropping output the primary may not have seen kills the run. */
  private trimOutput(run: HostedRun): void {
    while (run.chunkBytes > RUN_OUTPUT_BUFFER_BYTES && run.chunks.length > 1) {
      const dropped = run.chunks.shift();
      if (!dropped) return;
      run.chunkBytes -= dropped.bytes;
      if (!run.live) {
        this.overflow(run);
        return;
      }
    }
  }

  private overflow(run: HostedRun): void {
    if (run.failure) return;
    run.failure = OVERFLOW_ERROR;
    run.pending = "";
    run.transport?.signal("SIGKILL");
  }

  private stderr(run: HostedRun, data: string): void {
    run.stderrTail = (run.stderrTail + data).slice(-STDERR_LIMIT);
    if (run.live) this.send({ t: "run.err", runKey: run.start.runKey, data });
  }

  /** Apply stdin in seq order; duplicates (resent after a reconnect) are ignored. */
  private stdin(run: HostedRun, msg: RunInMsg): void {
    if (!Number.isInteger(msg.seq) || typeof msg.data !== "string" || msg.seq <= run.inSeq) return;
    run.inbox.set(msg.seq, msg.data);
    for (let data = run.inbox.get(run.inSeq + 1); data !== undefined; data = run.inbox.get(run.inSeq + 1)) {
      run.inbox.delete(run.inSeq + 1);
      run.inSeq += 1;
      if (run.transport) run.transport.write(data);
      else run.backlog.push(data);
    }
  }

  private endStdin(run: HostedRun): void {
    run.stdinEnded = true;
    run.transport?.end();
  }

  private signal(run: HostedRun, signal: unknown): void {
    if (typeof signal !== "string" || !Object.hasOwn(osConstants.signals, signal)) return;
    if (run.transport) run.transport.signal(signal as NodeJS.Signals);
    else if (run.phase !== "exited") this.exited(run, { code: null, signal, error: null });
  }

  private kill(run: HostedRun): void {
    run.forgotten = true;
    run.transport?.signal("SIGKILL");
    this.forget(run);
  }

  private killAll(signal: NodeJS.Signals): void {
    for (const run of this.runs.values()) {
      run.forgotten = true;
      run.transport?.signal(signal);
    }
  }

  private forget(run: HostedRun): void {
    clearInterval(run.syncTimer);
    if (this.runs.get(run.start.runKey) === run) this.runs.delete(run.start.runKey);
    this.session?.endpoint.dropScope(run.scope);
  }

  /** omp exited (or never started): report it now, or after the primary resumed the run. */
  private exited(run: HostedRun, exit: ExitInfo): void {
    if (run.exit) return;
    this.flushOut(run);
    run.exit = exit;
    run.downSynced.resolve();
    run.phase = "exited";
    clearInterval(run.syncTimer);
    if (!run.forgotten && run.live) void this.finish(run);
  }

  /** Final upstream push, then `run.exit`; a disconnect meanwhile defers the report to the resume. */
  private async finish(run: HostedRun): Promise<void> {
    const exit = run.exit;
    if (run.finishing || !exit) return;
    run.finishing = true;
    const pushError = run.transport?.pid === undefined ? null : await this.pushUp(run);
    run.finishing = false;
    if (!run.live || run.forgotten) return;
    const syncError = pushError ? `Syncing the run's files back failed: ${pushError}` : null;
    this.send({
      t: "run.exit",
      runKey: run.start.runKey,
      code: exit.code,
      signal: exit.signal,
      error: run.failure ?? exit.error ?? syncError,
      stderr: run.stderrTail,
    });
    this.forget(run);
  }

  /** Push the run's upstream folders (raw node paths: the primary rewrites pointers). Resolves with the error, if any. */
  private async pushUp(run: HostedRun): Promise<string | null> {
    const session = this.session;
    const upstream = run.start.folders.filter((folder) => folder.upstream);
    if (!session || !run.live || upstream.length === 0) return null;
    const push = session.endpoint.push(run.scope, upstream, PathMap.identity()).then(
      () => null,
      (err: unknown) => errorMessage(err),
    );
    run.pushing = push;
    const error = await push;
    if (run.pushing === push) run.pushing = null;
    return error;
  }

  private async flush(run: HostedRun | undefined, msg: RunFlushMsg): Promise<void> {
    const channel = this.session?.channel;
    if (run?.transport?.pid !== undefined && run.phase !== "exited") {
      const error = await this.pushUp(run);
      if (error) console.warn(`[cluster] upstream sync of ${run.scope} failed: ${error}`);
    }
    channel?.reply(msg, { t: "run.flushed", runKey: msg.runKey });
  }

  /** After a reconnect: replay stdout after `outSeq`, then stream live again (and report a pending exit). */
  private async resume(run: HostedRun | undefined, msg: RunResumeMsg): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (!run) {
      this.send({
        t: "run.exit",
        runKey: String(msg.runKey),
        code: null,
        signal: null,
        error: "The run is no longer hosted on this node",
        stderr: "",
      });
      return;
    }
    run.live = false;
    let next = (Number.isInteger(msg.outSeq) ? msg.outSeq : 0) + 1;
    while (next <= run.outSeq) {
      const first = run.chunks[0];
      const chunk = first ? run.chunks[next - first.seq] : undefined;
      if (!chunk) {
        // Output the primary never got was dropped: the stream cannot be continued.
        this.overflow(run);
        break;
      }
      session.channel.send({ t: "run.out", runKey: run.start.runKey, seq: chunk.seq, data: chunk.data });
      next += 1;
      await session.channel.drain();
      if (this.session !== session || run.forgotten) return;
    }
    run.live = true;
    this.sendStarted(run);
    if (run.exit) void this.finish(run);
  }

  private send(msg: WireMessage): boolean {
    return this.session?.channel.send(msg) ?? false;
  }
}

/** Why a run.start cannot be accepted, or null. Every path must stay inside DATA_DIR/cluster. */
function invalidStart(msg: RunStartMsg): string | null {
  if (typeof msg.runKey !== "string" || !RUN_KEY_PATTERN.test(msg.runKey)) return "invalid runKey";
  if (typeof msg.taskId !== "string") return "invalid taskId";
  if (!Array.isArray(msg.args) || !msg.args.every((arg) => typeof arg === "string")) return "invalid args";
  if (!isStringRecord(msg.env)) return "invalid env";
  if (!insideClusterDir(msg.cwd)) return "cwd outside the cluster directory";
  if (!Array.isArray(msg.files) || !msg.files.every((f) => insideClusterDir(f?.path) && typeof f.content === "string")) {
    return "invalid files";
  }
  if (!Array.isArray(msg.folders) || !msg.folders.every(validFolder)) return "invalid folders";
  const omp = msg.omp;
  if (omp !== null && !(omp && SHA256_PATTERN.test(String(omp.sha256)) && typeof omp.version === "string")) {
    return "invalid omp binary";
  }
  return null;
}

function validFolder(folder: SyncFolderSpec): boolean {
  return (
    typeof folder?.id === "string" &&
    insideClusterDir(folder.nodePath) &&
    typeof folder.primaryPath === "string" &&
    (folder.kind === "tree" || folder.kind === "raw") &&
    typeof folder.upstream === "boolean"
  );
}

/** One path equals or contains the other. */
function pathsOverlap(a: string, b: string): boolean {
  const relative = path.relative(a, b);
  const inside = (rel: string) => rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  return inside(relative) || inside(path.relative(b, a));
}

function insideClusterDir(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\0") || !path.isAbsolute(value)) return false;
  const relative = path.relative(clusterDir(), path.resolve(value));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

const g = globalThis as unknown as { __ompUiRunHost?: RunHost };

/** The process-wide run host (survives dev hot reloads and member reconnects). */
export function runHost(): RunHost {
  return (g.__ompUiRunHost ??= new RunHost());
}
