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
  Scheduler,
  SchedulerRun,
  Task,
  TaskStatus,
  AgentState,
  User,
  UserRole,
} from "@/lib/types";

/** A user with the secrets only lib/auth.ts may read. Never send it to a client. */
export interface UserAuthRecord extends User {
  /** `scrypt$N$r$p$<salt>$<hash>` (lib/auth.ts). */
  passwordHash: string;
  /** Per-user session epoch: bumped to revoke that user's tokens and chat logins. Starts at 0. */
  tokenEpoch: number;
}

/** `username`/`email` must already be normalized (trimmed, lowercase): drivers match them exactly. */
export interface CreateUserInput {
  username: string;
  /** Default null. */
  email?: string | null;
  passwordHash: string;
  role: UserRole;
  /** Default true. */
  isActive?: boolean;
}
export type UpdateUserInput = Partial<
  Pick<UserAuthRecord, "username" | "email" | "passwordHash" | "role" | "isActive" | "tokenEpoch">
>;

export interface CreateBoardInput {
  name: string;
  workdir: string;
  /** Default []. */
  extraFolders?: string[];
  model?: string | null;
  autoRun?: boolean;
  /** Default "main" (DEFAULT_PUSH_BRANCH). Must already be a valid branch name. */
  pushBranch?: string;
  /**
   * Default {}. Folder (absolute) → branch; keys must be among workdir + extraFolders and every
   * branch must already be a valid branch name.
   */
  defaultBranches?: Record<string, string>;
  /** Owning user (users.id). Default null (unowned: only admins see it until boot assigns it). */
  userId?: string | null;
}
export type UpdateBoardInput = Partial<
  Pick<
    Board,
    "name" | "workdir" | "extraFolders" | "model" | "autoRun" | "pinned" | "pushBranch" | "defaultBranches"
  >
>;

export interface CreateTaskInput {
  boardId: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  /** Omitted: appended to the end of the column (max position + 1024). */
  position?: number;
  /** Default null. */
  createdByTaskId?: string | null;
  /** Default null. Scheduler whose run creates this card. */
  schedulerId?: string | null;
}
/** A patch of only `usage` leaves `updatedAt` unchanged (see `touchesTask`). */
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
    | "pushedAt"
    | "autoRetries"
    | "retryAt"
    | "todos"
    | "review"
    | "resources"
    | "usage"
  >
>;

export interface CreateSchedulerInput {
  boardId: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  /** Default true. */
  enabled?: boolean;
  /** Default null (forever). */
  maxRuns?: number | null;
  /** Default null: cards use the project's model. */
  model?: string | null;
  /** Default null. Computed by the caller (lib/scheduler.ts), never by the driver. */
  nextRunAt?: string | null;
}
export type UpdateSchedulerInput = Partial<
  Pick<
    Scheduler,
    | "boardId"
    | "name"
    | "prompt"
    | "cron"
    | "timezone"
    | "enabled"
    | "maxRuns"
    | "runCount"
    | "lastRunAt"
    | "nextRunAt"
    | "lastStatus"
    | "lastTaskId"
    | "lastError"
    | "model"
  >
>;

export interface CreateSchedulerRunInput {
  schedulerId: string;
  taskId: string | null;
  trigger: SchedulerRun["trigger"];
  scheduledFor: string;
  status: SchedulerRun["status"];
  /** Default null. */
  error?: string | null;
}

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
  /** Cluster node that executes the run (Run.nodeId/nodeName); default null (standalone). */
  nodeId?: string | null;
  nodeName?: string | null;
}
export type UpdateRunInput = Partial<Pick<Run, "status" | "summary" | "error" | "endedAt">>;

export interface AppendRunEventInput {
  runId: string;
  taskId: string;
  kind: RunEventKind;
  text: string;
}

/**
 * Tables of a full data export (Settings → Data transfer), parents before children: importing
 * them in this order satisfies every foreign key.
 */
export const DATA_TABLES = [
  "settings",
  "users",
  "boards",
  "tasks",
  "comments",
  "runs",
  "run_events",
  "schedulers",
  "scheduler_runs",
] as const;
export type DataTable = (typeof DATA_TABLES)[number];

export interface SettingRow {
  key: string;
  value: string;
}

/** A card as stored: Task without the counts derived from its comments. */
export type TaskRow = Omit<Task, "commentCount" | "openCommentCount">;

/** The row of each data table, as driver-independent domain records (the export format). */
export interface DataRows {
  settings: SettingRow;
  users: UserAuthRecord;
  boards: Board;
  tasks: TaskRow;
  comments: Comment;
  runs: Run;
  run_events: RunEvent;
  schedulers: Scheduler;
  scheduler_runs: SchedulerRun;
}

/** Every row of every data table. */
export type DataSnapshot = { [T in DataTable]: DataRows[T][] };

/**
 * Storage abstraction. Implemented by SqliteRepository (node:sqlite, default), MongoRepository
 * and PostgresRepository (pg).
 * Every method returns fully-populated domain objects (including Task.commentCount /
 * Task.openCommentCount). Getters return null for unknown ids; mutators on unknown ids
 * return null (update) or false (delete) instead of throwing.
 *
 * Ownership: boards carry `userId`; tasks, comments, runs and schedulers copy it from their board
 * (the driver stamps it on create, never the caller). Optional `userId` arguments of list methods
 * restrict the result to that owner. Per-user access control lives in lib/db/scoped.ts, which wraps
 * this interface for request handlers; drivers never check permissions.
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

  /** Oldest first (createdAt asc). */
  listUsers(): Promise<User[]>;
  getUser(id: string): Promise<User | null>;
  /** With secrets; null for unknown ids. */
  getUserAuth(id: string): Promise<UserAuthRecord | null>;
  /** With secrets: the user whose `username` OR `email` equals `login` exactly; null if none. */
  findUserAuthByLogin(login: string): Promise<UserAuthRecord | null>;
  /** tokenEpoch 0; createdAt/updatedAt now. Throws when the username or email is already taken. */
  createUser(input: CreateUserInput): Promise<User>;
  /** Bumps updatedAt. Throws when the new username or email is already taken. */
  updateUser(id: string, patch: UpdateUserInput): Promise<User | null>;
  /** Deletes the user row only; callers move or delete the user's data first. */
  deleteUser(id: string): Promise<boolean>;
  /**
   * Set `userId = toUserId` on every board, task, comment, run and scheduler owned by `fromUserId`
   * (`null`: rows without an owner). Returns the number of boards moved.
   */
  reassignUserData(fromUserId: string | null, toUserId: string): Promise<number>;

  /** Newest first. `userId`: only that user's boards. */
  listBoards(userId?: string): Promise<BoardWithCounts[]>;
  getBoard(id: string): Promise<Board | null>;
  createBoard(input: CreateBoardInput): Promise<Board>;
  updateBoard(id: string, patch: UpdateBoardInput): Promise<Board | null>;
  /** Stamps `lastAccessedAt` with now; leaves `updatedAt` alone. Null when the board doesn't exist. */
  markBoardAccessed(id: string): Promise<Board | null>;
  /** Cascades: tasks, comments, runs, run events, schedulers and their scheduler runs. */
  deleteBoard(id: string): Promise<boolean>;

  /** Ordered by status then position ascending. */
  listTasks(boardId: string): Promise<Task[]>;
  /** `userId`: only that user's tasks. */
  listTasksByAgentState(states: AgentState[], userId?: string): Promise<Task[]>;
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
  /**
   * Runs of every card (or only `userId`'s), newest first (startedAt desc), at most `limit`
   * (default 500, max 5000).
   */
  listRecentRuns(limit?: number, userId?: string): Promise<Run[]>;
  getRun(id: string): Promise<Run | null>;
  createRun(input: CreateRunInput): Promise<Run>; // status "running", startedAt now
  updateRun(id: string, patch: UpdateRunInput): Promise<Run | null>;
  /** Marks every run still "running" as "aborted" (boot recovery). Returns count. */
  abortRunningRuns(reason: string): Promise<number>;

  appendRunEvent(input: AppendRunEventInput): Promise<RunEvent>;
  /** Events with seq > after, ascending, at most `limit` (default 500). */
  listRunEvents(runId: string, after?: number, limit?: number): Promise<RunEvent[]>;

  /** All schedulers (or one board's), newest first. `userId`: only that user's schedulers. */
  listSchedulers(boardId?: string, userId?: string): Promise<Scheduler[]>;
  getScheduler(id: string): Promise<Scheduler | null>;
  /** runCount 0, last* null; createdAt/updatedAt now. */
  createScheduler(input: CreateSchedulerInput): Promise<Scheduler>;
  /** Bumps updatedAt. A new `boardId` also re-stamps `userId` from that board. */
  updateScheduler(id: string, patch: UpdateSchedulerInput): Promise<Scheduler | null>;
  /** Cascades: its scheduler runs. Cards it created stay, with `schedulerId` cleared to null. */
  deleteScheduler(id: string): Promise<boolean>;

  /** Newest first (createdAt desc), at most `limit` (default 100, max 1000). */
  listSchedulerRuns(schedulerId: string, limit?: number): Promise<SchedulerRun[]>;
  /** createdAt now. */
  createSchedulerRun(input: CreateSchedulerRunInput): Promise<SchedulerRun>;

  /**
   * Every row of `table` as a domain record, in batches of at most a few hundred rows, ordered by
   * primary key (run events by seq). For exports; rows written meanwhile may or may not appear.
   */
  exportRows<T extends DataTable>(table: T): AsyncIterable<DataRows[T][]>;
  /**
   * Delete every row of every data table, then insert `data` verbatim: ids, run event seqs,
   * timestamps and owners are kept, and new run events continue after the highest imported seq.
   * `data` must be consistent (every referenced board, task, run and scheduler present). SQLite and
   * PostgreSQL do it in one transaction; MongoDB (no multi-document transactions on a standalone
   * server) clears and fills collection by collection.
   */
  replaceAllData(data: DataSnapshot): Promise<void>;
}

export type { RunStatus };
