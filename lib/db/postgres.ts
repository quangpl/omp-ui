import pg from "pg";

import type {
  AgentState,
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
  User,
  UserRole,
} from "@/lib/types";
import type {
  AppendRunEventInput,
  CreateBoardInput,
  CreateCommentInput,
  CreateRunInput,
  CreateSchedulerInput,
  CreateSchedulerRunInput,
  CreateTaskInput,
  CreateUserInput,
  Repository,
  UpdateBoardInput,
  UpdateRunInput,
  UpdateSchedulerInput,
  UpdateTaskInput,
  UpdateUserInput,
  UserAuthRecord,
  DataRows,
  DataSnapshot,
  DataTable,
  TaskRow as TaskRecord,
} from "@/lib/db/types";
import { DATA_TABLES } from "@/lib/db/types";
import {
  POSITION_STEP,
  type SchemaSnapshot,
  boardPatchUpdatedAt,
  emptyStatusCounts,
  logSchemaMigrations,
  newId,
  normalizeAfter,
  normalizeLimit,
  normalizeRecentRunLimit,
  nowIso,
  parseAgentResources,
  parseTaskUsage,
  parseBranchMap,
  parseFolderList,
  parseTaskReview,
  touchesTask,
} from "@/lib/db/util";
import { parseTodoPhases } from "@/lib/todos";
import { DEFAULT_PUSH_BRANCH } from "@/lib/push-branch";

/** Arbitrary constant key for the advisory lock serializing schema creation across processes. */
const SCHEMA_LOCK_KEY = 4_708_312_655;

// Timestamps are ISO-8601 TEXT (not TIMESTAMPTZ) so values and ordering match the other drivers exactly.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- user_id columns below are plain TEXT (no FK): deleting a user never cascades into data, callers move or delete it first.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  token_epoch INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workdir TEXT NOT NULL,
  extra_folders TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  auto_run BOOLEAN NOT NULL DEFAULT TRUE,
  push_branch TEXT NOT NULL DEFAULT 'main',
  default_branches TEXT NOT NULL DEFAULT '{}',
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  last_accessed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  user_id TEXT
);
-- Migrations for databases created before these columns existed.
ALTER TABLE boards ADD COLUMN IF NOT EXISTS extra_folders TEXT NOT NULL DEFAULT '[]';
ALTER TABLE boards ADD COLUMN IF NOT EXISTS push_branch TEXT NOT NULL DEFAULT 'main';
ALTER TABLE boards ADD COLUMN IF NOT EXISTS default_branches TEXT NOT NULL DEFAULT '{}';
ALTER TABLE boards ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS last_accessed_at TEXT;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_boards_created ON boards (created_at);
CREATE INDEX IF NOT EXISTS idx_boards_user ON boards (user_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
  position DOUBLE PRECISION NOT NULL,
  agent_state TEXT NOT NULL DEFAULT 'idle' CHECK (agent_state IN ('idle', 'queued', 'running', 'error')),
  agent_error TEXT,
  question TEXT,
  session_file TEXT,
  last_run_id TEXT,
  blocked_by TEXT NOT NULL DEFAULT '[]',
  created_by_task_id TEXT,
  pushed_at TEXT,
  auto_retries INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  todos TEXT NOT NULL DEFAULT '[]',
  review TEXT,
  resources TEXT,
  session_usage TEXT,
  scheduler_id TEXT,
  parallelize BOOLEAN,
  ignore_memory BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  user_id TEXT
);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS blocked_by TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by_task_id TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS question TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pushed_at TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS auto_retries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS retry_at TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS todos TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS review TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS resources TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS session_usage TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS scheduler_id TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parallelize BOOLEAN;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ignore_memory BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_board_status_position ON tasks (board_id, status, position);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_state ON tasks (agent_state);
CREATE INDEX IF NOT EXISTS idx_tasks_scheduler ON tasks (scheduler_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks (user_id);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author TEXT NOT NULL CHECK (author IN ('user', 'agent')),
  body TEXT NOT NULL,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at TEXT,
  resolved_by_run_id TEXT,
  from_task_id TEXT,
  created_at TEXT NOT NULL,
  user_id TEXT
);
ALTER TABLE comments ADD COLUMN IF NOT EXISTS from_task_id TEXT;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments (task_id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'aborted')),
  prompt TEXT NOT NULL,
  summary TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  user_id TEXT,
  node_id TEXT,
  node_name TEXT
);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS node_id TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS node_name TEXT;
CREATE INDEX IF NOT EXISTS idx_runs_task_started ON runs (task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at);
CREATE INDEX IF NOT EXISTS idx_runs_user_started ON runs (user_id, started_at);

CREATE TABLE IF NOT EXISTS run_events (
  seq BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events (run_id, seq);

CREATE TABLE IF NOT EXISTS schedulers (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  max_runs INTEGER,
  run_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  next_run_at TEXT,
  last_status TEXT CHECK (last_status IN ('created', 'failed')),
  last_task_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  user_id TEXT
);
ALTER TABLE schedulers ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_schedulers_board ON schedulers (board_id);
CREATE INDEX IF NOT EXISTS idx_schedulers_user ON schedulers (user_id);

-- task_id has no foreign key: run history outlives the card it created.
CREATE TABLE IF NOT EXISTS scheduler_runs (
  id TEXT PRIMARY KEY,
  scheduler_id TEXT NOT NULL REFERENCES schedulers(id) ON DELETE CASCADE,
  task_id TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduler_runs_scheduler_created ON scheduler_runs (scheduler_id, created_at);
`;

const TASK_SELECT = `
SELECT t.*,
  (SELECT COUNT(*)::int FROM comments c WHERE c.task_id = t.id) AS comment_count,
  (SELECT COUNT(*)::int FROM comments c WHERE c.task_id = t.id AND c.author = 'user' AND c.resolved = FALSE) AS open_comment_count
FROM tasks t`;

const TASK_ORDER = `
ORDER BY CASE t.status WHEN 'todo' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, t.position ASC, t.created_at ASC`;

interface BoardRow {
  id: string;
  name: string;
  workdir: string;
  extra_folders: string;
  model: string | null;
  auto_run: boolean;
  push_branch: string | null;
  default_branches: string | null;
  pinned: boolean;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
  user_id: string | null;
}

interface TaskRow {
  id: string;
  board_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  position: number;
  agent_state: AgentState;
  agent_error: string | null;
  question: string | null;
  session_file: string | null;
  last_run_id: string | null;
  blocked_by: string;
  created_by_task_id: string | null;
  pushed_at: string | null;
  auto_retries: number;
  retry_at: string | null;
  todos: string;
  review: string | null;
  resources: string | null;
  session_usage: string | null;
  scheduler_id: string | null;
  parallelize: boolean | null;
  ignore_memory: boolean | null;
  created_at: string;
  updated_at: string;
  comment_count: number;
  open_comment_count: number;
  user_id: string | null;
}

interface CommentRow {
  id: string;
  task_id: string;
  author: CommentAuthor;
  body: string;
  resolved: boolean;
  resolved_at: string | null;
  resolved_by_run_id: string | null;
  from_task_id: string | null;
  created_at: string;
  user_id: string | null;
}

interface RunRow {
  id: string;
  task_id: string;
  status: RunStatus;
  prompt: string;
  summary: string | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
  user_id: string | null;
  node_id: string | null;
  node_name: string | null;
}

interface RunEventRow {
  /** BIGSERIAL arrives as a string from pg. */
  seq: string;
  run_id: string;
  task_id: string;
  kind: RunEventKind;
  text: string;
  created_at: string;
}

interface SchedulerRow {
  id: string;
  board_id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  max_runs: number | null;
  run_count: number;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: Scheduler["lastStatus"];
  last_task_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  user_id: string | null;
}

interface SchedulerRunRow {
  id: string;
  scheduler_id: string;
  task_id: string | null;
  trigger: SchedulerRun["trigger"];
  scheduled_for: string;
  status: SchedulerRun["status"];
  error: string | null;
  created_at: string;
}

interface UserRow {
  id: string;
  username: string;
  email: string | null;
  password_hash: string;
  role: UserRole;
  is_active: boolean;
  token_epoch: number;
  created_at: string;
  updated_at: string;
}

function toBoard(r: BoardRow): Board {
  return {
    id: r.id,
    name: r.name,
    workdir: r.workdir,
    extraFolders: parseFolderList(r.extra_folders),
    model: r.model,
    autoRun: r.auto_run,
    pushBranch: r.push_branch ?? DEFAULT_PUSH_BRANCH,
    defaultBranches: parseBranchMap(r.default_branches),
    pinned: r.pinned,
    lastAccessedAt: r.last_accessed_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    userId: r.user_id ?? null,
  };
}

function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    boardId: r.board_id,
    title: r.title,
    description: r.description,
    status: r.status,
    position: Number(r.position),
    agentState: r.agent_state,
    agentError: r.agent_error,
    question: r.question,
    sessionFile: r.session_file,
    lastRunId: r.last_run_id,
    blockedBy: parseFolderList(r.blocked_by),
    createdByTaskId: r.created_by_task_id,
    pushedAt: r.pushed_at,
    autoRetries: Number(r.auto_retries),
    retryAt: r.retry_at,
    todos: parseTodoPhases(r.todos),
    review: parseTaskReview(r.review),
    resources: parseAgentResources(r.resources),
    usage: parseTaskUsage(r.session_usage),
    schedulerId: r.scheduler_id ?? null,
    parallelize: r.parallelize ?? null,
    ignoreMemory: r.ignore_memory === true,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    commentCount: Number(r.comment_count),
    openCommentCount: Number(r.open_comment_count),
    userId: r.user_id ?? null,
  };
}

function toComment(r: CommentRow): Comment {
  return {
    id: r.id,
    taskId: r.task_id,
    author: r.author,
    body: r.body,
    resolved: r.resolved,
    resolvedAt: r.resolved_at,
    resolvedByRunId: r.resolved_by_run_id,
    fromTaskId: r.from_task_id,
    createdAt: r.created_at,
    userId: r.user_id ?? null,
  };
}

function toRun(r: RunRow): Run {
  return {
    id: r.id,
    taskId: r.task_id,
    status: r.status,
    prompt: r.prompt,
    summary: r.summary,
    error: r.error,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    userId: r.user_id ?? null,
    nodeId: r.node_id,
    nodeName: r.node_name,
  };
}

function toRunEvent(r: RunEventRow): RunEvent {
  return {
    seq: Number(r.seq),
    runId: r.run_id,
    taskId: r.task_id,
    kind: r.kind,
    text: r.text,
    createdAt: r.created_at,
  };
}

function toScheduler(r: SchedulerRow): Scheduler {
  return {
    id: r.id,
    boardId: r.board_id,
    name: r.name,
    prompt: r.prompt,
    cron: r.cron,
    timezone: r.timezone,
    enabled: r.enabled,
    maxRuns: r.max_runs == null ? null : Number(r.max_runs),
    runCount: Number(r.run_count),
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
    lastStatus: r.last_status,
    lastTaskId: r.last_task_id,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    userId: r.user_id ?? null,
  };
}

function toSchedulerRun(r: SchedulerRunRow): SchedulerRun {
  return {
    id: r.id,
    schedulerId: r.scheduler_id,
    taskId: r.task_id,
    trigger: r.trigger,
    scheduledFor: r.scheduled_for,
    status: r.status,
    error: r.error,
    createdAt: r.created_at,
  };
}

function toUser(r: UserRow): User {
  return {
    id: r.id,
    username: r.username,
    email: r.email,
    role: r.role,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toUserAuth(r: UserRow): UserAuthRecord {
  return { ...toUser(r), passwordHash: r.password_hash, tokenEpoch: Number(r.token_epoch) };
}

/** Normalizes the `limit` of `listSchedulerRuns` into 1..1000 (default 100). */
function normalizeSchedulerRunLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 100;
  return Math.min(1000, Math.max(1, Math.floor(limit)));
}

/** Builds `a = $1, b = $2` for an UPDATE from the defined entries only (undefined = leave as is). */
function buildSet(fields: [column: string, value: unknown][]): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [column, value] of fields) {
    if (value === undefined) continue;
    params.push(value);
    parts.push(`${column} = $${params.length}`);
  }
  return { sql: parts.join(", "), params };
}

/** JSON-encodes a nullable JSON column the way updateTask stores it (null stays SQL NULL). */
function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** How each data table is exported (key column, row mapper) and imported (columns + values in order). */
interface TableSpec<T extends DataTable> {
  key: string;
  /** Takes the driver row type of the table (a `never` parameter accepts any of them). */
  toRow: (row: never) => DataRows[T];
  columns: string[];
  values: (row: DataRows[T]) => unknown[];
}

const TABLE_SPECS: { [T in DataTable]: TableSpec<T> } = {
  settings: {
    key: "key",
    toRow: (r: { key: string; value: string }) => ({ key: r.key, value: r.value }),
    columns: ["key", "value"],
    values: (s) => [s.key, s.value],
  },
  users: {
    key: "id",
    toRow: toUserAuth,
    columns: ["id", "username", "email", "password_hash", "role", "is_active", "token_epoch", "created_at", "updated_at"],
    values: (u) => [u.id, u.username, u.email, u.passwordHash, u.role, u.isActive, u.tokenEpoch, u.createdAt, u.updatedAt],
  },
  boards: {
    key: "id",
    toRow: toBoard,
    columns: [
      "id", "name", "workdir", "extra_folders", "model", "auto_run", "push_branch",
      "default_branches", "pinned", "last_accessed_at", "created_at", "updated_at", "user_id",
    ],
    values: (b) => [
      b.id, b.name, b.workdir, JSON.stringify(b.extraFolders), b.model, b.autoRun, b.pushBranch,
      JSON.stringify(b.defaultBranches), b.pinned, b.lastAccessedAt, b.createdAt, b.updatedAt, b.userId,
    ],
  },
  tasks: {
    key: "id",
    toRow: (r: TaskRow): TaskRecord => {
      const { commentCount: _c, openCommentCount: _o, ...task } = toTask({ ...r, comment_count: 0, open_comment_count: 0 });
      return task;
    },
    columns: [
      "id", "board_id", "title", "description", "status", "position", "agent_state", "agent_error", "question",
      "session_file", "last_run_id", "blocked_by", "created_by_task_id", "pushed_at", "auto_retries", "retry_at",
      "todos", "review", "resources", "session_usage", "scheduler_id", "parallelize", "ignore_memory",
      "created_at", "updated_at", "user_id",
    ],
    values: (t) => [
      t.id, t.boardId, t.title, t.description, t.status, t.position, t.agentState, t.agentError, t.question,
      t.sessionFile, t.lastRunId, JSON.stringify(t.blockedBy), t.createdByTaskId, t.pushedAt, t.autoRetries,
      t.retryAt, JSON.stringify(t.todos), jsonOrNull(t.review), jsonOrNull(t.resources), jsonOrNull(t.usage),
      t.schedulerId, t.parallelize, t.ignoreMemory, t.createdAt, t.updatedAt, t.userId,
    ],
  },
  comments: {
    key: "id",
    toRow: toComment,
    columns: [
      "id", "task_id", "author", "body", "resolved", "resolved_at", "resolved_by_run_id", "from_task_id",
      "created_at", "user_id",
    ],
    values: (c) => [
      c.id, c.taskId, c.author, c.body, c.resolved, c.resolvedAt, c.resolvedByRunId, c.fromTaskId, c.createdAt,
      c.userId,
    ],
  },
  runs: {
    key: "id",
    toRow: toRun,
    columns: [
      "id", "task_id", "status", "prompt", "summary", "error", "started_at", "ended_at", "user_id", "node_id",
      "node_name",
    ],
    values: (r) => [
      r.id, r.taskId, r.status, r.prompt, r.summary, r.error, r.startedAt, r.endedAt, r.userId, r.nodeId,
      r.nodeName,
    ],
  },
  run_events: {
    key: "seq",
    toRow: toRunEvent,
    columns: ["seq", "run_id", "task_id", "kind", "text", "created_at"],
    values: (e) => [e.seq, e.runId, e.taskId, e.kind, e.text, e.createdAt],
  },
  schedulers: {
    key: "id",
    toRow: toScheduler,
    columns: [
      "id", "board_id", "name", "prompt", "cron", "timezone", "enabled", "max_runs", "run_count", "last_run_at",
      "next_run_at", "last_status", "last_task_id", "last_error", "created_at", "updated_at", "user_id",
    ],
    values: (s) => [
      s.id, s.boardId, s.name, s.prompt, s.cron, s.timezone, s.enabled, s.maxRuns, s.runCount, s.lastRunAt,
      s.nextRunAt, s.lastStatus, s.lastTaskId, s.lastError, s.createdAt, s.updatedAt, s.userId,
    ],
  },
  scheduler_runs: {
    key: "id",
    toRow: toSchedulerRun,
    columns: ["id", "scheduler_id", "task_id", "trigger", "scheduled_for", "status", "error", "created_at"],
    values: (r) => [r.id, r.schedulerId, r.taskId, r.trigger, r.scheduledFor, r.status, r.error, r.createdAt],
  },
};

/** Rows per multi-row INSERT; the widest table (tasks, 26 columns) stays far below pg's 65535 parameters. */
const IMPORT_CHUNK = 500;
const EXPORT_BATCH = 500;

export class PostgresRepository implements Repository {
  readonly driver = "postgres" as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  private async query<R extends pg.QueryResultRow>(
    sql: string,
    params: unknown[] = [],
    client?: pg.PoolClient,
  ): Promise<pg.QueryResult<R>> {
    // Separate calls: `query` is overloaded on both types, so a union receiver doesn't typecheck.
    if (client) return client.query<R>(sql, params);
    return this.pool.query<R>(sql, params);
  }

  private async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async init(): Promise<void> {
    const [before, after] = await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK_KEY]);
      const snapshot = await this.schemaSnapshot(client);
      await client.query(SCHEMA);
      return [snapshot, await this.schemaSnapshot(client)];
    });
    logSchemaMigrations("postgres", before, after);
  }

  /** Current schema's tables (with their columns) and indexes, diffed by `init()` to log migrations. */
  private async schemaSnapshot(client: pg.PoolClient): Promise<SchemaSnapshot> {
    const columns = new Map<string, Set<string>>();
    const columnRows = await client.query<{ table_name: string; column_name: string }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()",
    );
    for (const row of columnRows.rows) {
      let set = columns.get(row.table_name);
      if (!set) columns.set(row.table_name, (set = new Set()));
      set.add(row.column_name);
    }
    const indexRows = await client.query<{ indexname: string; tablename: string }>(
      "SELECT indexname, tablename FROM pg_indexes WHERE schemaname = current_schema()",
    );
    return { columns, indexes: new Map(indexRows.rows.map((r) => [r.indexname, r.tablename])) };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async *exportRows<T extends DataTable>(table: T): AsyncIterable<DataRows[T][]> {
    const spec = TABLE_SPECS[table] as TableSpec<T>;
    let last: unknown;
    for (;;) {
      const res =
        last === undefined
          ? await this.query(`SELECT * FROM ${table} ORDER BY ${spec.key} LIMIT ${EXPORT_BATCH}`)
          : await this.query(
              `SELECT * FROM ${table} WHERE ${spec.key} > $1 ORDER BY ${spec.key} LIMIT ${EXPORT_BATCH}`,
              [last],
            );
      if (res.rows.length === 0) return;
      yield res.rows.map(spec.toRow as (row: pg.QueryResultRow) => DataRows[T]);
      if (res.rows.length < EXPORT_BATCH) return;
      last = res.rows[res.rows.length - 1][spec.key];
    }
  }

  /**
   * One transaction: wipe every table (children first), insert the snapshot verbatim, then move
   * the run_events sequence past the highest imported seq.
   */
  async replaceAllData(data: DataSnapshot): Promise<void> {
    await this.transaction(async (client) => {
      for (const table of [...DATA_TABLES].reverse()) await this.query(`DELETE FROM ${table}`, [], client);
      for (const table of DATA_TABLES) {
        const spec = TABLE_SPECS[table] as TableSpec<typeof table>;
        const rows = data[table] as DataRows[typeof table][];
        const width = spec.columns.length;
        for (let start = 0; start < rows.length; start += IMPORT_CHUNK) {
          const chunk = rows.slice(start, start + IMPORT_CHUNK);
          const params = chunk.flatMap((row) => spec.values(row));
          const tuples = chunk.map(
            (_, i) => `(${spec.columns.map((_c, j) => `$${i * width + j + 1}`).join(", ")})`,
          );
          await this.query(
            `INSERT INTO ${table} (${spec.columns.join(", ")}) VALUES ${tuples.join(", ")}`,
            params,
            client,
          );
        }
      }
      // is_called = false when empty, so the next appendRunEvent gets seq 1.
      await this.query(
        `SELECT setval(pg_get_serial_sequence('run_events', 'seq'), GREATEST(m, 1), m IS NOT NULL)
         FROM (SELECT MAX(seq) AS m FROM run_events) s`,
        [],
        client,
      );
    });
  }

  // ---------------------------------------------------------------- settings

  async getSetting(key: string): Promise<string | null> {
    const res = await this.query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key]);
    return res.rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.query(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [key, value],
    );
  }

  async deleteSetting(key: string): Promise<void> {
    await this.query("DELETE FROM settings WHERE key = $1", [key]);
  }

  // ------------------------------------------------------------------- users

  async listUsers(): Promise<User[]> {
    const res = await this.query<UserRow>("SELECT * FROM users ORDER BY created_at ASC, id ASC");
    return res.rows.map(toUser);
  }

  async getUser(id: string): Promise<User | null> {
    const res = await this.query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
    return res.rows[0] ? toUser(res.rows[0]) : null;
  }

  async getUserAuth(id: string): Promise<UserAuthRecord | null> {
    const res = await this.query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
    return res.rows[0] ? toUserAuth(res.rows[0]) : null;
  }

  async findUserAuthByLogin(login: string): Promise<UserAuthRecord | null> {
    const res = await this.query<UserRow>("SELECT * FROM users WHERE username = $1 OR email = $1 LIMIT 1", [login]);
    return res.rows[0] ? toUserAuth(res.rows[0]) : null;
  }

  async createUser(input: CreateUserInput): Promise<User> {
    const now = nowIso();
    // UNIQUE constraints on username/email make a taken name fail the insert.
    const res = await this.query<UserRow>(
      `INSERT INTO users (id, username, email, password_hash, role, is_active, token_epoch, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $7) RETURNING *`,
      [newId(), input.username, input.email ?? null, input.passwordHash, input.role, input.isActive ?? true, now],
    );
    return toUser(res.rows[0]);
  }

  async updateUser(id: string, patch: UpdateUserInput): Promise<User | null> {
    const { sql, params } = buildSet([
      ["username", patch.username],
      ["email", patch.email],
      ["password_hash", patch.passwordHash],
      ["role", patch.role],
      ["is_active", patch.isActive],
      ["token_epoch", patch.tokenEpoch],
      ["updated_at", nowIso()],
    ]);
    const res = await this.query<UserRow>(
      `UPDATE users SET ${sql} WHERE id = $${params.length + 1} RETURNING *`,
      [...params, id],
    );
    return res.rows[0] ? toUser(res.rows[0]) : null;
  }

  async deleteUser(id: string): Promise<boolean> {
    const res = await this.query("DELETE FROM users WHERE id = $1", [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async reassignUserData(fromUserId: string | null, toUserId: string): Promise<number> {
    const owner = fromUserId === null ? "user_id IS NULL" : "user_id = $2";
    const params = fromUserId === null ? [toUserId] : [toUserId, fromUserId];
    return this.transaction(async (client) => {
      const boards = await this.query(`UPDATE boards SET user_id = $1 WHERE ${owner}`, params, client);
      for (const table of ["tasks", "comments", "runs", "schedulers"]) {
        await this.query(`UPDATE ${table} SET user_id = $1 WHERE ${owner}`, params, client);
      }
      return boards.rowCount ?? 0;
    });
  }

  // ------------------------------------------------------------------ boards

  async listBoards(userId?: string): Promise<BoardWithCounts[]> {
    // Tasks carry their board's owner, so the stats query filters on the same column.
    const where = userId === undefined ? "" : "WHERE user_id = $1";
    const params = userId === undefined ? [] : [userId];
    const [boards, stats] = await Promise.all([
      this.query<BoardRow>(`SELECT * FROM boards ${where} ORDER BY created_at DESC`, params),
      this.query<{ board_id: string; status: TaskStatus; n: number; active: number }>(
        `SELECT board_id, status, COUNT(*)::int AS n,
           SUM(CASE WHEN agent_state IN ('running', 'queued') THEN 1 ELSE 0 END)::int AS active
         FROM tasks ${where} GROUP BY board_id, status`,
        params,
      ),
    ]);
    const byBoard = new Map<string, BoardWithCounts>();
    const result = boards.rows.map((row) => {
      const board: BoardWithCounts = { ...toBoard(row), counts: emptyStatusCounts(), runningCount: 0 };
      byBoard.set(board.id, board);
      return board;
    });
    for (const row of stats.rows) {
      const board = byBoard.get(row.board_id);
      if (!board) continue;
      if (row.status in board.counts) board.counts[row.status] = Number(row.n);
      board.runningCount += Number(row.active);
    }
    return result;
  }

  async getBoard(id: string): Promise<Board | null> {
    const res = await this.query<BoardRow>("SELECT * FROM boards WHERE id = $1", [id]);
    return res.rows[0] ? toBoard(res.rows[0]) : null;
  }

  async createBoard(input: CreateBoardInput): Promise<Board> {
    const now = nowIso();
    const res = await this.query<BoardRow>(
      `INSERT INTO boards (id, name, workdir, extra_folders, model, auto_run, push_branch, default_branches, created_at, updated_at, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10) RETURNING *`,
      [
        newId(),
        input.name,
        input.workdir,
        JSON.stringify(input.extraFolders ?? []),
        input.model ?? null,
        input.autoRun ?? true,
        input.pushBranch ?? DEFAULT_PUSH_BRANCH,
        JSON.stringify(input.defaultBranches ?? {}),
        now,
        input.userId ?? null,
      ],
    );
    return toBoard(res.rows[0]);
  }

  async updateBoard(id: string, patch: UpdateBoardInput): Promise<Board | null> {
    const { sql, params } = buildSet([
      ["name", patch.name],
      ["workdir", patch.workdir],
      ["extra_folders", patch.extraFolders === undefined ? undefined : JSON.stringify(patch.extraFolders)],
      ["model", patch.model],
      ["auto_run", patch.autoRun],
      ["push_branch", patch.pushBranch],
      [
        "default_branches",
        patch.defaultBranches === undefined ? undefined : JSON.stringify(patch.defaultBranches),
      ],
      ["pinned", patch.pinned],
      ["updated_at", boardPatchUpdatedAt(patch)],
    ]);
    const res = await this.query<BoardRow>(
      `UPDATE boards SET ${sql} WHERE id = $${params.length + 1} RETURNING *`,
      [...params, id],
    );
    return res.rows[0] ? toBoard(res.rows[0]) : null;
  }

  async markBoardAccessed(id: string): Promise<Board | null> {
    const res = await this.query<BoardRow>("UPDATE boards SET last_accessed_at = $1 WHERE id = $2 RETURNING *", [
      nowIso(),
      id,
    ]);
    return res.rows[0] ? toBoard(res.rows[0]) : null;
  }

  async deleteBoard(id: string): Promise<boolean> {
    const res = await this.query("DELETE FROM boards WHERE id = $1", [id]);
    return (res.rowCount ?? 0) > 0;
  }

  // ------------------------------------------------------------------- tasks

  async listTasks(boardId: string): Promise<Task[]> {
    const res = await this.query<TaskRow>(`${TASK_SELECT} WHERE t.board_id = $1 ${TASK_ORDER}`, [boardId]);
    return res.rows.map(toTask);
  }

  async listTasksByAgentState(states: AgentState[], userId?: string): Promise<Task[]> {
    if (states.length === 0) return [];
    const res =
      userId === undefined
        ? await this.query<TaskRow>(
            `${TASK_SELECT} WHERE t.agent_state = ANY($1::text[]) ORDER BY t.updated_at ASC, t.created_at ASC`,
            [states],
          )
        : await this.query<TaskRow>(
            `${TASK_SELECT} WHERE t.agent_state = ANY($1::text[]) AND t.user_id = $2
             ORDER BY t.updated_at ASC, t.created_at ASC`,
            [states, userId],
          );
    return res.rows.map(toTask);
  }

  async getTask(id: string): Promise<Task | null> {
    const res = await this.query<TaskRow>(`${TASK_SELECT} WHERE t.id = $1`, [id]);
    return res.rows[0] ? toTask(res.rows[0]) : null;
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const status = input.status ?? "todo";
    const id = newId();
    const now = nowIso();
    await this.transaction(async (client) => {
      let position = input.position;
      if (position === undefined) {
        const res = await this.query<{ m: number | null }>(
          "SELECT MAX(position) AS m FROM tasks WHERE board_id = $1 AND status = $2",
          [input.boardId, status],
          client,
        );
        const max = res.rows[0]?.m;
        position = max == null ? POSITION_STEP : Number(max) + POSITION_STEP;
      }
      await this.query(
        `INSERT INTO tasks (id, board_id, title, description, status, position, agent_state, blocked_by, created_by_task_id, scheduler_id, parallelize, ignore_memory, created_at, updated_at, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'idle', $7, $8, $9, $10, $11, $12, $12, (SELECT user_id FROM boards WHERE id = $2))`,
        [
          id,
          input.boardId,
          input.title,
          input.description ?? "",
          status,
          position,
          JSON.stringify(input.blockedBy ?? []),
          input.createdByTaskId ?? null,
          input.schedulerId ?? null,
          input.parallelize ?? null,
          input.ignoreMemory ?? false,
          now,
        ],
        client,
      );
    });
    const task = await this.getTask(id);
    if (!task) throw new Error(`Task ${id} vanished after insert`);
    return task;
  }

  async updateTask(id: string, patch: UpdateTaskInput): Promise<Task | null> {
    const { sql, params } = buildSet([
      ["title", patch.title],
      ["description", patch.description],
      ["status", patch.status],
      ["position", patch.position],
      ["agent_state", patch.agentState],
      ["agent_error", patch.agentError],
      ["question", patch.question],
      ["session_file", patch.sessionFile],
      ["last_run_id", patch.lastRunId],
      ["blocked_by", patch.blockedBy === undefined ? undefined : JSON.stringify(patch.blockedBy)],
      ["pushed_at", patch.pushedAt],
      ["auto_retries", patch.autoRetries],
      ["retry_at", patch.retryAt],
      ["todos", patch.todos === undefined ? undefined : JSON.stringify(patch.todos)],
      ["review", patch.review === undefined ? undefined : patch.review === null ? null : JSON.stringify(patch.review)],
      ["ignore_memory", patch.ignoreMemory],
      [
        "resources",
        patch.resources === undefined ? undefined : patch.resources === null ? null : JSON.stringify(patch.resources),
      ],
      ["session_usage", patch.usage === undefined ? undefined : patch.usage === null ? null : JSON.stringify(patch.usage)],
      ["updated_at", touchesTask(patch) ? nowIso() : undefined],
    ]);
    const res = await this.query(`UPDATE tasks SET ${sql} WHERE id = $${params.length + 1}`, [
      ...params,
      id,
    ]);
    if ((res.rowCount ?? 0) === 0) return null;
    return this.getTask(id);
  }

  async deleteTask(id: string): Promise<boolean> {
    const res = await this.query("DELETE FROM tasks WHERE id = $1", [id]);
    return (res.rowCount ?? 0) > 0;
  }

  // ---------------------------------------------------------------- comments

  async listComments(taskId: string): Promise<Comment[]> {
    const res = await this.query<CommentRow>(
      "SELECT * FROM comments WHERE task_id = $1 ORDER BY created_at ASC, id ASC",
      [taskId],
    );
    return res.rows.map(toComment);
  }

  async getComment(id: string): Promise<Comment | null> {
    const res = await this.query<CommentRow>("SELECT * FROM comments WHERE id = $1", [id]);
    return res.rows[0] ? toComment(res.rows[0]) : null;
  }

  async addComment(input: CreateCommentInput): Promise<Comment> {
    const now = nowIso();
    const resolved = input.resolved ?? input.author === "agent";
    const res = await this.query<CommentRow>(
      `INSERT INTO comments (id, task_id, author, body, resolved, resolved_at, resolved_by_run_id, from_task_id, created_at, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, (SELECT user_id FROM tasks WHERE id = $2)) RETURNING *`,
      [
        newId(),
        input.taskId,
        input.author,
        input.body,
        resolved,
        resolved ? now : null,
        input.fromTaskId ?? null,
        now,
      ],
    );
    return toComment(res.rows[0]);
  }

  async setCommentResolved(
    id: string,
    resolved: boolean,
    runId?: string | null,
  ): Promise<Comment | null> {
    const res = resolved
      ? await this.query<CommentRow>(
          "UPDATE comments SET resolved = TRUE, resolved_at = $1, resolved_by_run_id = $2 WHERE id = $3 RETURNING *",
          [nowIso(), runId ?? null, id],
        )
      : await this.query<CommentRow>(
          "UPDATE comments SET resolved = FALSE, resolved_at = NULL, resolved_by_run_id = NULL WHERE id = $1 RETURNING *",
          [id],
        );
    return res.rows[0] ? toComment(res.rows[0]) : null;
  }

  async resolveComments(ids: string[], runId: string): Promise<Comment[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    // A single UPDATE is atomic; no explicit transaction needed.
    const res = await this.query<CommentRow>(
      `UPDATE comments SET resolved = TRUE, resolved_at = $1, resolved_by_run_id = $2
       WHERE id = ANY($3::text[]) AND resolved = FALSE RETURNING *`,
      [nowIso(), runId, unique],
    );
    const order = new Map(unique.map((id, i) => [id, i]));
    return res.rows
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map(toComment);
  }

  async deleteComment(id: string): Promise<boolean> {
    const res = await this.query("DELETE FROM comments WHERE id = $1", [id]);
    return (res.rowCount ?? 0) > 0;
  }

  // -------------------------------------------------------------------- runs

  async listRuns(taskId: string): Promise<Run[]> {
    const res = await this.query<RunRow>(
      "SELECT * FROM runs WHERE task_id = $1 ORDER BY started_at DESC, id DESC",
      [taskId],
    );
    return res.rows.map(toRun);
  }

  async listRecentRuns(limit?: number, userId?: string): Promise<Run[]> {
    const res =
      userId === undefined
        ? await this.query<RunRow>("SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT $1", [
            normalizeRecentRunLimit(limit),
          ])
        : await this.query<RunRow>(
            "SELECT * FROM runs WHERE user_id = $1 ORDER BY started_at DESC, id DESC LIMIT $2",
            [userId, normalizeRecentRunLimit(limit)],
          );
    return res.rows.map(toRun);
  }

  async getRun(id: string): Promise<Run | null> {
    const res = await this.query<RunRow>("SELECT * FROM runs WHERE id = $1", [id]);
    return res.rows[0] ? toRun(res.rows[0]) : null;
  }

  async createRun(input: CreateRunInput): Promise<Run> {
    const res = await this.query<RunRow>(
      `INSERT INTO runs (id, task_id, status, prompt, summary, error, started_at, ended_at, user_id, node_id, node_name)
       VALUES ($1, $2, 'running', $3, NULL, NULL, $4, NULL, (SELECT user_id FROM tasks WHERE id = $2), $5, $6) RETURNING *`,
      [newId(), input.taskId, input.prompt, nowIso(), input.nodeId ?? null, input.nodeName ?? null],
    );
    return toRun(res.rows[0]);
  }

  async updateRun(id: string, patch: UpdateRunInput): Promise<Run | null> {
    const { sql, params } = buildSet([
      ["status", patch.status],
      ["summary", patch.summary],
      ["error", patch.error],
      ["ended_at", patch.endedAt],
    ]);
    if (params.length === 0) return this.getRun(id);
    const res = await this.query<RunRow>(
      `UPDATE runs SET ${sql} WHERE id = $${params.length + 1} RETURNING *`,
      [...params, id],
    );
    return res.rows[0] ? toRun(res.rows[0]) : null;
  }

  async abortRunningRuns(reason: string): Promise<number> {
    const res = await this.query(
      "UPDATE runs SET status = 'aborted', error = $1, ended_at = $2 WHERE status = 'running'",
      [reason, nowIso()],
    );
    return res.rowCount ?? 0;
  }

  // -------------------------------------------------------------- run events

  async appendRunEvent(input: AppendRunEventInput): Promise<RunEvent> {
    const res = await this.query<RunEventRow>(
      `INSERT INTO run_events (run_id, task_id, kind, text, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.runId, input.taskId, input.kind, input.text, nowIso()],
    );
    return toRunEvent(res.rows[0]);
  }

  async listRunEvents(runId: string, after?: number, limit?: number): Promise<RunEvent[]> {
    const res = await this.query<RunEventRow>(
      "SELECT * FROM run_events WHERE run_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3",
      [runId, normalizeAfter(after), normalizeLimit(limit)],
    );
    return res.rows.map(toRunEvent);
  }

  // -------------------------------------------------------------- schedulers

  async listSchedulers(boardId?: string, userId?: string): Promise<Scheduler[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (boardId !== undefined) {
      params.push(boardId);
      conditions.push(`board_id = $${params.length}`);
    }
    if (userId !== undefined) {
      params.push(userId);
      conditions.push(`user_id = $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const res = await this.query<SchedulerRow>(
      `SELECT * FROM schedulers ${where} ORDER BY created_at DESC, id DESC`,
      params,
    );
    return res.rows.map(toScheduler);
  }

  async getScheduler(id: string): Promise<Scheduler | null> {
    const res = await this.query<SchedulerRow>("SELECT * FROM schedulers WHERE id = $1", [id]);
    return res.rows[0] ? toScheduler(res.rows[0]) : null;
  }

  async createScheduler(input: CreateSchedulerInput): Promise<Scheduler> {
    const now = nowIso();
    const res = await this.query<SchedulerRow>(
      `INSERT INTO schedulers (id, board_id, name, prompt, cron, timezone, enabled, max_runs, run_count,
         last_run_at, next_run_at, last_status, last_task_id, last_error, created_at, updated_at, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, NULL, $9, NULL, NULL, NULL, $10, $10,
         (SELECT user_id FROM boards WHERE id = $2)) RETURNING *`,
      [
        newId(),
        input.boardId,
        input.name,
        input.prompt,
        input.cron,
        input.timezone,
        input.enabled ?? true,
        input.maxRuns ?? null,
        input.nextRunAt ?? null,
        now,
      ],
    );
    return toScheduler(res.rows[0]);
  }

  async updateScheduler(id: string, patch: UpdateSchedulerInput): Promise<Scheduler | null> {
    const set = buildSet([
      ["board_id", patch.boardId],
      ["name", patch.name],
      ["prompt", patch.prompt],
      ["cron", patch.cron],
      ["timezone", patch.timezone],
      ["enabled", patch.enabled],
      ["max_runs", patch.maxRuns],
      ["run_count", patch.runCount],
      ["last_run_at", patch.lastRunAt],
      ["next_run_at", patch.nextRunAt],
      ["last_status", patch.lastStatus],
      ["last_task_id", patch.lastTaskId],
      ["last_error", patch.lastError],
      ["updated_at", nowIso()],
    ]);
    const params = set.params;
    let sql = set.sql;
    if (patch.boardId !== undefined) {
      // Moving to another board moves the scheduler to that board's owner.
      params.push(patch.boardId);
      sql += `, user_id = (SELECT user_id FROM boards WHERE id = $${params.length})`;
    }
    const res = await this.query<SchedulerRow>(
      `UPDATE schedulers SET ${sql} WHERE id = $${params.length + 1} RETURNING *`,
      [...params, id],
    );
    return res.rows[0] ? toScheduler(res.rows[0]) : null;
  }

  async deleteScheduler(id: string): Promise<boolean> {
    return this.transaction(async (client) => {
      // Its cards stay on the board, detached; its run history goes with it (FK cascade).
      await this.query("UPDATE tasks SET scheduler_id = NULL WHERE scheduler_id = $1", [id], client);
      const res = await this.query("DELETE FROM schedulers WHERE id = $1", [id], client);
      return (res.rowCount ?? 0) > 0;
    });
  }

  // ---------------------------------------------------------- scheduler runs

  async listSchedulerRuns(schedulerId: string, limit?: number): Promise<SchedulerRun[]> {
    const res = await this.query<SchedulerRunRow>(
      "SELECT * FROM scheduler_runs WHERE scheduler_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
      [schedulerId, normalizeSchedulerRunLimit(limit)],
    );
    return res.rows.map(toSchedulerRun);
  }

  async createSchedulerRun(input: CreateSchedulerRunInput): Promise<SchedulerRun> {
    const res = await this.query<SchedulerRunRow>(
      `INSERT INTO scheduler_runs (id, scheduler_id, task_id, trigger, scheduled_for, status, error, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        newId(),
        input.schedulerId,
        input.taskId,
        input.trigger,
        input.scheduledFor,
        input.status,
        input.error ?? null,
        nowIso(),
      ],
    );
    return toSchedulerRun(res.rows[0]);
  }
}
