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

export interface Board {
  id: string;
  name: string;
  /** Absolute directory omp runs in (`omp --cwd <workdir>`). */
  workdir: string;
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
