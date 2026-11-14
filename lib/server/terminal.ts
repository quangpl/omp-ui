// The persistent `/terminal` session (contract in lib/terminal-types.ts): tmux-like, in-process.
//
// Every command is a detached shell (own process group, setsid) whose stdout and stderr go straight
// to `DATA_DIR/terminal/<id>.log`, so it keeps running and logging when the browser leaves and even
// across an app restart. A wrapper trap writes the final `pwd` to `<id>.cwd` and the exit status to
// `<id>.exit`. The server only watches those files: it tails the logs of running blocks to its SSE
// subscribers and finalizes a block once its exit file appears (or the process is gone). Block
// metadata lives in `session.json`; a restarted server reloads it and resumes watching.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { childEnv } from "@/lib/child-env";
import { dataDir } from "@/lib/files";
import { HttpError } from "@/lib/server/http";
import { mcpAgentEnv } from "@/lib/server/mcp-env";
import {
  TERMINAL_MAX_BLOCKS,
  TERMINAL_MAX_COMMAND_LENGTH,
  TERMINAL_MAX_OUTPUT_BYTES,
  TERMINAL_MAX_RUNNING,
  TERMINAL_REPLAY_BYTES,
  TERMINAL_TIMEOUT_MS,
  type TerminalBlock,
  type TerminalSnapshot,
  type TerminalStreamEvent,
} from "@/lib/terminal-types";

const SHELL = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

/** Delay between SIGTERM and SIGKILL when stopping a command's process group. */
const KILL_GRACE_MS = 2_000;
/** How often running blocks' logs and exit files are checked. */
const WATCH_INTERVAL_MS = 150;
/** Log bytes read (and sent) per block per tick, so a flood of output can't stall the server. */
const READ_PER_TICK = 1024 * 1024;
const READ_CHUNK = 256 * 1024;

/**
 * Runs as `sh -c SCRIPT omp-terminal <command> <cwd file> <exit file>`. The command is `eval`ed in
 * the shell itself (not a subshell), so `cd`, `export` and `exit N` behave as typed, and comments,
 * unbalanced quotes or a trailing `\` cannot swallow anything after it. `set --` hides the wrapper's
 * arguments from the command. The EXIT trap also runs on `exit N`; it captures `$?` first, writes the
 * cwd, then the exit file last via tmp + mv, so an existing exit file means both are complete.
 * HUP/INT/TERM are trapped so a killed shell reports the signal (`SIGTERM`) rather than the stale
 * `$?` bash would otherwise leave for the EXIT trap. SIGKILL leaves no exit file.
 */
const SCRIPT = [
  "__omp_cmd=$1; __omp_cwdf=$2; __omp_exitf=$3; __omp_sig=; set --",
  "trap '__omp_code=$?; trap - EXIT; " +
    '[ -n "$__omp_sig" ] && __omp_res=SIG$__omp_sig || __omp_res=$__omp_code; ' +
    'pwd >"$__omp_cwdf" 2>/dev/null; ' +
    'echo "$__omp_res" >"$__omp_exitf.tmp" 2>/dev/null && mv -f "$__omp_exitf.tmp" "$__omp_exitf"; ' +
    "exit \"$__omp_code\"' EXIT",
  "trap '__omp_sig=HUP; exit 129' HUP",
  "trap '__omp_sig=INT; exit 130' INT",
  "trap '__omp_sig=TERM; exit 143' TERM",
  'eval "$__omp_cmd"',
].join("\n");

export interface TerminalSessionOptions {
  /** Storage directory (default `DATA_DIR/terminal`). */
  dir?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

type Listener = (event: TerminalStreamEvent) => void;

/** Runtime state of a running block. `block.outputBytes` is the log offset already sent. */
interface Watch {
  block: TerminalBlock;
  /** Our own child (null after a restart). */
  child: ChildProcess | null;
  /** The child's `exit` event, when it fired. */
  exit: { code: number | null; signal: string | null; at: number } | null;
  killing: boolean;
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function homeDir(): string {
  try {
    return os.homedir();
  } catch {
    // No HOME and no passwd entry for the current uid.
    return "";
  }
}

/** The server user's home, or the server's cwd when there is none. */
function defaultCwd(): string {
  const home = homeDir();
  return home && isDirectory(home) ? home : process.cwd();
}

/** Signal a whole process group; a group that is already gone (ESRCH) is fine. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Length of the longest prefix of `buf[0, len)` that does not end inside a UTF-8 character. */
function utf8Boundary(buf: Buffer, len: number): number {
  for (let i = len - 1; i >= Math.max(0, len - 4); i--) {
    const byte = buf[i];
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf8 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return i + need > len ? i : len;
  }
  return len;
}

/** Sortable by start time: base-36 epoch ms (fixed width) plus a random suffix. */
function newBlockId(): string {
  return Date.now().toString(36).padStart(9, "0") + Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

function isBlock(value: unknown): value is TerminalBlock {
  const block = value as TerminalBlock | null;
  return (
    !!block &&
    typeof block === "object" &&
    typeof block.id === "string" &&
    /^[a-z0-9]+$/.test(block.id) &&
    typeof block.command === "string" &&
    typeof block.cwd === "string" &&
    typeof block.startedAt === "number" &&
    (block.status === "running" || block.status === "done")
  );
}

export class TerminalSession {
  private readonly dir: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private cwd: string;
  private blocks: TerminalBlock[] = [];
  private readonly watches = new Map<string, Watch>();
  private readonly listeners = new Set<Listener>();
  private readonly buffer = Buffer.allocUnsafe(READ_CHUNK);
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(opts: TerminalSessionOptions = {}) {
    this.dir = opts.dir ?? path.join(dataDir(), "terminal");
    this.timeoutMs = opts.timeoutMs ?? TERMINAL_TIMEOUT_MS;
    this.maxOutputBytes = opts.maxOutputBytes ?? TERMINAL_MAX_OUTPUT_BYTES;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });

    let saved: { cwd?: unknown; blocks?: unknown } = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file("session.json"), "utf8")) ?? {};
    } catch {
      // First start, or an unreadable file: start empty.
    }
    this.cwd = typeof saved.cwd === "string" && path.isAbsolute(saved.cwd) ? saved.cwd : defaultCwd();
    this.blocks = Array.isArray(saved.blocks) ? saved.blocks.filter(isBlock) : [];
    for (const block of this.blocks) {
      if (block.status !== "running") continue;
      // Resume where the previous server stopped sending; the snapshot replays up to there.
      let size = 0;
      try {
        size = fs.statSync(this.file(`${block.id}.log`)).size;
      } catch {}
      block.outputBytes = Math.min(block.outputBytes || 0, size);
      this.watches.set(block.id, { block, child: null, exit: null, killing: false });
    }
    if (this.watches.size) {
      // Finalize blocks that ended while the server was down before anyone reads the session.
      this.tick();
      this.startTimer();
    }
  }

  /** Current state, with output replayed exactly up to what live `output` events continue from. */
  snapshot(): TerminalSnapshot {
    const output: Record<string, string> = {};
    const skipped: Record<string, number> = {};
    for (const block of this.blocks) {
      const end = block.outputBytes;
      let start = Math.max(0, end - TERMINAL_REPLAY_BYTES);
      let text = "";
      if (end > start) {
        const buf = Buffer.alloc(end - start);
        let read = 0;
        try {
          const fd = fs.openSync(this.file(`${block.id}.log`), "r");
          try {
            while (read < buf.length) {
              const n = fs.readSync(fd, buf, read, buf.length - read, start + read);
              if (n <= 0) break;
              read += n;
            }
          } finally {
            fs.closeSync(fd);
          }
        } catch {}
        // A cut inside a multi-byte character advances to the next character.
        let from = 0;
        while (start > 0 && from < 3 && from < read && (buf[from] & 0xc0) === 0x80) from++;
        start += from;
        text = buf.toString("utf8", from, read);
      }
      output[block.id] = text;
      if (start > 0) skipped[block.id] = start;
    }
    return { cwd: this.cwd, home: homeDir(), blocks: this.blocks.map((b) => ({ ...b })), output, skipped };
  }

  /** Live events. Call right after `snapshot()` in the same tick so no output is lost or repeated. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start `command` in `cwd` (default: the session cwd) and return its running block. */
  async execute(command: string, cwd?: string): Promise<TerminalBlock> {
    // Users run omp here too: the MCP secrets resolve the `${OMPUI_MCP_…}` placeholders in mcp.json.
    // Awaited first, so the checks and registration below stay in one tick.
    const mcpEnv = await mcpAgentEnv();
    if (!command.trim()) throw new HttpError(400, "command is required");
    if (command.length > TERMINAL_MAX_COMMAND_LENGTH) {
      throw new HttpError(400, `command is longer than ${TERMINAL_MAX_COMMAND_LENGTH} characters`);
    }
    let dir: string;
    if (cwd) {
      if (!path.isAbsolute(cwd) || !isDirectory(cwd)) throw new HttpError(400, `Directory not found: ${cwd}`);
      dir = path.normalize(cwd);
    } else {
      dir = isDirectory(this.cwd) ? this.cwd : defaultCwd();
    }
    if (this.watches.size >= TERMINAL_MAX_RUNNING) {
      throw new HttpError(429, `At most ${TERMINAL_MAX_RUNNING} commands can run at once`);
    }

    const id = newBlockId();
    const block: TerminalBlock = {
      id,
      command,
      cwd: dir,
      startedAt: Date.now(),
      pid: null,
      status: "running",
      exitCode: null,
      signal: null,
      durationMs: null,
      timedOut: false,
      truncated: false,
      cancelled: false,
      outputBytes: 0,
      endCwd: null,
    };
    const watch: Watch = { block, child: null, exit: null, killing: false };
    let spawnError: string | null = null;
    let logFd: number | null = null;
    try {
      logFd = fs.openSync(this.file(`${id}.log`), "a", 0o600);
      const child = spawn(
        SHELL,
        ["-c", SCRIPT, "omp-terminal", command, this.file(`${id}.cwd`), this.file(`${id}.exit`)],
        {
          cwd: dir,
          // PWD keeps the directory as given (symlinks unresolved), so `pwd` reports it the same way.
          env: childEnv({
            ...mcpEnv,
            TERM: "xterm-256color",
            COLUMNS: "120",
            PAGER: "cat",
            GIT_PAGER: "cat",
            PWD: dir,
          }),
          // Straight to the log file: no pipe ties the command to this server process.
          stdio: ["ignore", logFd, logFd],
          // Own process group (setsid): `kill(-pid)` reaches the shell and everything it started, and
          // signals sent to the server's group (Ctrl+C, shutdown) don't reach it.
          detached: true,
        },
      );
      watch.child = child;
      block.pid = child.pid ?? null;
      child.on("error", (err) => {
        // Only a failed spawn ends the block here; later errors (a failed kill) are irrelevant.
        if (block.pid === null && this.watches.get(id) === watch) this.finish(watch, err.message);
      });
      child.on("exit", (code, signal) => {
        watch.exit = { code, signal, at: Date.now() };
        if (!this.disposed) setImmediate(() => this.tick());
      });
      // The server may exit (or restart) while the command runs.
      child.unref();
    } catch (err) {
      spawnError = err instanceof Error ? err.message : String(err);
    } finally {
      if (logFd !== null) fs.closeSync(logFd);
    }

    this.blocks.push(block);
    this.watches.set(id, watch);
    if (spawnError) {
      this.finish(watch, spawnError);
    } else {
      this.persist();
      this.emitBlock(block);
      this.startTimer();
    }
    return { ...block };
  }

  /** Kill a running block's process group; its completion arrives through the watcher. */
  cancel(id: string): void {
    if (!this.blocks.some((b) => b.id === id)) throw new HttpError(404, "Command not found");
    const watch = this.watches.get(id);
    if (!watch) return;
    if (!watch.block.cancelled) {
      watch.block.cancelled = true;
      this.persist();
      this.emitBlock(watch.block);
    }
    this.kill(watch);
  }

  /** Drop finished blocks and their files; running blocks stay. Sends everyone a fresh snapshot. */
  clear(): void {
    const finished = this.blocks.filter((b) => b.status !== "running");
    this.blocks = this.blocks.filter((b) => b.status === "running");
    for (const block of finished) this.removeFiles(block.id);
    this.persist();
    if (this.listeners.size) this.emit({ type: "snapshot", snapshot: this.snapshot() });
  }

  /** Stop watching and notifying (tests). Commands keep running, as on a server exit. */
  dispose(): void {
    this.disposed = true;
    this.stopTimer();
    this.listeners.clear();
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  private startTimer(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => this.tick(), WATCH_INTERVAL_MS);
    this.timer.unref();
  }

  private stopTimer(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    if (this.disposed) return;
    const now = Date.now();
    for (const watch of [...this.watches.values()]) {
      const { block } = watch;
      // Checked before reading, so the final read gets everything the shell wrote.
      const ended =
        watch.exit !== null ||
        fs.existsSync(this.file(`${block.id}.exit`)) ||
        (watch.child === null && !pidAlive(block.pid));
      this.pump(watch, ended);
      if (ended) {
        this.finish(watch);
      } else if (!watch.killing && now - block.startedAt > this.timeoutMs) {
        block.timedOut = true;
        this.kill(watch);
        this.persist();
        this.emitBlock(block);
      }
    }
    if (!this.watches.size) this.stopTimer();
  }

  /**
   * Send the log bytes written since the last read, cut at a UTF-8 character boundary (the rest is
   * read again next time) unless `final`. Past `maxOutputBytes` the block is truncated and killed.
   */
  private pump(watch: Watch, final: boolean): void {
    const { block } = watch;
    let fd: number;
    try {
      fd = fs.openSync(this.file(`${block.id}.log`), "r");
    } catch {
      return;
    }
    try {
      const size = fs.fstatSync(fd).size;
      const over = size > this.maxOutputBytes;
      const limit = Math.min(size, this.maxOutputBytes);
      let budget = final ? Number.POSITIVE_INFINITY : READ_PER_TICK;
      while (block.outputBytes < limit && budget > 0) {
        const want = Math.min(this.buffer.length, limit - block.outputBytes);
        const read = fs.readSync(fd, this.buffer, 0, want, block.outputBytes);
        if (read <= 0) break;
        const last = block.outputBytes + read >= limit;
        const end = last && final && !over ? read : utf8Boundary(this.buffer, read);
        if (end === 0) break;
        const data = this.buffer.toString("utf8", 0, end);
        block.outputBytes += end;
        budget -= end;
        this.emit({ type: "output", id: block.id, data });
      }
      if (over && !block.truncated) {
        block.truncated = true;
        this.kill(watch);
        this.persist();
        this.emitBlock(block);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Mark a block done from its exit/cwd files and the child's exit event, then persist and notify. */
  private finish(watch: Watch, spawnError?: string): void {
    const { block } = watch;
    this.watches.delete(block.id);
    const exitFile = this.file(`${block.id}.exit`);
    const status = readText(exitFile)?.trim() ?? "";
    let endedAt = watch.exit?.at ?? null;
    if (status) {
      try {
        endedAt ??= fs.statSync(exitFile).mtimeMs;
      } catch {}
    }
    if (/^\d+$/.test(status)) {
      block.exitCode = Number(status);
      block.signal = watch.exit?.signal ?? null;
    } else if (/^SIG[A-Z]+$/.test(status)) {
      block.exitCode = null;
      block.signal = status;
    } else if (watch.exit) {
      block.exitCode = watch.exit.code;
      block.signal = watch.exit.signal;
    } else {
      block.exitCode = null;
      block.signal = null;
      // Killed on purpose (SIGKILL leaves no report) is explained by the flags; anything else vanished.
      if (!spawnError && !block.cancelled && !block.timedOut && !block.truncated) block.error = "lost";
    }
    if (spawnError) block.error = spawnError;
    const endCwd = readText(this.file(`${block.id}.cwd`))?.replace(/\n$/, "") ?? "";
    block.endCwd = endCwd && path.isAbsolute(endCwd) ? endCwd : null;
    block.status = "done";
    block.durationMs = Math.max(0, Math.round((endedAt ?? Date.now()) - block.startedAt));
    if (block.endCwd) this.cwd = block.endCwd;
    this.prune();
    this.persist();
    this.emitBlock(block);
  }

  /** Keep at most TERMINAL_MAX_BLOCKS finished blocks; the oldest go with their files. */
  private prune(): void {
    let excess = this.blocks.filter((b) => b.status === "done").length - TERMINAL_MAX_BLOCKS;
    if (excess <= 0) return;
    this.blocks = this.blocks.filter((b) => {
      if (excess <= 0 || b.status !== "done") return true;
      excess--;
      this.removeFiles(b.id);
      return false;
    });
  }

  private kill(watch: Watch): void {
    const pid = watch.block.pid;
    if (watch.killing || pid === null) return;
    watch.killing = true;
    if (!signalGroup(pid, "SIGTERM")) return;
    setTimeout(() => {
      if (signalGroup(pid, 0)) signalGroup(pid, "SIGKILL");
    }, KILL_GRACE_MS).unref();
  }

  private removeFiles(id: string): void {
    for (const ext of ["log", "exit", "exit.tmp", "cwd"]) {
      fs.rmSync(this.file(`${id}.${ext}`), { force: true });
    }
  }

  /** session.json via tmp + rename, so a crash never leaves it half-written. */
  private persist(): void {
    if (this.disposed) return;
    const file = this.file("session.json");
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ cwd: this.cwd, blocks: this.blocks }), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
      console.error("[terminal] saving the session failed:", err);
    }
  }

  private emitBlock(block: TerminalBlock): void {
    this.emit({ type: "block", block: { ...block }, cwd: this.cwd });
  }

  private emit(event: TerminalStreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[terminal] listener failed:", err);
      }
    }
  }
}

const g = globalThis as unknown as {
  __ompUiTerminal?: TerminalSession;
  __ompUiTerminalOptions?: TerminalSessionOptions;
};

/** The server-wide session, loaded from disk on first use. Kept on globalThis to survive HMR. */
export function getTerminalSession(): TerminalSession {
  g.__ompUiTerminal ??= new TerminalSession(g.__ompUiTerminalOptions);
  return g.__ompUiTerminal;
}

/**
 * Tests: drop the in-memory session (its commands keep running, like an app restart); the next
 * `getTerminalSession()` loads `opts.dir` (default `DATA_DIR/terminal`) with the given limits.
 */
export function resetTerminalSessionForTests(opts: TerminalSessionOptions = {}): void {
  g.__ompUiTerminal?.dispose();
  g.__ompUiTerminal = undefined;
  g.__ompUiTerminalOptions = opts;
}
