export type DbDriver = "sqlite" | "mongodb" | "postgres";

import type {
  Board,
  BoardWithCounts,
  Comment,
  CommentAuthor,
  Run,
  RunEvent,
  RunEventKind,
  RunStatus,
  Task,
  TaskStatus,
  AgentState,
} from "@/lib/types";

export interface CreateBoardInput {
  name: string;
  workdir: string;
  /** Default []. */
  extraFolders?: string[];
  model?: string | null;
  autoRun?: boolean;
  /** Default false. */
  worktrees?: boolean;
}
export type UpdateBoardInput = Partial<
  Pick<Board, "name" | "workdir" | "extraFolders" | "model" | "autoRun" | "worktrees">
>;

export interface CreateTaskInput {
  boardId: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  /** Omitted: appended to the end of the column (max position + 1024). */
  position?: number;
  /** Default []. */
  blockedBy?: string[];
  /** Default null. */
  createdByTaskId?: string | null;
}
export type UpdateTaskInput = Partial<
  Pick<
    Task,
    | "title"
    | "description"
    | "status"
    | "position"
    | "agentState"
    | "agentError"
    | "question"
    | "sessionFile"
    | "lastRunId"
    | "blockedBy"
    | "pushedAt"
    | "autoRetries"
    | "retryAt"
  >
>;

export interface CreateCommentInput {
  taskId: string;
  author: CommentAuthor;
  body: string;
  /** Agent comments are created resolved; user comments default unresolved. */
  resolved?: boolean;
  /** Agent-to-agent message: the sending card. Default null. */
  fromTaskId?: string | null;
}

export interface CreateRunInput {
  taskId: string;
  prompt: string;
}
export type UpdateRunInput = Partial<Pick<Run, "status" | "summary" | "error" | "endedAt">>;

export interface AppendRunEventInput {
  runId: string;
  taskId: string;
  kind: RunEventKind;
  text: string;
}

/**
 * Storage abstraction. Implemented by SqliteRepository (node:sqlite, default), MongoRepository
 * and PostgresRepository (pg).
 * Every method returns fully-populated domain objects (including Task.commentCount /
 * Task.openCommentCount). Getters return null for unknown ids; mutators on unknown ids
 * return null (update) or false (delete) instead of throwing.
 */
export interface Repository {
  readonly driver: DbDriver;
  /** Create tables/collections/indexes. Idempotent. */
  init(): Promise<void>;
  close(): Promise<void>;
  /**
   * Reclaim free pages on disk (SQLite: checkpoint + truncate the WAL, then VACUUM). Only file-backed
   * drivers implement it; server databases manage their own storage.
   */
  compact?(): Promise<void>;
  /** Bytes `compact()` would free (free pages + write-ahead log); implemented with `compact`. */
  compactableBytes?(): Promise<number>;

  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  deleteSetting(key: string): Promise<void>;

  listBoards(): Promise<BoardWithCounts[]>; // newest first
  getBoard(id: string): Promise<Board | null>;
  createBoard(input: CreateBoardInput): Promise<Board>;
  updateBoard(id: string, patch: UpdateBoardInput): Promise<Board | null>;
  /** Cascades: tasks, comments, runs, run events. */
  deleteBoard(id: string): Promise<boolean>;

  /** Ordered by status then position ascending. */
  listTasks(boardId: string): Promise<Task[]>;
  listTasksByAgentState(states: AgentState[]): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  createTask(input: CreateTaskInput): Promise<Task>;
  updateTask(id: string, patch: UpdateTaskInput): Promise<Task | null>;
  /** Cascades: comments, runs, run events. */
  deleteTask(id: string): Promise<boolean>;

  /** Oldest first. */
  listComments(taskId: string): Promise<Comment[]>;
  getComment(id: string): Promise<Comment | null>;
  addComment(input: CreateCommentInput): Promise<Comment>;
  /** Mark resolved=false/true; resolvedAt set/cleared accordingly. */
  setCommentResolved(id: string, resolved: boolean, runId?: string | null): Promise<Comment | null>;
  /** Resolve many at once (used when a run succeeds). Returns updated comments. */
  resolveComments(ids: string[], runId: string): Promise<Comment[]>;
  deleteComment(id: string): Promise<boolean>;

  /** Newest first. */
  listRuns(taskId: string): Promise<Run[]>;
  getRun(id: string): Promise<Run | null>;
  createRun(input: CreateRunInput): Promise<Run>; // status "running", startedAt now
  updateRun(id: string, patch: UpdateRunInput): Promise<Run | null>;
  /** Marks every run still "running" as "aborted" (boot recovery). Returns count. */
  abortRunningRuns(reason: string): Promise<number>;

  appendRunEvent(input: AppendRunEventInput): Promise<RunEvent>;
  /** Events with seq > after, ascending, at most `limit` (default 500). */
  listRunEvents(runId: string, after?: number, limit?: number): Promise<RunEvent[]>;
}

export type { RunStatus };
