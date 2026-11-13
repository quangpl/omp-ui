import { MongoClient, type Collection } from "mongodb";

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
  TodoPhase,
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
  compareTasks,
  emptyStatusCounts,
  newId,
  normalizeAfter,
  normalizeLimit,
  nowIso,
  parseFolderList,
} from "@/lib/db/util";
import { parseTodoPhases } from "@/lib/todos";

interface SettingDoc {
  _id: string;
  value: string;
}

interface BoardDoc {
  _id: string;
  name: string;
  workdir: string;
  /** Missing on documents created before boards had extra folders. */
  extraFolders?: string[];
  model: string | null;
  autoRun: boolean;
  /** Missing on documents created before dedicated workspaces. */
  worktrees?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TaskDoc {
  _id: string;
  boardId: string;
  title: string;
  description: string;
  status: TaskStatus;
  position: number;
  agentState: AgentState;
  agentError: string | null;
  /** Missing on documents created before agent questions. */
  question?: string | null;
  sessionFile: string | null;
  lastRunId: string | null;
  /** Missing on documents created before card dependencies. */
  blockedBy?: string[];
  createdByTaskId?: string | null;
  /** Missing on documents created before "pushed" cards. */
  pushedAt?: string | null;
  /** Missing on documents created before automatic retries. */
  autoRetries?: number;
  retryAt?: string | null;
  /** Missing on documents created before agent todo lists. */
  todos?: TodoPhase[];
  createdAt: string;
  updatedAt: string;
}

interface CommentDoc {
  _id: string;
  taskId: string;
  author: CommentAuthor;
  body: string;
  resolved: boolean;
  resolvedAt: string | null;
  resolvedByRunId: string | null;
  /** Missing on documents created before agent-to-agent messages. */
  fromTaskId?: string | null;
  createdAt: string;
}

interface RunDoc {
  _id: string;
  taskId: string;
  status: RunStatus;
  prompt: string;
  summary: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

/** Run events are keyed by their sequence number (`_id` = seq). */
interface RunEventDoc {
  _id: number;
  runId: string;
  taskId: string;
  kind: RunEventKind;
  text: string;
  createdAt: string;
}

interface CounterDoc {
  _id: string;
  seq: number;
}

interface CommentStats {
  total: number;
  open: number;
}

const RUN_EVENTS_COUNTER = "run_events";

function toBoard(d: BoardDoc): Board {
  return {
    id: d._id,
    name: d.name,
    workdir: d.workdir,
    extraFolders: parseFolderList(d.extraFolders),
    model: d.model ?? null,
    autoRun: d.autoRun,
    worktrees: d.worktrees ?? false,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function toTask(d: TaskDoc, stats: CommentStats | undefined): Task {
  return {
    id: d._id,
    boardId: d.boardId,
    title: d.title,
    description: d.description,
    status: d.status,
    position: d.position,
    agentState: d.agentState,
    agentError: d.agentError ?? null,
    question: d.question ?? null,
    sessionFile: d.sessionFile ?? null,
    lastRunId: d.lastRunId ?? null,
    blockedBy: parseFolderList(d.blockedBy),
    createdByTaskId: d.createdByTaskId ?? null,
    pushedAt: d.pushedAt ?? null,
    autoRetries: d.autoRetries ?? 0,
    retryAt: d.retryAt ?? null,
    todos: parseTodoPhases(d.todos),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    commentCount: stats?.total ?? 0,
    openCommentCount: stats?.open ?? 0,
  };
}

function toComment(d: CommentDoc): Comment {
  return {
    id: d._id,
    taskId: d.taskId,
    author: d.author,
    body: d.body,
    resolved: d.resolved,
    resolvedAt: d.resolvedAt ?? null,
    resolvedByRunId: d.resolvedByRunId ?? null,
    fromTaskId: d.fromTaskId ?? null,
    createdAt: d.createdAt,
  };
}

function toRun(d: RunDoc): Run {
  return {
    id: d._id,
    taskId: d.taskId,
    status: d.status,
    prompt: d.prompt,
    summary: d.summary ?? null,
    error: d.error ?? null,
    startedAt: d.startedAt,
    endedAt: d.endedAt ?? null,
  };
}

function toRunEvent(d: RunEventDoc): RunEvent {
  return {
    seq: d._id,
    runId: d.runId,
    taskId: d.taskId,
    kind: d.kind,
    text: d.text,
    createdAt: d.createdAt,
  };
}

/** Copies only the whitelisted, defined keys of `patch` (request bodies may carry extra fields). */
function pickDefined<T extends object, K extends keyof T>(patch: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (patch[key] !== undefined) out[key] = patch[key];
  }
  return out;
}

const BOARD_PATCH_KEYS = ["name", "workdir", "extraFolders", "model", "autoRun", "worktrees"] as const satisfies readonly (keyof UpdateBoardInput)[];
const TASK_PATCH_KEYS = [
  "title",
  "description",
  "status",
  "position",
  "agentState",
  "agentError",
  "question",
  "sessionFile",
  "lastRunId",
  "blockedBy",
  "pushedAt",
  "autoRetries",
  "retryAt",
  "todos",
] as const satisfies readonly (keyof UpdateTaskInput)[];
const RUN_PATCH_KEYS = ["status", "summary", "error", "endedAt"] as const satisfies readonly (keyof UpdateRunInput)[];

export class MongoRepository implements Repository {
  readonly driver = "mongodb" as const;
  private readonly client: MongoClient;
  private readonly settings: Collection<SettingDoc>;
  private readonly boards: Collection<BoardDoc>;
  private readonly tasks: Collection<TaskDoc>;
  private readonly comments: Collection<CommentDoc>;
  private readonly runs: Collection<RunDoc>;
  private readonly runEvents: Collection<RunEventDoc>;
  private readonly counters: Collection<CounterDoc>;

  constructor(url: string, dbName: string) {
    this.client = new MongoClient(url, { appName: "omp-ui" });
    const db = this.client.db(dbName);
    this.settings = db.collection<SettingDoc>("settings");
    this.boards = db.collection<BoardDoc>("boards");
    this.tasks = db.collection<TaskDoc>("tasks");
    this.comments = db.collection<CommentDoc>("comments");
    this.runs = db.collection<RunDoc>("runs");
    this.runEvents = db.collection<RunEventDoc>("run_events");
    this.counters = db.collection<CounterDoc>("counters");
  }

  async init(): Promise<void> {
    await this.client.connect();
    await Promise.all([
      this.boards.createIndex({ createdAt: -1 }),
      this.tasks.createIndex({ boardId: 1, status: 1, position: 1 }),
      this.tasks.createIndex({ agentState: 1 }),
      this.comments.createIndex({ taskId: 1, createdAt: 1 }),
      this.runs.createIndex({ taskId: 1, startedAt: -1 }),
      this.runs.createIndex({ status: 1 }),
      this.runEvents.createIndex({ runId: 1, _id: 1 }),
      this.runEvents.createIndex({ taskId: 1 }),
    ]);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /** Comment totals and open (unresolved user) counts for the given tasks, in one aggregation. */
  private async commentStats(taskIds: string[]): Promise<Map<string, CommentStats>> {
    const stats = new Map<string, CommentStats>();
    if (taskIds.length === 0) return stats;
    const rows = await this.comments
      .aggregate<{ _id: string; total: number; open: number }>([
        { $match: { taskId: { $in: taskIds } } },
        {
          $group: {
            _id: "$taskId",
            total: { $sum: 1 },
            open: {
              $sum: {
                $cond: [{ $and: [{ $eq: ["$author", "user"] }, { $eq: ["$resolved", false] }] }, 1, 0],
              },
            },
          },
        },
      ])
      .toArray();
    for (const row of rows) stats.set(row._id, { total: row.total, open: row.open });
    return stats;
  }

  private async withCommentStats(docs: TaskDoc[]): Promise<Task[]> {
    const stats = await this.commentStats(docs.map((d) => d._id));
    return docs.map((d) => toTask(d, stats.get(d._id)));
  }

  /** Removes comments, runs and run events belonging to the given tasks. */
  private async cascadeTasks(taskIds: string[]): Promise<void> {
    if (taskIds.length === 0) return;
    const filter = { taskId: { $in: taskIds } };
    await Promise.all([
      this.comments.deleteMany(filter),
      this.runs.deleteMany(filter),
      this.runEvents.deleteMany(filter),
    ]);
  }

  // ---------------------------------------------------------------- settings

  async getSetting(key: string): Promise<string | null> {
    const doc = await this.settings.findOne({ _id: key });
    return doc ? doc.value : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.settings.updateOne({ _id: key }, { $set: { value } }, { upsert: true });
  }

  async deleteSetting(key: string): Promise<void> {
    await this.settings.deleteOne({ _id: key });
  }

  // ------------------------------------------------------------------ boards

  async listBoards(): Promise<BoardWithCounts[]> {
    const [boards, stats] = await Promise.all([
      this.boards.find().sort({ createdAt: -1 }).toArray(),
      this.tasks
        .aggregate<{ _id: { boardId: string; status: TaskStatus }; n: number; active: number }>([
          {
            $group: {
              _id: { boardId: "$boardId", status: "$status" },
              n: { $sum: 1 },
              active: { $sum: { $cond: [{ $in: ["$agentState", ["running", "queued"]] }, 1, 0] } },
            },
          },
        ])
        .toArray(),
    ]);
    const byBoard = new Map<string, BoardWithCounts>();
    const result = boards.map((doc) => {
      const board: BoardWithCounts = { ...toBoard(doc), counts: emptyStatusCounts(), runningCount: 0 };
      byBoard.set(board.id, board);
      return board;
    });
    for (const row of stats) {
      const board = byBoard.get(row._id.boardId);
      if (!board) continue;
      if (row._id.status in board.counts) board.counts[row._id.status] = row.n;
      board.runningCount += row.active;
    }
    return result;
  }

  async getBoard(id: string): Promise<Board | null> {
    const doc = await this.boards.findOne({ _id: id });
    return doc ? toBoard(doc) : null;
  }

  async createBoard(input: CreateBoardInput): Promise<Board> {
    const now = nowIso();
    const doc: BoardDoc = {
      _id: newId(),
      name: input.name,
      workdir: input.workdir,
      extraFolders: input.extraFolders ?? [],
      model: input.model ?? null,
      autoRun: input.autoRun ?? true,
      worktrees: input.worktrees ?? false,
      createdAt: now,
      updatedAt: now,
    };
    await this.boards.insertOne(doc);
    return toBoard(doc);
  }

  async updateBoard(id: string, patch: UpdateBoardInput): Promise<Board | null> {
    const doc = await this.boards.findOneAndUpdate(
      { _id: id },
      { $set: { ...pickDefined(patch, BOARD_PATCH_KEYS), updatedAt: nowIso() } },
      { returnDocument: "after" },
    );
    return doc ? toBoard(doc) : null;
  }

  async deleteBoard(id: string): Promise<boolean> {
    const res = await this.boards.deleteOne({ _id: id });
    if (res.deletedCount === 0) return false;
    const taskIds = (await this.tasks.find({ boardId: id }, { projection: { _id: 1 } }).toArray()).map(
      (t) => t._id,
    );
    await this.cascadeTasks(taskIds);
    await this.tasks.deleteMany({ boardId: id });
    return true;
  }

  // ------------------------------------------------------------------- tasks

  async listTasks(boardId: string): Promise<Task[]> {
    const docs = await this.tasks.find({ boardId }).toArray();
    return (await this.withCommentStats(docs)).sort(compareTasks);
  }

  async listTasksByAgentState(states: AgentState[]): Promise<Task[]> {
    if (states.length === 0) return [];
    const docs = await this.tasks
      .find({ agentState: { $in: states } })
      .sort({ updatedAt: 1, createdAt: 1 })
      .toArray();
    return this.withCommentStats(docs);
  }

  async getTask(id: string): Promise<Task | null> {
    const doc = await this.tasks.findOne({ _id: id });
    if (!doc) return null;
    const [task] = await this.withCommentStats([doc]);
    return task;
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    if ((await this.boards.countDocuments({ _id: input.boardId }, { limit: 1 })) === 0) {
      throw new Error(`Board ${input.boardId} does not exist`);
    }
    const status = input.status ?? "todo";
    let position = input.position;
    if (position === undefined) {
      const last = await this.tasks.findOne(
        { boardId: input.boardId, status },
        { sort: { position: -1 }, projection: { position: 1 } },
      );
      position = last ? last.position + POSITION_STEP : POSITION_STEP;
    }
    const now = nowIso();
    const doc: TaskDoc = {
      _id: newId(),
      boardId: input.boardId,
      title: input.title,
      description: input.description ?? "",
      status,
      position,
      agentState: "idle",
      agentError: null,
      question: null,
      sessionFile: null,
      lastRunId: null,
      blockedBy: input.blockedBy ?? [],
      createdByTaskId: input.createdByTaskId ?? null,
      pushedAt: null,
      autoRetries: 0,
      retryAt: null,
      todos: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.tasks.insertOne(doc);
    return toTask(doc, undefined);
  }

  async updateTask(id: string, patch: UpdateTaskInput): Promise<Task | null> {
    const doc = await this.tasks.findOneAndUpdate(
      { _id: id },
      { $set: { ...pickDefined(patch, TASK_PATCH_KEYS), updatedAt: nowIso() } },
      { returnDocument: "after" },
    );
    if (!doc) return null;
    const [task] = await this.withCommentStats([doc]);
    return task;
  }

  async deleteTask(id: string): Promise<boolean> {
    const res = await this.tasks.deleteOne({ _id: id });
    if (res.deletedCount === 0) return false;
    await this.cascadeTasks([id]);
    return true;
  }

  // ---------------------------------------------------------------- comments

  async listComments(taskId: string): Promise<Comment[]> {
    const docs = await this.comments.find({ taskId }).sort({ createdAt: 1 }).toArray();
    return docs.map(toComment);
  }

  async getComment(id: string): Promise<Comment | null> {
    const doc = await this.comments.findOne({ _id: id });
    return doc ? toComment(doc) : null;
  }

  async addComment(input: CreateCommentInput): Promise<Comment> {
    if ((await this.tasks.countDocuments({ _id: input.taskId }, { limit: 1 })) === 0) {
      throw new Error(`Task ${input.taskId} does not exist`);
    }
    const now = nowIso();
    const resolved = input.resolved ?? input.author === "agent";
    const doc: CommentDoc = {
      _id: newId(),
      taskId: input.taskId,
      author: input.author,
      body: input.body,
      resolved,
      resolvedAt: resolved ? now : null,
      resolvedByRunId: null,
      fromTaskId: input.fromTaskId ?? null,
      createdAt: now,
    };
    await this.comments.insertOne(doc);
    return toComment(doc);
  }

  async setCommentResolved(
    id: string,
    resolved: boolean,
    runId?: string | null,
  ): Promise<Comment | null> {
    const doc = await this.comments.findOneAndUpdate(
      { _id: id },
      {
        $set: resolved
          ? { resolved: true, resolvedAt: nowIso(), resolvedByRunId: runId ?? null }
          : { resolved: false, resolvedAt: null, resolvedByRunId: null },
      },
      { returnDocument: "after" },
    );
    return doc ? toComment(doc) : null;
  }

  async resolveComments(ids: string[], runId: string): Promise<Comment[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const targets = (
      await this.comments
        .find({ _id: { $in: unique }, resolved: false }, { projection: { _id: 1 } })
        .toArray()
    ).map((c) => c._id);
    if (targets.length === 0) return [];
    const now = nowIso();
    await this.comments.updateMany(
      { _id: { $in: targets }, resolved: false },
      { $set: { resolved: true, resolvedAt: now, resolvedByRunId: runId } },
    );
    const docs = await this.comments
      .find({ _id: { $in: targets }, resolvedAt: now, resolvedByRunId: runId })
      .toArray();
    const order = new Map(unique.map((id, i) => [id, i]));
    return docs
      .sort((a, b) => (order.get(a._id) ?? 0) - (order.get(b._id) ?? 0))
      .map(toComment);
  }

  async deleteComment(id: string): Promise<boolean> {
    const res = await this.comments.deleteOne({ _id: id });
    return res.deletedCount > 0;
  }

  // -------------------------------------------------------------------- runs

  async listRuns(taskId: string): Promise<Run[]> {
    const docs = await this.runs.find({ taskId }).sort({ startedAt: -1 }).toArray();
    return docs.map(toRun);
  }

  async getRun(id: string): Promise<Run | null> {
    const doc = await this.runs.findOne({ _id: id });
    return doc ? toRun(doc) : null;
  }

  async createRun(input: CreateRunInput): Promise<Run> {
    if ((await this.tasks.countDocuments({ _id: input.taskId }, { limit: 1 })) === 0) {
      throw new Error(`Task ${input.taskId} does not exist`);
    }
    const doc: RunDoc = {
      _id: newId(),
      taskId: input.taskId,
      status: "running",
      prompt: input.prompt,
      summary: null,
      error: null,
      startedAt: nowIso(),
      endedAt: null,
    };
    await this.runs.insertOne(doc);
    return toRun(doc);
  }

  async updateRun(id: string, patch: UpdateRunInput): Promise<Run | null> {
    const set = pickDefined(patch, RUN_PATCH_KEYS);
    if (Object.keys(set).length === 0) return this.getRun(id);
    const doc = await this.runs.findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: "after" });
    return doc ? toRun(doc) : null;
  }

  async abortRunningRuns(reason: string): Promise<number> {
    const res = await this.runs.updateMany(
      { status: "running" },
      { $set: { status: "aborted", error: reason, endedAt: nowIso() } },
    );
    return res.modifiedCount;
  }

  // -------------------------------------------------------------- run events

  async appendRunEvent(input: AppendRunEventInput): Promise<RunEvent> {
    const counter = await this.counters.findOneAndUpdate(
      { _id: RUN_EVENTS_COUNTER },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" },
    );
    if (!counter) throw new Error("Failed to allocate run event sequence number");
    const doc: RunEventDoc = {
      _id: counter.seq,
      runId: input.runId,
      taskId: input.taskId,
      kind: input.kind,
      text: input.text,
      createdAt: nowIso(),
    };
    await this.runEvents.insertOne(doc);
    return toRunEvent(doc);
  }

  async listRunEvents(runId: string, after?: number, limit?: number): Promise<RunEvent[]> {
    const docs = await this.runEvents
      .find({ runId, _id: { $gt: normalizeAfter(after) } })
      .sort({ _id: 1 })
      .limit(normalizeLimit(limit))
      .toArray();
    return docs.map(toRunEvent);
  }
}
