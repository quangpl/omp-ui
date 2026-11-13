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
} from "@/lib/types";
import type {
  AppendRunEventInput,
  CreateBoardInput,
  CreateCommentInput,
  CreateRunInput,
  CreateSchedulerInput,
  CreateSchedulerRunInput,
  CreateTaskInput,
  Repository,
  UpdateBoardInput,
  UpdateRunInput,
  UpdateSchedulerInput,
  UpdateTaskInput,
} from "@/lib/db/types";
import {
  POSITION_STEP,
  type SchemaSnapshot,
  emptyStatusCounts,
  logSchemaMigrations,
  newId,
  normalizeAfter,
  normalizeLimit,
  normalizeRecentRunLimit,
  nowIso,
  parseFolderList,
} from "@/lib/db/util";
import { parseTodoPhases } from "@/lib/todos";

type Row = Record<string, SQLOutputValue>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workdir TEXT NOT NULL,
  extra_folders TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  auto_run INTEGER NOT NULL DEFAULT 1,
  worktrees INTEGER NOT NULL DEFAULT 0,
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
  blocked_by TEXT NOT NULL DEFAULT '[]',
  created_by_task_id TEXT,
  pushed_at TEXT,
  auto_retries INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  todos TEXT NOT NULL DEFAULT '[]',
  scheduler_id TEXT,
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
  ended_at TEXT
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
    blockedBy: parseFolderList(r.blocked_by),
    createdByTaskId: strOrNull(r.created_by_task_id),
    pushedAt: strOrNull(r.pushed_at),
    autoRetries: num(r.auto_retries),
    retryAt: strOrNull(r.retry_at),
    todos: parseTodoPhases(r.todos),
    schedulerId: strOrNull(r.scheduler_id),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    commentCount: num(r.comment_count),
    openCommentCount: num(r.open_comment_count),
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
    ]);
    this.addMissingColumns("tasks", [
      ["blocked_by", "TEXT NOT NULL DEFAULT '[]'"],
      ["created_by_task_id", "TEXT"],
      ["question", "TEXT"],
      ["pushed_at", "TEXT"],
      ["auto_retries", "INTEGER NOT NULL DEFAULT 0"],
      ["todos", "TEXT NOT NULL DEFAULT '[]'"],
      ["scheduler_id", "TEXT"],
    ]);
    // After the migration: older databases only now have tasks.scheduler_id.
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_scheduler ON tasks (scheduler_id)");
    this.addMissingColumns("comments", [["from_task_id", "TEXT"]]);
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

  // ------------------------------------------------------------------ boards

  async listBoards(): Promise<BoardWithCounts[]> {
    const boards = this.stmt("SELECT * FROM boards ORDER BY created_at DESC").all().map(toBoard);
    const stats = this.stmt(
      `SELECT board_id, status, COUNT(*) AS n,
         SUM(CASE WHEN agent_state IN ('running', 'queued') THEN 1 ELSE 0 END) AS active
       FROM tasks GROUP BY board_id, status`,
    ).all();
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
      createdAt: now,
      updatedAt: now,
    };
    this.stmt(
      "INSERT INTO boards (id, name, workdir, extra_folders, model, auto_run, worktrees, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      board.id,
      board.name,
      board.workdir,
      JSON.stringify(board.extraFolders),
      board.model,
      board.autoRun ? 1 : 0,
      board.worktrees ? 1 : 0,
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
      ["updated_at", nowIso()],
    ]);
    const res = this.db.prepare(`UPDATE boards SET ${sql} WHERE id = ?`).run(...params, id);
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

  async listTasksByAgentState(states: AgentState[]): Promise<Task[]> {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(", ");
    return this.db
      .prepare(
        `${TASK_SELECT} WHERE t.agent_state IN (${placeholders}) ORDER BY t.updated_at ASC, t.created_at ASC`,
      )
      .all(...states)
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
      this.stmt(
        `INSERT INTO tasks (id, board_id, title, description, status, position, agent_state, blocked_by, created_by_task_id, scheduler_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.boardId,
        input.title,
        input.description ?? "",
        status,
        position,
        JSON.stringify(input.blockedBy ?? []),
        input.createdByTaskId ?? null,
        input.schedulerId ?? null,
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
      ["blocked_by", patch.blockedBy === undefined ? undefined : JSON.stringify(patch.blockedBy)],
      ["pushed_at", patch.pushedAt],
      ["auto_retries", patch.autoRetries],
      ["retry_at", patch.retryAt],
      ["todos", patch.todos === undefined ? undefined : JSON.stringify(patch.todos)],
      ["updated_at", nowIso()],
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
      createdAt: now,
    };
    this.stmt(
      `INSERT INTO comments (id, task_id, author, body, resolved, resolved_at, resolved_by_run_id, from_task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      comment.id,
      comment.taskId,
      comment.author,
      comment.body,
      comment.resolved ? 1 : 0,
      comment.resolvedAt,
      comment.resolvedByRunId,
      comment.fromTaskId,
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

  async listRecentRuns(limit?: number): Promise<Run[]> {
    return this.stmt("SELECT * FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?")
      .all(normalizeRecentRunLimit(limit))
      .map(toRun);
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
    };
    this.stmt(
      `INSERT INTO runs (id, task_id, status, prompt, summary, error, started_at, ended_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL)`,
    ).run(run.id, run.taskId, run.status, run.prompt, run.startedAt);
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

  async listSchedulers(boardId?: string): Promise<Scheduler[]> {
    const rows =
      boardId === undefined
        ? this.stmt("SELECT * FROM schedulers ORDER BY created_at DESC, rowid DESC").all()
        : this.stmt(
            "SELECT * FROM schedulers WHERE board_id = ? ORDER BY created_at DESC, rowid DESC",
          ).all(boardId);
    return rows.map(toScheduler);
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
      createdAt: now,
      updatedAt: now,
    };
    this.stmt(
      `INSERT INTO schedulers (id, board_id, name, prompt, cron, timezone, enabled, max_runs, run_count, last_run_at, next_run_at, last_status, last_task_id, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, NULL, NULL, ?, ?)`,
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
      scheduler.createdAt,
      scheduler.updatedAt,
    );
    return scheduler;
  }

  async updateScheduler(id: string, patch: UpdateSchedulerInput): Promise<Scheduler | null> {
    const { sql, params } = buildSet([
      ["board_id", patch.boardId],
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
}
