import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ADVISOR_FEEDBACK_PREFIX,
  ADVISOR_TOOL,
  consultAdvisor,
  formatAnswers,
  formatDecision,
  parseAdvisorArgs,
  triageQuestions,
  type AdvisorScope,
  type QuestionTriage,
} from "@/lib/agent/advisor";
import { BOARD_TOOLS, BOARD_TOOL_NAMES, runBoardTool, type BoardToolHost } from "@/lib/agent/board-tools";
import { CONCURRENCY_SAMPLE_MS, resolveConcurrency } from "@/lib/agent/concurrency";
import { chooseModel, readModelRoles } from "@/lib/agent/model-select";
import { buildPrompt, buildSteerMessage } from "@/lib/agent/prompt";
import { planQueue, type PlanCard, type QueuePlan } from "@/lib/agent/queue-planner";
import { OmpRpcProcess, describeExit, type RpcExitInfo, type RpcFrame } from "@/lib/agent/rpc";
import {
  describeTaskCall,
  isTerminalSubagent,
  lifecyclePatch,
  mergeSubagent,
  progressPatch,
  taskToolPatches,
  type SubagentPatch,
} from "@/lib/agent/subagents";
import type { AgentManager } from "@/lib/agent/types";
import { childEnv } from "@/lib/child-env";
import { startCleanupScheduler } from "@/lib/cleanup";
import { getRepo } from "@/lib/db";
import type { Repository, UpdateTaskInput } from "@/lib/db/types";
import { publish } from "@/lib/events";
import { dataDir, ensureFilesFolder } from "@/lib/files";
import { extractQuestion } from "@/lib/question";
import { isQuotaError, QUOTA_RETRY_STEPS_MS } from "@/lib/quota";
import { startSchedulerService } from "@/lib/scheduler";
import { agentmemoryEnabled, memoryProjectName, tagMemorySession } from "@/lib/server/agentmemory";
import { startCredentialHealthChecks } from "@/lib/server/credentials";
import { getAppSettings } from "@/lib/settings";
import { parseTodoPhases, stampTodos } from "@/lib/todos";
import { ensureWorkspace } from "@/lib/workspaces";
import type {
  AppSettings,
  Comment,
  QueueEntry,
  QueueSnapshot,
  RunEventKind,
  SubagentSnapshot,
  Task,
  TaskStatus,
  TodoPhase,
} from "@/lib/types";

const READY_TIMEOUT_MS = 60_000;
const ABORT_TIMEOUT_MS = 5_000;
const SUMMARY_TIMEOUT_MS = 15_000;
const PUMP_RETRY_MS = 5_000;
const MAX_EVENT_TEXT = 50_000;
const MAX_THINKING_TEXT = 2_000;
const MAX_TOOL_TEXT = 300;
const MAX_TOOL_INTENT_TEXT = 160;
const MAX_TOOL_ERROR_TEXT = 1_000;
/** Live `run.delta` events: at most one per run+kind per window (leading + trailing). */
const DELTA_THROTTLE_MS = 120;
const MAX_THINKING_DELTA = 4_000;
/** Live `run.agent` progress: at most one per subagent per window (status changes are persisted). */
const SUBAGENT_LIVE_THROTTLE_MS = 300;
/** Smart queue: a board's plan waits this long after its latest queued card, so a burst is planned together. */
const PLAN_DEBOUNCE_MS = 1_500;
/**
 * Automatic retries of a failed run: 15 s, 30 s, 1 min, 2 min, 4 min, … at most 10 min apart.
 * Quota failures wait longer instead (QUOTA_RETRY_STEPS_MS: 5, 10, 15, 30 min, then hourly).
 */
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 10 * 60_000;

type DeltaKind = "text" | "thinking";

/** A subagent of the run: its merged state, and what was last persisted / published live. */
interface TrackedSubagent {
  snapshot: SubagentSnapshot;
  persisted: string;
  published: string;
  publishedAt: number;
}

/** Streaming accumulator for one kind of content of the assistant message in progress. */
interface DeltaStream {
  /** Accumulated text per content block index. */
  blocks: Map<number, string>;
  lastSentAt: number;
  lastSentText: string;
  /** Pending trailing publish. */
  timer: NodeJS.Timeout | undefined;
}

/** In-memory state of one task's run, from dequeue until it is released. */
interface ActiveRun {
  taskId: string;
  boardId: string;
  ompPath: string;
  runId: string | null;
  promptId: string;
  proc: OmpRpcProcess | null;
  /** Feedback comments this run addresses (prompt set + steered); resolved on success. */
  feedbackIds: Set<string>;
  promptSent: boolean;
  /** Completed, failed, stopped or deleted: frames from here on are ignored. */
  finished: boolean;
  /** stop() is shutting the process down itself; release() must not close it again. */
  closing: boolean;
  /** Feedback arrived that this run could not take; start a new run once it is released. */
  restartAfter: boolean;
  /** Streaming text of the assistant message in progress. */
  currentText: string;
  /** Live (unpersisted) accumulators behind `run.delta` events. */
  deltas: Record<DeltaKind, DeltaStream>;
  /** Text of the last completed assistant message that had any. */
  lastText: string;
  lastStopReason: string | null;
  lastError: string | null;
  /** Subagents the run delegated to, by id. */
  subagents: Map<string, TrackedSubagent>;
  /** Board tool calls in flight (`host_tool_call` id → abort). */
  hostCalls: Map<string, AbortController>;
  /** What the advisor needs to answer this run's questions; set once the run has started. */
  advisor: Omit<AdvisorScope, "signal" | "onActivity"> | null;
  /** This run addresses advisor feedback: its own questions go to the user, not back to the agent. */
  advisorFollowUp: boolean;
  /** JSON of the omp todo list this run last stored on the card; repeated `todo` views write nothing. */
  todos: string | null;
  /** When this run was launched (ISO); bounds which `startedAt` todo stamps count as this run's work. */
  launchedAt: string;
  /** The stamped todo list this run last stored, and when; null before its first update. */
  stampedTodos: { list: TodoPhase[]; at: string } | null;
  /** Serializes startup, frame handling and teardown so persistence stays ordered. */
  chain: Promise<void>;
}

/** Smart-queue plan of one board: pending (debounce timer) or in flight (planner running). */
interface BoardPlan {
  timer: NodeJS.Timeout | undefined;
  controller: AbortController | null;
  /** Queued cards the in-flight plan orders; a card that leaves the queue drops out (queued anew, it waits for the next plan). */
  sent: Set<string>;
  /** Cards of `sent` the user moved meanwhile: the plan keeps them where the user put them. */
  pinned: Set<string>;
}

type Json = Record<string, unknown>;

class OmpAgentManager implements AgentManager {
  /** start() calls between their guard and the "queued" write. */
  private readonly claiming = new Set<string>();
  private readonly queue: string[] = [];
  private readonly active = new Map<string, ActiveRun>();
  private pumping = false;
  private pumpAgain = false;
  private pumpRetry: NodeJS.Timeout | undefined;
  /** Runs waiting in board_wait_for_cards; each lends its slot to the queue meanwhile. */
  private lent = 0;
  /** Last published `queue.updated` (deduplicates). */
  private lastQueue = "";
  /** Queued cards that take part in the smart queue (not created by an agent) → their board. */
  private readonly plannable = new Map<string, string>();
  /** Plannable queued cards not ordered by a plan yet; held while their board's plan is pending. */
  private readonly unplanned = new Set<string>();
  /** Boards with a pending or in-flight plan. */
  private readonly plans = new Map<string, BoardPlan>();
  /** The planner's one-line reason per queued card. */
  private readonly planNotes = new Map<string, string>();
  /** Failed cards waiting for their automatic retry → its timer. */
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  /** Queued cards held until their preparation (the card writer) settles → its abort. */
  private readonly preparing = new Map<string, AbortController>();

  /** Agents allowed at once, as of the latest pump (part of the `queue.updated` dedupe key). */
  private limit = 0;
  /** Re-samples the machine (an automatic limit) while cards wait in the queue. */
  private sampler: NodeJS.Timeout | undefined;

  constructor(private readonly repo: Repository) {}

  stats(): { running: string[]; queued: string[] } {
    return { running: [...this.active.keys()], queued: [...this.claiming, ...this.queue] };
  }

  async queueSnapshot(): Promise<QueueSnapshot> {
    const settings = await getAppSettings(this.repo);
    const boardNames = new Map<string, string>();
    const boardName = async (boardId: string): Promise<string> => {
      if (!boardNames.has(boardId)) {
        boardNames.set(boardId, (await this.repo.getBoard(boardId))?.name ?? "");
      }
      return boardNames.get(boardId) ?? "";
    };
    const entry = async (taskId: string, state: QueueEntry["state"]): Promise<QueueEntry | null> => {
      const task = await this.repo.getTask(taskId);
      if (!task) return null;
      return {
        taskId,
        boardId: task.boardId,
        boardName: await boardName(task.boardId),
        title: task.title,
        state,
        waitingFor: state === "queued" ? await this.pendingBlockers(task) : [],
        planning: state === "queued" && this.awaitsPlan(taskId),
        drafting: state === "queued" && this.preparing.has(taskId),
        planNote: this.planNotes.get(taskId) ?? null,
        createdByTaskId: task.createdByTaskId ?? null,
      };
    };
    const isEntry = (e: QueueEntry | null): e is QueueEntry => e !== null;
    const running = (await Promise.all([...this.active.keys()].map((id) => entry(id, "running")))).filter(isEntry);
    const queued = (
      await Promise.all([...this.claiming, ...this.queue].map((id) => entry(id, "queued")))
    ).filter(isEntry);
    const planning = await Promise.all(
      [...this.plans.keys()].map(async (boardId) => ({ boardId, boardName: await boardName(boardId) })),
    );
    const concurrency = resolveConcurrency(settings.maxConcurrentAgents, this.active.size);
    return { limit: concurrency.limit, concurrency, running, queued, planning };
  }

  moveInQueue(taskId: string, position: number): boolean {
    if (!this.removeFromQueue(taskId)) return false;
    this.queue.splice(Math.max(0, Math.min(this.queue.length, Math.floor(position))), 0, taskId);
    // The user's explicit choice: the card no longer waits for its board's plan, and a plan in
    // flight keeps it where the user put it.
    const boardId = this.plannable.get(taskId);
    if (boardId !== undefined) {
      const state = this.plans.get(boardId);
      if (state?.sent.has(taskId)) state.pinned.add(taskId);
      if (this.unplanned.delete(taskId)) this.dropIdlePlan(boardId);
    }
    void this.pump();
    return true;
  }

  refreshQueue(): void {
    void this.pump();
  }

  /** A person (or another card's agent) runs the card: it gets a fresh automatic-retry budget. */
  start(taskId: string): Promise<Task> {
    return this.queueRun(taskId, false);
  }

  async startPrepared(taskId: string, prepare: (signal: AbortSignal) => Promise<void>): Promise<Task> {
    if (this.isTracked(taskId)) return this.start(taskId);
    const controller = new AbortController();
    this.preparing.set(taskId, controller);
    let task: Task;
    try {
      task = await this.start(taskId);
    } catch (err) {
      this.endPreparing(taskId, controller);
      throw err;
    }
    // Stopped or deleted while it was being queued.
    if (controller.signal.aborted) return task;
    void prepare(controller.signal)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) console.error(`[agent] preparing task ${taskId} failed; running it as it is:`, err);
      })
      .finally(() => this.endPreparing(taskId, controller));
    return task;
  }

  /** Releases the card's preparation hold (aborting `prepare` when it is still running). */
  private endPreparing(taskId: string, controller?: AbortController): void {
    const current = this.preparing.get(taskId);
    if (!current || (controller && current !== controller)) return;
    this.preparing.delete(taskId);
    current.abort();
    this.publishQueue();
    void this.pump();
  }

  /** `auto`: an automatic retry or a restart resume, which keeps counting the card's retries. */
  private async queueRun(taskId: string, auto: boolean): Promise<Task> {
    if (this.isTracked(taskId)) {
      const task = await this.repo.getTask(taskId);
      if (!task) throw new Error("Task not found");
      return task;
    }
    this.cancelRetry(taskId);
    this.claiming.add(taskId);
    let task: Task | null;
    let smart = false;
    try {
      const current = await this.repo.getTask(taskId);
      if (!current) throw new Error("Task not found");
      const patch: UpdateTaskInput = { agentState: "queued", agentError: null, question: null, retryAt: null };
      if (!auto) patch.autoRetries = 0;
      if (current.status !== "in_progress") {
        patch.status = "in_progress";
        patch.position = await this.topPosition(current.boardId, "in_progress", taskId);
      }
      task = await this.repo.updateTask(taskId, patch);
      if (!task) throw new Error("Task not found");
      smart = task.createdByTaskId === null && (await getAppSettings(this.repo)).smartQueue;
    } catch (err) {
      this.claiming.delete(taskId);
      throw err;
    }
    if (!this.claiming.delete(taskId)) {
      // stop() or onTaskDeleted() ran while this start was being queued.
      const idle = await this.repo.updateTask(taskId, { agentState: "idle" });
      if (idle) publish({ type: "task.updated", task: idle });
      return idle ?? task;
    }
    this.queue.push(taskId);
    // Cards an agent created (board_create_card) are coordinated by their creator: never planned.
    if (task.createdByTaskId === null) {
      this.plannable.set(taskId, task.boardId);
      if (smart) {
        this.unplanned.add(taskId);
        this.schedulePlan(task.boardId);
      }
    }
    publish({ type: "task.updated", task });
    void this.pump();
    return task;
  }

  async stop(taskId: string): Promise<Task | null> {
    this.endPreparing(taskId);
    this.cancelRetry(taskId);
    const wasClaiming = this.claiming.delete(taskId);
    if (this.removeFromQueue(taskId) || wasClaiming) {
      this.leftQueue(taskId);
      this.publishQueue();
      return this.setIdle(taskId);
    }

    const run = this.active.get(taskId);
    if (run && !run.finished) {
      run.finished = true;
      run.closing = true;
      void this.shutdown(run);
      const { promise, resolve } = Promise.withResolvers<Task | null>();
      // Runs after any in-flight startup step has unwound, so it sees the final runId.
      this.enqueue(run, async () => {
        let task: Task | null = null;
        try {
          if (run.runId) {
            const updated = await this.repo.updateRun(run.runId, {
              status: "aborted",
              error: "Stopped by user",
              endedAt: nowIso(),
            });
            if (updated) publish({ type: "run.updated", run: updated, boardId: run.boardId });
            await this.settleSubagents(run);
            await this.event(run, "status", "Stopped by user");
          }
          task = await this.setIdle(taskId);
        } catch (err) {
          console.error(`[agent] failed to record stop of task ${taskId}:`, err);
        } finally {
          this.release(run);
          resolve(task);
        }
      });
      return promise;
    }
    if (run) {
      // Already completing; its own teardown sets the final state.
      return this.repo.getTask(taskId);
    }

    const task = await this.repo.getTask(taskId);
    if (task && (task.agentState !== "idle" || task.agentError !== null || task.retryAt !== null)) {
      return this.setIdle(taskId);
    }
    return task;
  }

  async onTaskMoved(task: Task, previousStatus: TaskStatus): Promise<void> {
    try {
      if (task.status === previousStatus) return;
      // A card reaching (or leaving) Done may unblock queued cards that wait for it.
      void this.pump();
      const busy = this.isTracked(task.id);
      if (task.status === "in_progress") {
        if (busy) return;
        const board = await this.repo.getBoard(task.boardId);
        if (board?.autoRun) await this.start(task.id);
        return;
      }
      if (busy) await this.stop(task.id);
      else if (task.retryAt !== null || this.retryTimers.has(task.id)) {
        // A failed card leaving In progress is not retried anymore.
        this.cancelRetry(task.id);
        const updated = await this.repo.updateTask(task.id, { retryAt: null });
        if (updated) publish({ type: "task.updated", task: updated });
      }
    } catch (err) {
      await this.recordTaskError(task.id, err);
    }
  }

  async onComment(task: Task, comment: Comment): Promise<void> {
    try {
      if (comment.author !== "user" || comment.resolved) return;
      const run = this.active.get(task.id);
      if (run && !run.finished) {
        this.enqueue(run, () => this.steer(run, comment));
        return;
      }
      if (run) {
        // The run is wrapping up; pick the feedback up in a fresh run afterwards.
        run.restartAfter = true;
        return;
      }
      // Queued runs build their prompt from all unresolved feedback when they start.
      if (this.claiming.has(task.id) || this.queue.includes(task.id)) return;
      if (task.status === "todo") return;
      await this.start(task.id);
    } catch (err) {
      await this.recordTaskError(task.id, err);
    }
  }

  async onTaskDeleted(taskId: string): Promise<void> {
    this.endPreparing(taskId);
    this.cancelRetry(taskId);
    this.claiming.delete(taskId);
    if (this.removeFromQueue(taskId)) this.leftQueue(taskId);
    const run = this.active.get(taskId);
    if (!run) {
      void this.pump();
      return;
    }
    run.finished = true;
    run.restartAfter = false;
    run.closing = true;
    this.active.delete(taskId);
    if (run.proc) terminate(run.proc);
    void this.pump();
  }

  /**
   * Boot recovery: the omp processes died with the previous server. Queued cards are queued
   * again, pending automatic retries are rescheduled at their time, and interrupted runs resume
   * their omp session and failed In progress cards are retried, each while its automatic-retry
   * budget lasts — even with persistent retries on (a restart that keeps killing a card's run,
   * e.g. an agent restarting this server, stops once the budget is used up).
   */
  async recover(): Promise<void> {
    const settings = await getAppSettings(this.repo);
    // Oldest first (listTasksByAgentState orders by updatedAt).
    for (const task of await this.repo.listTasksByAgentState(["running", "queued", "error"])) {
      try {
        await this.recoverTask(task, settings);
      } catch (err) {
        console.error(`[agent] could not resume task ${task.id} after the restart:`, err);
        await this.recordTaskError(task.id, err);
      }
    }
  }

  private async recoverTask(task: Task, settings: AppSettings): Promise<void> {
    if (task.agentState === "queued") {
      // It had not started: nothing to redo, and no retry is used.
      await this.queueRun(task.id, true);
      return;
    }
    const retrying = settings.autoRetry && task.status === "in_progress";
    if (task.agentState === "error" && task.retryAt !== null && retrying) {
      // Scheduled (and counted) before the restart.
      this.scheduleRetry(task.id, task.retryAt);
      return;
    }
    const interrupted = task.agentState === "running";
    const plan = planRetry(task, settings, { kind: "restart" });
    if (plan && plan !== "exhausted") {
      await this.repo.updateTask(task.id, { autoRetries: plan.attempt });
      await this.addAgentComment(
        task,
        `${interrupted ? "The server restarted while the agent was working" : "The server restarted"}: resuming automatically (${retryCount(plan)}).`,
      );
      await this.queueRun(task.id, true);
      return;
    }
    if (!interrupted && task.retryAt === null) return;
    const updated = await this.repo.updateTask(task.id, {
      retryAt: null,
      ...(interrupted
        ? {
            agentState: "error" as const,
            agentError: `Interrupted by server restart${plan === "exhausted" ? " (automatic retries used up)" : ""}`,
          }
        : {}),
    });
    if (updated) publish({ type: "task.updated", task: updated });
  }

  // --- Automatic retries -----------------------------------------------------------------

  private cancelRetry(taskId: string): void {
    clearTimeout(this.retryTimers.get(taskId));
    this.retryTimers.delete(taskId);
  }

  /** Runs the card's automatic retry at `at` (ISO time; a past time runs it now). */
  private scheduleRetry(taskId: string, at: string): void {
    this.cancelRetry(taskId);
    const delay = Math.max(0, (Date.parse(at) || 0) - Date.now());
    const timer = setTimeout(() => {
      this.retryTimers.delete(taskId);
      void this.runRetry(taskId);
    }, delay);
    timer.unref();
    this.retryTimers.set(taskId, timer);
  }

  private async runRetry(taskId: string): Promise<void> {
    try {
      const task = await this.repo.getTask(taskId);
      // Run, stopped or moved out of In progress meanwhile: nothing to retry.
      if (!task || task.retryAt === null || task.agentState !== "error" || task.status !== "in_progress") return;
      await this.queueRun(taskId, true);
    } catch (err) {
      await this.recordTaskError(taskId, err);
    }
  }

  /**
   * Records a failed card (agentState "error") with its next automatic retry, if it gets one.
   * Returns the retry time (the caller schedules it once the run is released) and a note for the
   * failure comment.
   */
  private async recordFailure(
    taskId: string,
    message: string,
    canRetry: boolean,
  ): Promise<{ task: Task | null; retryAt: string | null; note: string }> {
    const current = await this.repo.getTask(taskId);
    const plan =
      current && canRetry ? planRetry(current, await getAppSettings(this.repo), { kind: "failure", message }) : null;
    const retry = plan === "exhausted" ? null : plan;
    const retryAt = retry ? new Date(Date.now() + retry.delayMs).toISOString() : null;
    const task = await this.repo.updateTask(taskId, {
      agentState: "error",
      agentError: message,
      retryAt,
      ...(retry ? { autoRetries: retry.attempt } : {}),
    });
    if (task) publish({ type: "task.updated", task });
    const note = retry
      ? retryNote(retry)
      : plan === "exhausted"
        ? "Automatic retries are used up; press Run to try again."
        : "";
    return { task, retryAt, note };
  }

  private async addAgentComment(task: Task, body: string): Promise<void> {
    const comment = await this.repo.addComment({ taskId: task.id, author: "agent", body, resolved: true });
    publish({ type: "comment.added", comment, boardId: task.boardId });
  }

  // --- Queue -----------------------------------------------------------------------------

  private isTracked(taskId: string): boolean {
    return this.claiming.has(taskId) || this.queue.includes(taskId) || this.active.has(taskId);
  }

  private removeFromQueue(taskId: string): boolean {
    const index = this.queue.indexOf(taskId);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    return true;
  }

  /** Blockers of the card (Task.blockedBy) that exist and are not Done yet. */
  private async pendingBlockers(task: Task): Promise<string[]> {
    const blockers = await Promise.all(task.blockedBy.map((id) => this.repo.getTask(id)));
    return task.blockedBy.filter((_, index) => {
      const blocker = blockers[index];
      return blocker && blocker.status !== "done";
    });
  }

  /** Forgets the smart-queue state of a card that left the queue (launched, stopped, deleted). */
  private leftQueue(taskId: string): void {
    const boardId = this.plannable.get(taskId);
    this.plannable.delete(taskId);
    this.unplanned.delete(taskId);
    this.planNotes.delete(taskId);
    if (boardId === undefined) return;
    const state = this.plans.get(boardId);
    state?.sent.delete(taskId);
    state?.pinned.delete(taskId);
    this.dropIdlePlan(boardId);
  }

  /** The card waits for its preparation or its board's smart-queue plan before it may launch. */
  private isHeld(taskId: string): boolean {
    return this.preparing.has(taskId) || this.awaitsPlan(taskId);
  }

  /** The card waits for its board's pending or in-flight plan. */
  private awaitsPlan(taskId: string): boolean {
    const boardId = this.plannable.get(taskId);
    return boardId !== undefined && this.unplanned.has(taskId) && this.plans.has(boardId);
  }

  private hasUnplanned(boardId: string): boolean {
    for (const id of this.unplanned) if (this.plannable.get(id) === boardId) return true;
    return false;
  }

  /** (Re)starts the board's plan debounce; a plan in flight re-schedules itself when it ends. */
  private schedulePlan(boardId: string): void {
    let state = this.plans.get(boardId);
    if (!state) {
      state = { timer: undefined, controller: null, sent: new Set(), pinned: new Set() };
      this.plans.set(boardId, state);
    }
    if (state.controller) return;
    this.debouncePlan(boardId, state);
  }

  private debouncePlan(boardId: string, state: BoardPlan): void {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => void this.runPlan(boardId, state), PLAN_DEBOUNCE_MS);
  }

  /**
   * Ends the board's plan once nothing needs it: aborts it when none of the board's cards is
   * queued anymore, and drops a pending debounce when no card waits for it.
   */
  private dropIdlePlan(boardId: string): void {
    const state = this.plans.get(boardId);
    if (!state) return;
    const queued = [...this.plannable.values()].includes(boardId);
    if (queued && (state.controller || this.hasUnplanned(boardId))) return;
    clearTimeout(state.timer);
    state.controller?.abort();
    this.plans.delete(boardId);
  }

  /**
   * Has the planner order the board's plannable queued cards and infer their prerequisites, then
   * releases the held ones. A failed plan keeps the queue order; nothing stays held.
   */
  private async runPlan(boardId: string, state: BoardPlan): Promise<void> {
    state.timer = undefined;
    const controller = new AbortController();
    state.controller = controller;
    const sent = state.sent;
    for (const id of this.queue) if (this.plannable.get(id) === boardId) sent.add(id);
    try {
      const settings = await getAppSettings(this.repo);
      const board = await this.repo.getBoard(boardId);
      if (!board || !settings.smartQueue || sent.size < 2 || !this.hasUnplanned(boardId)) return;
      // Queued cards that launched meanwhile count as running: possible prerequisites only.
      const queued: PlanCard[] = [];
      const running: PlanCard[] = [];
      for (const id of [...sent, ...this.active.keys()]) {
        const task = await this.repo.getTask(id);
        if (task?.boardId !== boardId) continue;
        const card = { id: task.id, title: task.title, description: task.description, blockedBy: task.blockedBy };
        (this.active.has(id) ? running : queued).push(card);
      }
      this.publishQueue();
      const plan = await planQueue({ board, queued, running, settings, signal: controller.signal });
      if (controller.signal.aborted) return;
      await this.applyPlan(plan, state);
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error(`[agent] queue planner failed for board ${boardId}; keeping the queue order:`, err);
      }
    } finally {
      if (this.plans.get(boardId) === state) {
        // Only cards still in `sent`: one stopped and queued anew meanwhile waits for the next plan.
        for (const id of sent) this.unplanned.delete(id);
        sent.clear();
        state.pinned.clear();
        state.controller = null;
        // Cards queued while the planner ran get a plan of their own.
        if (this.hasUnplanned(boardId)) this.debouncePlan(boardId, state);
        else this.plans.delete(boardId);
      }
      this.publishQueue();
      void this.pump();
    }
  }

  /**
   * Persists the inferred prerequisites (before the held cards are released, so none launches
   * early), then refills the queue slots of the planned cards in the plan's order; cards the user
   * moved meanwhile keep their place.
   */
  private async applyPlan(plan: QueuePlan, state: BoardPlan): Promise<void> {
    for (const [taskId, deps] of Object.entries(plan.dependencies)) {
      if (!state.sent.has(taskId)) continue;
      const task = await this.repo.getTask(taskId);
      if (!task) continue;
      const added = [...new Set(deps)].filter((id) => id !== taskId && !task.blockedBy.includes(id));
      if (added.length === 0) continue;
      const updated = await this.repo.updateTask(taskId, { blockedBy: [...task.blockedBy, ...added] });
      if (updated) publish({ type: "task.updated", task: updated });
    }
    const queued = new Set([...state.sent].filter((id) => !state.pinned.has(id) && this.queue.includes(id)));
    const order = [...new Set([...plan.order, ...state.sent])].filter((id) => queued.has(id));
    let next = 0;
    for (let i = 0; i < this.queue.length; i++) {
      if (queued.has(this.queue[i]!)) this.queue[i] = order[next++]!;
    }
    for (const id of state.sent) {
      const reason = plan.reasons[id];
      if (reason) this.planNotes.set(id, reason);
      else this.planNotes.delete(id);
    }
  }

  private publishQueue(): void {
    const running = [...this.active.keys()];
    const queued = [...this.claiming, ...this.queue];
    const drafting = queued.filter((id) => this.preparing.has(id));
    // Planning state is part of the key: the UI re-reads the snapshot when a plan starts or ends.
    const held = queued.filter((id) => this.isHeld(id));
    // So is the limit: an automatic one changes with the machine's free resources.
    const key = JSON.stringify([running, queued, drafting, [...this.plans.keys()], held, this.limit]);
    if (key === this.lastQueue) return;
    this.lastQueue = key;
    publish({ type: "queue.updated", running, queued, drafting });
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        if (this.queue.length === 0) break;
        // Re-read every time a slot frees so settings changes apply without a restart, and
        // re-sample the machine so an automatic limit follows its free cores and memory.
        const settings = await getAppSettings(this.repo);
        this.limit = resolveConcurrency(settings.maxConcurrentAgents, this.active.size).limit;
        if (this.active.size - this.lent >= this.limit) continue;
        // Start order, skipping cards that wait for unfinished cards (Task.blockedBy) or for their
        // board's smart-queue plan. The queued cards' blockers are read in parallel.
        const candidates = [...this.queue];
        const blocked = await Promise.all(
          candidates.map(async (taskId) => {
            const task = await this.repo.getTask(taskId);
            return task !== null && (await this.pendingBlockers(task)).length > 0;
          }),
        );
        for (const [index, taskId] of candidates.entries()) {
          if (this.active.size - this.lent >= this.limit) break;
          if (blocked[index]) continue;
          // Checked after the reads: the card may have been stopped and queued anew meanwhile.
          if (this.isHeld(taskId)) continue;
          if (this.removeFromQueue(taskId)) {
            this.leftQueue(taskId);
            this.launch(taskId, settings);
          }
        }
      } while (this.pumpAgain);
    } catch (err) {
      console.error("[agent] failed to schedule queued runs:", err);
      clearTimeout(this.pumpRetry);
      this.pumpRetry = setTimeout(() => void this.pump(), PUMP_RETRY_MS);
    } finally {
      this.pumping = false;
      // While cards wait, re-sample the machine periodically: freed resources start more of them.
      if (this.queue.length > 0) {
        this.sampler ??= setInterval(() => void this.pump(), CONCURRENCY_SAMPLE_MS);
        this.sampler.unref();
      } else if (this.sampler) {
        clearInterval(this.sampler);
        this.sampler = undefined;
      }
      this.publishQueue();
    }
  }

  private launch(taskId: string, settings: AppSettings): void {
    const run: ActiveRun = {
      taskId,
      boardId: "",
      ompPath: settings.ompPath,
      runId: null,
      promptId: "",
      proc: null,
      feedbackIds: new Set(),
      promptSent: false,
      finished: false,
      closing: false,
      restartAfter: false,
      currentText: "",
      deltas: { text: newDeltaStream(), thinking: newDeltaStream() },
      lastText: "",
      lastStopReason: null,
      lastError: null,
      subagents: new Map(),
      hostCalls: new Map(),
      advisor: null,
      advisorFollowUp: false,
      todos: null,
      launchedAt: new Date().toISOString(),
      stampedTodos: null,
      chain: Promise.resolve(),
    };
    this.active.set(taskId, run);
    this.enqueue(run, () => this.startRun(run, settings));
  }

  private enqueue(run: ActiveRun, step: () => Promise<void>): void {
    run.chain = run.chain.then(step).catch(async (err: unknown) => {
      // After stop/delete the process is torn down on purpose; its rejections are expected.
      if (run.finished) return;
      await this.fail(run, errorMessage(err, run.ompPath));
    });
  }

  /** Drop the run from the active set, close its process, and refill the free slot. */
  private release(run: ActiveRun): void {
    run.finished = true;
    this.resetDeltas(run);
    for (const call of run.hostCalls.values()) call.abort();
    run.hostCalls.clear();
    if (this.active.get(run.taskId) === run) this.active.delete(run.taskId);
    // The agent may have written files or screenshots into the card's folder.
    if (run.boardId) publish({ type: "files.updated", boardId: run.boardId, taskId: run.taskId });
    if (run.proc && !run.closing) {
      run.closing = true;
      void run.proc.close();
    }
    if (run.restartAfter) {
      run.restartAfter = false;
      void this.restart(run.taskId);
    }
    void this.pump();
  }

  private async restart(taskId: string): Promise<void> {
    try {
      const task = await this.repo.getTask(taskId);
      if (task && task.status !== "todo") await this.start(taskId);
    } catch (err) {
      await this.recordTaskError(taskId, err);
    }
  }

  /** Abort the agent gracefully if it is working, then close the process. */
  private async shutdown(run: ActiveRun): Promise<void> {
    const proc = run.proc;
    if (!proc) return;
    try {
      if (run.promptSent && !proc.exited) {
        await proc.send({ type: "abort" }, { timeoutMs: ABORT_TIMEOUT_MS }).catch(() => undefined);
        await proc.close();
      } else {
        terminate(proc);
      }
    } catch (err) {
      console.error(`[agent] failed to shut down omp for task ${run.taskId}:`, err);
    }
  }

  // --- Run lifecycle ---------------------------------------------------------------------

  private async startRun(run: ActiveRun, settings: AppSettings): Promise<void> {
    const repo = this.repo;
    const task = await repo.getTask(run.taskId);
    const board = task ? await repo.getBoard(task.boardId) : null;
    if (!task || !board) {
      // Deleted while queued.
      this.release(run);
      return;
    }
    run.boardId = task.boardId;
    if (run.finished) return;

    // Independent startup reads and folder setup run in parallel. Dedicated workspace: the
    // card's own worktrees stand in for the project folders.
    const sessionFile = task.sessionFile;
    const [workspace, taskFiles, boardFiles, comments, resumeFile] = await Promise.all([
      board.worktrees ? ensureWorkspace(board, task) : null,
      ensureFilesFolder("tasks", task.id),
      ensureFilesFolder("boards", board.id),
      repo.listComments(task.id),
      sessionFile ? stat(sessionFile).then(() => sessionFile, () => null) : null,
    ]);
    let workdir = board.workdir;
    let projectExtras = board.extraFolders ?? [];
    let workspaceBranch: string | null = null;
    let workspaceNotes: string[] = [];
    if (workspace) {
      [workdir, ...projectExtras] = workspace.workspace.folders.map((f) => f.path);
      workspaceBranch = workspace.workspace.folders.find((f) => f.isolated)?.branch ?? null;
      workspaceNotes = workspace.notes;
    }
    if (run.finished) return;

    const feedback = comments.filter((c) => c.author === "user" && !c.resolved);
    const senderIds = [...new Set(feedback.map((c) => c.fromTaskId).filter((id): id is string => !!id))];
    const [senderTitles, folders] = await Promise.all([
      Promise.all(senderIds.map(async (id) => (await repo.getTask(id))?.title ?? id)),
      Promise.all(projectExtras.map(async (folder) => ({ folder, ok: await isDirectory(folder) }))),
    ]);
    const senders: Record<string, string> = Object.fromEntries(senderIds.map((id, index) => [id, senderTitles[index]!]));
    const extraFolders = folders.filter((f) => f.ok).map((f) => f.folder);
    const missingFolders = folders.filter((f) => !f.ok).map((f) => f.folder);
    // The prompt lists only folders the agent can actually reach.
    const prompt = buildPrompt(task, { ...board, workdir, extraFolders }, feedback, resumeFile !== null, {
      taskFiles,
      boardFiles,
      workspaceBranch,
      browser: settings.browser,
      senders,
    });
    const created = await repo.createRun({ taskId: task.id, prompt });
    run.runId = created.id;
    run.promptId = `prompt-${created.id}`;
    for (const c of feedback) run.feedbackIds.add(c.id);
    run.advisor = { task, board, workdir, extraFolders, settings };
    run.advisorFollowUp = feedback.some((c) => c.body.startsWith(ADVISOR_FEEDBACK_PREFIX));
    publish({ type: "run.updated", run: created, boardId: run.boardId });
    if (run.finished) return;

    const running = await repo.updateTask(task.id, {
      agentState: "running",
      agentError: null,
      lastRunId: created.id,
    });
    if (running) publish({ type: "task.updated", task: running });
    if (run.finished) return;

    // Roles are read per run: the user may reconfigure omp, and project `.omp` configs differ.
    const autoSelect = !board.model?.trim() && settings.autoModel;
    const [workdirFound, roles, configFile, memoryProject] = await Promise.all([
      isDirectory(workdir),
      autoSelect ? readModelRoles(settings.ompPath, workdir, childEnv()) : null,
      writeRunConfig(task.id, settings, taskFiles),
      // Cards in worktrees remember under the board's project, like omp sessions in its folder.
      memoryProjectName(board.workdir),
    ]);
    if (!workdirFound) {
      throw new Error(`Board directory not found: ${workdir}`);
    }
    const choice = chooseModel({
      board,
      settings,
      task,
      feedback,
      isResume: resumeFile !== null,
      roles,
    });
    if (run.finished) return;
    const { model, thinking } = choice;
    const args = [
      "--mode",
      "rpc",
      "--cwd",
      workdir,
      "--no-title",
      "--approval-mode",
      settings.approvalMode,
      "--config",
      configFile,
    ];
    for (const folder of [...extraFolders, taskFiles, boardFiles]) args.push("--add-dir", folder);
    if (model) args.push("--model", model);
    if (thinking) args.push("--thinking", thinking);
    if (resumeFile) args.push("--resume", resumeFile);
    const extra = process.env.OMP_EXTRA_ARGS?.trim();
    if (extra) args.push(...extra.split(/\s+/));

    if (choice.source === "auto") {
      await this.event(run, "status", `Model auto-selected: ${model ?? "omp default"} (${choice.reason})`);
      if (run.finished) return;
    }
    const modelNote = [model && `model ${model}`, thinking && `thinking ${thinking}`].filter(Boolean).join(", ");
    await this.event(
      run,
      "status",
      [resumeFile ? "Resuming agent session" : "Starting agent", `in ${workdir}`, modelNote && `(${modelNote})`]
        .filter(Boolean)
        .join(" "),
    );
    if (run.finished) return;
    for (const note of workspaceNotes) await this.event(run, "status", note);
    for (const folder of missingFolders) {
      await this.event(run, "status", `Skipped missing folder ${folder}`);
    }
    if (run.finished) return;

    const proc = new OmpRpcProcess({
      command: settings.ompPath,
      args,
      cwd: workdir,
      env: childEnv({ AGENTMEMORY_PROJECT_NAME: memoryProject }),
      autoConfirm: settings.approvalMode === "yolo",
    });
    run.proc = proc;
    proc.on("frame", (frame) => {
      // Board tools run outside the chain: a wait can last minutes while frames keep flowing.
      if (frame.type === "host_tool_call" || frame.type === "host_tool_cancel") {
        this.onHostTool(run, proc, frame);
        return;
      }
      this.enqueue(run, () => this.onFrame(run, frame));
    });
    proc.on("protocolError", (message) =>
      this.enqueue(run, () => this.onTransportError(run, message, undefined)),
    );
    proc.on("exit", (info) => this.enqueue(run, () => this.onExit(run, info)));

    await proc.waitReady(READY_TIMEOUT_MS);
    if (run.finished) return;

    try {
      const state = await proc.send({ type: "get_state" });
      const sessionFile = isObject(state.data) ? asString(state.data.sessionFile) : undefined;
      const sessionId = isObject(state.data) ? asString(state.data.sessionId) : undefined;
      if (sessionFile && sessionFile !== task.sessionFile) {
        const updated = await repo.updateTask(task.id, { sessionFile });
        if (updated) publish({ type: "task.updated", task: updated });
      }
      // Name the card's agentmemory session after the card (best effort, not awaited).
      if (sessionId && agentmemoryEnabled()) {
        void tagMemorySession({ sessionId, project: memoryProject, cwd: workdir, title: `${task.title} (card ${task.id})` });
      }
    } catch (err) {
      if (run.finished) return;
      await this.event(run, "error", `Could not read the omp session state: ${errorMessage(err, run.ompPath)}`);
    }
    if (run.finished) return;

    // Orchestrated runs: stream subagent lifecycle + progress. Older omp versions lack it; the
    // `task` tool's own updates still carry progress then.
    await proc.send({ type: "set_subagent_subscription", level: "progress" }).catch(() => undefined);
    if (run.finished) return;

    // Agent-to-agent collaboration tools and the advisor, executed by onHostTool.
    try {
      await proc.send({ type: "set_host_tools", tools: [...BOARD_TOOLS, ADVISOR_TOOL] });
    } catch (err) {
      if (run.finished) return;
      await this.event(run, "error", `Board tools are unavailable in this run: ${errorMessage(err, run.ompPath)}`);
    }

    run.promptSent = true;
    const response = await proc.send({ id: run.promptId, type: "prompt", message: prompt });
    if (run.finished) return;
    await this.event(run, "status", "Prompt sent to agent");
    if (isObject(response.data) && response.data.agentInvoked === false) await this.complete(run);
  }

  private async onFrame(run: ActiveRun, frame: RpcFrame): Promise<void> {
    if (run.finished) return;
    switch (frame.type) {
      case "message_start":
        this.resetDeltas(run);
        break;
      case "message_update": {
        const event = frame.assistantMessageEvent;
        if (!isObject(event)) break;
        const delta = asString(event.delta) ?? "";
        const index = asNumber(event.contentIndex) ?? 0;
        if (event.type === "text_delta") {
          run.currentText += delta;
          this.onDelta(run, "text", index, delta);
        } else if (event.type === "thinking_delta") {
          this.onDelta(run, "thinking", index, delta);
        }
        break;
      }
      case "message_end": {
        if (isObject(frame.message) && frame.message.role === "assistant") {
          await this.onAssistantMessage(run, frame.message);
        } else {
          this.resetDeltas(run);
        }
        break;
      }
      case "tool_execution_start":
        await this.event(run, "tool", describeToolStart(frame));
        break;
      case "tool_execution_update":
        for (const patch of taskToolPatches(frame)) await this.trackSubagent(run, patch);
        break;
      case "tool_execution_end":
        for (const patch of taskToolPatches(frame)) await this.trackSubagent(run, patch);
        if (frame.isError === true) {
          const name = asString(frame.toolName) ?? "tool";
          const detail = truncate(oneLineTrim(resultText(frame.result)), MAX_TOOL_ERROR_TEXT);
          await this.event(run, "error", `✗ ${name} failed${detail ? `: ${detail}` : ""}`);
        } else if (frame.toolName === "todo") {
          await this.trackTodos(run, frame.result);
        }
        break;
      case "agent_end": {
        if (frame.isTerminal === false) break;
        const messages = Array.isArray(frame.messages) ? frame.messages : [];
        const last = messages.findLast((m): m is Json => isObject(m) && m.role === "assistant");
        if (last) {
          run.lastStopReason = asString(last.stopReason) ?? run.lastStopReason;
          run.lastError = assistantError(last) ?? run.lastError;
          if (!run.lastText) run.lastText = blockText(last.content, "text");
        }
        await this.complete(run);
        break;
      }
      case "prompt_result":
        if (frame.agentInvoked === false && (frame.id === undefined || frame.id === run.promptId)) {
          await this.complete(run);
        }
        break;
      case "response":
        // A scheduled prompt can be acknowledged and later fail asynchronously with the same id.
        if (frame.id === run.promptId && frame.success === false) {
          await this.fail(run, asString(frame.error) ?? "omp rejected the prompt");
        }
        break;
      case "auto_retry_start": {
        const attempt = asNumber(frame.attempt);
        const max = asNumber(frame.maxAttempts);
        const delay = asNumber(frame.delayMs);
        const reason = asString(frame.errorMessage);
        await this.event(
          run,
          "status",
          `Retrying${attempt !== undefined ? ` (attempt ${attempt}${max !== undefined ? `/${max}` : ""})` : ""}${delay !== undefined ? ` in ${Math.round(delay / 1000)}s` : ""}${reason ? ` after error: ${reason}` : ""}`,
        );
        break;
      }
      case "auto_retry_end":
        if (frame.success === true) await this.event(run, "status", "Retry succeeded");
        else await this.event(run, "error", `Retries exhausted${asString(frame.finalError) ? `: ${asString(frame.finalError)}` : ""}`);
        break;
      case "auto_compaction_start":
        await this.event(run, "status", "Compacting conversation context");
        break;
      case "auto_compaction_end": {
        const failure = asString(frame.errorMessage);
        if (failure) await this.event(run, "error", `Context compaction failed: ${failure}`);
        break;
      }
      case "notice": {
        const message = asString(frame.message);
        if (message) await this.event(run, frame.level === "error" ? "error" : "status", message);
        break;
      }
      case "extension_error":
        await this.event(
          run,
          "error",
          `Extension error${asString(frame.extensionPath) ? ` (${asString(frame.extensionPath)})` : ""}: ${asString(frame.error) ?? "unknown error"}`,
        );
        break;
      case "subagent_lifecycle": {
        const patch = lifecyclePatch(frame.payload);
        if (patch) await this.trackSubagent(run, patch);
        break;
      }
      case "subagent_progress": {
        const patch = isObject(frame.payload) ? progressPatch(frame.payload.progress) : null;
        if (patch) await this.trackSubagent(run, patch);
        break;
      }
      case "rpc_frame_error":
        await this.onTransportError(
          run,
          asString(frame.error) ?? "omp could not deliver a frame",
          asString(frame.originalType),
        );
        break;
    }
  }

  private async onAssistantMessage(run: ActiveRun, message: Json): Promise<void> {
    const thinking = blockText(message.content, "thinking");
    const text = blockText(message.content, "text");
    // Final live state first, so clients see it before the persisted run.event supersedes it.
    this.flushDelta(run, "thinking", thinking);
    this.flushDelta(run, "text", text);
    this.resetDeltas(run);
    if (thinking) await this.event(run, "thinking", truncate(thinking, MAX_THINKING_TEXT));
    if (text) {
      await this.event(run, "text", text);
      run.lastText = text;
    }
    run.currentText = "";
    run.lastStopReason = asString(message.stopReason) ?? null;
    run.lastError = assistantError(message) ?? null;
    if (run.lastStopReason === "error") {
      await this.event(run, "error", `Model error: ${run.lastError ?? "unknown error"}`);
    }
  }

  // --- Live deltas -----------------------------------------------------------------------

  private onDelta(run: ActiveRun, kind: DeltaKind, index: number, delta: string): void {
    if (!delta) return;
    const stream = run.deltas[kind];
    stream.blocks.set(index, (stream.blocks.get(index) ?? "") + delta);
    if (stream.timer) return; // the trailing publish will carry this delta
    const wait = stream.lastSentAt + DELTA_THROTTLE_MS - Date.now();
    if (wait <= 0) {
      this.publishDelta(run, kind, joinBlocks(stream.blocks));
      return;
    }
    stream.timer = setTimeout(() => {
      stream.timer = undefined;
      this.publishDelta(run, kind, joinBlocks(stream.blocks));
    }, wait);
  }

  /** Publish the message's final content if it streamed and differs from the last delta. */
  private flushDelta(run: ActiveRun, kind: DeltaKind, finalText: string): void {
    const stream = run.deltas[kind];
    clearTimeout(stream.timer);
    stream.timer = undefined;
    if (stream.blocks.size === 0) return;
    this.publishDelta(run, kind, finalText || joinBlocks(stream.blocks));
  }

  private publishDelta(run: ActiveRun, kind: DeltaKind, accumulated: string): void {
    if (run.finished || !run.runId) return;
    const stream = run.deltas[kind];
    const text = kind === "thinking" ? tail(accumulated, MAX_THINKING_DELTA) : accumulated;
    if (!text || text === stream.lastSentText) return;
    stream.lastSentAt = Date.now();
    stream.lastSentText = text;
    publish({
      type: "run.delta",
      runId: run.runId,
      taskId: run.taskId,
      boardId: run.boardId,
      kind,
      text,
    });
  }

  /** Drop accumulated deltas and any pending trailing publish (throttle window is kept). */
  private resetDeltas(run: ActiveRun): void {
    for (const stream of Object.values(run.deltas)) {
      clearTimeout(stream.timer);
      stream.timer = undefined;
      stream.blocks.clear();
      stream.lastSentText = "";
    }
  }

  /**
   * A logical frame was lost. If it was the terminal `agent_end`, complete now; otherwise ask
   * omp whether it is still working so a lost completion can never leave the task running.
   */
  private async onTransportError(
    run: ActiveRun,
    message: string,
    originalType: string | undefined,
  ): Promise<void> {
    if (run.finished) return;
    await this.event(run, "error", `Transport error: ${message}`);
    if (originalType === "agent_end") {
      await this.complete(run);
      return;
    }
    const proc = run.proc;
    if (!run.promptSent || !proc || proc.exited) return;
    try {
      const state = await proc.send({ type: "get_state" });
      if (!run.finished && isObject(state.data) && state.data.isStreaming === false) {
        await this.complete(run);
      }
    } catch {
      // The exit handler covers a dead process.
    }
  }

  private async onExit(run: ActiveRun, info: RpcExitInfo): Promise<void> {
    if (run.finished) return;
    await this.fail(
      run,
      info.error
        ? errorMessage(info.error, run.ompPath)
        : `omp exited unexpectedly (${describeExit(info)})`,
    );
  }

  private async steer(run: ActiveRun, comment: Comment): Promise<void> {
    try {
      if (run.finished || this.active.get(run.taskId) !== run || !run.proc) {
        // The run ended before the feedback could be steered; apply the normal comment rules.
        const task = await this.repo.getTask(run.taskId);
        if (task) await this.onComment(task, comment);
        return;
      }
      // Already part of this run's prompt.
      if (run.feedbackIds.has(comment.id)) return;
      try {
        const sender = comment.fromTaskId ? await this.repo.getTask(comment.fromTaskId) : null;
        // Steered like typing into the omp CLI mid-run: a `prompt` with streamingBehavior "steer" runs
        // magic-keyword detection (`orchestrate`, `ultrathink`, …), which the RPC `steer` command skips.
        // Its own id keeps it apart from run.promptId, so its response cannot complete or fail the run;
        // unlike the run's prompt it is answered right away, so it gets the normal command timeout.
        await run.proc.send(
          {
            id: `steer-${comment.id}`,
            type: "prompt",
            message: buildSteerMessage(comment, sender?.title),
            streamingBehavior: "steer",
          },
          { timeoutMs: run.proc.commandTimeoutMs },
        );
      } catch (err) {
        if (run.finished) {
          const task = await this.repo.getTask(run.taskId);
          if (task) await this.onComment(task, comment);
          return;
        }
        run.restartAfter = true;
        await this.event(
          run,
          "error",
          `Could not send feedback to the agent (it will be picked up by the next run): ${errorMessage(err, run.ompPath)}`,
        );
        return;
      }
      run.feedbackIds.add(comment.id);
      await this.event(run, "status", "Feedback sent to agent");
    } catch (err) {
      console.error(`[agent] failed to steer feedback for task ${run.taskId}:`, err);
    }
  }

  // --- Board tools (agent-to-agent collaboration) ----------------------------------------

  private toolHost(): BoardToolHost {
    return {
      repo: this.repo,
      start: (taskId) => this.start(taskId),
      onComment: (task, comment) => this.onComment(task, comment),
      isBusy: (taskId) => this.isTracked(taskId),
      lendSlot: (delta) => {
        this.lent = Math.max(0, this.lent + delta);
        void this.pump();
      },
    };
  }

  /** `host_tool_call`: run a board tool and answer with `host_tool_result`; `host_tool_cancel` aborts it. */
  private onHostTool(run: ActiveRun, proc: OmpRpcProcess, frame: RpcFrame): void {
    if (frame.type === "host_tool_cancel") {
      const target = asString(frame.targetId);
      if (target) run.hostCalls.get(target)?.abort();
      return;
    }
    const id = asString(frame.id);
    if (!id) return;
    const name = asString(frame.toolName) ?? "";
    const args = isObject(frame.arguments) ? frame.arguments : {};
    const controller = new AbortController();
    run.hostCalls.set(id, controller);
    const reply = (text: string, isError: boolean) => {
      run.hostCalls.delete(id);
      proc.notify({
        type: "host_tool_result",
        id,
        result: { content: [{ type: "text", text }] },
        ...(isError ? { isError: true } : {}),
      });
    };
    if (name === ADVISOR_TOOL.name && !run.finished) {
      this.askAdvisor(run, args, controller.signal).then(
        (text) => reply(text, false),
        (err: unknown) => reply(err instanceof Error ? err.message : String(err), true),
      );
      return;
    }
    if (run.finished || !run.boardId || !BOARD_TOOL_NAMES.has(name)) {
      reply(run.finished ? "The run has ended." : `Unknown tool ${name}`, true);
      return;
    }
    runBoardTool(this.toolHost(), { taskId: run.taskId, boardId: run.boardId }, name, args, controller.signal).then(
      (text) => reply(text, false),
      (err: unknown) => reply(err instanceof Error ? err.message : String(err), true),
    );
  }

  /** `ask_advisor`: the advisor decides a question the agent would otherwise leave for the user. */
  private async askAdvisor(run: ActiveRun, args: Json, signal: AbortSignal): Promise<string> {
    const ask = parseAdvisorArgs(args);
    if (!run.advisor) throw new Error("The advisor is not available yet.");
    await this.event(run, "status", truncate(`Agent asked the advisor: ${oneLineTrim(ask.question)}`, MAX_TOOL_ERROR_TEXT));
    try {
      const decision = await consultAdvisor({ ...run.advisor, signal }, ask);
      await this.event(
        run,
        "status",
        truncate(
          `Advisor${decision.needsUser ? " (left for the user)" : ""}: ${oneLineTrim(decision.decision)}`,
          MAX_TOOL_ERROR_TEXT,
        ),
      );
      return formatDecision(decision);
    } catch (err) {
      if (!signal.aborted) await this.event(run, "error", `Advisor failed: ${errorMessage(err, run.ompPath)}`);
      throw err;
    }
  }

  /**
   * The run's summary asks the user something: the advisor answers what it can and keeps for the
   * user only what needs their judgment. Null when it could not (the question goes to the user as is).
   */
  private async triage(run: ActiveRun, question: string, summary: string): Promise<QuestionTriage | null> {
    if (!run.advisor) return null;
    await this.event(run, "status", "Advisor is reviewing the agent's questions");
    try {
      // The run has already ended: nothing cancels the triage (the advisor's timeout bounds it).
      const triage = await triageQuestions({ ...run.advisor, signal: new AbortController().signal }, { question, summary });
      await this.event(
        run,
        "status",
        `Advisor answered ${triage.answers.length} question${triage.answers.length === 1 ? "" : "s"}${triage.userQuestion ? "; the rest needs you" : ""}`,
      );
      return triage;
    } catch (err) {
      await this.event(run, "error", `Advisor could not review the questions: ${errorMessage(err, run.ompPath)}`);
      return null;
    }
  }

  private async complete(run: ActiveRun): Promise<void> {
    if (run.finished) return;
    if (run.lastStopReason === "error" || run.lastStopReason === "aborted") {
      await this.fail(
        run,
        run.lastStopReason === "error"
          ? (run.lastError ?? "The model returned an error")
          : "The agent run was aborted",
      );
      return;
    }
    run.finished = true;
    const repo = this.repo;
    let retryAt: string | null = null;
    try {
      let summary = "";
      if (run.proc && !run.proc.exited) {
        try {
          const response = await run.proc.send(
            { type: "get_last_assistant_text" },
            { timeoutMs: SUMMARY_TIMEOUT_MS },
          );
          summary = (isObject(response.data) ? asString(response.data.text) : undefined)?.trim() ?? "";
        } catch {
          // Fall back to the streamed text below.
        }
      }
      if (!summary) summary = run.lastText || run.currentText.trim();
      const asked = extractQuestion(summary);
      const triage = asked ? await this.triage(run, asked, summary) : null;

      if (run.runId) {
        const updated = await repo.updateRun(run.runId, {
          status: "succeeded",
          summary: summary || null,
          error: null,
          endedAt: nowIso(),
        });
        if (updated) publish({ type: "run.updated", run: updated, boardId: run.boardId });
        await this.settleSubagents(run);
        await this.event(run, "status", "Agent finished");
      }

      const comment = await repo.addComment({
        taskId: run.taskId,
        author: "agent",
        body: summary || "Done.",
        resolved: true,
      });
      publish({ type: "comment.added", comment, boardId: run.boardId });

      if (triage && triage.answers.length > 0) {
        const answers = await repo.addComment({
          taskId: run.taskId,
          author: "agent",
          body: formatAnswers(triage.answers),
          resolved: true,
        });
        publish({ type: "comment.added", comment: answers, boardId: run.boardId });
      }
      // The advisor sends the agent back to work once; a second round of questions goes to the user.
      const followUp = triage?.followUp && !run.advisorFollowUp ? triage.followUp : null;
      if (followUp) {
        const feedback = await repo.addComment({
          taskId: run.taskId,
          author: "user",
          body: `${ADVISOR_FEEDBACK_PREFIX}${followUp}`,
        });
        publish({ type: "comment.added", comment: feedback, boardId: run.boardId });
        run.restartAfter = true;
      }
      const question = triage ? (triage.userQuestion ?? (triage.followUp && !followUp ? asked : null)) : asked;

      if (run.runId && run.feedbackIds.size > 0) {
        const resolved = await repo.resolveComments([...run.feedbackIds], run.runId);
        for (const c of resolved) publish({ type: "comment.updated", comment: c, boardId: run.boardId });
      }

      // A card the advisor sends back to work stays In progress.
      const task = await repo.updateTask(run.taskId, {
        ...(followUp ? {} : { status: "done" as const, position: await this.topPosition(run.boardId, "done", run.taskId) }),
        agentState: "idle",
        agentError: null,
        question,
        autoRetries: 0,
        retryAt: null,
      });
      if (task) publish({ type: "task.updated", task });
    } catch (err) {
      console.error(`[agent] failed to record the result for task ${run.taskId}:`, err);
      retryAt = await this.writeTaskError(run.taskId, `Failed to record the agent result: ${errorMessage(err, run.ompPath)}`);
    } finally {
      this.release(run);
      if (retryAt) this.scheduleRetry(run.taskId, retryAt);
    }
  }

  private async fail(run: ActiveRun, message: string): Promise<void> {
    if (run.finished) return;
    run.finished = true;
    const repo = this.repo;
    let retryAt: string | null = null;
    try {
      if (run.runId) {
        const updated = await repo.updateRun(run.runId, {
          status: "failed",
          error: message,
          endedAt: nowIso(),
        });
        if (updated) publish({ type: "run.updated", run: updated, boardId: run.boardId });
        await this.settleSubagents(run);
        await this.event(run, "error", message);
      }
      // Feedback that arrived meanwhile starts a fresh run once this one is released.
      const failure = await this.recordFailure(run.taskId, message, !run.restartAfter);
      retryAt = failure.retryAt;
      if (failure.task) {
        await this.addAgentComment(failure.task, `Agent failed: ${message}${failure.note ? `\n\n${failure.note}` : ""}`);
      }
    } catch (err) {
      console.error(`[agent] failed to record the failure of task ${run.taskId}:`, err);
    } finally {
      this.release(run);
      // After the release: a retry due right away must not find the run still active.
      if (retryAt) this.scheduleRetry(run.taskId, retryAt);
    }
  }

  // --- Persistence helpers ---------------------------------------------------------------

  /** Persist + broadcast a run event. Never throws: a log write must not kill a run. */
  private async event(run: ActiveRun, kind: RunEventKind, text: string): Promise<void> {
    if (!run.runId || !text) return;
    try {
      const event = await this.repo.appendRunEvent({
        runId: run.runId,
        taskId: run.taskId,
        kind,
        text: truncate(text, MAX_EVENT_TEXT),
      });
      publish({ type: "run.event", event, boardId: run.boardId });
    } catch (err) {
      console.error(`[agent] failed to store a run event for task ${run.taskId}:`, err);
    }
  }

  /** Stores the agent's todo list (`todo` tool result `details.phases`) on the card, with item timing stamps. */
  private async trackTodos(run: ActiveRun, result: unknown): Promise<void> {
    if (!isObject(result) || !isObject(result.details) || !Array.isArray(result.details.phases)) return;
    const fresh = parseTodoPhases(result.details.phases);
    const json = JSON.stringify(fresh);
    if (json === run.todos) return;
    run.todos = json;
    const now = new Date().toISOString();
    try {
      // A run's first update carries the stamps of the list stored by an earlier run.
      const previous = run.stampedTodos?.list ?? (await this.repo.getTask(run.taskId))?.todos ?? [];
      const todos = stampTodos(previous, fresh, {
        now,
        runStart: run.launchedAt,
        lastUpdate: run.stampedTodos?.at ?? run.launchedAt,
      });
      run.stampedTodos = { list: todos, at: now };
      const task = await this.repo.updateTask(run.taskId, { todos });
      if (task) publish({ type: "task.updated", task });
    } catch (err) {
      console.error(`[agent] failed to store the todo list of task ${run.taskId}:`, err);
    }
  }

  /**
   * Merge a subagent update. A new subagent, a status change or its final report is persisted
   * as an `agent` run event; anything else (tool calls, token counts) is only published live.
   */
  private async trackSubagent(run: ActiveRun, patch: SubagentPatch): Promise<void> {
    if (run.finished || !run.runId) return;
    const tracked = run.subagents.get(patch.id);
    const snapshot = mergeSubagent(tracked?.snapshot, patch);
    if (!tracked) {
      const entry: TrackedSubagent = { snapshot, persisted: "", published: "", publishedAt: 0 };
      run.subagents.set(patch.id, entry);
      await this.persistSubagent(run, entry);
      return;
    }
    const milestone =
      snapshot.status !== tracked.snapshot.status ||
      snapshot.output !== tracked.snapshot.output ||
      snapshot.error !== tracked.snapshot.error;
    tracked.snapshot = snapshot;
    if (milestone) {
      await this.persistSubagent(run, tracked);
      return;
    }
    const json = JSON.stringify(snapshot);
    const now = Date.now();
    if (json === tracked.published || now - tracked.publishedAt < SUBAGENT_LIVE_THROTTLE_MS) return;
    tracked.published = json;
    tracked.publishedAt = now;
    publish({ type: "run.agent", runId: run.runId, taskId: run.taskId, boardId: run.boardId, agent: snapshot });
  }

  private async persistSubagent(run: ActiveRun, tracked: TrackedSubagent): Promise<void> {
    const json = JSON.stringify(tracked.snapshot);
    if (json === tracked.persisted) return;
    tracked.persisted = json;
    tracked.published = json;
    await this.event(run, "agent", json);
  }

  /** Run ended: persist every subagent's final state; any still working died with the process. */
  private async settleSubagents(run: ActiveRun): Promise<void> {
    for (const tracked of run.subagents.values()) {
      if (!isTerminalSubagent(tracked.snapshot.status)) {
        tracked.snapshot = mergeSubagent(tracked.snapshot, {
          id: tracked.snapshot.id,
          status: "aborted",
          currentTool: null,
          currentToolDetail: null,
        });
      }
      await this.persistSubagent(run, tracked);
    }
  }

  private async setIdle(taskId: string): Promise<Task | null> {
    const task = await this.repo.updateTask(taskId, { agentState: "idle", agentError: null, retryAt: null });
    if (task) publish({ type: "task.updated", task });
    return task;
  }

  /** Error from a hook (start/stop/steer plumbing); a tracked run owns the task state instead. */
  private async recordTaskError(taskId: string, err: unknown): Promise<void> {
    const message = errorMessage(err, "omp");
    console.error(`[agent] task ${taskId}: ${message}`);
    if (this.isTracked(taskId)) return;
    const retryAt = await this.writeTaskError(taskId, message);
    if (retryAt) this.scheduleRetry(taskId, retryAt);
  }

  /** Never throws. Returns when the card's automatic retry is due, which the caller schedules. */
  private async writeTaskError(taskId: string, message: string): Promise<string | null> {
    try {
      return (await this.recordFailure(taskId, message, true)).retryAt;
    } catch (err) {
      console.error(`[agent] failed to record the error for task ${taskId}:`, err);
      return null;
    }
  }

  /** Position that puts a card at the top of a column. */
  private async topPosition(boardId: string, status: TaskStatus, excludeId: string): Promise<number> {
    const tasks = await this.repo.listTasks(boardId);
    let min = Number.POSITIVE_INFINITY;
    for (const t of tasks) {
      if (t.status === status && t.id !== excludeId && t.position < min) min = t.position;
    }
    return Number.isFinite(min) ? min - 1024 : 0;
  }
}

// --- Frame helpers ---------------------------------------------------------------------------

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Joined `text` or `thinking` blocks of an assistant message's content. */
function blockText(content: unknown, kind: "text" | "thinking"): string {
  if (typeof content === "string") return kind === "text" ? content.trim() : "";
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isObject(block) || block.type !== kind) continue;
    const value = asString(block[kind])?.trim();
    if (value) parts.push(value);
  }
  return parts.join("\n\n");
}

function assistantError(message: Json): string | undefined {
  return asString(message.errorMessage) ?? asString(message.error);
}

/**
 * Persisted log line for a `tool_execution_start` frame: `▸ name: detail`, plus the call's intent
 * on a second line when it differs from the detail. Board tool calls keep their JSON args as the
 * detail so readers (the Visualize tab) can recover the card ids they touch.
 */
export function describeToolStart(frame: RpcFrame): string {
  const rawArgs = isObject(frame.args) ? frame.args : undefined;
  const { name, args } = unwrapDeviceCall(asString(frame.toolName) ?? "tool", rawArgs);
  const intent = asString(frame.intent) ?? asString(rawArgs?.intent) ?? asString(args?.intent);
  const detail = name.startsWith("board_")
    ? boardToolDetail(name, args)
    : ((name === "task" ? describeTaskCall(args, intent) || undefined : undefined) ??
      asString(args?.command) ??
      intent ??
      asString(args?.path) ??
      (args && Object.keys(args).length > 0 ? JSON.stringify(args) : ""));
  const line = oneLineTrim(detail);
  const head = truncate(`▸ ${name}${line ? `: ${line}` : ""}`, MAX_TOOL_TEXT);
  // The intent rides on a second line (readers that want one line take the first): the log shows
  // "why" first and keeps the raw command as detail. `task` already folds the intent into its line.
  const why = intent && name !== "task" ? oneLineTrim(intent) : "";
  return why && why !== line ? `${head}\n${truncate(why, MAX_TOOL_INTENT_TEXT)}` : head;
}

/**
 * Some omp builds expose host tools as `xd://<tool>` devices: the agent calls `write` with the
 * tool's JSON args as `content`. Such a call is logged as the device tool itself.
 */
function unwrapDeviceCall(name: string, args: Json | undefined): { name: string; args: Json | undefined } {
  const target = name === "write" ? asString(args?.path) : undefined;
  const content = asString(args?.content);
  if (!target?.startsWith("xd://") || content === undefined) return { name, args };
  const device = target.slice("xd://".length).split("/")[0];
  if (!device) return { name, args };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { name, args };
  }
  return isObject(parsed) ? { name: device, args: parsed } : { name, args };
}

/** Board tool args as one-line JSON without the intent; `board_message_card` leads with its card id. */
function boardToolDetail(name: string, args: Json | undefined): string {
  const rest: Json = { ...args };
  delete rest.intent;
  const ordered = name === "board_message_card" && "cardId" in rest ? { cardId: rest.cardId, ...rest } : rest;
  return Object.keys(ordered).length > 0 ? JSON.stringify(ordered) : "";
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  if (isObject(result) && Array.isArray(result.content)) {
    return result.content
      .map((block) => (isObject(block) && block.type === "text" ? (asString(block.text) ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(result);
}

function oneLineTrim(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Keeps the end of a growing text (live thinking shows its latest part). */
function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
}

function newDeltaStream(): DeltaStream {
  return { blocks: new Map(), lastSentAt: 0, lastSentText: "", timer: undefined };
}

/** Streamed blocks rendered like the persisted event (`blockText`): trimmed, joined by blank lines. */
function joinBlocks(blocks: Map<number, string>): string {
  return [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, value]) => value.trim())
    .filter(Boolean)
    .join("\n\n");
}

function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

interface RetryPlan {
  /** Retries used once this one starts (1-based). */
  attempt: number;
  /** Retry budget; null when unlimited (persistent retries). */
  max: number | null;
  /** The run failed on a quota / usage limit: a long backoff ("Waiting for quota"). */
  quota: boolean;
  delayMs: number;
}

/** Why a card is retried: its run failed with `message`, or the server restart interrupted it. */
type RetryCause = { kind: "failure"; message: string } | { kind: "restart" };

/**
 * The card's next automatic retry; "exhausted" when its budget is used up, null when it is not
 * retried at all (retries off, or the card is not In progress anymore). With persistent retries
 * on, a failed run is always retried (never exhausted, whatever maxAutoRetries says); restart
 * interruptions stay bounded by maxAutoRetries so a server-restarting agent cannot loop forever.
 * Quota failures back off along QUOTA_RETRY_STEPS_MS, other failures exponentially.
 */
function planRetry(task: Task, settings: AppSettings, cause: RetryCause): RetryPlan | "exhausted" | null {
  if (!settings.autoRetry || task.status !== "in_progress") return null;
  const unlimited = cause.kind === "failure" && settings.persistentRetry;
  if (!unlimited) {
    if (settings.maxAutoRetries === 0) return null;
    if (task.autoRetries >= settings.maxAutoRetries) return "exhausted";
  }
  const attempt = task.autoRetries + 1;
  const quota = cause.kind === "failure" && isQuotaError(cause.message);
  return {
    attempt,
    max: unlimited ? null : settings.maxAutoRetries,
    quota,
    delayMs: quota ? quotaRetryDelay(attempt) : retryDelay(attempt),
  };
}

function retryDelay(attempt: number): number {
  // OMP_UI_RETRY_BASE_MS: first backoff step (default 15 s), doubling per retry.
  const base = Number(process.env.OMP_UI_RETRY_BASE_MS) || RETRY_BASE_MS;
  return Math.min(RETRY_MAX_MS, base * 2 ** (attempt - 1));
}

function quotaRetryDelay(attempt: number): number {
  const step = QUOTA_RETRY_STEPS_MS[Math.min(attempt, QUOTA_RETRY_STEPS_MS.length) - 1];
  // OMP_UI_QUOTA_RETRY_BASE_MS: first step (default 5 min); later steps scale along.
  const base = Number(process.env.OMP_UI_QUOTA_RETRY_BASE_MS);
  return base ? Math.round((step * base) / QUOTA_RETRY_STEPS_MS[0]) : step;
}

function retryCount(plan: RetryPlan): string {
  return plan.max === null ? `retry ${plan.attempt}` : `retry ${plan.attempt} of ${plan.max}`;
}

/** Failure-comment note of a scheduled retry. */
function retryNote(plan: RetryPlan): string {
  const delay = formatDelay(plan.delayMs);
  return plan.quota
    ? `Waiting for quota: retrying automatically in ${delay} (${retryCount(plan)}).`
    : `Retrying automatically in ${delay} (${retryCount(plan)}).`;
}

function formatDelay(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60}s`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

/** Per-run omp config overlay (`--config`): browser control for this card. JSON is valid YAML. */
async function writeRunConfig(taskId: string, settings: AppSettings, taskFiles: string): Promise<string> {
  const dir = path.join(dataDir(), "runtime");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `omp-config-${taskId}.yml`);
  const browser =
    settings.browser === "off"
      ? { enabled: false }
      : {
          enabled: true,
          headless: settings.browser !== "visible",
          relay: settings.browser === "relay",
          screenshotDir: path.join(taskFiles, "screenshots"),
        };
  await writeFile(file, `${JSON.stringify({ browser }, null, 2)}\n`);
  return file;
}

function errorMessage(err: unknown, ompPath: string): string {
  const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
  if (code === "ENOENT") return `omp not found at ${ompPath}. Install from https://omp.sh or set OMP_PATH`;
  if (code === "EACCES") return `omp at ${ompPath} is not executable (permission denied)`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** SIGTERM now, escalate to SIGKILL via close() if omp does not exit. */
function terminate(proc: OmpRpcProcess): void {
  proc.kill("SIGTERM");
  void proc.close();
}

// --- Singleton -------------------------------------------------------------------------------

const g = globalThis as unknown as { __ompUiAgentManager?: Promise<AgentManager> };

async function createAgentManager(): Promise<AgentManager> {
  const repo = await getRepo();
  await repo.abortRunningRuns("Server restarted");
  const manager = new OmpAgentManager(repo);
  await manager.recover();
  startCleanupScheduler(repo, manager);
  startCredentialHealthChecks(repo);
  startSchedulerService(repo, manager);
  return manager;
}

/** Process-wide agent manager; the first call performs boot recovery. */
export async function getAgentManager(): Promise<AgentManager> {
  g.__ompUiAgentManager ??= createAgentManager().catch((err: unknown) => {
    g.__ompUiAgentManager = undefined;
    throw err;
  });
  return g.__ompUiAgentManager;
}
