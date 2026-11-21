import fs from "node:fs";
import path from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";

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
  SchedulerRunStatus,
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
  DataRows,
  DataSnapshot,
  DataTable,
  Repository,
  UpdateBoardInput,
  UpdateRunInput,
  UpdateSchedulerInput,
  UpdateTaskInput,
  UpdateUserInput,
  UserAuthRecord,
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

type Row = Record<string, SQLOutputValue>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  is_active INTEGER NOT NULL DEFAULT 1,
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
  auto_run INTEGER NOT NULL DEFAULT 1,
  worktrees INTEGER NOT NULL DEFAULT 0,
  push_branch TEXT NOT NULL DEFAULT 'main',
  default_branches TEXT NOT NULL DEFAULT '{}',
  pinned INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
  position REAL NOT NULL,
  agent_state TEXT NOT NULL DEFAULT 'idle' CHECK (agent_state IN ('idle', 'queued', 'running', 'error')),
  agent_error TEXT,
  question TEXT,
  session_file TEXT,
  last_run_id TEXT,
  created_by_task_id TEXT,
  pushed_at TEXT,
  auto_retries INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  todos TEXT NOT NULL DEFAULT '[]',
  review TEXT,
  resources TEXT,
  session_usage TEXT,
  scheduler_id TEXT,
  parallelize INTEGER,
  ignore_memory INTEGER NOT NULL DEFAULT 0,
  user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_board_status_position ON tasks (board_id, status, position);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_state ON tasks (agent_state);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author TEXT NOT NULL CHECK (author IN ('user', 'agent')),
  body TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  resolved_by_run_id TEXT,
  from_task_id TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL
);
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
CREATE INDEX IF NOT EXISTS idx_runs_task_started ON runs (task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at);

CREATE TABLE IF NOT EXISTS run_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
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
  enabled INTEGER NOT NULL DEFAULT 1,
  max_runs INTEGER,
  run_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  next_run_at TEXT,
  last_status TEXT CHECK (last_status IN ('created', 'failed')),
  last_task_id TEXT,
  last_error TEXT,
  model TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedulers_board ON schedulers (board_id);

-- task_id has no foreign key: the history row outlives its card.
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
  (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count,
  (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id AND c.author = 'user' AND c.resolved = 0) AS open_comment_count
FROM tasks t`;

const TASK_ORDER = `
ORDER BY CASE t.status WHEN 'todo' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, t.position ASC, t.created_at ASC`;

function str(v: SQLOutputValue): string {
  return v == null ? "" : String(v);
}

function strOrNull(v: SQLOutputValue): string | null {
  return v == null ? null : String(v);
}

function num(v: SQLOutputValue): number {
  return v == null ? 0 : Number(v);
}

function toBoard(r: Row): Board {
  return {
    id: str(r.id),
    name: str(r.name),
    workdir: str(r.workdir),
    extraFolders: parseFolderList(r.extra_folders),
    model: strOrNull(r.model),
    autoRun: num(r.auto_run) !== 0,
    worktrees: num(r.worktrees) !== 0,
    pushBranch: strOrNull(r.push_branch) ?? DEFAULT_PUSH_BRANCH,
    defaultBranches: parseBranchMap(r.default_branches),
    pinned: num(r.pinned) !== 0,
    lastAccessedAt: strOrNull(r.last_accessed_at),
    userId: strOrNull(r.user_id),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function toTask(r: Row): Task {
  return {
    id: str(r.id),
    boardId: str(r.board_id),
    title: str(r.title),
    description: str(r.description),
    status: str(r.status) as TaskStatus,
    position: num(r.position),
    agentState: str(r.agent_state) as AgentState,
    agentError: strOrNull(r.agent_error),
    question: strOrNull(r.question),
    sessionFile: strOrNull(r.session_file),
    lastRunId: strOrNull(r.last_run_id),
    createdByTaskId: strOrNull(r.created_by_task_id),
    pushedAt: strOrNull(r.pushed_at),
    autoRetries: num(r.auto_retries),
    retryAt: strOrNull(r.retry_at),
    todos: parseTodoPhases(r.todos),
    review: parseTaskReview(r.review),
    resources: parseAgentResources(r.resources),
    usage: parseTaskUsage(r.session_usage),
    schedulerId: strOrNull(r.scheduler_id),
    ignoreMemory: r.ignore_memory != null && num(r.ignore_memory) !== 0,
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    commentCount: num(r.comment_count),
    openCommentCount: num(r.open_comment_count),
    userId: strOrNull(r.user_id),
  };
}

function toComment(r: Row): Comment {
  return {
    id: str(r.id),
    taskId: str(r.task_id),
    author: str(r.author) as CommentAuthor,
    body: str(r.body),
    resolved: num(r.resolved) !== 0,
    resolvedAt: strOrNull(r.resolved_at),
    resolvedByRunId: strOrNull(r.resolved_by_run_id),
    fromTaskId: strOrNull(r.from_task_id),
    userId: strOrNull(r.user_id),
    createdAt: str(r.created_at),
  };
}

function toRun(r: Row): Run {
  return {
    id: str(r.id),
    taskId: str(r.task_id),
    status: str(r.status) as RunStatus,
    prompt: str(r.prompt),
    summary: strOrNull(r.summary),
    error: strOrNull(r.error),
    startedAt: str(r.started_at),
    endedAt: strOrNull(r.ended_at),
    userId: strOrNull(r.user_id),
    nodeId: strOrNull(r.node_id),
    nodeName: strOrNull(r.node_name),
  };
}

function toRunEvent(r: Row): RunEvent {
  return {
    seq: num(r.seq),
    runId: str(r.run_id),
    taskId: str(r.task_id),
    kind: str(r.kind) as RunEventKind,
    text: str(r.text),
    createdAt: str(r.created_at),
  };
}

function toScheduler(r: Row): Scheduler {
  return {
    id: str(r.id),
    boardId: str(r.board_id),
    name: str(r.name),
    prompt: str(r.prompt),
    cron: str(r.cron),
    timezone: str(r.timezone),
    enabled: num(r.enabled) !== 0,
    maxRuns: r.max_runs == null ? null : Number(r.max_runs),
    runCount: num(r.run_count),
    lastRunAt: strOrNull(r.last_run_at),
    nextRunAt: strOrNull(r.next_run_at),
    lastStatus: strOrNull(r.last_status) as SchedulerRunStatus | null,
    lastTaskId: strOrNull(r.last_task_id),
    lastError: strOrNull(r.last_error),
    model: strOrNull(r.model),
    userId: strOrNull(r.user_id),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function toSchedulerRun(r: Row): SchedulerRun {
  return {
    id: str(r.id),
    schedulerId: str(r.scheduler_id),
    taskId: strOrNull(r.task_id),
    trigger: str(r.trigger) as SchedulerRun["trigger"],
    scheduledFor: str(r.scheduled_for),
    status: str(r.status) as SchedulerRunStatus,
    error: strOrNull(r.error),
    createdAt: str(r.created_at),
  };
}

function toUser(r: Row): User {
  return {
    id: str(r.id),
    username: str(r.username),
    email: strOrNull(r.email),
    role: str(r.role) as UserRole,
    isActive: num(r.is_active) !== 0,
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function toUserAuth(r: Row): UserAuthRecord {
  return { ...toUser(r), passwordHash: str(r.password_hash), tokenEpoch: num(r.token_epoch) };
}

/** Normalizes the `limit` of `listSchedulerRuns` into 1..1000 (default 100). */
function normalizeSchedulerRunLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 100;
  return Math.min(1000, Math.max(1, Math.floor(limit)));
}

/** Builds `a = ?, b = ?` for an UPDATE from the defined entries only (undefined = leave as is). */
function buildSet(
  fields: [column: string, value: SQLInputValue | undefined][],
): { sql: string; params: SQLInputValue[] } {
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  for (const [column, value] of fields) {
    if (value === undefined) continue;
    parts.push(`${column} = ?`);
    params.push(value);
  }
  return { sql: parts.join(", "), params };
}

/** Rows per batch of `exportRows`. */
const EXPORT_BATCH = 500;

/** How a data table's rows map to domain records: primary key, columns (insert order), both directions. */
interface TableSpec<R> {
  key: string;
  columns: string[];
  read(r: Row): R;
  /** Values for `columns`, in order. */
  write(row: R): SQLInputValue[];
}

function bit(value: boolean): number {
  return value ? 1 : 0;
}

function jsonOrNull(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

const DATA_COLUMNS: { [T in DataTable]: TableSpec<DataRows[T]> } = {
  settings: {
    key: "key",
    columns: ["key", "value"],
    read: (r) => ({ key: str(r.key), value: str(r.value) }),
    write: (s) => [s.key, s.value],
  },
  users: {
    key: "id",
    columns: ["id", "username", "email", "password_hash", "role", "is_active", "token_epoch", "created_at", "updated_at"],
    read: toUserAuth,
    write: (u) => [u.id, u.username, u.email, u.passwordHash, u.role, bit(u.isActive), u.tokenEpoch, u.createdAt, u.updatedAt],
  },
  boards: {
    key: "id",
    columns: [
      "id",
      "name",
      "workdir",
      "extra_folders",
      "model",
      "auto_run",
      "worktrees",
      "push_branch",
      "default_branches",
      "pinned",
      "last_accessed_at",
      "user_id",
      "created_at",
      "updated_at",
    ],
    read: toBoard,
    write: (b) => [
      b.id,
      b.name,
      b.workdir,
      JSON.stringify(b.extraFolders),
      b.model,
      bit(b.autoRun),
      bit(b.worktrees),
      b.pushBranch,
      JSON.stringify(b.defaultBranches),
      bit(b.pinned),
      b.lastAccessedAt,
      b.userId,
      b.createdAt,
      b.updatedAt,
    ],
  },
  tasks: {
    key: "id",
    columns: [
      "id",
      "board_id",
      "title",
      "description",
      "status",
      "position",
      "agent_state",
      "agent_error",
      "question",
      "session_file",
      "last_run_id",
      "created_by_task_id",
      "pushed_at",
      "auto_retries",
      "retry_at",
      "todos",
      "review",
      "resources",
      "session_usage",
      "scheduler_id",
      "ignore_memory",
      "user_id",
      "created_at",
      "updated_at",
    ],
    read: (r) => {
      const { commentCount: _total, openCommentCount: _open, ...row } = toTask(r);
      return row;
    },
    write: (t) => [
      t.id,
      t.boardId,
      t.title,
      t.description,
      t.status,
      t.position,
      t.agentState,
      t.agentError,
      t.question,
      t.sessionFile,
      t.lastRunId,
      t.createdByTaskId,
      t.pushedAt,
      t.autoRetries,
      t.retryAt,
      JSON.stringify(t.todos),
      jsonOrNull(t.review),
      jsonOrNull(t.resources),
      jsonOrNull(t.usage),
      t.schedulerId,
      bit(t.ignoreMemory),
      t.userId,
      t.createdAt,
      t.updatedAt,
    ],
  },
  comments: {
    key: "id",
    columns: [
      "id",
      "task_id",
      "author",
      "body",
      "resolved",
      "resolved_at",
      "resolved_by_run_id",
      "from_task_id",
      "user_id",
      "created_at",
    ],
    read: toComment,
    write: (c) => [
      c.id,
      c.taskId,
      c.author,
      c.body,
      bit(c.resolved),
      c.resolvedAt,
      c.resolvedByRunId,
      c.fromTaskId,
      c.userId,
      c.createdAt,
    ],
  },
  runs: {
    key: "id",
    columns: ["id", "task_id", "status", "prompt", "summary", "error", "started_at", "ended_at", "user_id", "node_id", "node_name"],
    read: toRun,
    write: (r) => [r.id, r.taskId, r.status, r.prompt, r.summary, r.error, r.startedAt, r.endedAt, r.userId, r.nodeId, r.nodeName],
  },
  run_events: {
    key: "seq",
    columns: ["seq", "run_id", "task_id", "kind", "text", "created_at"],
    read: toRunEvent,
    write: (e) => [e.seq, e.runId, e.taskId, e.kind, e.text, e.createdAt],
  },
  schedulers: {
    key: "id",
    columns: [
      "id",
      "board_id",
      "name",
      "prompt",
      "cron",
      "timezone",
      "enabled",
      "max_runs",
      "run_count",
      "last_run_at",
      "next_run_at",
      "last_status",
      "last_task_id",
      "last_error",
      "model",
      "user_id",
      "created_at",
      "updated_at",
    ],
    read: toScheduler,
    write: (s) => [
      s.id,
      s.boardId,
      s.name,
      s.prompt,
      s.cron,
      s.timezone,
      bit(s.enabled),
      s.maxRuns,
      s.runCount,
      s.lastRunAt,
      s.nextRunAt,
      s.lastStatus,
      s.lastTaskId,
      s.lastError,
      s.model,
      s.userId,
      s.createdAt,
      s.updatedAt,
    ],
  },
  scheduler_runs: {
    key: "id",
    columns: ["id", "scheduler_id", "task_id", "trigger", "scheduled_for", "status", "error", "created_at"],
    read: toSchedulerRun,
    write: (r) => [r.id, r.schedulerId, r.taskId, r.trigger, r.scheduledFor, r.status, r.error, r.createdAt],
  },
};

export class SqliteRepository implements Repository {
  readonly driver = "sqlite" as const;
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(private readonly file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async init(): Promise<void> {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    const before = this.schemaSnapshot();
    this.db.exec(SCHEMA);
    // Migrations for databases created before these columns existed.
    this.addMissingColumns("boards", [
      ["extra_folders", "TEXT NOT NULL DEFAULT '[]'"],
      ["worktrees", "INTEGER NOT NULL DEFAULT 0"],
      ["push_branch", "TEXT NOT NULL DEFAULT 'main'"],
      ["default_branches", "TEXT NOT NULL DEFAULT '{}'"],
      ["pinned", "INTEGER NOT NULL DEFAULT 0"],
      ["last_accessed_at", "TEXT"],
      ["user_id", "TEXT"],
    ]);
    this.addMissingColumns("tasks", [
      ["created_by_task_id", "TEXT"],
      ["question", "TEXT"],
      ["pushed_at", "TEXT"],
      ["auto_retries", "INTEGER NOT NULL DEFAULT 0"],
      ["todos", "TEXT NOT NULL DEFAULT '[]'"],
      ["review", "TEXT"],
      ["resources", "TEXT"],
      ["session_usage", "TEXT"],
      ["scheduler_id", "TEXT"],
      ["parallelize", "INTEGER"],
      ["ignore_memory", "INTEGER NOT NULL DEFAULT 0"],
      ["user_id", "TEXT"],
    ]);
    this.addMissingColumns("comments", [
      ["from_task_id", "TEXT"],
      ["user_id", "TEXT"],
    ]);
    this.addMissingColumns("runs", [
      ["user_id", "TEXT"],
      ["node_id", "TEXT"],
      ["node_name", "TEXT"],
    ]);
    this.addMissingColumns("schedulers", [
      ["user_id", "TEXT"],
      ["model", "TEXT"],
    ]);
    // After the migrations: older databases only now have these columns.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_scheduler ON tasks (scheduler_id);
      CREATE INDEX IF NOT EXISTS idx_boards_user ON boards (user_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks (user_id);
      CREATE INDEX IF NOT EXISTS idx_runs_user_started ON runs (user_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_schedulers_user ON schedulers (user_id);
    `);
    logSchemaMigrations("sqlite", before, this.schemaSnapshot());
  }

  /** Current tables (with their columns) and indexes, diffed by `init()` to log migrations. */
  private schemaSnapshot(): SchemaSnapshot {
    const columns = new Map<string, Set<string>>();
    const columnRows = this.db
      .prepare(
        `SELECT m.name AS tbl, c.name AS col FROM sqlite_master m, pragma_table_info(m.name) c
         WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'`,
      )
      .all();
    for (const row of columnRows) {
      const table = str(row.tbl);
      let set = columns.get(table);
      if (!set) columns.set(table, (set = new Set()));
      set.add(str(row.col));
    }
    const indexRows = this.db
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
      .all();
    return { columns, indexes: new Map(indexRows.map((r) => [str(r.name), str(r.tbl_name)])) };
  }

  private addMissingColumns(table: string, columns: [name: string, definition: string][]): void {
    const existing = new Set(
      this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => str(c.name)),
    );
    for (const [name, definition] of columns) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }

  /** `user_id` of the row `id` in `table` (the owner a child row inherits); null when unowned or missing. */
  private ownerOf(table: "boards" | "tasks", id: string): string | null {
    const row = this.stmt(`SELECT user_id FROM ${table} WHERE id = ?`).get(id);
    return row ? strOrNull(row.user_id) : null;
  }

  async close(): Promise<void> {
    this.statements.clear();
    if (this.db.isOpen) this.db.close();
  }

  async compactableBytes(): Promise<number> {
    const row = this.db
      .prepare("SELECT freelist_count * page_size AS bytes FROM pragma_freelist_count(), pragma_page_size()")
      .get() as { bytes: number } | undefined;
    const free = Number(row?.bytes ?? 0);
    let wal = 0;
    try {
      wal = fs.statSync(`${this.file}-wal`).size;
    } catch {
      // No WAL file (in-memory database or nothing written yet).
    }
    return free + wal;
  }

  async compact(): Promise<void> {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.exec("VACUUM");
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  // ---------------------------------------------------------------- settings

  async getSetting(key: string): Promise<string | null> {
    const row = this.stmt("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? strOrNull(row.value) : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.stmt(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  }

  async deleteSetting(key: string): Promise<void> {
    this.stmt("DELETE FROM settings WHERE key = ?").run(key);
  }

  // ------------------------------------------------------------------- users

  async listUsers(): Promise<User[]> {
    return this.stmt("SELECT * FROM users ORDER BY created_at ASC, rowid ASC").all().map(toUser);
  }

  async getUser(id: string): Promise<User | null> {
    const row = this.stmt("SELECT * FROM users WHERE id = ?").get(id);
    return row ? toUser(row) : null;
  }

  async getUserAuth(id: string): Promise<UserAuthRecord | null> {
    const row = this.stmt("SELECT * FROM users WHERE id = ?").get(id);
    return row ? toUserAuth(row) : null;
  }

  async findUserAuthByLogin(login: string): Promise<UserAuthRecord | null> {
    const row = this.stmt("SELECT * FROM users WHERE username = ? OR email = ? LIMIT 1").get(login, login);
    return row ? toUserAuth(row) : null;
  }

  async createUser(input: CreateUserInput): Promise<User> {
    const now = nowIso();
    const user: User = {
      id: newId(),
      username: input.username,
      email: input.email ?? null,
      role: input.role,
      isActive: input.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    };
    // UNIQUE(username) / UNIQUE(email) violations throw: the caller maps them to 409.
    this.stmt(
      `INSERT INTO users (id, username, email, password_hash, role, is_active, token_epoch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      user.id,
      user.username,
      user.email,
      input.passwordHash,
      user.role,
      user.isActive ? 1 : 0,
      user.createdAt,
      user.updatedAt,
    );
    return user;
  }

  async updateUser(id: string, patch: UpdateUserInput): Promise<User | null> {
    const { sql, params } = buildSet([
      ["username", patch.username],
      ["email", patch.email],
      ["password_hash", patch.passwordHash],
      ["role", patch.role],
      ["is_active", patch.isActive === undefined ? undefined : patch.isActive ? 1 : 0],
      ["token_epoch", patch.tokenEpoch],
      ["updated_at", nowIso()],
    ]);
    const res = this.db.prepare(`UPDATE users SET ${sql} WHERE id = ?`).run(...params, id);
    if (Number(res.changes) === 0) return null;
    return this.getUser(id);
  }

  async deleteUser(id: string): Promise<boolean> {
    const res = this.stmt("DELETE FROM users WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  async reassignUserData(fromUserId: string | null, toUserId: string): Promise<number> {
    const where = fromUserId === null ? "user_id IS NULL" : "user_id = ?";
    const params: SQLInputValue[] = fromUserId === null ? [toUserId] : [toUserId, fromUserId];
    return this.transaction(() => {
      const boards = this.stmt(`UPDATE boards SET user_id = ? WHERE ${where}`).run(...params);
      for (const table of ["tasks", "comments", "runs", "schedulers"]) {
        this.stmt(`UPDATE ${table} SET user_id = ? WHERE ${where}`).run(...params);
      }
      return Number(boards.changes);
    });
  }

  // ------------------------------------------------------------------ boards

  async listBoards(userId?: string): Promise<BoardWithCounts[]> {
    const owned = userId !== undefined;
    const boards = (
      owned
        ? this.stmt("SELECT * FROM boards WHERE user_id = ? ORDER BY created_at DESC").all(userId)
        : this.stmt("SELECT * FROM boards ORDER BY created_at DESC").all()
    ).map(toBoard);
    const stats = this.stmt(
      `SELECT board_id, status, COUNT(*) AS n,
         SUM(CASE WHEN agent_state IN ('running', 'queued') THEN 1 ELSE 0 END) AS active
       FROM tasks ${owned ? "WHERE user_id = ?" : ""} GROUP BY board_id, status`,
    ).all(...(owned ? [userId] : []));
    const byBoard = new Map<string, BoardWithCounts>();
    const result = boards.map((b) => {
      const withCounts: BoardWithCounts = { ...b, counts: emptyStatusCounts(), runningCount: 0 };
      byBoard.set(b.id, withCounts);
      return withCounts;
    });
    for (const row of stats) {
      const board = byBoard.get(str(row.board_id));
      if (!board) continue;
      const status = str(row.status) as TaskStatus;
      if (status in board.counts) board.counts[status] = num(row.n);
      board.runningCount += num(row.active);
    }
    return result;
  }

  async getBoard(id: string): Promise<Board | null> {
    const row = this.stmt("SELECT * FROM boards WHERE id = ?").get(id);
    return row ? toBoard(row) : null;
  }

  async createBoard(input: CreateBoardInput): Promise<Board> {
    const now = nowIso();
    const board: Board = {
      id: newId(),
      name: input.name,
      workdir: input.workdir,
      extraFolders: input.extraFolders ?? [],
      model: input.model ?? null,
      autoRun: input.autoRun ?? true,
      worktrees: input.worktrees ?? false,
      pushBranch: input.pushBranch ?? DEFAULT_PUSH_BRANCH,
      defaultBranches: input.defaultBranches ?? {},
      pinned: false,
      lastAccessedAt: null,
      userId: input.userId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.stmt(
      "INSERT INTO boards (id, name, workdir, extra_folders, model, auto_run, worktrees, push_branch, default_branches, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      board.id,
      board.name,
      board.workdir,
      JSON.stringify(board.extraFolders),
      board.model,
      board.autoRun ? 1 : 0,
      board.worktrees ? 1 : 0,
      board.pushBranch,
      JSON.stringify(board.defaultBranches),
      board.userId,
      board.createdAt,
      board.updatedAt,
    );
    return board;
  }

  async updateBoard(id: string, patch: UpdateBoardInput): Promise<Board | null> {
    const { sql, params } = buildSet([
      ["name", patch.name],
      ["workdir", patch.workdir],
      ["extra_folders", patch.extraFolders === undefined ? undefined : JSON.stringify(patch.extraFolders)],
      ["model", patch.model],
      ["auto_run", patch.autoRun === undefined ? undefined : patch.autoRun ? 1 : 0],
      ["worktrees", patch.worktrees === undefined ? undefined : patch.worktrees ? 1 : 0],
      ["push_branch", patch.pushBranch],
      [
        "default_branches",
        patch.defaultBranches === undefined ? undefined : JSON.stringify(patch.defaultBranches),
      ],
      ["pinned", patch.pinned === undefined ? undefined : patch.pinned ? 1 : 0],
      ["updated_at", boardPatchUpdatedAt(patch)],
    ]);
    const res = this.db.prepare(`UPDATE boards SET ${sql} WHERE id = ?`).run(...params, id);
    if (Number(res.changes) === 0) return null;
    return this.getBoard(id);
  }

  async markBoardAccessed(id: string): Promise<Board | null> {
    const res = this.stmt("UPDATE boards SET last_accessed_at = ? WHERE id = ?").run(nowIso(), id);
    if (Number(res.changes) === 0) return null;
    return this.getBoard(id);
  }

  async deleteBoard(id: string): Promise<boolean> {
    return this.transaction(() => {
      // Tasks, comments, runs, run events, schedulers and scheduler runs cascade via foreign keys.
      // A scheduler moved here from another board may have cards there: unlink them first.
      this.stmt(
        "UPDATE tasks SET scheduler_id = NULL WHERE scheduler_id IN (SELECT id FROM schedulers WHERE board_id = ?)",
      ).run(id);
      const res = this.stmt("DELETE FROM boards WHERE id = ?").run(id);
      return Number(res.changes) > 0;
    });
  }

  // ------------------------------------------------------------------- tasks

  async listTasks(boardId: string): Promise<Task[]> {
    return this.stmt(`${TASK_SELECT} WHERE t.board_id = ? ${TASK_ORDER}`).all(boardId).map(toTask);
  }

  async listTasksByAgentState(states: AgentState[], userId?: string): Promise<Task[]> {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(", ");
    const owned = userId !== undefined;
    return this.db
      .prepare(
        `${TASK_SELECT} WHERE t.agent_state IN (${placeholders}) ${owned ? "AND t.user_id = ?" : ""}
         ORDER BY t.updated_at ASC, t.created_at ASC`,
      )
      .all(...states, ...(owned ? [userId] : []))
      .map(toTask);
  }

  async getTask(id: string): Promise<Task | null> {
    const row = this.stmt(`${TASK_SELECT} WHERE t.id = ?`).get(id);
    return row ? toTask(row) : null;
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const status = input.status ?? "todo";
    const id = newId();
    const now = nowIso();
    this.transaction(() => {
      let position = input.position;
      if (position === undefined) {
        const row = this.stmt(
          "SELECT MAX(position) AS m FROM tasks WHERE board_id = ? AND status = ?",
        ).get(input.boardId, status);
        position = row && row.m != null ? Number(row.m) + POSITION_STEP : POSITION_STEP;
      }
      // The card inherits its board's owner.
      this.stmt(
        `INSERT INTO tasks (id, board_id, title, description, status, position, agent_state, created_by_task_id, scheduler_id, ignore_memory, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.boardId,
        input.title,
        input.description ?? "",
        status,
        position,
        input.createdByTaskId ?? null,
        input.schedulerId ?? null,
        input.ignoreMemory ? 1 : 0,
        this.ownerOf("boards", input.boardId),
        now,
        now,
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
      ["pushed_at", patch.pushedAt],
      ["auto_retries", patch.autoRetries],
      ["retry_at", patch.retryAt],
      ["todos", patch.todos === undefined ? undefined : JSON.stringify(patch.todos)],
      ["review", patch.review === undefined ? undefined : patch.review === null ? null : JSON.stringify(patch.review)],
      ["ignore_memory", patch.ignoreMemory === undefined ? undefined : patch.ignoreMemory ? 1 : 0],
      [
        "resources",
        patch.resources === undefined ? undefined : patch.resources === null ? null : JSON.stringify(patch.resources),
      ],
      ["session_usage", patch.usage === undefined ? undefined : patch.usage === null ? null : JSON.stringify(patch.usage)],
      ["updated_at", touchesTask(patch) ? nowIso() : undefined],
    ]);
    const res = this.db.prepare(`UPDATE tasks SET ${sql} WHERE id = ?`).run(...params, id);
    if (Number(res.changes) === 0) return null;
    return this.getTask(id);
  }

  async deleteTask(id: string): Promise<boolean> {
    const res = this.stmt("DELETE FROM tasks WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  // ---------------------------------------------------------------- comments

  async listComments(taskId: string): Promise<Comment[]> {
    return this.stmt("SELECT * FROM comments WHERE task_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(taskId)
      .map(toComment);
  }

  async getComment(id: string): Promise<Comment | null> {
    const row = this.stmt("SELECT * FROM comments WHERE id = ?").get(id);
    return row ? toComment(row) : null;
  }

  async addComment(input: CreateCommentInput): Promise<Comment> {
    const now = nowIso();
    const resolved = input.resolved ?? input.author === "agent";
    const comment: Comment = {
      id: newId(),
      taskId: input.taskId,
      author: input.author,
      body: input.body,
      resolved,
      resolvedAt: resolved ? now : null,
      resolvedByRunId: null,
      fromTaskId: input.fromTaskId ?? null,
      userId: this.ownerOf("tasks", input.taskId),
      createdAt: now,
    };
    this.stmt(
      `INSERT INTO comments (id, task_id, author, body, resolved, resolved_at, resolved_by_run_id, from_task_id, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      comment.id,
      comment.taskId,
      comment.author,
      comment.body,
      comment.resolved ? 1 : 0,
      comment.resolvedAt,
      comment.resolvedByRunId,
      comment.fromTaskId,
      comment.userId,
      comment.createdAt,
    );
    return comment;
  }

  async setCommentResolved(
    id: string,
    resolved: boolean,
    runId?: string | null,
  ): Promise<Comment | null> {
    const res = resolved
      ? this.stmt(
          "UPDATE comments SET resolved = 1, resolved_at = ?, resolved_by_run_id = ? WHERE id = ?",
        ).run(nowIso(), runId ?? null, id)
      : this.stmt(
          "UPDATE comments SET resolved = 0, resolved_at = NULL, resolved_by_run_id = NULL WHERE id = ?",
        ).run(id);
    if (Number(res.changes) === 0) return null;
    return this.getComment(id);
  }

  async resolveComments(ids: string[], runId: string): Promise<Comment[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const now = nowIso();
    return this.transaction(() => {
      const update = this.stmt(
        "UPDATE comments SET resolved = 1, resolved_at = ?, resolved_by_run_id = ? WHERE id = ? AND resolved = 0",
      );
      const select = this.stmt("SELECT * FROM comments WHERE id = ?");
      const updated: Comment[] = [];
      for (const id of unique) {
        if (Number(update.run(now, runId, id).changes) === 0) continue;
        const row = select.get(id);
        if (row) updated.push(toComment(row));
      }
      return updated;
    });
  }

  async deleteComment(id: string): Promise<boolean> {
    const res = this.stmt("DELETE FROM comments WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  // -------------------------------------------------------------------- runs

  async listRuns(taskId: string): Promise<Run[]> {
    return this.stmt("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC")
      .all(taskId)
      .map(toRun);
  }

  async listRecentRuns(limit?: number, userId?: string): Promise<Run[]> {
    const rows =
      userId === undefined
        ? this.stmt("SELECT * FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?").all(
            normalizeRecentRunLimit(limit),
          )
        : this.stmt("SELECT * FROM runs WHERE user_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(
            userId,
            normalizeRecentRunLimit(limit),
          );
    return rows.map(toRun);
  }

  async getRun(id: string): Promise<Run | null> {
    const row = this.stmt("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? toRun(row) : null;
  }

  async createRun(input: CreateRunInput): Promise<Run> {
    const run: Run = {
      id: newId(),
      taskId: input.taskId,
      status: "running",
      prompt: input.prompt,
      summary: null,
      error: null,
      startedAt: nowIso(),
      endedAt: null,
      userId: this.ownerOf("tasks", input.taskId),
      nodeId: input.nodeId ?? null,
      nodeName: input.nodeName ?? null,
    };
    this.stmt(
      `INSERT INTO runs (id, task_id, status, prompt, summary, error, started_at, ended_at, user_id, node_id, node_name)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?)`,
    ).run(run.id, run.taskId, run.status, run.prompt, run.startedAt, run.userId, run.nodeId, run.nodeName);
    return run;
  }

  async updateRun(id: string, patch: UpdateRunInput): Promise<Run | null> {
    const { sql, params } = buildSet([
      ["status", patch.status],
      ["summary", patch.summary],
      ["error", patch.error],
      ["ended_at", patch.endedAt],
    ]);
    if (params.length === 0) return this.getRun(id);
    const res = this.db.prepare(`UPDATE runs SET ${sql} WHERE id = ?`).run(...params, id);
    if (Number(res.changes) === 0) return null;
    return this.getRun(id);
  }

  async abortRunningRuns(reason: string): Promise<number> {
    const res = this.stmt(
      "UPDATE runs SET status = 'aborted', error = ?, ended_at = ? WHERE status = 'running'",
    ).run(reason, nowIso());
    return Number(res.changes);
  }

  // -------------------------------------------------------------- run events

  async appendRunEvent(input: AppendRunEventInput): Promise<RunEvent> {
    const createdAt = nowIso();
    const res = this.stmt(
      "INSERT INTO run_events (run_id, task_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(input.runId, input.taskId, input.kind, input.text, createdAt);
    return {
      seq: Number(res.lastInsertRowid),
      runId: input.runId,
      taskId: input.taskId,
      kind: input.kind,
      text: input.text,
      createdAt,
    };
  }

  async listRunEvents(runId: string, after?: number, limit?: number): Promise<RunEvent[]> {
    return this.stmt(
      "SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
    )
      .all(runId, normalizeAfter(after), normalizeLimit(limit))
      .map(toRunEvent);
  }

  // -------------------------------------------------------------- schedulers

  async listSchedulers(boardId?: string, userId?: string): Promise<Scheduler[]> {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (boardId !== undefined) {
      where.push("board_id = ?");
      params.push(boardId);
    }
    if (userId !== undefined) {
      where.push("user_id = ?");
      params.push(userId);
    }
    const filter = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.stmt(`SELECT * FROM schedulers ${filter} ORDER BY created_at DESC, rowid DESC`)
      .all(...params)
      .map(toScheduler);
  }

  async getScheduler(id: string): Promise<Scheduler | null> {
    const row = this.stmt("SELECT * FROM schedulers WHERE id = ?").get(id);
    return row ? toScheduler(row) : null;
  }

  async createScheduler(input: CreateSchedulerInput): Promise<Scheduler> {
    const now = nowIso();
    const scheduler: Scheduler = {
      id: newId(),
      boardId: input.boardId,
      name: input.name,
      prompt: input.prompt,
      cron: input.cron,
      timezone: input.timezone,
      enabled: input.enabled ?? true,
      maxRuns: input.maxRuns ?? null,
      runCount: 0,
      lastRunAt: null,
      nextRunAt: input.nextRunAt ?? null,
      lastStatus: null,
      lastTaskId: null,
      lastError: null,
      model: input.model ?? null,
      userId: this.ownerOf("boards", input.boardId),
      createdAt: now,
      updatedAt: now,
    };
    this.stmt(
      `INSERT INTO schedulers (id, board_id, name, prompt, cron, timezone, enabled, max_runs, run_count, last_run_at, next_run_at, last_status, last_task_id, last_error, model, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
    ).run(
      scheduler.id,
      scheduler.boardId,
      scheduler.name,
      scheduler.prompt,
      scheduler.cron,
      scheduler.timezone,
      scheduler.enabled ? 1 : 0,
      scheduler.maxRuns,
      scheduler.nextRunAt,
      scheduler.model,
      scheduler.userId,
      scheduler.createdAt,
      scheduler.updatedAt,
    );
    return scheduler;
  }

  async updateScheduler(id: string, patch: UpdateSchedulerInput): Promise<Scheduler | null> {
    const { sql, params } = buildSet([
      ["board_id", patch.boardId],
      // Moving to another board moves the scheduler to that board's owner.
      ["user_id", patch.boardId === undefined ? undefined : this.ownerOf("boards", patch.boardId)],
      ["name", patch.name],
      ["prompt", patch.prompt],
      ["cron", patch.cron],
      ["timezone", patch.timezone],
      ["enabled", patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0],
      ["max_runs", patch.maxRuns],
      ["run_count", patch.runCount],
      ["last_run_at", patch.lastRunAt],
      ["next_run_at", patch.nextRunAt],
      ["last_status", patch.lastStatus],
      ["last_task_id", patch.lastTaskId],
      ["last_error", patch.lastError],
      ["model", patch.model],
      ["updated_at", nowIso()],
    ]);
    const res = this.db.prepare(`UPDATE schedulers SET ${sql} WHERE id = ?`).run(...params, id);
    if (Number(res.changes) === 0) return null;
    return this.getScheduler(id);
  }

  async deleteScheduler(id: string): Promise<boolean> {
    return this.transaction(() => {
      // Its cards stay; only their link to the scheduler goes. Scheduler runs cascade.
      this.stmt("UPDATE tasks SET scheduler_id = NULL WHERE scheduler_id = ?").run(id);
      const res = this.stmt("DELETE FROM schedulers WHERE id = ?").run(id);
      return Number(res.changes) > 0;
    });
  }

  // ---------------------------------------------------------- scheduler runs

  async listSchedulerRuns(schedulerId: string, limit?: number): Promise<SchedulerRun[]> {
    return this.stmt(
      "SELECT * FROM scheduler_runs WHERE scheduler_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    )
      .all(schedulerId, normalizeSchedulerRunLimit(limit))
      .map(toSchedulerRun);
  }

  async createSchedulerRun(input: CreateSchedulerRunInput): Promise<SchedulerRun> {
    const run: SchedulerRun = {
      id: newId(),
      schedulerId: input.schedulerId,
      taskId: input.taskId,
      trigger: input.trigger,
      scheduledFor: input.scheduledFor,
      status: input.status,
      error: input.error ?? null,
      createdAt: nowIso(),
    };
    this.stmt(
      `INSERT INTO scheduler_runs (id, scheduler_id, task_id, trigger, scheduled_for, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id,
      run.schedulerId,
      run.taskId,
      run.trigger,
      run.scheduledFor,
      run.status,
      run.error,
      run.createdAt,
    );
    return run;
  }

  // ------------------------------------------------------------ export/import

  async *exportRows<T extends DataTable>(table: T): AsyncGenerator<DataRows[T][]> {
    const spec = DATA_COLUMNS[table] as unknown as TableSpec<DataRows[T]>;
    const first = this.stmt(`SELECT * FROM ${table} ORDER BY ${spec.key} LIMIT ${EXPORT_BATCH}`);
    const next = this.stmt(`SELECT * FROM ${table} WHERE ${spec.key} > ? ORDER BY ${spec.key} LIMIT ${EXPORT_BATCH}`);
    let last: SQLOutputValue | undefined;
    for (;;) {
      const rows = last === undefined ? first.all() : next.all(last as SQLInputValue);
      if (rows.length > 0) yield rows.map(spec.read);
      if (rows.length < EXPORT_BATCH) return;
      last = rows[rows.length - 1]![spec.key];
    }
  }

  async replaceAllData(data: DataSnapshot): Promise<void> {
    // Synchronous from BEGIN to COMMIT: no other request's statement can land in between.
    this.transaction(() => {
      for (const table of [...DATA_TABLES].reverse()) this.db.exec(`DELETE FROM ${table}`);
      // AUTOINCREMENT remembers the highest seq ever used; start over from the imported events.
      this.db.exec("DELETE FROM sqlite_sequence WHERE name = 'run_events'");
      for (const table of DATA_TABLES) {
        const spec = DATA_COLUMNS[table] as unknown as TableSpec<DataRows[typeof table]>;
        const insert = this.stmt(
          `INSERT INTO ${table} (${spec.columns.join(", ")}) VALUES (${spec.columns.map(() => "?").join(", ")})`,
        );
        for (const row of data[table]) insert.run(...spec.write(row));
      }
    });
  }
}
