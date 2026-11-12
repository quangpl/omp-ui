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
  Task,
  TaskStatus,
} from "@/lib/types";
import type {
  AppendRunEventInput,
  CreateBoardInput,
  CreateCommentInput,
  CreateRunInput,
  CreateTaskInput,
  Repository,
  UpdateBoardInput,
  UpdateRunInput,
  UpdateTaskInput,
} from "@/lib/db/types";
import {
  POSITION_STEP,
  emptyStatusCounts,
  newId,
  normalizeAfter,
  normalizeLimit,
  nowIso,
  parseFolderList,
} from "@/lib/db/util";

/** Arbitrary constant key for the advisory lock serializing schema creation across processes. */
const SCHEMA_LOCK_KEY = 4_708_312_655;

// Timestamps are ISO-8601 TEXT (not TIMESTAMPTZ) so values and ordering match the other drivers exactly.
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
  auto_run BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Migration for databases created before boards had extra folders.
ALTER TABLE boards ADD COLUMN IF NOT EXISTS extra_folders TEXT NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS idx_boards_created ON boards (created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
  position DOUBLE PRECISION NOT NULL,
  agent_state TEXT NOT NULL DEFAULT 'idle' CHECK (agent_state IN ('idle', 'queued', 'running', 'error')),
  agent_error TEXT,
  session_file TEXT,
  last_run_id TEXT,
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
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at TEXT,
  resolved_by_run_id TEXT,
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

CREATE TABLE IF NOT EXISTS run_events (
  seq BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events (run_id, seq);
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
  created_at: string;
  updated_at: string;
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
  session_file: string | null;
  last_run_id: string | null;
  created_at: string;
  updated_at: string;
  comment_count: number;
  open_comment_count: number;
}

interface CommentRow {
  id: string;
  task_id: string;
  author: CommentAuthor;
  body: string;
  resolved: boolean;
  resolved_at: string | null;
  resolved_by_run_id: string | null;
  created_at: string;
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

function toBoard(r: BoardRow): Board {
  return {
    id: r.id,
    name: r.name,
    workdir: r.workdir,
    extraFolders: parseFolderList(r.extra_folders),
    model: r.model,
    autoRun: r.auto_run,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
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
    sessionFile: r.session_file,
    lastRunId: r.last_run_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    commentCount: Number(r.comment_count),
    openCommentCount: Number(r.open_comment_count),
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
    createdAt: r.created_at,
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
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK_KEY]);
      await client.query(SCHEMA);
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
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

  // ------------------------------------------------------------------ boards

  async listBoards(): Promise<BoardWithCounts[]> {
    const [boards, stats] = await Promise.all([
      this.query<BoardRow>("SELECT * FROM boards ORDER BY created_at DESC"),
      this.query<{ board_id: string; status: TaskStatus; n: number; active: number }>(
        `SELECT board_id, status, COUNT(*)::int AS n,
           SUM(CASE WHEN agent_state IN ('running', 'queued') THEN 1 ELSE 0 END)::int AS active
         FROM tasks GROUP BY board_id, status`,
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
      `INSERT INTO boards (id, name, workdir, extra_folders, model, auto_run, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
      [
        newId(),
        input.name,
        input.workdir,
        JSON.stringify(input.extraFolders ?? []),
        input.model ?? null,
        input.autoRun ?? true,
        now,
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
      ["updated_at", nowIso()],
    ]);
    const res = await this.query<BoardRow>(
      `UPDATE boards SET ${sql} WHERE id = $${params.length + 1} RETURNING *`,
      [...params, id],
    );
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

  async listTasksByAgentState(states: AgentState[]): Promise<Task[]> {
    if (states.length === 0) return [];
    const res = await this.query<TaskRow>(
      `${TASK_SELECT} WHERE t.agent_state = ANY($1::text[]) ORDER BY t.updated_at ASC, t.created_at ASC`,
      [states],
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
        `INSERT INTO tasks (id, board_id, title, description, status, position, agent_state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'idle', $7, $7)`,
        [id, input.boardId, input.title, input.description ?? "", status, position, now],
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
      ["session_file", patch.sessionFile],
      ["last_run_id", patch.lastRunId],
      ["updated_at", nowIso()],
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
      `INSERT INTO comments (id, task_id, author, body, resolved, resolved_at, resolved_by_run_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7) RETURNING *`,
      [newId(), input.taskId, input.author, input.body, resolved, resolved ? now : null, now],
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

  async getRun(id: string): Promise<Run | null> {
    const res = await this.query<RunRow>("SELECT * FROM runs WHERE id = $1", [id]);
    return res.rows[0] ? toRun(res.rows[0]) : null;
  }

  async createRun(input: CreateRunInput): Promise<Run> {
    const res = await this.query<RunRow>(
      `INSERT INTO runs (id, task_id, status, prompt, summary, error, started_at, ended_at)
       VALUES ($1, $2, 'running', $3, NULL, NULL, $4, NULL) RETURNING *`,
      [newId(), input.taskId, input.prompt, nowIso()],
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
}
