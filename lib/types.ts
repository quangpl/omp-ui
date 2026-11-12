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

export type RunEventKind = "status" | "text" | "thinking" | "tool" | "error";

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
}

export const DEFAULT_SETTINGS: AppSettings = {
  maxConcurrentAgents: 2,
  ompPath: "omp",
  approvalMode: "yolo",
  defaultModel: "",
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
  | { type: "run.event"; event: RunEvent; boardId: string };

export interface ApiError {
  error: string;
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
