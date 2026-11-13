// Shared domain types. Used by DB drivers, API routes, agent runner, web UI,
// and (later) mobile clients. All timestamps are ISO-8601 strings; all ids are strings.

export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

/** Lifecycle of the omp agent attached to a task. */
export type AgentState = "idle" | "queued" | "running" | "error";

/** A board is one project. A project has a primary folder plus optional extra folders. */
export interface Board {
  id: string;
  name: string;
  /** Primary project folder (absolute); omp runs here (`omp --cwd <workdir>`). */
  workdir: string;
  /**
   * Additional absolute folders that belong to the project (e.g. frontend + backend repos).
   * Passed to omp as repeated `--add-dir <folder>`. Never contains `workdir`. Default [].
   */
  extraFolders: string[];
  /** Optional omp model selector (`--model`), e.g. "sonnet" or "anthropic/claude-sonnet-4-5". */
  model: string | null;
  /** When true, moving a card into "In progress" starts the agent automatically. */
  autoRun: boolean;
  /**
   * Dedicated workspaces: each card's agent works in its own git worktree of every project
   * folder that is a git repository (branch `omp/<card>`), so parallel cards never share a
   * working tree. Non-git folders stay shared. Default false.
   */
  worktrees: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BoardWithCounts extends Board {
  counts: Record<TaskStatus, number>;
  runningCount: number;
}

export interface Task {
  id: string;
  boardId: string;
  title: string;
  description: string;
  status: TaskStatus;
  /** Sort key inside its column (ascending). Fractional values allowed. */
  position: number;
  agentState: AgentState;
  agentError: string | null;
  /**
   * Question(s) the agent asked the user in its last run summary. Set when a run succeeds,
   * cleared when the next run starts or the user dismisses it (PATCH question: null).
   */
  question: string | null;
  /** omp session JSONL path; reused with `--resume` so feedback keeps context. */
  sessionFile: string | null;
  lastRunId: string | null;
  /**
   * Task queue dependencies: ids of cards on the same board that must be Done before this
   * card's agent starts. While any is not Done, a queued run waits. Default [].
   */
  blockedBy: string[];
  /** Card whose agent created this card (agent-to-agent delegation); null when a person did. */
  createdByTaskId: string | null;
  /**
   * When "Push to main" last landed this card's changes on the default branch; null if never.
   * Cards with it set show a struck-through title.
   */
  pushedAt: string | null;
  /**
   * Automatic retries used since the card's last successful run or manual start (Run, feedback).
   * A run that fails, or is interrupted by a server restart, is retried while this is below
   * `AppSettings.maxAutoRetries`.
   */
  autoRetries: number;
  /** When the next automatic retry of a failed run starts; null when none is scheduled. */
  retryAt: string | null;
  /**
   * The agent's todo list (omp `todo` tool), as of its latest update; replaced on every update
   * and kept after the run ends. [] when the agent never kept one.
   */
  todos: TodoPhase[];
  createdAt: string;
  updatedAt: string;
  /** Derived: total comments. */
  commentCount: number;
  /** Derived: unresolved user comments (pending feedback). */
  openCommentCount: number;
}

export type TodoItemStatus = "pending" | "in_progress" | "completed" | "abandoned";

export interface TodoItem {
  content: string;
  status: TodoItemStatus;
}

/** One phase of an agent's todo list; `name` may be "". */
export interface TodoPhase {
  name: string;
  tasks: TodoItem[];
}

export type CommentAuthor = "user" | "agent";

export interface Comment {
  id: string;
  taskId: string;
  author: CommentAuthor;
  body: string;
  resolved: boolean;
  resolvedAt: string | null;
  /** Run that addressed this feedback. */
  resolvedByRunId: string | null;
  /**
   * Agent-to-agent message: id of the card whose agent sent this comment. Such comments have
   * `author: "user"` (they are feedback the receiving agent must address). Null otherwise.
   */
  fromTaskId: string | null;
  createdAt: string;
}

export type RunStatus = "running" | "succeeded" | "failed" | "aborted";

export interface Run {
  id: string;
  taskId: string;
  status: RunStatus;
  /** Prompt sent to omp for this run. */
  prompt: string;
  /** Final assistant text, set on success. */
  summary: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

/**
 * `agent` events carry a JSON-encoded `SubagentSnapshot` (full state of one subagent at that
 * point); the latest event per subagent id wins. `tool` events read `▸ name: detail`, plus the
 * call's intent on a second line when omp reported one apart from the detail.
 */
export type RunEventKind = "status" | "text" | "thinking" | "tool" | "error" | "agent";

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

/** A tool call a subagent made (newest first in `recentTools`). */
export interface SubagentToolCall {
  tool: string;
  /** Intent or argument summary. */
  detail?: string;
  isError?: boolean;
}

/** One subagent the run delegated work to (omp `task` tool / orchestration). */
export interface SubagentSnapshot {
  /** omp agent id (`agent://<id>`); nested subagents are dot-qualified (`Parent.Child`). */
  id: string;
  /** Agent definition: `task`, `scout`, `reviewer`… */
  agent: string;
  /** Spawn order within its batch. */
  index?: number;
  status: SubagentStatus;
  description?: string;
  /** The brief it was given (truncated). */
  task?: string;
  model?: string;
  /** What it says it is doing now. */
  intent?: string;
  /** Tool running right now. */
  currentTool?: string;
  currentToolDetail?: string;
  recentTools?: SubagentToolCall[];
  /** Last lines of its output (newest first). */
  recentOutput?: string[];
  toolCount?: number;
  requests?: number;
  tokens?: number;
  cost?: number;
  durationMs?: number;
  /** Final report (truncated). */
  output?: string;
  error?: string;
}

export interface RunEvent {
  /** Monotonic per-database integer sequence; used as the `after` cursor. */
  seq: number;
  runId: string;
  taskId: string;
  kind: RunEventKind;
  text: string;
  createdAt: string;
}

export type ApprovalMode = "yolo" | "write" | "always-ask";

export interface AppSettings {
  /**
   * Max omp processes running at once; extra runs wait in "queued". `"auto"` (default) derives
   * the limit from the machine's cores and free memory (see QueueSnapshot.concurrency).
   */
  maxConcurrentAgents: number | "auto";
  /** omp executable path or name on PATH. */
  ompPath: string;
  /** Passed as `--approval-mode`. Headless runs cannot answer prompts, so "yolo" is default. */
  approvalMode: ApprovalMode;
  /** Default `--model` when a board has none. Empty = omp default. */
  defaultModel: string;
  /**
   * When a board has no model: pick one per run from the task (omp's `smol` role for small edits,
   * `slow` for hard problems, `designer` for UI work), falling back to `defaultModel`.
   */
  autoModel: boolean;
  /**
   * Smart queue: when several cards of a project wait in the agent queue, a planner agent orders
   * them (prerequisites and quick unblockers first) and adds the "Runs after" links it finds, so
   * independent cards run in parallel and dependent ones wait for what they build on.
   */
  smartQueue: boolean;
  /** What a card's agent may do with a web browser (omp's `browser` tool). */
  browser: BrowserMode;
  /**
   * Retry failed runs automatically (resuming the omp session) with exponential backoff, and
   * resume interrupted and failed In progress cards when the server restarts.
   */
  autoRetry: boolean;
  /** Automatic retries per card before it stays failed (0-20); a success or a manual run resets the count. */
  maxAutoRetries: number;
  /** Run the AgentMan-data cleanup automatically; "off" (default) leaves it to "Clean up now". */
  cleanupSchedule: CleanupSchedule;
  /** What scheduled and manual "Clean up now" runs remove (default: every safe target). */
  cleanupTargets: ScheduledCleanupId[];
  /** Show a browser notification when a card on the open board finishes (moves to Done). Permission is per browser; the UI asks for it when turning this on. */
  taskCompletionNotifications: boolean;
}

/**
 * Browser control for agents: `off` disables omp's browser; `headless` (default) runs an
 * invisible browser; `visible` shows its window on the server's desktop; `relay` drives the
 * server user's own Chrome through omp's browser relay (`omp browser-relay`).
 */
export const BROWSER_MODES = ["off", "headless", "visible", "relay"] as const;
export type BrowserMode = (typeof BROWSER_MODES)[number];

/** How often the scheduled AgentMan-data cleanup runs (Settings → Cleanup). */
export const CLEANUP_SCHEDULES = ["off", "weekly", "monthly"] as const;
export type CleanupSchedule = (typeof CLEANUP_SCHEDULES)[number];

/** AgentMan-data cleanups a schedule may run (Docker prunes stay manual on the Maintenance page). */
export const SCHEDULED_CLEANUP_IDS = [
  "orphan-card-files",
  "orphan-board-files",
  "orphan-workspaces",
  "shipped-workspaces",
  "run-configs",
  "drafts",
  "diff-cache",
  "rotated-logs",
  "database",
] as const satisfies readonly CleanupId[];
export type ScheduledCleanupId = (typeof SCHEDULED_CLEANUP_IDS)[number];

export const DEFAULT_SETTINGS: AppSettings = {
  maxConcurrentAgents: "auto",
  ompPath: "omp",
  approvalMode: "yolo",
  defaultModel: "",
  autoModel: true,
  smartQueue: true,
  browser: "headless",
  autoRetry: true,
  maxAutoRetries: 5,
  cleanupSchedule: "off",
  // Worktrees of shipped cards may still be wanted; they are opt-in.
  cleanupTargets: SCHEDULED_CLEANUP_IDS.filter((id) => id !== "shipped-workspaces"),
  taskCompletionNotifications: false,
};

/** An installed omp skill (from `omp skill list`): pickable with "/" when composing a card. */
export interface OmpSkill {
  name: string;
  description: string;
  /** Where omp found it, e.g. "native:user" or a plugin name. */
  source: string;
}

/** One "@" mention candidate from GET /boards/:id/project-files. */
export interface ProjectFileHit {
  /** Shown in the picker, relative to its project folder; directories end with "/". */
  path: string;
  kind: "file" | "dir";
  /** Text to put after "@": relative to the board workdir, or absolute for extra folders; directories end with "/". */
  insert: string;
  /** Basename of the extra project folder holding the hit; omitted for the workdir. */
  folder?: string;
}

/** Server-sent events on GET /api/v1/events. */
export type ServerEvent =
  | { type: "board.updated"; board: Board }
  | { type: "board.deleted"; boardId: string }
  | { type: "task.updated"; task: Task }
  | { type: "task.deleted"; taskId: string; boardId: string }
  | { type: "comment.added"; comment: Comment; boardId: string }
  | { type: "comment.updated"; comment: Comment; boardId: string }
  | { type: "comment.deleted"; commentId: string; taskId: string; boardId: string }
  | { type: "run.updated"; run: Run; boardId: string }
  | { type: "run.event"; event: RunEvent; boardId: string }
  /** Files of a card (`taskId`) or the board's shared files (`taskId` null) changed. */
  | { type: "files.updated"; boardId: string; taskId: string | null }
  /**
   * The agent queue changed: running and queued task ids, queued in start order. `drafting`:
   * queued cards held while the card writer turns their free text into a title and brief.
   */
  | { type: "queue.updated"; running: string[]; queued: string[]; drafting: string[] }
  /** Live, NOT persisted: progress line of the card writer while it writes a queued card. */
  | { type: "task.activity"; taskId: string; boardId: string; text: string }
  /** Live, NOT persisted: subagent progress between its persisted `agent` events. */
  | { type: "run.agent"; runId: string; taskId: string; boardId: string; agent: SubagentSnapshot }
  /**
   * Live, NOT persisted: streaming assistant output while a message is being generated.
   * `text` is the accumulated content of the current message so far (not just the delta), so a
   * client that missed frames still renders correctly. Superseded by the persisted `run.event`
   * (kind text/thinking) published at message end — clients drop the live block then.
   */
  | {
      type: "run.delta";
      runId: string;
      taskId: string;
      boardId: string;
      kind: "text" | "thinking";
      text: string;
    };

export interface ApiError {
  error: string;
}

/**
 * The card the card writer made from a card's free text (POST /boards/:id/tasks with `text`).
 * `description` never contains the `orchestrate` keyword; `orchestrate` adds it.
 */
export interface CardDraft {
  title: string;
  description: string;
  /** The work splits into independent parts: the card asks omp to orchestrate parallel subagents. */
  orchestrate: boolean;
  /** Open cards on the board this one must wait for ("Run after"). */
  waitFor: { id: string; title: string }[];
}

/** A file shared on a card or on a board (GET /tasks/:id/files, GET /boards/:id/files). */
export interface SharedFile {
  /** Path relative to the files folder, `/`-separated (agents may create sub-folders). */
  name: string;
  /** Absolute path on the server (what an agent reads/writes). */
  path: string;
  size: number;
  modifiedAt: string;
}

export interface SharedFiles {
  /** Absolute folder holding these files; agents get it as an extra workspace directory. */
  folder: string;
  files: SharedFile[];
}

/** One project folder of a card's dedicated workspace (GET /tasks/:id/workspace). */
export interface WorkspaceFolder {
  /** Project folder on the board. */
  source: string;
  /** Where the agent works: the worktree, or `source` for a non-git (shared) folder. */
  path: string;
  /** Worktree branch; null for a shared folder. */
  branch: string | null;
  /** True when `path` is a dedicated git worktree. */
  isolated: boolean;
  /** False until the card's first run creates the worktree. */
  exists: boolean;
}

export interface TaskWorkspace {
  /** Board has dedicated workspaces on (Board.worktrees). */
  enabled: boolean;
  folders: WorkspaceFolder[];
}

/** One entry of the agent queue (GET /queue). */
export interface QueueEntry {
  taskId: string;
  boardId: string;
  boardName: string;
  title: string;
  state: "running" | "queued";
  /** Blocking cards (Task.blockedBy) that are not Done yet; the run waits for them. */
  waitingFor: string[];
  /** Held until the smart-queue planner has ordered its project's queued cards. */
  planning: boolean;
  /** Held while the card writer turns the card's free text into its title and brief. */
  drafting: boolean;
  /** Why the smart-queue planner put the card where it is (one line); null when not planned. */
  planNote: string | null;
  /** Card whose agent created this card (Task.createdByTaskId); null when a person did. */
  createdByTaskId: string | null;
}

/** The agent limit in effect and where it comes from (GET /queue). */
export interface ConcurrencyInfo {
  /** `auto`: derived from the machine; `manual`: the number set in Settings or MAX_AGENTS. */
  mode: "auto" | "manual";
  /** Agents allowed to run at once right now. */
  limit: number;
  /** What bounds an automatic limit (logical cores, free memory, or the hard cap); null when manual. */
  boundBy: "cpu" | "memory" | "max" | null;
  /** Logical cores available to the server. */
  cpus: number;
  freeMemoryBytes: number;
  totalMemoryBytes: number;
  /** One line for the UI, e.g. "Auto: 12 parallel (16 cores, 28 GB free)". */
  reason: string;
}

export interface QueueSnapshot {
  /** Max agents running at once (the effective limit, `concurrency.limit`). */
  limit: number;
  concurrency: ConcurrencyInfo;
  running: QueueEntry[];
  /** Start order. */
  queued: QueueEntry[];
  /** Projects whose queued cards the smart-queue planner is ordering right now. */
  planning: { boardId: string; boardName: string }[];
}

/** A card with its project's name, for cross-project lists on the home dashboard. */
export type DashboardCard = Pick<
  Task,
  | "id"
  | "boardId"
  | "title"
  | "status"
  | "agentState"
  | "agentError"
  | "commentCount"
  | "openCommentCount"
  | "lastRunId"
  | "updatedAt"
> & { boardName: string };

/**
 * Why a card needs the user: its agent `failed`, or it sits In progress with no agent working
 * on it (`stalled`: stopped, or never started on a board without auto-run).
 */
export type AttentionReason = "failed" | "stalled";

export interface DashboardBoard extends BoardWithCounts {
  /** Latest card change on the board, else the board's own update. */
  lastActivityAt: string;
  /** Cards on this board that need the user (see AttentionReason). */
  attentionCount: number;
  /** Cards on this board waiting on the user by the home page's broader rules (NeedsYouReason). */
  needsYouCount: number;
  /** Agent runs that ended in the last 30 days (stopped runs are not counted). */
  runs30d: { succeeded: number; failed: number };
  /** Git status per project folder (workdir first); cached for a few seconds on the server. */
  git: GitStatus[];
}

/**
 * Why a card waits on the user on the home page, most urgent first: the agent asked a
 * `question`; it `failed`; it failed and an automatic retry is scheduled (`retrying`); unresolved
 * `feedback` comments with no agent working; `stalled` (see AttentionReason); or it is Done but
 * its changes were not pushed yet (`unpushed`, only for projects that can push, recent cards).
 */
export type NeedsYouReason = "question" | "failed" | "retrying" | "feedback" | "stalled" | "unpushed";

export interface NeedsYouCard extends DashboardCard {
  /** Every reason that applies, most urgent first. */
  reasons: NeedsYouReason[];
  /** The agent's question (truncated); null unless `reasons` includes "question". */
  question: string | null;
  retryAt: string | null;
  pushedAt: string | null;
}

/** A running or queued agent on the home page (one per QueueSnapshot entry). */
export interface DashboardLiveAgent {
  taskId: string;
  /** When the current run started; null while queued. */
  startedAt: string | null;
  /** Model the run uses, when known (board/settings model or the auto-selected one). */
  model: string | null;
  /** Latest thing the agent did (tool call, status or first line of its text). */
  activity: string | null;
  activityAt: string | null;
}

/** Agent runs and shipped cards in a time window. */
export interface DashboardStatsWindow {
  /** Runs that ended in the window (succeeded, failed or stopped). */
  runs: number;
  succeeded: number;
  failed: number;
  /** Mean wall time of succeeded + failed runs; null when there were none. */
  avgDurationMs: number | null;
  /** Cards pushed to the default branch (Task.pushedAt). */
  shipped: number;
  /** Cards created. */
  created: number;
}

export interface DashboardStats {
  /** Last 24 hours. */
  day: DashboardStatsWindow;
  /** Last 7 × 24 hours. */
  week: DashboardStatsWindow;
  /** The same 7 days as rolling 24-hour buckets, oldest first. */
  daily: Pick<DashboardStatsWindow, "runs" | "succeeded" | "failed" | "shipped">[];
}

export type DashboardActivityKind = "created" | "succeeded" | "failed" | "stopped" | "pushed";

/** One entry of the home page's recent activity feed. */
export interface DashboardActivity {
  kind: DashboardActivityKind;
  at: string;
  taskId: string;
  boardId: string;
  boardName: string;
  title: string;
  /** Run wall time for succeeded/failed/stopped. */
  durationMs: number | null;
  /** First line of the error for failed runs; "by an agent" style notes otherwise. */
  detail: string | null;
}

/** GET /dashboard — everything the home page shows, in one request. */
export interface Dashboard {
  generatedAt: string;
  /** Most recently active first. */
  boards: DashboardBoard[];
  /** Cards per column across every project. */
  totals: Record<TaskStatus, number>;
  /**
   * Failed first, then stalled; most recently changed first within each. At most 12; the full
   * count is the sum of `boards[].attentionCount`.
   */
  attention: (DashboardCard & { reason: AttentionReason })[];
  /** Done cards an agent worked on, most recently finished first (at most 6). */
  finished: DashboardCard[];
  /** Cards waiting on the user, most urgent first (at most 50; the full count is `needsYouTotal`). */
  needsYou: NeedsYouCard[];
  needsYouTotal: number;
  queue: QueueSnapshot;
  /** Run details for every running and queued entry of `queue`. */
  live: DashboardLiveAgent[];
  stats: DashboardStats;
  /** Newest first, at most 12. */
  activity: DashboardActivity[];
  /** Getting-started progress beyond "has a project". */
  setup: {
    hasCard: boolean;
    hasRun: boolean;
    hasDone: boolean;
    /** A card was pushed to the default branch at least once. */
    hasPush: boolean;
    /** The settings were saved at least once. */
    settingsSaved: boolean;
    /** The docker CLI reaches a daemon (cached for a few minutes). */
    dockerAvailable: boolean;
  };
}

/** GET /fs/browse — server-side folder picker. */
export interface FsEntry {
  name: string;
  /** Absolute path. */
  path: string;
  isGitRepo: boolean;
}

export interface FsBrowseResult {
  /** Absolute path being listed. */
  path: string;
  /** Parent directory, or null at filesystem root. */
  parent: string | null;
  /** WORKSPACE_DIR: default start folder and clone destination. */
  workspaceRoot: string;
  /** Sub-directories only (no files), hidden dirs excluded, sorted by name. */
  entries: FsEntry[];
}

export type GitProvider = "github" | "gitlab" | "other";

/** GET /boards/:id/git returns one entry per project folder (workdir first, then extraFolders). */
export interface GitStatus {
  /** Absolute project folder this status describes. */
  folder: string;
  isRepo: boolean;
  branch: string | null;
  /** origin's default branch (origin/HEAD), falling back to "main"/"master". */
  defaultBranch: string | null;
  remoteUrl: string | null;
  /** https URL of the repository web page, if derivable from the remote. */
  webUrl: string | null;
  provider: GitProvider | null;
  /** Uncommitted changes present. */
  dirty: boolean;
  changedFiles: number;
  /** Commits ahead/behind the upstream of the current branch (0 if no upstream). */
  ahead: number;
  behind: number;
  /** `gh` (GitHub) or `glab` (GitLab) CLI is installed for creating PR/MRs. */
  prCliAvailable: boolean;
}

export interface GitBranch {
  /** Branch name without `refs/heads/` / `origin/`. */
  name: string;
  /** Exists only on origin; switching to it creates a local branch tracking it. */
  remoteOnly: boolean;
}

/** GET /boards/:id/git/branches?folder=<abs>: local branches (newest first), then origin-only ones. */
export interface GitBranches {
  folder: string;
  /** Checked-out branch, or null on a detached HEAD. */
  current: string | null;
  branches: GitBranch[];
}

/** Outcome for one folder of a push / PR action. */
export interface GitRepoActionResult {
  folder: string;
  /** Branch that was pushed (null if nothing happened for this folder). */
  branch: string | null;
  /** Commit created for uncommitted changes, or null if the tree was clean. */
  commit: string | null;
  /** PR/MR URL (pr) or repository/commit URL (push), if known. */
  url: string | null;
  /** Combined git/gh/glab output, for display. */
  output: string;
  /** Error for this folder; other folders still proceed. */
  error: string | null;
  /** True when the folder had nothing to commit or push. */
  skipped: boolean;
}

/**
 * POST /tasks/:id/git/push and POST /tasks/:id/git/pr. Acts on every project folder that is a
 * git repo with changes (uncommitted or unpushed), or only on `folders` when given.
 */
export interface GitActionResult {
  action: "push" | "pr";
  results: GitRepoActionResult[];
  /** The agent comment posted on the task describing the result (links included). */
  comment: Comment;
}

/** POST /boards/:id/git/push — header quick push of every project repo to its default branch. */
export interface BoardPushResult {
  results: GitRepoActionResult[];
}

/** GET /system/restart — can the "Restart server" button restart this server, and the last restart. */
export interface RestartStatus {
  /** Whether the button can restart this server; `reason` says why not. */
  available: boolean;
  /** "cli": started by `omp-ui up`/`start`; "pm2": supervised by pm2. */
  mode: "cli" | "pm2" | null;
  reason: string | null;
  /** Agents that a restart would interrupt. */
  running: number;
  /** Tail of the last restart's output (`DATA_DIR/restart.log`), or null when there was none. */
  log: string | null;
  /** The last restart's build failed, so the previous build was started instead. */
  buildFailed: boolean;
  /** A restart was requested and its CLI process is still running. */
  restarting: boolean;
}

/** GET /stats/system — host + app statistics. Byte counts are bytes; times are seconds. */
export interface SystemStats {
  generatedAt: string;
  host: {
    hostname: string;
    platform: string;
    arch: string;
    release: string;
    uptimeSec: number;
    nodeVersion: string;
  };
  /** usagePercent is sampled over ~200ms across all cores (0–100). */
  cpu: { model: string; cores: number; loadAvg: [number, number, number]; usagePercent: number };
  memory: { totalBytes: number; usedBytes: number; freeBytes: number };
  /** Filesystem holding DATA_DIR (statfs); null if unavailable. */
  disk: { path: string; totalBytes: number; usedBytes: number; freeBytes: number } | null;
  process: { pid: number; uptimeSec: number; rssBytes: number; heapUsedBytes: number };
  app: {
    version: string;
    db: "sqlite" | "mongodb" | "postgres";
    boards: number;
    tasks: Record<TaskStatus, number>;
    agentsRunning: number;
    agentsQueued: number;
  };
}

// ---------------------------------------------------------------------------------------------
// Maintenance: GET /stats/maintenance (analyze) and POST /stats/maintenance (clean up / free)

/**
 * What a process is to AgentMan:
 * - server: this server or one of its ancestors (supervisor, pm2…); never ended from the UI
 * - card-agent: a running card's omp agent (stop the card instead)
 * - helper: a pooled omp helper (card writer, advisor…) of this server
 * - orphan-agent: an omp agent of this DATA_DIR that this server no longer tracks (left by a crash)
 * - agent-spawned: started by an omp process (dev servers, browsers, test runners…)
 * - omp: another omp process (your own sessions, daemons)
 * - user: any other process of the server's user
 * - system: a process of another user (not killable)
 */
export type ProcessTag =
  | "server"
  | "card-agent"
  | "helper"
  | "orphan-agent"
  | "agent-spawned"
  | "omp"
  | "user"
  | "system";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  user: string;
  /** Executable name, e.g. "node", "omp", "chrome". */
  name: string;
  /** Full command line (truncated). */
  command: string;
  /** Share of one core over the sample window (can exceed 100 on several cores). */
  cpuPercent: number;
  rssBytes: number;
  /** Seconds since the process started; null when unknown. */
  elapsedSec: number | null;
  tag: ProcessTag;
  /** card-agent / orphan-agent: the card it runs for, when known. */
  taskId: string | null;
  taskTitle: string | null;
  taskBoardId: string | null;
  /** Owned by the server's user and not protected: POST { action: "kill" } accepts it. */
  killable: boolean;
}

/** Storage the cleanup can free. Docker ids map to `docker <kind> prune -f`. */
export const CLEANUP_IDS = [
  "orphan-card-files",
  "orphan-board-files",
  "orphan-workspaces",
  "shipped-workspaces",
  "run-configs",
  "drafts",
  "diff-cache",
  "rotated-logs",
  "database",
  "docker-images",
  "docker-builder",
  "docker-containers",
  "docker-volumes",
  "docker-networks",
] as const;
export type CleanupId = (typeof CLEANUP_IDS)[number];

export interface CleanupItem {
  id: CleanupId;
  label: string;
  description: string;
  /** Bytes the cleanup should free (an estimate for Docker and the database); null when unknown. */
  bytes: number | null;
  /** Files, folders or objects it would remove. */
  count: number;
  /** "safe": regenerated or unused data, included in "Clean up all safe items"; "review": may remove something you still want. */
  risk: "safe" | "review";
  /** Nothing to do (count 0 / bytes 0) or not applicable on this setup. */
  empty: boolean;
}

/** Space used outside AgentMan's own data; shown for context, never deleted from the UI. */
export interface StorageUsage {
  label: string;
  path: string;
  bytes: number | null;
  note: string;
}

export type MaintenanceAction =
  | { kind: "cleanup"; ids: CleanupId[] }
  | { kind: "kill"; pids: number[] }
  | { kind: "release-memory" }
  | { kind: "stop-card"; taskId: string };

export interface MaintenanceRecommendation {
  id: string;
  area: "cpu" | "memory" | "storage";
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  /** One-click fix; null when it needs a look first. */
  action: MaintenanceAction | null;
  actionLabel: string | null;
}

export interface MaintenanceReport {
  generatedAt: string;
  /** How long the analysis took. */
  durationMs: number;
  /** Process list could not be read (unsupported platform…); null when it worked. */
  processError: string | null;
  /** Top CPU and memory users plus every agent-related process. */
  processes: ProcessInfo[];
  cpu: { cores: number; usagePercent: number; loadAvg: [number, number, number] };
  memory: {
    totalBytes: number;
    /** Memory the OS can hand out without swapping (MemAvailable on Linux). */
    availableBytes: number;
    swapTotalBytes: number | null;
    swapUsedBytes: number | null;
    server: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number };
    /** Warm omp helper workers waiting for the next call. */
    idleHelpers: { count: number; rssBytes: number };
  };
  storage: {
    disk: SystemStats["disk"];
    dataDir: string;
    dataBytes: number | null;
    cleanup: CleanupItem[];
    /** Sum of non-empty "safe" cleanup items. */
    safeBytes: number;
    other: StorageUsage[];
    dockerError: string | null;
  };
  recommendations: MaintenanceRecommendation[];
}

export interface MaintenanceStepResult {
  /** A cleanup id, `kill:<pid>`, `release-memory` or `stop-card:<id>`. */
  id: string;
  ok: boolean;
  message: string;
  /** Bytes freed on disk or in memory, when measurable. */
  freedBytes: number | null;
}

export interface MaintenanceResult {
  results: MaintenanceStepResult[];
  freedBytes: number;
}

/** A cleanup the schedule may run, as shown in Settings (texts from the Maintenance targets). */
export interface CleanupTargetInfo {
  id: ScheduledCleanupId;
  label: string;
  description: string;
  risk: "safe" | "review";
}

/** GET|POST /api/v1/settings/cleanup: the scheduled cleanup's configuration and last outcome. */
export interface CleanupStatus {
  schedule: CleanupSchedule;
  targets: ScheduledCleanupId[];
  /** Every schedulable target with label/description/risk taken from lib/maintenance.ts TARGETS. */
  available: CleanupTargetInfo[];
  /** ISO. */
  lastRunAt: string | null;
  lastTrigger: "manual" | "scheduled" | null;
  lastResult: MaintenanceResult | null;
  /** ISO; null when schedule is "off". */
  nextRunAt: string | null;
  /** A cleanup is in progress right now. */
  running: boolean;
}

export interface AiQuotaLimit {
  id: string;
  label: string;
  /** e.g. "5 Hour", "7 Day". */
  windowLabel: string | null;
  resetsAt: string | null;
  used: number | null;
  limit: number | null;
  /** 0–1. */
  usedFraction: number | null;
  /** e.g. "percent", "requests", "tokens", "usd". */
  unit: string | null;
  /** Provider-reported status, e.g. "ok", "warning", "exhausted". */
  status: string | null;
}

export interface AiProviderQuota {
  provider: string;
  /** Account label (email/org) if reported. */
  account: string | null;
  fetchedAt: string | null;
  limits: AiQuotaLimit[];
}

export interface AiModelUsage {
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

/** GET /stats/ai — from `omp usage --json` (quota) and `omp stats --json` (usage). Cached 60s. */
export interface AiStats {
  generatedAt: string;
  quota: { available: boolean; error: string | null; providers: AiProviderQuota[] };
  usage: {
    available: boolean;
    error: string | null;
    totals: {
      requests: number;
      failedRequests: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      costUsd: number;
      firstAt: string | null;
      lastAt: string | null;
    } | null;
    byModel: AiModelUsage[];
  };
}

/** A value omp's config.yml holds for one editable key; null = not set (omp's default applies). */
export type OmpConfigValue = string | number | boolean | null;

export type OmpConfigFieldType = "model" | "enum" | "boolean" | "number" | "string";

/** One editable key of omp's user config (GET /omp-config `schema`). */
export interface OmpConfigField {
  /** Dotted omp setting key, e.g. "defaultThinkingLevel"; model roles are "modelRoles.<role>". */
  key: string;
  label: string;
  type: OmpConfigFieldType;
  group: "models" | "behavior" | "tools";
  help: string;
  /** `enum` choices, in omp's order. */
  options?: { value: string; label: string }[];
  /** `number` bounds (integers). */
  min?: number;
  max?: number;
  placeholder?: string;
}

/** GET/PUT /omp-config: omp's user-level config.yml. */
export interface OmpConfigSnapshot {
  /** Absolute path of the config file (it may not exist yet). */
  path: string;
  /** Where the previous version is kept on every save. */
  backupPath: string;
  format: "yaml";
  exists: boolean;
  /** Content hash of `raw`; send it back on PUT to refuse saving over a newer file. */
  version: string;
  raw: string;
  /** Schema key → value set in the file (null when unset). */
  values: Record<string, OmpConfigValue>;
  /** Schema key → value omp uses when the file leaves it unset. */
  defaults: Record<string, OmpConfigValue>;
  schema: OmpConfigField[];
}

/** PUT /omp-config: structured `values` (null unsets a key) or a whole `raw` file. */
export type OmpConfigUpdate =
  | { values: Record<string, OmpConfigValue>; version?: string }
  | { raw: string; version?: string };

/** One chat model of `omp models --json`. */
export interface OmpModel {
  /** "provider/model-id": what omp's model settings take (optionally with ":<thinking>"). */
  selector: string;
  name: string;
  provider: string;
  /** Thinking levels the model supports; empty when it does not reason. */
  thinking: string[];
}

/** `AGENTMEMORY_ENABLED`: auto (default) starts the memory server when agentmemory is installed. */
export type MemoryEnabledMode = "auto" | "true" | "false";

/** GET /memory: the local agentmemory server (https://github.com/rohitg00/agentmemory) and its OMP hook-up. */
export interface MemoryStatus {
  enabled: MemoryEnabledMode;
  /** The `agentmemory` CLI was found (global install on PATH, or the npx cache). */
  installed: boolean;
  /** How the CLI was found. */
  installSource: "path" | "npx" | null;
  /** Server version when it answers, else the CLI's. */
  version: string | null;
  /** REST API base (`AGENTMEMORY_URL`, default http://127.0.0.1:3111). */
  url: string;
  /** Live viewer; binds to loopback on the server host by default. */
  viewerUrl: string;
  /** The REST API answered at all (even with an error). */
  reachable: boolean;
  /** `/agentmemory/health` reports ok/healthy/degraded. */
  healthy: boolean;
  /** A start through AgentMan is still running. */
  starting: boolean;
  /** Why the server is not healthy (unreachable, unauthorized, …). */
  error: string | null;
  /** Overall status of `/agentmemory/status` (ok|info|warn|error) and its one-line headline. */
  level: string | null;
  headline: string | null;
  /** Problems `/agentmemory/status` lists, each with its fix. */
  problems: { level: string; message: string; fix?: string }[];
  /** "bm25" (keyless) or the embedding provider ("local", "openai", …). */
  embeddings: string;
  /** Whether `embeddings` comes from the running server or from ~/.agentmemory/.env. */
  embeddingsSource: "server" | "config";
  /** LLM provider for summaries/consolidation ("noop" when keyless); null when the server is down. */
  llm: string | null;
  stats: MemoryStats | null;
  omp: {
    /** omp's agent dir (`omp config path`); null when omp is missing. */
    agentDir: string | null;
    /** `agentmemory connect omp` installed the extension and listed it in config.yml `extensions`. */
    connected: boolean;
    /** The connector also wired the MCP toolset (`--with-mcp`). */
    mcp: boolean;
    error: string | null;
  };
}

export interface MemoryStats {
  memories: number | null;
  sessions: number | null;
  observations: number | null;
  lessons: number | null;
}
