/**
 * Per-user view of a Repository. withApi (lib/server/http.ts) hands request handlers
 * `scopeRepo(baseRepo, user)`, so every route reads and writes through the caller's permissions
 * without checking ownership itself; drivers never check permissions. Admins see everything;
 * other users only rows whose `userId` equals theirs (rows without an owner included: hidden).
 * Rows they cannot see behave like unknown ids: getters return null, lists [], updates null,
 * deletes false, and creating under them throws ScopeError (HTTP 404).
 */
import type {
  AppendRunEventInput,
  CreateBoardInput,
  CreateCommentInput,
  CreateRunInput,
  CreateSchedulerInput,
  CreateSchedulerRunInput,
  CreateTaskInput,
  CreateUserInput,
  DbDriver,
  Repository,
  UpdateBoardInput,
  UpdateRunInput,
  UpdateSchedulerInput,
  UpdateTaskInput,
  UpdateUserInput,
  UserAuthRecord,
} from "@/lib/db/types";
import type {
  AgentState,
  Board,
  BoardWithCounts,
  Comment,
  Run,
  RunEvent,
  Scheduler,
  SchedulerRun,
  Task,
  User,
  UserRole,
} from "@/lib/types";

export interface RepoActor {
  id: string;
  role: UserRole;
}

/** 404-style failure raised by scoped writes on rows the actor cannot see. withApi maps it to HTTP 404. */
export class ScopeError extends Error {
  readonly status = 404;

  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

/**
 * Admin view: delegates everything to the base repository; new boards default to the admin as owner.
 * Also the parent of UserScopedRepository, which narrows what a regular user can reach.
 */
class ScopedRepository implements Repository {
  /** Only set when the base implements them: callers test `repo.compact` before use. */
  declare readonly compact?: () => Promise<void>;
  declare readonly compactableBytes?: () => Promise<number>;

  constructor(
    protected readonly base: Repository,
    protected readonly actor: RepoActor,
  ) {
    const { compact, compactableBytes } = base;
    if (compact) this.compact = compact.bind(base);
    if (compactableBytes) this.compactableBytes = compactableBytes.bind(base);
  }

  /** The unscoped repository behind `repo` (itself when it is not scoped). */
  static unwrap(repo: Repository): Repository {
    return repo instanceof ScopedRepository ? repo.base : repo;
  }

  static actorOf(repo: Repository): RepoActor | null {
    return repo instanceof ScopedRepository ? repo.actor : null;
  }

  get driver(): DbDriver {
    return this.base.driver;
  }

  init(): Promise<void> {
    return this.base.init();
  }

  close(): Promise<void> {
    return this.base.close();
  }

  getSetting(key: string): Promise<string | null> {
    return this.base.getSetting(key);
  }

  setSetting(key: string, value: string): Promise<void> {
    return this.base.setSetting(key, value);
  }

  deleteSetting(key: string): Promise<void> {
    return this.base.deleteSetting(key);
  }

  listUsers(): Promise<User[]> {
    return this.base.listUsers();
  }

  getUser(id: string): Promise<User | null> {
    return this.base.getUser(id);
  }

  getUserAuth(id: string): Promise<UserAuthRecord | null> {
    return this.base.getUserAuth(id);
  }

  findUserAuthByLogin(login: string): Promise<UserAuthRecord | null> {
    return this.base.findUserAuthByLogin(login);
  }

  createUser(input: CreateUserInput): Promise<User> {
    return this.base.createUser(input);
  }

  updateUser(id: string, patch: UpdateUserInput): Promise<User | null> {
    return this.base.updateUser(id, patch);
  }

  deleteUser(id: string): Promise<boolean> {
    return this.base.deleteUser(id);
  }

  reassignUserData(fromUserId: string | null, toUserId: string): Promise<number> {
    return this.base.reassignUserData(fromUserId, toUserId);
  }

  listBoards(userId?: string): Promise<BoardWithCounts[]> {
    return this.base.listBoards(userId);
  }

  getBoard(id: string): Promise<Board | null> {
    return this.base.getBoard(id);
  }

  createBoard(input: CreateBoardInput): Promise<Board> {
    return this.base.createBoard({ ...input, userId: input.userId ?? this.actor.id });
  }

  updateBoard(id: string, patch: UpdateBoardInput): Promise<Board | null> {
    return this.base.updateBoard(id, patch);
  }

  markBoardAccessed(id: string): Promise<Board | null> {
    return this.base.markBoardAccessed(id);
  }

  deleteBoard(id: string): Promise<boolean> {
    return this.base.deleteBoard(id);
  }

  listTasks(boardId: string): Promise<Task[]> {
    return this.base.listTasks(boardId);
  }

  listTasksByAgentState(states: AgentState[], userId?: string): Promise<Task[]> {
    return this.base.listTasksByAgentState(states, userId);
  }

  getTask(id: string): Promise<Task | null> {
    return this.base.getTask(id);
  }

  createTask(input: CreateTaskInput): Promise<Task> {
    return this.base.createTask(input);
  }

  updateTask(id: string, patch: UpdateTaskInput): Promise<Task | null> {
    return this.base.updateTask(id, patch);
  }

  deleteTask(id: string): Promise<boolean> {
    return this.base.deleteTask(id);
  }

  listComments(taskId: string): Promise<Comment[]> {
    return this.base.listComments(taskId);
  }

  getComment(id: string): Promise<Comment | null> {
    return this.base.getComment(id);
  }

  addComment(input: CreateCommentInput): Promise<Comment> {
    return this.base.addComment(input);
  }

  setCommentResolved(id: string, resolved: boolean, runId?: string | null): Promise<Comment | null> {
    return this.base.setCommentResolved(id, resolved, runId);
  }

  resolveComments(ids: string[], runId: string): Promise<Comment[]> {
    return this.base.resolveComments(ids, runId);
  }

  deleteComment(id: string): Promise<boolean> {
    return this.base.deleteComment(id);
  }

  listRuns(taskId: string): Promise<Run[]> {
    return this.base.listRuns(taskId);
  }

  listRecentRuns(limit?: number, userId?: string): Promise<Run[]> {
    return this.base.listRecentRuns(limit, userId);
  }

  getRun(id: string): Promise<Run | null> {
    return this.base.getRun(id);
  }

  createRun(input: CreateRunInput): Promise<Run> {
    return this.base.createRun(input);
  }

  updateRun(id: string, patch: UpdateRunInput): Promise<Run | null> {
    return this.base.updateRun(id, patch);
  }

  abortRunningRuns(reason: string): Promise<number> {
    return this.base.abortRunningRuns(reason);
  }

  appendRunEvent(input: AppendRunEventInput): Promise<RunEvent> {
    return this.base.appendRunEvent(input);
  }

  listRunEvents(runId: string, after?: number, limit?: number): Promise<RunEvent[]> {
    return this.base.listRunEvents(runId, after, limit);
  }

  listSchedulers(boardId?: string, userId?: string): Promise<Scheduler[]> {
    return this.base.listSchedulers(boardId, userId);
  }

  getScheduler(id: string): Promise<Scheduler | null> {
    return this.base.getScheduler(id);
  }

  createScheduler(input: CreateSchedulerInput): Promise<Scheduler> {
    return this.base.createScheduler(input);
  }

  updateScheduler(id: string, patch: UpdateSchedulerInput): Promise<Scheduler | null> {
    return this.base.updateScheduler(id, patch);
  }

  deleteScheduler(id: string): Promise<boolean> {
    return this.base.deleteScheduler(id);
  }

  listSchedulerRuns(schedulerId: string, limit?: number): Promise<SchedulerRun[]> {
    return this.base.listSchedulerRuns(schedulerId, limit);
  }

  createSchedulerRun(input: CreateSchedulerRunInput): Promise<SchedulerRun> {
    return this.base.createSchedulerRun(input);
  }
}

/**
 * Regular user view: only rows owned by the actor. Children are checked through their own
 * denormalized `userId`, loaded from the base repository. Settings and user reads pass through
 * (route-level admin guards protect the user endpoints); user writes always fail.
 */
class UserScopedRepository extends ScopedRepository {
  /** `row` when the actor owns it; null for foreign and unowned (legacy, `userId` null) rows. */
  private mine<T extends { userId: string | null }>(row: T | null): T | null {
    return row !== null && row.userId === this.actor.id ? row : null;
  }

  private async ownedBoard(id: string): Promise<Board | null> {
    return this.mine(await this.base.getBoard(id));
  }

  private async ownedTask(id: string): Promise<Task | null> {
    return this.mine(await this.base.getTask(id));
  }

  private async ownedComment(id: string): Promise<Comment | null> {
    return this.mine(await this.base.getComment(id));
  }

  private async ownedRun(id: string): Promise<Run | null> {
    return this.mine(await this.base.getRun(id));
  }

  private async ownedScheduler(id: string): Promise<Scheduler | null> {
    return this.mine(await this.base.getScheduler(id));
  }

  // Managing users is admin-only: a regular user's view refuses every user write, whatever the route.
  override async createUser(): Promise<User> {
    throw new ScopeError("User not found");
  }

  override async updateUser(): Promise<User | null> {
    throw new ScopeError("User not found");
  }

  override async deleteUser(): Promise<boolean> {
    throw new ScopeError("User not found");
  }

  override async reassignUserData(): Promise<number> {
    throw new ScopeError("User not found");
  }

  /** Always the actor's own boards, whatever owner the caller asks for. */
  override listBoards(): Promise<BoardWithCounts[]> {
    return this.base.listBoards(this.actor.id);
  }

  override getBoard(id: string): Promise<Board | null> {
    return this.ownedBoard(id);
  }

  override createBoard(input: CreateBoardInput): Promise<Board> {
    return this.base.createBoard({ ...input, userId: this.actor.id });
  }

  override async updateBoard(id: string, patch: UpdateBoardInput): Promise<Board | null> {
    return (await this.ownedBoard(id)) ? this.base.updateBoard(id, patch) : null;
  }

  override async markBoardAccessed(id: string): Promise<Board | null> {
    return (await this.ownedBoard(id)) ? this.base.markBoardAccessed(id) : null;
  }

  override async deleteBoard(id: string): Promise<boolean> {
    return (await this.ownedBoard(id)) ? this.base.deleteBoard(id) : false;
  }

  override async listTasks(boardId: string): Promise<Task[]> {
    return (await this.ownedBoard(boardId)) ? this.base.listTasks(boardId) : [];
  }

  override listTasksByAgentState(states: AgentState[]): Promise<Task[]> {
    return this.base.listTasksByAgentState(states, this.actor.id);
  }

  override getTask(id: string): Promise<Task | null> {
    return this.ownedTask(id);
  }

  override async createTask(input: CreateTaskInput): Promise<Task> {
    if (!(await this.ownedBoard(input.boardId))) throw new ScopeError("Board not found");
    return this.base.createTask(input);
  }

  override async updateTask(id: string, patch: UpdateTaskInput): Promise<Task | null> {
    return (await this.ownedTask(id)) ? this.base.updateTask(id, patch) : null;
  }

  override async deleteTask(id: string): Promise<boolean> {
    return (await this.ownedTask(id)) ? this.base.deleteTask(id) : false;
  }

  override async listComments(taskId: string): Promise<Comment[]> {
    return (await this.ownedTask(taskId)) ? this.base.listComments(taskId) : [];
  }

  override getComment(id: string): Promise<Comment | null> {
    return this.ownedComment(id);
  }

  override async addComment(input: CreateCommentInput): Promise<Comment> {
    if (!(await this.ownedTask(input.taskId))) throw new ScopeError("Task not found");
    return this.base.addComment(input);
  }

  override async setCommentResolved(id: string, resolved: boolean, runId?: string | null): Promise<Comment | null> {
    return (await this.ownedComment(id)) ? this.base.setCommentResolved(id, resolved, runId) : null;
  }

  /** Foreign ids are dropped silently, like unknown ids in the base repository. */
  override async resolveComments(ids: string[], runId: string): Promise<Comment[]> {
    const owned = await Promise.all(ids.map((id) => this.ownedComment(id)));
    const ownedIds = owned.flatMap((comment) => (comment ? [comment.id] : []));
    return ownedIds.length > 0 ? this.base.resolveComments(ownedIds, runId) : [];
  }

  override async deleteComment(id: string): Promise<boolean> {
    return (await this.ownedComment(id)) ? this.base.deleteComment(id) : false;
  }

  override async listRuns(taskId: string): Promise<Run[]> {
    return (await this.ownedTask(taskId)) ? this.base.listRuns(taskId) : [];
  }

  override listRecentRuns(limit?: number): Promise<Run[]> {
    return this.base.listRecentRuns(limit, this.actor.id);
  }

  override getRun(id: string): Promise<Run | null> {
    return this.ownedRun(id);
  }

  override async createRun(input: CreateRunInput): Promise<Run> {
    if (!(await this.ownedTask(input.taskId))) throw new ScopeError("Task not found");
    return this.base.createRun(input);
  }

  override async updateRun(id: string, patch: UpdateRunInput): Promise<Run | null> {
    return (await this.ownedRun(id)) ? this.base.updateRun(id, patch) : null;
  }

  /** Boot recovery touches every user's runs: system-only, never on behalf of a user. */
  override async abortRunningRuns(): Promise<number> {
    throw new ScopeError("Run not found");
  }

  override async appendRunEvent(input: AppendRunEventInput): Promise<RunEvent> {
    if (!(await this.ownedRun(input.runId))) throw new ScopeError("Run not found");
    return this.base.appendRunEvent(input);
  }

  override async listRunEvents(runId: string, after?: number, limit?: number): Promise<RunEvent[]> {
    return (await this.ownedRun(runId)) ? this.base.listRunEvents(runId, after, limit) : [];
  }

  override listSchedulers(boardId?: string): Promise<Scheduler[]> {
    return this.base.listSchedulers(boardId, this.actor.id);
  }

  override getScheduler(id: string): Promise<Scheduler | null> {
    return this.ownedScheduler(id);
  }

  override async createScheduler(input: CreateSchedulerInput): Promise<Scheduler> {
    if (!(await this.ownedBoard(input.boardId))) throw new ScopeError("Board not found");
    return this.base.createScheduler(input);
  }

  /** Moving a scheduler requires owning the target board too (the driver re-stamps its owner from it). */
  override async updateScheduler(id: string, patch: UpdateSchedulerInput): Promise<Scheduler | null> {
    if (!(await this.ownedScheduler(id))) return null;
    if (patch.boardId !== undefined && !(await this.ownedBoard(patch.boardId))) {
      throw new ScopeError("Board not found");
    }
    return this.base.updateScheduler(id, patch);
  }

  override async deleteScheduler(id: string): Promise<boolean> {
    return (await this.ownedScheduler(id)) ? this.base.deleteScheduler(id) : false;
  }

  override async listSchedulerRuns(schedulerId: string, limit?: number): Promise<SchedulerRun[]> {
    return (await this.ownedScheduler(schedulerId)) ? this.base.listSchedulerRuns(schedulerId, limit) : [];
  }

  override async createSchedulerRun(input: CreateSchedulerRunInput): Promise<SchedulerRun> {
    if (!(await this.ownedScheduler(input.schedulerId))) throw new ScopeError("Scheduler not found");
    return this.base.createSchedulerRun(input);
  }
}

/**
 * Repository as seen by `actor`. Admins see everything; users only rows whose userId === actor.id.
 * Scoping an already scoped repository re-scopes its base instead of stacking views.
 */
export function scopeRepo(repo: Repository, actor: RepoActor): Repository {
  const base = ScopedRepository.unwrap(repo);
  const owner: RepoActor = Object.freeze({ id: actor.id, role: actor.role });
  return owner.role === "admin" ? new ScopedRepository(base, owner) : new UserScopedRepository(base, owner);
}

/** The actor a scoped repository was built for; null for the base (unscoped) repository. */
export function repoActor(repo: Repository): RepoActor | null {
  return ScopedRepository.actorOf(repo);
}
