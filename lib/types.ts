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
  createdAt: string;
  updatedAt: string;
  /** Derived: total comments. */
  commentCount: number;
  /** Derived: unresolved user comments (pending feedback). */
  openCommentCount: number;
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
 * point); the latest event per subagent id wins.
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
  /** Max omp processes running at once; extra runs wait in "queued". */
  maxConcurrentAgents: number;
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
  /** What a card's agent may do with a web browser (omp's `browser` tool). */
  browser: BrowserMode;
}

/**
 * Browser control for agents: `off` disables omp's browser; `headless` (default) runs an
 * invisible browser; `visible` shows its window on the server's desktop; `relay` drives the
 * server user's own Chrome through omp's browser relay (`omp browser-relay`).
 */
export const BROWSER_MODES = ["off", "headless", "visible", "relay"] as const;
export type BrowserMode = (typeof BROWSER_MODES)[number];

export const DEFAULT_SETTINGS: AppSettings = {
  maxConcurrentAgents: 2,
  ompPath: "omp",
  approvalMode: "yolo",
  defaultModel: "",
  autoModel: true,
  browser: "headless",
};

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
  /** The agent queue changed: running and queued task ids, queued in start order. */
  | { type: "queue.updated"; running: string[]; queued: string[] }
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
}

export interface QueueSnapshot {
  /** Max agents running at once. */
  limit: number;
  running: QueueEntry[];
  /** Start order. */
  queued: QueueEntry[];
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
  queue: QueueSnapshot;
  /** Getting-started progress beyond "has a project". */
  setup: { hasCard: boolean; hasRun: boolean; hasDone: boolean };
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
