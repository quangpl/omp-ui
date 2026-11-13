// Wire contract of the persistent terminal session (client-safe: no Node imports).
//
// tmux-like semantics: one server-wide session of command blocks. A command keeps running when the
// browser leaves (it is spawned detached with its output written straight to a log file under
// DATA_DIR/terminal/, so it even survives an app restart); revisiting /terminal re-attaches and
// replays every block. stdout and stderr share one log, interleaved exactly as written.
//
// Endpoints (all under /api/v1/terminal, auth required):
//   GET    /stream            SSE. Unnamed `message` frames carry a JSON `TerminalStreamEvent`;
//                             a named `ping` event (empty data) every TERMINAL_PING_INTERVAL_MS.
//                             The first frame of every connection is a `snapshot`.
//   POST   /execute           body TerminalExecuteRequest → 201 TerminalBlock (status "running").
//                             400 bad command/cwd; 429 when TERMINAL_MAX_RUNNING are running.
//   POST   /cancel            body { id } → { ok: true }. Kills the block's process group
//                             (SIGTERM, SIGKILL after 2 s). 404 unknown id; finished → { ok: true }.
//   DELETE /session           Clears finished blocks (and their logs) → { ok: true }.
//                             Running blocks stay. Broadcasts a fresh `snapshot`.

/** `cwd` must be an absolute existing directory; omitted → the session cwd. */
export interface TerminalExecuteRequest {
  command: string;
  cwd?: string;
}

export interface TerminalBlock {
  /** Unique, sortable by start time. */
  id: string;
  command: string;
  /** Directory the command started in. */
  cwd: string;
  /** Epoch ms. */
  startedAt: number;
  pid: number | null;
  status: "running" | "done";
  /** Set once done: process exit code; null when killed by a signal, lost, or never started. */
  exitCode: number | null;
  signal: string | null;
  /** Set once done. */
  durationMs: number | null;
  /** Killed after TERMINAL_TIMEOUT_MS. */
  timedOut: boolean;
  /** Log exceeded TERMINAL_MAX_OUTPUT_BYTES: the process was killed and the rest is not served. */
  truncated: boolean;
  /** Killed through POST /cancel. */
  cancelled: boolean;
  /** Bytes in the block's log so far (capped at TERMINAL_MAX_OUTPUT_BYTES). */
  outputBytes: number;
  /** Working directory after the command ran (follows `cd`); null while running or unknown. */
  endCwd: string | null;
  /** Spawn failure, or "lost" when the process vanished without reporting an exit code. */
  error?: string;
}

export interface TerminalSnapshot {
  /** Session working directory: where a command without `cwd` starts. */
  cwd: string;
  /** Server user's home directory (for `~` abbreviation). */
  home: string;
  /** Oldest first. */
  blocks: TerminalBlock[];
  /** Block id → its output so far (at most the last TERMINAL_REPLAY_BYTES of it). */
  output: Record<string, string>;
  /** Block id → bytes dropped from the start of `output[id]` by the replay cap (absent = none). */
  skipped: Record<string, number>;
}

export type TerminalStreamEvent =
  | { type: "snapshot"; snapshot: TerminalSnapshot }
  /** A block was added or changed (started, finished, cancelled). Upsert by id. */
  | { type: "block"; block: TerminalBlock; cwd: string }
  /** New output of a block, appended in order. */
  | { type: "output"; id: string; data: string };

export const TERMINAL_TIMEOUT_MS = 6 * 60 * 60_000;
export const TERMINAL_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const TERMINAL_REPLAY_BYTES = 512 * 1024;
export const TERMINAL_MAX_COMMAND_LENGTH = 16_384;
export const TERMINAL_MAX_RUNNING = 8;
/** Finished blocks kept (oldest pruned with their logs). */
export const TERMINAL_MAX_BLOCKS = 100;
export const TERMINAL_PING_INTERVAL_MS = 15_000;
