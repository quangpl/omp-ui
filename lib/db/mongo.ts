import { MongoClient, type Collection, type Document, type Filter, type OptionalUnlessRequiredId } from "mongodb";

import type {
  AgentResources,
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
  TaskReview,
  TaskStatus,
  TaskUsage,
  TodoPhase,
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
  TaskRow,
} from "@/lib/db/types";
import { DATA_TABLES } from "@/lib/db/types";
import {
  POSITION_STEP,
  boardPatchUpdatedAt,
  compareTasks,
  emptyStatusCounts,
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

interface SettingDoc {
  _id: string;
  value: string;
}

interface UserDoc {
  _id: string;
  username: string;
  email: string | null;
  passwordHash: string;
  role: UserRole;
  isActive: boolean;
  tokenEpoch: number;
  createdAt: string;
  updatedAt: string;
}

interface BoardDoc {
  _id: string;
  name: string;
  workdir: string;
  /** Missing on documents created before boards had extra folders. */
  extraFolders?: string[];
  model: string | null;
  autoRun: boolean;
  /** Missing on documents created before configurable push branches. */
  pushBranch?: string | null;
  /** Per-repo default branch, folder → branch. Missing on documents created before it existed. */
  defaultBranches?: Record<string, string> | null;
  /** Missing on documents created before projects could be pinned. */
  pinned?: boolean;
  /** Missing until the board is first opened. */
  lastAccessedAt?: string | null;
  /** Owning user. Missing on documents created before multi-user support (read as null). */
  userId?: string | null;
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
  createdByTaskId?: string | null;
  /** Missing on documents created before "pushed" cards. */
  pushedAt?: string | null;
  /** Missing on documents created before automatic retries. */
  autoRetries?: number;
  retryAt?: string | null;
  /** Missing on documents created before agent todo lists. */
  todos?: TodoPhase[];
  /** Missing on documents created before code reviews. */
  review?: TaskReview | null;
  /** Missing on documents created before agent resource tracking. */
  resources?: AgentResources | null;
  /** Missing on documents created before session usage tracking. */
  usage?: TaskUsage | null;
  /** Missing on documents created before schedulers. */
  schedulerId?: string | null;
  /** Missing on documents created before the parallelize toggle. */
  parallelize?: boolean | null;
  /** Missing on documents created before the ignore-memory toggle (counts as false). */
  ignoreMemory?: boolean;
  /** Copied from the board on create. Missing on documents created before multi-user support. */
  userId?: string | null;
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
  /** Copied from the task on create. Missing on documents created before multi-user support. */
  userId?: string | null;
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
  /** Copied from the task on create. Missing on documents created before multi-user support. */
  userId?: string | null;
  /** Cluster node of the run. Missing on documents created before cluster mode. */
  nodeId?: string | null;
  nodeName?: string | null;
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

interface SchedulerDoc {
  _id: string;
  boardId: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  maxRuns: number | null;
  runCount: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: SchedulerRunStatus | null;
  lastTaskId: string | null;
  lastError: string | null;
  /** Missing on documents created before schedulers could pin a model. */
  model?: string | null;
  /** Copied from the board on create/move. Missing on documents created before multi-user support. */
  userId?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SchedulerRunDoc {
  _id: string;
  schedulerId: string;
  taskId: string | null;
  trigger: SchedulerRun["trigger"];
  scheduledFor: string;
  status: SchedulerRunStatus;
  error: string | null;
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

/** `listSchedulerRuns` limit bounds. */
const DEFAULT_SCHEDULER_RUN_LIMIT = 100;
const MAX_SCHEDULER_RUN_LIMIT = 1000;

function toUser(d: UserDoc): User {
  return {
    id: d._id,
    username: d.username,
    email: d.email ?? null,
    role: d.role,
    isActive: d.isActive,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function toUserAuth(d: UserDoc): UserAuthRecord {
  return { ...toUser(d), passwordHash: d.passwordHash, tokenEpoch: d.tokenEpoch ?? 0 };
}

function toBoard(d: BoardDoc): Board {
  return {
    id: d._id,
    name: d.name,
    workdir: d.workdir,
    extraFolders: parseFolderList(d.extraFolders),
    model: d.model ?? null,
    autoRun: d.autoRun,
    pushBranch: d.pushBranch ?? DEFAULT_PUSH_BRANCH,
    defaultBranches: parseBranchMap(d.defaultBranches),
    pinned: d.pinned ?? false,
    lastAccessedAt: d.lastAccessedAt ?? null,
    userId: d.userId ?? null,
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
    createdByTaskId: d.createdByTaskId ?? null,
    pushedAt: d.pushedAt ?? null,
    autoRetries: d.autoRetries ?? 0,
    retryAt: d.retryAt ?? null,
    todos: parseTodoPhases(d.todos),
    review: parseTaskReview(d.review),
    resources: parseAgentResources(d.resources),
    usage: parseTaskUsage(d.usage),
    schedulerId: d.schedulerId ?? null,
    parallelize: d.parallelize ?? null,
    ignoreMemory: d.ignoreMemory === true,
    userId: d.userId ?? null,
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
    userId: d.userId ?? null,
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
    userId: d.userId ?? null,
    nodeId: d.nodeId ?? null,
    nodeName: d.nodeName ?? null,
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

function toScheduler(d: SchedulerDoc): Scheduler {
  return {
    id: d._id,
    boardId: d.boardId,
    name: d.name,
    prompt: d.prompt,
    cron: d.cron,
    timezone: d.timezone,
    enabled: d.enabled,
    maxRuns: d.maxRuns ?? null,
    runCount: d.runCount ?? 0,
    lastRunAt: d.lastRunAt ?? null,
    nextRunAt: d.nextRunAt ?? null,
    lastStatus: d.lastStatus ?? null,
    lastTaskId: d.lastTaskId ?? null,
    lastError: d.lastError ?? null,
    model: d.model ?? null,
    userId: d.userId ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function toSchedulerRun(d: SchedulerRunDoc): SchedulerRun {
  return {
    id: d._id,
    schedulerId: d.schedulerId,
    taskId: d.taskId ?? null,
    trigger: d.trigger,
    scheduledFor: d.scheduledFor,
    status: d.status,
    error: d.error ?? null,
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

const BOARD_PATCH_KEYS = [
  "name",
  "workdir",
  "extraFolders",
  "model",
  "autoRun",
  "pushBranch",
  "defaultBranches",
  "pinned",
] as const satisfies readonly (keyof UpdateBoardInput)[];
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
  "pushedAt",
  "autoRetries",
  "retryAt",
  "todos",
  "review",
  "resources",
  "usage",
  "ignoreMemory",
] as const satisfies readonly (keyof UpdateTaskInput)[];
const RUN_PATCH_KEYS = ["status", "summary", "error", "endedAt"] as const satisfies readonly (keyof UpdateRunInput)[];
const SCHEDULER_PATCH_KEYS = [
  "boardId",
  "name",
  "prompt",
  "cron",
  "timezone",
  "enabled",
  "maxRuns",
  "runCount",
  "lastRunAt",
  "nextRunAt",
  "lastStatus",
  "lastTaskId",
  "lastError",
  "model",
] as const satisfies readonly (keyof UpdateSchedulerInput)[];
const USER_PATCH_KEYS = [
  "username",
  "email",
  "passwordHash",
  "role",
  "isActive",
  "tokenEpoch",
] as const satisfies readonly (keyof UpdateUserInput)[];

export class MongoRepository implements Repository {
  readonly driver = "mongodb" as const;
  private readonly client: MongoClient;
  private readonly settings: Collection<SettingDoc>;
  private readonly users: Collection<UserDoc>;
  private readonly boards: Collection<BoardDoc>;
  private readonly tasks: Collection<TaskDoc>;
  private readonly comments: Collection<CommentDoc>;
  private readonly runs: Collection<RunDoc>;
  private readonly runEvents: Collection<RunEventDoc>;
  private readonly counters: Collection<CounterDoc>;
  private readonly schedulers: Collection<SchedulerDoc>;
  private readonly schedulerRuns: Collection<SchedulerRunDoc>;

  constructor(url: string, dbName: string) {
    this.client = new MongoClient(url, { appName: "omp-ui" });
    const db = this.client.db(dbName);
    this.settings = db.collection<SettingDoc>("settings");
    this.users = db.collection<UserDoc>("users");
    this.boards = db.collection<BoardDoc>("boards");
    this.tasks = db.collection<TaskDoc>("tasks");
    this.comments = db.collection<CommentDoc>("comments");
    this.runs = db.collection<RunDoc>("runs");
    this.runEvents = db.collection<RunEventDoc>("run_events");
    this.counters = db.collection<CounterDoc>("counters");
    this.schedulers = db.collection<SchedulerDoc>("schedulers");
    this.schedulerRuns = db.collection<SchedulerRunDoc>("scheduler_runs");
  }

  async init(): Promise<void> {
    await this.client.connect();
    await Promise.all([
      this.users.createIndex({ username: 1 }, { unique: true }),
      // Partial: accounts without an email (null) must not collide with each other.
      this.users.createIndex(
        { email: 1 },
        { unique: true, partialFilterExpression: { email: { $type: "string" } } },
      ),
      this.users.createIndex({ createdAt: 1 }),
      this.boards.createIndex({ createdAt: -1 }),
      this.boards.createIndex({ userId: 1, createdAt: -1 }),
      this.tasks.createIndex({ boardId: 1, status: 1, position: 1 }),
      this.tasks.createIndex({ agentState: 1 }),
      this.tasks.createIndex({ schedulerId: 1 }),
      this.tasks.createIndex({ userId: 1 }),
      this.comments.createIndex({ taskId: 1, createdAt: 1 }),
      this.runs.createIndex({ taskId: 1, startedAt: -1 }),
      this.runs.createIndex({ status: 1 }),
      this.runs.createIndex({ startedAt: -1 }),
      this.runs.createIndex({ userId: 1, startedAt: -1 }),
      this.runEvents.createIndex({ runId: 1, _id: 1 }),
      this.runEvents.createIndex({ taskId: 1 }),
      this.schedulers.createIndex({ boardId: 1 }),
      this.schedulers.createIndex({ createdAt: -1 }),
      this.schedulers.createIndex({ userId: 1 }),
      this.schedulerRuns.createIndex({ schedulerId: 1, createdAt: -1 }),
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

  /** Domain mapper and collection of each data table, used by export/import. */
  private dataCollection<T extends DataTable>(
    table: T,
  ): { coll: Collection<Document>; toRow: (doc: Document) => DataRows[T] } {
    const toTaskRow = (d: TaskDoc): TaskRow => {
      const { commentCount: _c, openCommentCount: _o, ...row } = toTask(d, undefined);
      return row;
    };
    const map = {
      settings: [this.settings, (d: SettingDoc) => ({ key: d._id, value: d.value })],
      users: [this.users, toUserAuth],
      boards: [this.boards, toBoard],
      tasks: [this.tasks, toTaskRow],
      comments: [this.comments, toComment],
      runs: [this.runs, toRun],
      run_events: [this.runEvents, toRunEvent],
      schedulers: [this.schedulers, toScheduler],
      scheduler_runs: [this.schedulerRuns, toSchedulerRun],
    } as const;
    const [coll, toRow] = map[table];
    return {
      coll: coll as unknown as Collection<Document>,
      toRow: toRow as unknown as (doc: Document) => DataRows[T],
    };
  }

  async *exportRows<T extends DataTable>(table: T): AsyncIterable<DataRows[T][]> {
    const { coll, toRow } = this.dataCollection(table);
    let last: Document["_id"];
    for (;;) {
      const filter = (last === undefined ? {} : { _id: { $gt: last } }) as Filter<Document>;
      const docs = await coll.find(filter).sort({ _id: 1 }).limit(500).toArray();
      if (docs.length === 0) return;
      yield docs.map(toRow);
      if (docs.length < 500) return;
      last = docs[docs.length - 1]._id;
    }
  }

  /**
   * Not transactional (standalone servers lack transactions). Documents keep the domain field
   * names; JSON fields (todos, review, resources, usage, extraFolders) stay native BSON values
   * exactly as createTask/updateTask store them.
   */
  async replaceAllData(data: DataSnapshot): Promise<void> {
    for (const table of [...DATA_TABLES].reverse()) await this.dataCollection(table).coll.deleteMany({});
    const toDoc = (table: DataTable, row: object): Document => {
      if (table === "settings") {
        const { key, value } = row as DataRows["settings"];
        return { _id: key, value };
      }
      if (table === "run_events") {
        const { seq, ...rest } = row as DataRows["run_events"];
        return { _id: seq, ...rest };
      }
      const { id, ...rest } = row as { id: string };
      return { _id: id, ...rest };
    };
    for (const table of DATA_TABLES) {
      const rows = data[table] as object[];
      if (rows.length === 0) continue;
      const docs = rows.map((row) => toDoc(table, row)) as OptionalUnlessRequiredId<Document>[];
      await this.dataCollection(table).coll.insertMany(docs, { ordered: true });
    }
    // appendRunEvent $inc's this counter, so the next event gets max + 1 (or 1 after the delete).
    const maxSeq = data.run_events.reduce((max, e) => Math.max(max, e.seq), 0);
    if (maxSeq > 0) {
      await this.counters.updateOne({ _id: RUN_EVENTS_COUNTER }, { $set: { seq: maxSeq } }, { upsert: true });
    } else {
      await this.counters.deleteOne({ _id: RUN_EVENTS_COUNTER });
    }
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

  // ------------------------------------------------------------------- users

  async listUsers(): Promise<User[]> {
    const docs = await this.users.find().sort({ createdAt: 1, _id: 1 }).toArray();
    return docs.map(toUser);
  }

  async getUser(id: string): Promise<User | null> {
    const doc = await this.users.findOne({ _id: id });
    return doc ? toUser(doc) : null;
  }

  async getUserAuth(id: string): Promise<UserAuthRecord | null> {
    const doc = await this.users.findOne({ _id: id });
    return doc ? toUserAuth(doc) : null;
  }

  async findUserAuthByLogin(login: string): Promise<UserAuthRecord | null> {
    const doc = await this.users.findOne({ $or: [{ username: login }, { email: login }] });
    return doc ? toUserAuth(doc) : null;
  }

  /** Duplicate usernames/emails fail on the unique indexes (MongoServerError code 11000). */
  async createUser(input: CreateUserInput): Promise<User> {
    const now = nowIso();
    const doc: UserDoc = {
      _id: newId(),
      username: input.username,
      email: input.email ?? null,
      passwordHash: input.passwordHash,
      role: input.role,
      isActive: input.isActive ?? true,
      tokenEpoch: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.users.insertOne(doc);
    return toUser(doc);
  }

  async updateUser(id: string, patch: UpdateUserInput): Promise<User | null> {
    const doc = await this.users.findOneAndUpdate(
      { _id: id },
      { $set: { ...pickDefined(patch, USER_PATCH_KEYS), updatedAt: nowIso() } },
      { returnDocument: "after" },
    );
    return doc ? toUser(doc) : null;
  }

  async deleteUser(id: string): Promise<boolean> {
    const res = await this.users.deleteOne({ _id: id });
    return res.deletedCount > 0;
  }

  /** `{ userId: null }` also matches documents without the field (written before multi-user support). */
  async reassignUserData(fromUserId: string | null, toUserId: string): Promise<number> {
    const filter = { userId: fromUserId };
    const update = { $set: { userId: toUserId } };
    const [boards] = await Promise.all([
      this.boards.updateMany(filter, update),
      this.tasks.updateMany(filter, update),
      this.comments.updateMany(filter, update),
      this.runs.updateMany(filter, update),
      this.schedulers.updateMany(filter, update),
    ]);
    return boards.modifiedCount;
  }

  // ------------------------------------------------------------------ boards

  async listBoards(userId?: string): Promise<BoardWithCounts[]> {
    const owner = userId === undefined ? {} : { userId };
    const [boards, stats] = await Promise.all([
      this.boards.find(owner).sort({ createdAt: -1 }).toArray(),
      this.tasks
        .aggregate<{ _id: { boardId: string; status: TaskStatus }; n: number; active: number }>([
          { $match: owner },
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
      pushBranch: input.pushBranch ?? DEFAULT_PUSH_BRANCH,
      defaultBranches: input.defaultBranches ?? {},
      pinned: false,
      lastAccessedAt: null,
      userId: input.userId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.boards.insertOne(doc);
    return toBoard(doc);
  }

  async updateBoard(id: string, patch: UpdateBoardInput): Promise<Board | null> {
    const updatedAt = boardPatchUpdatedAt(patch);
    const doc = await this.boards.findOneAndUpdate(
      { _id: id },
      { $set: { ...pickDefined(patch, BOARD_PATCH_KEYS), ...(updatedAt && { updatedAt }) } },
      { returnDocument: "after" },
    );
    return doc ? toBoard(doc) : null;
  }

  async markBoardAccessed(id: string): Promise<Board | null> {
    const doc = await this.boards.findOneAndUpdate(
      { _id: id },
      { $set: { lastAccessedAt: nowIso() } },
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
    const schedulerIds = (
      await this.schedulers.find({ boardId: id }, { projection: { _id: 1 } }).toArray()
    ).map((s) => s._id);
    if (schedulerIds.length > 0) {
      await this.schedulerRuns.deleteMany({ schedulerId: { $in: schedulerIds } });
      await this.schedulers.deleteMany({ _id: { $in: schedulerIds } });
    }
    return true;
  }

  // ------------------------------------------------------------------- tasks

  async listTasks(boardId: string): Promise<Task[]> {
    const docs = await this.tasks.find({ boardId }).toArray();
    return (await this.withCommentStats(docs)).sort(compareTasks);
  }

  async listTasksByAgentState(states: AgentState[], userId?: string): Promise<Task[]> {
    if (states.length === 0) return [];
    const docs = await this.tasks
      .find({ agentState: { $in: states }, ...(userId !== undefined && { userId }) })
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
    const board = await this.boards.findOne({ _id: input.boardId }, { projection: { userId: 1 } });
    if (!board) throw new Error(`Board ${input.boardId} does not exist`);
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
      createdByTaskId: input.createdByTaskId ?? null,
      pushedAt: null,
      autoRetries: 0,
      retryAt: null,
      todos: [],
      review: null,
      resources: null,
      usage: null,
      schedulerId: input.schedulerId ?? null,
      parallelize: input.parallelize ?? null,
      ignoreMemory: input.ignoreMemory ?? false,
      userId: board.userId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.tasks.insertOne(doc);
    return toTask(doc, undefined);
  }

  async updateTask(id: string, patch: UpdateTaskInput): Promise<Task | null> {
    const doc = await this.tasks.findOneAndUpdate(
      { _id: id },
      { $set: { ...pickDefined(patch, TASK_PATCH_KEYS), ...(touchesTask(patch) ? { updatedAt: nowIso() } : {}) } },
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
    const task = await this.tasks.findOne({ _id: input.taskId }, { projection: { userId: 1 } });
    if (!task) throw new Error(`Task ${input.taskId} does not exist`);
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
      userId: task.userId ?? null,
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

  async listRecentRuns(limit?: number, userId?: string): Promise<Run[]> {
    const docs = await this.runs
      .find(userId === undefined ? {} : { userId })
      .sort({ startedAt: -1 })
      .limit(normalizeRecentRunLimit(limit))
      .toArray();
    return docs.map(toRun);
  }

  async getRun(id: string): Promise<Run | null> {
    const doc = await this.runs.findOne({ _id: id });
    return doc ? toRun(doc) : null;
  }

  async createRun(input: CreateRunInput): Promise<Run> {
    const task = await this.tasks.findOne({ _id: input.taskId }, { projection: { userId: 1 } });
    if (!task) throw new Error(`Task ${input.taskId} does not exist`);
    const doc: RunDoc = {
      _id: newId(),
      taskId: input.taskId,
      status: "running",
      prompt: input.prompt,
      summary: null,
      error: null,
      startedAt: nowIso(),
      endedAt: null,
      userId: task.userId ?? null,
      nodeId: input.nodeId ?? null,
      nodeName: input.nodeName ?? null,
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

  // -------------------------------------------------------------- schedulers

  async listSchedulers(boardId?: string, userId?: string): Promise<Scheduler[]> {
    const docs = await this.schedulers
      .find({ ...(boardId !== undefined && { boardId }), ...(userId !== undefined && { userId }) })
      .sort({ createdAt: -1 })
      .toArray();
    return docs.map(toScheduler);
  }

  async getScheduler(id: string): Promise<Scheduler | null> {
    const doc = await this.schedulers.findOne({ _id: id });
    return doc ? toScheduler(doc) : null;
  }

  async createScheduler(input: CreateSchedulerInput): Promise<Scheduler> {
    const board = await this.boards.findOne({ _id: input.boardId }, { projection: { userId: 1 } });
    if (!board) throw new Error(`Board ${input.boardId} does not exist`);
    const now = nowIso();
    const doc: SchedulerDoc = {
      _id: newId(),
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
      userId: board.userId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.schedulers.insertOne(doc);
    return toScheduler(doc);
  }

  /** Moving to another board (unknown boards throw, like the SQL foreign keys) re-stamps the owner. */
  async updateScheduler(id: string, patch: UpdateSchedulerInput): Promise<Scheduler | null> {
    const set: Partial<SchedulerDoc> = { ...pickDefined(patch, SCHEDULER_PATCH_KEYS), updatedAt: nowIso() };
    if (set.boardId !== undefined) {
      const board = await this.boards.findOne({ _id: set.boardId }, { projection: { userId: 1 } });
      if (!board) throw new Error(`Board ${set.boardId} does not exist`);
      set.userId = board.userId ?? null;
    }
    const doc = await this.schedulers.findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: "after" });
    return doc ? toScheduler(doc) : null;
  }

  async deleteScheduler(id: string): Promise<boolean> {
    const res = await this.schedulers.deleteOne({ _id: id });
    if (res.deletedCount === 0) return false;
    await Promise.all([
      this.schedulerRuns.deleteMany({ schedulerId: id }),
      this.tasks.updateMany({ schedulerId: id }, { $set: { schedulerId: null } }),
    ]);
    return true;
  }

  // ---------------------------------------------------------- scheduler runs

  async listSchedulerRuns(schedulerId: string, limit?: number): Promise<SchedulerRun[]> {
    const n =
      limit === undefined || !Number.isFinite(limit)
        ? DEFAULT_SCHEDULER_RUN_LIMIT
        : Math.min(MAX_SCHEDULER_RUN_LIMIT, Math.max(1, Math.floor(limit)));
    const docs = await this.schedulerRuns
      .find({ schedulerId })
      .sort({ createdAt: -1 })
      .limit(n)
      .toArray();
    return docs.map(toSchedulerRun);
  }

  async createSchedulerRun(input: CreateSchedulerRunInput): Promise<SchedulerRun> {
    if ((await this.schedulers.countDocuments({ _id: input.schedulerId }, { limit: 1 })) === 0) {
      throw new Error(`Scheduler ${input.schedulerId} does not exist`);
    }
    const doc: SchedulerRunDoc = {
      _id: newId(),
      schedulerId: input.schedulerId,
      taskId: input.taskId,
      trigger: input.trigger,
      scheduledFor: input.scheduledFor,
      status: input.status,
      error: input.error ?? null,
      createdAt: nowIso(),
    };
    await this.schedulerRuns.insertOne(doc);
    return toSchedulerRun(doc);
  }
}
