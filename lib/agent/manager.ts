import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
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
import {
  AgentMemoryModel,
  CONCURRENCY_SAMPLE_MS,
  committedMemoryBytes,
  readLoadHold,
  readMachineResources,
  resolveConcurrency,
  subagentConcurrency,
} from "@/lib/agent/concurrency";
import { currentResourcePressure, startResourceGuard } from "@/lib/agent/resource-guard";
import { LoopDetector, loopSteerMessage, type LoopDetection } from "@/lib/agent/loop-detector";
import { chooseModel, readModelRoles } from "@/lib/agent/model-select";
import { chooseProvider, markOutOfQuota } from "@/lib/agent/provider-quota";
import { buildPrompt, buildSteerMessage } from "@/lib/agent/prompt";
import { planQueue, type PlanCard, type QueuePlan } from "@/lib/agent/queue-planner";
import { listProcesses, nextResources, treeTotals } from "@/lib/agent/resources";
import {
  emptyUsage,
  sameUsage,
  SessionUsageScanner,
  sumUsage,
  usageBeyond,
  type UsageSums,
} from "@/lib/agent/session-usage";
import { OmpRpcProcess, describeExit, type RpcExitInfo, type RpcFrame } from "@/lib/agent/rpc";
import {
  evaluateBudget,
  evaluateRunGuards,
  evaluateWrapUp,
  guardsEnabled,
  guardTickMs,
  sessionUsage,
  totalUsage,
  wrapUpSteerMessage,
  type RunGuardState,
  type RunUsage,
  type WrapUpHit,
} from "@/lib/agent/run-guards";
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
import { childEnv, remoteChildEnv } from "@/lib/child-env";
import { startCleanupScheduler } from "@/lib/cleanup";
import { clusterRole, readNodeState, startCluster } from "@/lib/cluster/node";
import { sessionDirFor } from "@/lib/cluster/paths";
import {
  cancelPlacement,
  clusterCapacity,
  isPrimaryActive,
  openRemoteRun,
  placeRun,
  reportLocalRuns,
  type RemoteRunInfo,
  type RunPlacement,
} from "@/lib/cluster/primary";
import { NODE_LOST_CODE } from "@/lib/cluster/types";
import { getRepo } from "@/lib/db";
import type { Repository, UpdateTaskInput } from "@/lib/db/types";
import { topPosition } from "@/lib/db/util";
import { removeTaskDockerResources } from "@/lib/docker";
import { publish } from "@/lib/events";
import { dataDir, ensureFilesFolder } from "@/lib/files";
import { extractQuestion } from "@/lib/question";
import { fallbackRetryConfig, selectorProvider, type ProviderPick } from "@/lib/provider-priority";
import { isQuotaError, QUOTA_RETRY_STEPS_MS } from "@/lib/quota";
import { startSchedulerService } from "@/lib/scheduler";
import {
  QUALITY_GATE_PREFIX,
  releaseGate,
  SDLC_PHASE_INFO,
  SDLC_PHASES,
  sdlcChange,
  sdlcProgress,
  type SdlcViolation,
} from "@/lib/sdlc";
import {
  agentmemoryEnabled,
  MEMORY_OFF_ENV,
  memoryOffOverlay,
  memoryProjectName,
  tagMemorySession,
} from "@/lib/server/agentmemory";
import { loadAiProviderEnv } from "@/lib/server/ai-providers";
import { createCheckpoints } from "@/lib/server/checkpoints";
import { startChatIntegrations } from "@/lib/server/chat/service";
import { startCredentialHealthChecks } from "@/lib/server/credentials";
import { HttpError } from "@/lib/server/http";
import { startMcpSync } from "@/lib/server/mcp";
import { mcpAgentEnv } from "@/lib/server/mcp-env";
import { agentDir } from "@/lib/server/omp-config";
import { startTelemetryExporter } from "@/lib/server/telemetry";
import { getAppSettings } from "@/lib/settings";
import { parseTodoPhases, stampTodos } from "@/lib/todos";
import { ensureWorkspace } from "@/lib/workspaces";
import type {
  AgentResources,
  AppSettings,
  ApprovalMode,
  Comment,
  ConcurrencyInfo,
  ContextUsage,
  QueueEntry,
  QueueSnapshot,
  RunEventKind,
  SteerState,
  SubagentSnapshot,
  Task,
  TaskStatus,
  TaskUsage,
  TodoPhase,
} from "@/lib/types";

const READY_TIMEOUT_MS = 60_000;
/** Remote runs first sync the card's folders to the node (and the node may fetch the omp binary). */
const REMOTE_READY_TIMEOUT_MS = 10 * 60_000;
const ABORT_TIMEOUT_MS = 5_000;
const SUMMARY_TIMEOUT_MS = 15_000;
/** `get_session_stats` after an assistant message: best effort, never blocks frame handling. */
const CONTEXT_STATS_TIMEOUT_MS = 5_000;
/** Least time between two session usage scans of a run while it goes (the run's end always scans). */
const USAGE_REFRESH_MS = 15_000;
const PUMP_RETRY_MS = 5_000;
const MAX_EVENT_TEXT = 50_000;
const MAX_THINKING_TEXT = 2_000;
const MAX_TOOL_TEXT = 300;
const MAX_TOOL_INTENT_TEXT = 160;
const MAX_TOOL_ERROR_TEXT = 1_000;
/** Text quoted inside a status line (a delivered steer, a declined omp dialog's title). */
const MAX_QUOTED_TEXT = 120;
/** RPC id prefix of a steered comment (`steer-<comment id>`): its prompt_result names the comment. */
const STEER_ID_PREFIX = "steer-";
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
/** Memory/CPU sampling of the running agents' process trees (live `run.resources` events). */
const RESOURCE_SAMPLE_MS = 5_000;
/** A run's first resource sample waits until its process has run this long (see sampleResources). */
const FIRST_SAMPLE_MIN_MS = 1_000;
/**
 * A run not sampled yet (sampling failed, or Windows where it is unavailable) still counts as
 * growing to the learned memory per agent this long after its spawn; later its memory is taken
 * as fully grown, i.e. already missing from the free figure.
 */
const MEMORY_WARMUP_MS = 90_000;
/**
 * Only a run that lived this long teaches the learned memory per agent: a quota/auth wave failing
 * many cards within seconds would otherwise pull the estimate down to its floor.
 */
const MEMORY_LEARN_MIN_MS = 120_000;
/**
 * Boot seeding learns only from cards whose stored resources show at least this much CPU: a proxy
 * for a run that did work (a run crashing at start uses a few CPU seconds).
 */
const MEMORY_LEARN_MIN_CPU_SECONDS = 30;
/** Suffix of the error of a run whose node was lost (rescheduleLost): not the agent's failure. */
const RESCHEDULED_SUFFIX = "; rescheduled";

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
  /** Cluster mode (primary): the node the run was placed on; null on a standalone server. */
  placement: RunPlacement | null;
  /** The placement's slot is still reserved: the process has not opened yet (cancelUnusedPlacement). */
  placementPending: boolean;
  /** Remote placement: the run's node-side details (resource totals); null for local runs. */
  remote: RemoteRunInfo | null;
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
  /** This run addresses a release-gate comment (QUALITY_GATE_PREFIX): missing the gate again ships the card anyway. */
  qualityGateFollowUp: boolean;
  /** JSON of the omp todo list this run last stored on the card; repeated `todo` views write nothing. */
  todos: string | null;
  /** When this run was launched (ISO); bounds which `startedAt` todo stamps count as this run's work. */
  launchedAt: string;
  /** The stamped todo list this run last stored, and when; null before its first update. */
  stampedTodos: { list: TodoPhase[]; at: string } | null;
  /** Context window fill as of the latest `get_session_stats`; null before the first model reply. */
  context: ContextUsage | null;
  /** When omp last sent any frame (ms epoch), for the stall watchdog. */
  lastActivityAt: number;
  /** Spend of the run's own omp session as of the latest `get_session_stats` (subagents excluded). */
  sessionUsage: RunUsage;
  /** Loop detection (settings `loopDetection` at launch); null when off or turned off mid-run. */
  loop: LoopDetector | null;
  /** Loops detected so far: the first steers the agent, the second fails the run. */
  loopStrikes: number;
  /** The wrap-up nudge (settings `wrapUpNudge`) was sent: it is sent at most once per run. */
  wrapUpSent: boolean;
  /** SDLC violations (`phase:requires`) already steered back to the agent: each is steered once per run. */
  sdlcNudges: Set<string>;
  /** When the run's omp process was spawned (ms epoch); 0 before. The first CPU rate counts from here. */
  spawnedAt: number;
  /** Latest memory/CPU sample of the omp process tree; persisted on the task when the run is released. */
  resources: AgentResources | null;
  /** Raw CPU total of the process tree at the latest sample (`nextResources`); 0 before the first. */
  treeCpuSeconds: number;
  /** Session JSONL this run's spend is tallied from (`get_state`); null until known or when untrusted. */
  usageFile: string | null;
  /** Incremental reader of `usageFile` and its subagents' files; created on the first scan. */
  usageScanner: SessionUsageScanner | null;
  /** Spend of the card's earlier omp sessions, when this run started a new one; zero otherwise. */
  usageBase: UsageSums;
  /** Usage last stored on the card (`Task.usage`); null when none. */
  usage: UsageSums | null;
  /** When the latest usage scan was scheduled (ms epoch); 0 before. */
  usageScannedAt: number;
  /** Usage scans run one after another. */
  usageChain: Promise<void>;
  /** Approval mode the run's omp was started with (settings `approvalMode` at launch). */
  approvalMode: ApprovalMode;
  /** omp's `confirm` dialogs are approved (yolo); otherwise lib/agent/rpc.ts declines them. */
  autoConfirm: boolean;
  /**
   * Ids of steers sent as `prompt` with streamingBehavior "steer" (sendSteer) whose `prompt_result`
   * has not arrived: such a steer may still start another turn, so the run cannot complete yet.
   */
  pendingSteers: Set<string>;
  /** The agent yielded: a terminal `agent_end` from an omp that reports `yielded`; reset by `agent_start`. */
  yielded: boolean;
  /** omp reported the session settled (nothing queued or in the background can wake it) since the last `agent_start`. */
  settled: boolean;
  /** Steering texts omp last reported queued (`queue_update`); a text that leaves the queue reached the agent. */
  queuedSteering: string[];
  /**
   * Comments steered into this run that have not reached the agent yet: comment id → the message
   * sent. One reaches the agent when its text leaves omp's steering queue (`queue_update`) or its
   * steer's `prompt_result` arrives; the card's Activity chat is told (`comment.steer`).
   */
  undeliveredSteers: Map<string, string>;
  /** The "waiting for background work" status was logged for this stretch of the run (reset by `agent_start`). */
  waitingLogged: boolean;
  /**
   * omp provider of the model the run is on (omp's `get_state`, then each `retry_fallback_applied`);
   * a quota failure puts it on cooldown for the provider priority. Null until omp reports it.
   */
  provider: string | null;
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

class OmpAgentManager implements AgentManager, RunControl {
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

  /** Agents allowed at once, as of the latest pump (part of the `queue.updated` dedupe key). */
  private limit = 0;
  /** What bounds the limit as of the latest pump (part of the dedupe key, so a hold/resume always republishes). */
  private boundBy: ConcurrencyInfo["boundBy"] = null;
  /** Re-samples the machine (an automatic limit) while cards wait in the queue. */
  private sampler: NodeJS.Timeout | undefined;
  /** Run guards (lib/agent/run-guards.ts): ticks while any run is active. */
  private supervisor: NodeJS.Timeout | undefined;
  /** Samples the active runs' memory/CPU (sampleResources): ticks while any run is active. */
  private resourceSampler: NodeJS.Timeout | undefined;
  /** A resource sample is in flight; overlapping ticks are skipped. */
  private sampling = false;
  /** Failback (lib/cluster/node.ts handOverPrimary): pump() launches nothing while set. */
  private holding = false;
  /** Cluster mode: this machine's own agent limit, as of the latest resolveLimit(). */
  private localLimit = 0;
  /** Cluster mode: this machine's resource or load guard holds new local runs, as of the latest resolveLimit(). */
  private localHeld = false;
  /** Last reportLocalRuns() payload (deduplicates). */
  private lastLocalReport = "";
  /**
   * Learns the memory one agent needs from the peak RSS of finished runs, local and remote alike
   * (auto limit): it is a property of the workload (omp and its builds/tests), not of the node.
   */
  private readonly memoryModel = new AgentMemoryModel();

  constructor(private readonly repo: Repository) {}

  stats(): { running: string[]; queued: string[] } {
    return { running: [...this.active.keys()], queued: [...this.claiming, ...this.queue] };
  }

  contextUsage(taskId: string): ContextUsage | null {
    const run = this.active.get(taskId);
    return run && !run.finished ? run.context : null;
  }

  holdNewRuns(hold: boolean): void {
    if (this.holding === hold) return;
    this.holding = hold;
    if (!hold) void this.pump();
  }

  activeRunCount(): number {
    return this.active.size;
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
        planning: state === "queued" && this.awaitsPlan(taskId),
        planNote: this.planNotes.get(taskId) ?? null,
        createdByTaskId: task.createdByTaskId ?? null,
        sdlc: sdlcProgress(task.todos),
        node: state === "running" ? this.nodeOf(taskId) : null,
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
    const concurrency = this.resolveLimit(settings);
    return { limit: concurrency.limit, concurrency, running, queued, planning };
  }

  /** The node a running card was placed on (cluster mode); null on a standalone server. */
  private nodeOf(taskId: string): QueueEntry["node"] {
    const placement = this.active.get(taskId)?.placement;
    return placement ? { id: placement.nodeId, name: placement.nodeName } : null;
  }

  /**
   * The agent limit in effect: this machine's own, plus (cluster mode, primary) the slots of the
   * replica nodes; the local part then counts only the runs on this machine. A local hold does not
   * hold cards cluster-wide while replicas have slots.
   */
  private resolveLimit(settings: AppSettings): ConcurrencyInfo {
    const cluster = clusterActive();
    const localRuns = this.localRuns();
    const perAgentBytes = this.memoryModel.estimate();
    const now = Date.now();
    const local = resolveConcurrency(
      settings.maxConcurrentAgents,
      cluster ? localRuns.length : this.active.size,
      undefined,
      readLoadHold(settings),
      currentResourcePressure(),
      // A hold launches nothing, not even into lent slots. Cluster placement counts its own free local slots.
      cluster ? 0 : this.lent,
      // Local runs not at their expected size yet will still take memory the free figure counts.
      {
        perAgentBytes,
        committedBytes: committedMemoryBytes(
          perAgentBytes,
          // Unsampled: fully committed while warming up, then taken as fully grown.
          localRuns.map(
            (run) =>
              run.resources?.memoryBytes ??
              (run.spawnedAt === 0 || now - run.spawnedAt < MEMORY_WARMUP_MS ? null : perAgentBytes),
          ),
        ),
      },
    );
    if (!cluster) return local;
    this.localLimit = local.limit;
    const capacity = clusterCapacity(local.limit, settings.clusterRunLocal);
    const held = local.boundBy === "resources" || local.boundBy === "load";
    this.localHeld = held;
    if (held && capacity.info.remoteSlots > 0) {
      return {
        ...local,
        limit: capacity.limit,
        cluster: capacity.info,
        boundBy: null,
        reason: `${local.reason} on this machine — new cards run on other nodes`,
      };
    }
    return { ...local, limit: capacity.limit, cluster: capacity.info };
  }

  /** Active runs on this machine (no placement, or placed locally). */
  private localRuns(): ActiveRun[] {
    return [...this.active.values()].filter((run) => !run.placement || run.placement.local);
  }

  /** Cluster mode: tell the primary runtime which cards run on this machine and its own limit. */
  private reportLocal(): void {
    if (!clusterActive()) return;
    const taskIds = this.localRuns().map((run) => run.taskId);
    const key = JSON.stringify([taskIds, this.localLimit]);
    if (key === this.lastLocalReport) return;
    this.lastLocalReport = key;
    reportLocalRuns(taskIds, this.localLimit);
  }

  /** Returns the slot reserved for a run that never opened its process (released or deleted first). */
  private cancelUnusedPlacement(run: ActiveRun): void {
    if (!run.placement || !run.placementPending) return;
    run.placementPending = false;
    cancelPlacement(run.placement);
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
        patch.position = await topPosition(this.repo, current.boardId, "in_progress", taskId);
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
        publishSteer(task.boardId, task.id, comment.id, "deferred");
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
    this.stopSupervisorIfIdle();
    this.stopResourceSamplerIfIdle();
    if (run.proc) terminate(run.proc);
    else this.cancelUnusedPlacement(run);
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
    // Before queued runs start: the automatic limit sizes them by the learned memory per agent.
    await this.seedMemoryModel();
    // Oldest first (listTasksByAgentState orders by updatedAt).
    for (const task of await this.repo.listTasksByAgentState(["running", "queued", "error"])) {
      try {
        await this.recoverTask(task, settings);
      } catch (err) {
        console.error(`[agent] could not resume task ${task.id} after the restart:`, err);
        await this.recordTaskError(task.id, err);
      }
    }
    void this.backfillUsage();
  }

  /**
   * Boot: learn the memory per agent from the peaks the latest finished runs stored on their
   * cards (the newest AgentMemoryModel.WINDOW, recorded oldest first), local and remote alike.
   * Only runs that did work count (MEMORY_LEARN_MIN_CPU_SECONDS). Best effort: a failed read
   * leaves the default estimate.
   */
  private async seedMemoryModel(): Promise<void> {
    try {
      // Oldest first (listTasksByAgentState orders by updatedAt).
      const peaks = (await this.repo.listTasksByAgentState(["idle", "error"]))
        .map((task) => task.resources)
        .filter(
          (resources): resources is AgentResources =>
            !!resources && resources.cpuSeconds >= MEMORY_LEARN_MIN_CPU_SECONDS,
        )
        .map((resources) => resources.peakMemoryBytes)
        .slice(-AgentMemoryModel.WINDOW);
      for (const peak of peaks) this.memoryModel.record(peak);
    } catch (err) {
      console.error("[agent] could not read the memory of past runs:", err);
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

  /** The card waits for its board's smart-queue plan before it may launch. */
  private isHeld(taskId: string): boolean {
    return this.awaitsPlan(taskId);
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
   * Has the planner order the board's plannable queued cards, then releases the held ones. A
   * failed plan keeps the queue order; nothing stays held.
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
      // Running cards are context for the planner (what is already in flight); only queued cards
      // are ordered.
      const queued: PlanCard[] = [];
      const running: PlanCard[] = [];
      for (const id of [...sent, ...this.active.keys()]) {
        const task = await this.repo.getTask(id);
        if (task?.boardId !== boardId) continue;
        const card = { id: task.id, title: task.title, description: task.description };
        (this.active.has(id) ? running : queued).push(card);
      }
      this.publishQueue();
      const plan = await planQueue({ board, queued, running, settings, signal: controller.signal });
      if (controller.signal.aborted) return;
      this.applyPlan(plan, state);
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
   * Refills the queue slots of the planned cards in the plan's order; cards the user moved
   * meanwhile keep their place. The planner's reason is kept per card for the UI.
   */
  private applyPlan(plan: QueuePlan, state: BoardPlan): void {
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
    // Cluster mode: the machine each running card runs on (a card's placement is set at launch).
    const nodes: Record<string, { id: string; name: string }> = {};
    for (const taskId of running) {
      const node = this.nodeOf(taskId);
      if (node) nodes[taskId] = node;
    }
    // Planning state is part of the key: the UI re-reads the snapshot when a plan starts or ends.
    const held = queued.filter((id) => this.isHeld(id));
    // So are the limit and what bounds it: an automatic one changes with the machine's free
    // resources, and a resource-guard hold/resume must reach the UI even when the limit stays.
    const key = JSON.stringify([
      running,
      queued,
      nodes,
      [...this.plans.keys()],
      held,
      this.limit,
      this.boundBy,
    ]);
    if (key === this.lastQueue) return;
    this.lastQueue = key;
    publish({ type: "queue.updated", running, queued, nodes });
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
        // Cluster mode reports this machine's limit even with an empty queue.
        const cluster = clusterActive();
        if (this.queue.length === 0 && !cluster) break;
        // Re-read every time a slot frees so settings changes apply without a restart, and
        // re-sample the machine so an automatic limit follows its free cores and memory, and a
        // tripped load guard holds new runs until the sampler below sees the load drop. The
        // resource guard (lib/agent/resource-guard.ts) holds them under memory/CPU pressure and
        // re-pumps on hold/resume. (A slot lent by a run idling in board_wait_for_cards is still
        // free to its child cards.)
        const settings = await getAppSettings(this.repo);
        const concurrency = this.resolveLimit(settings);
        this.limit = concurrency.limit;
        this.boundBy = concurrency.boundBy;
        if (this.queue.length === 0 || this.holding) break;
        if (this.active.size - this.lent >= this.limit) continue;
        // Start order, skipping cards that still wait for their board's smart-queue plan.
        const candidates = [...this.queue];
        // Cluster mode: among equally good replicas, a card prefers the node of its last run.
        const lastNodes = cluster ? await Promise.all(candidates.map((taskId) => this.lastRunNode(taskId))) : [];
        for (const [index, taskId] of candidates.entries()) {
          if (this.active.size - this.lent >= this.limit) break;
          if (this.isHeld(taskId)) continue;
          // Cluster mode: place the card before it leaves the queue. No placement means no node can
          // safely take a card now, or the pump's count is ahead of the nodes' (e.g. a remote run's
          // transport still closing), so the rest stay queued too (the sampler and refreshQueue re-pump,
          // and the primary re-pumps when a node frees a slot).
          let placement: RunPlacement | null = null;
          if (cluster) {
            placement = placeRun({
              taskId,
              localFree: this.localLimit - this.localRuns().length,
              localLimit: this.localLimit,
              runLocal: settings.clusterRunLocal,
              localHeld: this.localHeld,
              // True only when the room comes from a slot lent by board_wait_for_cards; otherwise
              // placeRun never puts a card on a node without a free slot.
              overflow: this.active.size >= this.limit,
              preferNodeId: lastNodes[index] ?? null,
            });
            if (!placement) break;
          }
          if (this.removeFromQueue(taskId)) {
            this.leftQueue(taskId);
            this.launch(taskId, settings, placement);
          } else if (placement) {
            cancelPlacement(placement);
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
      this.reportLocal();
    }
  }

  /** Node id of the card's last run; null when it has none or ran on a standalone server. */
  private async lastRunNode(taskId: string): Promise<string | null> {
    const lastRunId = (await this.repo.getTask(taskId))?.lastRunId;
    return lastRunId ? ((await this.repo.getRun(lastRunId))?.nodeId ?? null) : null;
  }

  /** Starts a queued card; `placement` is the node pump() reserved for it (null in standalone mode). */
  private launch(taskId: string, settings: AppSettings, placement: RunPlacement | null): void {
    const now = Date.now();
    const run: ActiveRun = {
      taskId,
      boardId: "",
      ompPath: settings.ompPath,
      runId: null,
      promptId: "",
      proc: null,
      placement,
      placementPending: placement !== null,
      remote: null,
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
      qualityGateFollowUp: false,
      todos: null,
      launchedAt: new Date(now).toISOString(),
      stampedTodos: null,
      context: null,
      lastActivityAt: now,
      sessionUsage: { costUsd: 0, tokens: 0 },
      loop: settings.loopDetection ? new LoopDetector() : null,
      loopStrikes: 0,
      wrapUpSent: false,
      sdlcNudges: new Set(),
      spawnedAt: 0,
      resources: null,
      treeCpuSeconds: 0,
      usageFile: null,
      usageScanner: null,
      usageBase: emptyUsage(),
      usage: null,
      usageScannedAt: 0,
      usageChain: Promise.resolve(),
      approvalMode: settings.approvalMode,
      autoConfirm: settings.approvalMode === "yolo",
      pendingSteers: new Set(),
      yielded: false,
      settled: false,
      queuedSteering: [],
      undeliveredSteers: new Map(),
      waitingLogged: false,
      provider: null,
      chain: Promise.resolve(),
    };
    this.active.set(taskId, run);
    this.supervisor ??= setInterval(() => void this.superviseRuns(), guardTickMs());
    this.supervisor.unref();
    this.resourceSampler ??= setInterval(() => void this.sampleResources(), RESOURCE_SAMPLE_MS);
    this.resourceSampler.unref();
    this.enqueue(run, () => this.startRun(run, settings));
  }

  private enqueue(run: ActiveRun, step: () => Promise<void>): void {
    run.chain = run.chain.then(step).catch(async (err: unknown) => {
      // After stop/delete the process is torn down on purpose; its rejections are expected.
      if (run.finished) return;
      // A remote run whose node was lost (e.g. while it was starting) is rescheduled, not failed.
      const exit = run.remote && run.proc?.exited ? await run.proc.waitExit() : null;
      if (exit?.error?.code === NODE_LOST_CODE) {
        await this.rescheduleLost(run, exit.error.message);
        return;
      }
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
    this.stopSupervisorIfIdle();
    this.stopResourceSamplerIfIdle();
    void this.persistResources(run);
    this.refreshUsage(run, true);
    // The agent may have written files or screenshots into the card's folder.
    if (run.boardId) publish({ type: "files.updated", boardId: run.boardId, taskId: run.taskId });
    this.cancelUnusedPlacement(run);
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

  // --- Run guards (lib/agent/run-guards.ts) ----------------------------------------------

  /**
   * Supervisor tick. Settings are read on every tick, so toggling a guard applies to runs already
   * working; with every guard off nothing else happens. A tripped run fails from its own chain;
   * release() closes its process (stdin end, then SIGTERM/SIGKILL), which also ends a stalled one.
   * A run that trips nothing may get the wrap-up nudge (checkWrapUp).
   */
  private async superviseRuns(): Promise<void> {
    let settings: AppSettings;
    try {
      settings = await getAppSettings(this.repo);
    } catch (err) {
      console.error("[agent] run guards could not read the settings:", err);
      return;
    }
    if (!guardsEnabled(settings)) return;
    const now = Date.now();
    for (const run of this.active.values()) {
      if (run.finished || !run.promptSent) continue;
      const waitingOnHost = run.hostCalls.size > 0;
      // A board-tool wait sends no frames: the stall clock restarts once it ends.
      if (waitingOnHost) run.lastActivityAt = now;
      const state: RunGuardState = {
        launchedAt: Date.parse(run.launchedAt),
        lastActivityAt: run.lastActivityAt,
        waitingOnHost,
        ...this.runUsage(run),
      };
      const hit = evaluateRunGuards(state, settings, now);
      if (hit) this.enqueue(run, () => this.fail(run, hit.message, { retry: hit.retry }));
      else this.checkWrapUp(run, state, settings, now);
    }
  }

  /** The budget guard right after omp reported new spend, without waiting for the tick. */
  private async checkBudget(run: ActiveRun): Promise<void> {
    try {
      const settings = await getAppSettings(this.repo);
      if (run.finished) return;
      const usage = this.runUsage(run);
      const hit = evaluateBudget(usage, settings);
      if (hit) {
        this.enqueue(run, () => this.fail(run, hit.message, { retry: hit.retry }));
        return;
      }
      if (!run.promptSent) return;
      const state: RunGuardState = {
        launchedAt: Date.parse(run.launchedAt),
        lastActivityAt: run.lastActivityAt,
        waitingOnHost: run.hostCalls.size > 0,
        ...usage,
      };
      this.checkWrapUp(run, state, settings, Date.now());
    } catch (err) {
      console.error(`[agent] budget check failed for task ${run.taskId}:`, err);
    }
  }

  /**
   * Wrap-up nudge (settings `wrapUpNudge`): once a run has used `wrapUpPercent` % of its run time
   * limit or run budget, the agent is asked once to finish up and summarize before the hard guard
   * stops it (Hermes' iteration-budget warning).
   */
  private checkWrapUp(run: ActiveRun, state: RunGuardState, settings: AppSettings, now: number): void {
    if (run.wrapUpSent) return;
    const hit = evaluateWrapUp(state, settings, now);
    if (!hit) return;
    run.wrapUpSent = true;
    this.enqueue(run, () => this.wrapUp(run, hit));
  }

  /** Inside the run's chain: record the wrap-up nudge and steer it to the agent. */
  private async wrapUp(run: ActiveRun, hit: WrapUpHit): Promise<void> {
    if (run.finished) return;
    const limit = hit.guard === "time" ? "run time limit" : "run budget";
    await this.event(
      run,
      "status",
      `Wrap-up nudge: ${Math.round(hit.percent)}% of the ${limit} used (${hit.detail}); asked the agent to finish up`,
    );
    try {
      // Steered like the loop detector's nudge (see onLoop); its own id keeps the response apart from the run's prompt.
      await this.sendSteer(run, `wrapup-${run.runId}`, wrapUpSteerMessage(hit));
    } catch (err) {
      // The hard guard still stops a run that does not wrap up.
      console.error(`[agent] failed to steer the wrap-up nudge for task ${run.taskId}:`, err);
    }
  }

  /** Spend of the run's omp session plus its subagents. */
  private runUsage(run: ActiveRun): RunUsage {
    return totalUsage(run.sessionUsage, Array.from(run.subagents.values(), (tracked) => tracked.snapshot));
  }

  // --- Session usage (lib/agent/session-usage.ts) -------------------------------------------

  /**
   * Schedule a scan of the run's session files and store the card's usage when it changed: at
   * most every USAGE_REFRESH_MS while the run goes, always when `final` (the run ended).
   */
  private refreshUsage(run: ActiveRun, final = false): void {
    if (!run.usageFile) return;
    const now = Date.now();
    if (!final && now - run.usageScannedAt < USAGE_REFRESH_MS) return;
    run.usageScannedAt = now;
    run.usageChain = run.usageChain.then(() => this.storeUsage(run));
  }

  /**
   * Run start: tally the session as it stands before this run. Stored usage beyond it (the card's
   * earlier sessions, e.g. after its session file went missing) carries over as `usageBase`.
   */
  private async primeUsage(run: ActiveRun, stored: TaskUsage | null): Promise<void> {
    run.usage = stored;
    if (!run.usageFile) return;
    try {
      run.usageScanner = new SessionUsageScanner(run.usageFile);
      const before = await run.usageScanner.scan();
      if (stored) run.usageBase = usageBeyond(stored, before ?? emptyUsage());
    } catch (err) {
      console.error(`[agent] failed to read the model usage of task ${run.taskId}:`, err);
    }
  }

  private async storeUsage(run: ActiveRun): Promise<void> {
    const file = run.usageFile;
    if (!file) return;
    try {
      if (run.usageScanner?.sessionFile !== file) run.usageScanner = new SessionUsageScanner(file);
      const session = await run.usageScanner.scan();
      if (!session) return;
      const sums = sumUsage(run.usageBase, session);
      // Nothing stored yet counts as zero: a session without model requests stores nothing.
      if (sameUsage(sums, run.usage ?? emptyUsage())) return;
      const task = await this.repo.updateTask(run.taskId, { usage: { ...sums, updatedAt: new Date().toISOString() } });
      run.usage = sums;
      if (task) publish({ type: "task.updated", task });
    } catch (err) {
      console.error(`[agent] failed to store the model usage of task ${run.taskId}:`, err);
    }
  }

  /**
   * Boot: tally the usage of finished cards that have an omp session but no stored usage (cards
   * that ran before usage tracking). One card at a time, in the background; best effort.
   */
  private async backfillUsage(): Promise<void> {
    try {
      const tasks = await this.repo.listTasksByAgentState(["idle", "error"]);
      for (const task of tasks) {
        if (!task.sessionFile || task.usage) continue;
        const sums = await new SessionUsageScanner(task.sessionFile).scan();
        if (!sums || sums.requests === 0) continue;
        const updated = await this.repo.updateTask(task.id, { usage: { ...sums, updatedAt: new Date().toISOString() } });
        if (updated) publish({ type: "task.updated", task: updated });
      }
    } catch (err) {
      console.error("[agent] could not tally the model usage of past runs:", err);
    }
  }

  private stopSupervisorIfIdle(): void {
    if (this.active.size > 0 || !this.supervisor) return;
    clearInterval(this.supervisor);
    this.supervisor = undefined;
  }

  // --- Resource sampling (lib/agent/resources.ts) ---------------------------------------

  /**
   * Sampler tick: one process-table read for all local runs, then each live run's process tree
   * totals go out as a `run.resources` event; remote runs (cluster mode) use the totals their node
   * reports. Unsupported platforms or a failed read skip the local part of the tick.
   */
  private async sampleResources(): Promise<void> {
    if (this.sampling) return;
    const live = [...this.active.values()].filter(
      (run) => !run.finished && run.runId && run.proc && !run.proc.exited,
    );
    if (live.length === 0) return;
    const runs = live.filter((run) => run.proc?.pid !== undefined);
    this.sampling = true;
    try {
      for (const run of live) {
        const total = run.remote?.totals();
        if (total) this.recordResources(run, total, Date.now());
      }
      if (runs.length === 0) return;
      const list = await listProcesses();
      if (!list) return;
      const totals = treeTotals(list, runs.map((run) => run.proc!.pid!));
      const now = Date.now();
      for (const run of runs) {
        const total = run.proc?.pid === undefined ? undefined : totals.get(run.proc.pid);
        // Released while the table was read: its last sample is already persisted.
        if (!total || run.finished || !run.runId) continue;
        this.recordResources(run, total, now);
      }
    } catch (err) {
      console.error("[agent] resource sampling failed:", err);
    } finally {
      this.sampling = false;
    }
  }

  /** Turn a process tree total into the run's next sample and publish it. */
  private recordResources(run: ActiveRun, total: { memoryBytes: number; cpuSeconds: number }, now: number): void {
    if (!run.runId) return;
    // A first rate over a few ms since spawn would be all clock granularity (0 % or 200 %).
    if (!run.resources && now - run.spawnedAt < FIRST_SAMPLE_MIN_MS) return;
    run.resources = nextResources(run.resources, run.treeCpuSeconds, total, now, run.spawnedAt);
    run.treeCpuSeconds = total.cpuSeconds;
    publish({
      type: "run.resources",
      runId: run.runId,
      taskId: run.taskId,
      boardId: run.boardId,
      resources: run.resources,
    });
  }

  private stopResourceSamplerIfIdle(): void {
    if (this.active.size > 0 || !this.resourceSampler) return;
    clearInterval(this.resourceSampler);
    this.resourceSampler = undefined;
  }

  /**
   * Store the run's latest resource sample on the task once it ends (skipped before the first
   * sample); the peak of a run that lived MEMORY_LEARN_MIN_MS (local or remote) also teaches the
   * learned memory per agent.
   */
  private async persistResources(run: ActiveRun): Promise<void> {
    const resources = run.resources;
    if (!resources) return;
    if (run.spawnedAt > 0 && Date.now() - run.spawnedAt >= MEMORY_LEARN_MIN_MS) {
      this.memoryModel.record(resources.peakMemoryBytes);
    }
    try {
      const task = await this.repo.updateTask(run.taskId, { resources });
      if (task) publish({ type: "task.updated", task });
    } catch (err) {
      console.error(`[agent] failed to store the resource usage of task ${run.taskId}:`, err);
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
    // An automatic retry after a quota failure waits for the quota instead of the normal backoff.
    const retriedRunId = task.autoRetries > 0 ? task.lastRunId : null;
    const [workspace, taskFiles, boardFiles, comments, foundSession, retriedRun, scheduler] = await Promise.all([
      board.worktrees ? ensureWorkspace(board, task) : null,
      ensureFilesFolder("tasks", task.id),
      ensureFilesFolder("boards", board.id),
      repo.listComments(task.id),
      sessionFile ? stat(sessionFile).then(() => sessionFile, () => null) : null,
      retriedRunId ? repo.getRun(retriedRunId) : null,
      task.schedulerId ? repo.getScheduler(task.schedulerId) : null,
    ]);
    // A scheduler's model is pinned like the project's and wins over it, for the cards it created.
    const pinnedModel = scheduler?.model?.trim() || board.model?.trim() || null;
    const modelBoard = { model: pinnedModel };
    const quotaRetry = retriedRun?.status === "failed" && isQuotaError(retriedRun.error);
    let workdir = board.workdir;
    let projectExtras = board.extraFolders ?? [];
    let workspaceNotes: string[] = [];
    if (workspace) {
      [workdir, ...projectExtras] = workspace.workspace.folders.map((f) => f.path);
      workspaceNotes = workspace.notes;
    }
    if (run.finished) return;
    // Cluster mode: every run keeps its omp session in the card's session dir, which travels to
    // the node running it and is replicated to the others. Only a session file of omp's own
    // session folders is resumed (copied in): the stored path may have come from a node.
    const placement = run.placement;
    const sessionDir = placement ? sessionDirFor(task.id) : null;
    let resumeFile = foundSession;
    if (sessionDir) {
      await mkdir(sessionDir, { recursive: true });
      if (foundSession) {
        resumeFile = await resumeInSessionDir(foundSession, sessionDir, settings.ompPath);
        if (!resumeFile) {
          workspaceNotes = [...workspaceNotes, `Not resuming ${foundSession}: it is not an omp session file`];
        }
      }
      if (run.finished) return;
    }

    const feedback = comments.filter((c) => c.author === "user" && !c.resolved);
    const senderIds = [...new Set(feedback.map((c) => c.fromTaskId).filter((id): id is string => !!id))];
    const [senderTitles, folders] = await Promise.all([
      Promise.all(senderIds.map(async (id) => (await repo.getTask(id))?.title ?? id)),
      Promise.all(projectExtras.map(async (folder) => ({ folder, ok: await isDirectory(folder) }))),
    ]);
    const senders: Record<string, string> = Object.fromEntries(senderIds.map((id, index) => [id, senderTitles[index]!]));
    const extraFolders = folders.filter((f) => f.ok).map((f) => f.folder);
    const missingFolders = folders.filter((f) => !f.ok).map((f) => f.folder);
    const prompt = buildPrompt(task, feedback, resumeFile !== null, senders);
    const created = await repo.createRun({
      taskId: task.id,
      prompt,
      ...(placement ? { nodeId: placement.nodeId, nodeName: placement.nodeName } : {}),
    });
    run.runId = created.id;
    run.promptId = `prompt-${created.id}`;
    for (const c of feedback) run.feedbackIds.add(c.id);
    run.advisor = { task, board, workdir, extraFolders, settings };
    run.advisorFollowUp = feedback.some((c) => c.body.startsWith(ADVISOR_FEEDBACK_PREFIX));
    run.qualityGateFollowUp = feedback.some((c) => c.body.startsWith(QUALITY_GATE_PREFIX));
    publish({ type: "run.updated", run: created, boardId: run.boardId });
    if (run.finished) return;

    const running = await repo.updateTask(task.id, {
      agentState: "running",
      agentError: null,
      lastRunId: created.id,
      resources: null,
    });
    if (running) publish({ type: "task.updated", task: running });
    if (run.finished) return;


    const remote = placement && !placement.local ? placement : null;
    // A local run's subagents share this machine: their cap is the run's fair share of it, as of
    // now. A remote node's machine is not sampled here, so its runs get the ceiling.
    const subagents =
      settings.subagentLimits && !remote
        ? subagentConcurrency({
            ceiling: settings.subagentMaxConcurrency,
            ...readMachineResources(),
            runningAgents: this.localRuns().length,
          })
        : null;
    // Memory off for this card: the run config drops agentmemory's extension and MCP server.
    const memoryOff = task.ignoreMemory ? memoryOffOverlay(settings.ompPath, workdir) : null;
    // The provider priority runs the model of an omp role on its provider, so it needs the roles,
    // read per run: the user may reconfigure omp, and project `.omp` configs differ.
    const needRoles = settings.providerPriority.length > 0 && !pinnedModel;
    const roles = needRoles ? await readModelRoles(settings.ompPath, workdir, childEnv()) : null;
    const providerPick = await chooseProvider(settings, pinnedModel, roles);
    if (run.finished) return;
    const overlay = runConfigOverlay(settings, taskFiles, subagents, providerPick);
    const [workdirFound, configFile, memoryProject, memoryOffSettings] = await Promise.all([
      isDirectory(workdir),
      memoryOff
        ? memoryOff.then((off) => writeRunConfig(task.id, { ...overlay, ...off }))
        : writeRunConfig(task.id, overlay),
      // Cards in worktrees remember under the board's project, like omp sessions in its folder.
      memoryOff ? "" : memoryProjectName(board.workdir),
      memoryOff,
    ]);
    if (!workdirFound) {
      throw new Error(`Board directory not found: ${workdir}`);
    }
    const choice = chooseModel({
      board: modelBoard,
      settings,
      isResume: resumeFile !== null,
      provider: providerPick,
      quotaRetry,
    });
    if (run.finished) return;
    const { model } = choice;
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
    if (sessionDir) args.push("--session-dir", sessionDir);
    for (const folder of [...extraFolders, taskFiles, boardFiles]) args.push("--add-dir", folder);
    if (model) args.push("--model", model);
    if (resumeFile) args.push("--resume", resumeFile);
    if (memoryOff && !memoryOffSettings) args.push("--no-extensions");
    const extra = process.env.OMP_EXTRA_ARGS?.trim();
    if (extra) args.push(...extra.split(/\s+/));

    if (memoryOff) {
      await this.event(run, "status", "Agent memory off for this card: no recall, no capture, no memory tools");
      if (!memoryOffSettings) {
        await this.event(run, "status", "Couldn't read omp's extension settings; all extensions are off for this run");
      }
      if (run.finished) return;
    }

    if (providerPick) {
      await this.event(run, "status", providerNote(providerPick));
      if (run.finished) return;
    }
    const modelNote = model ? `model ${model}` : "";
    await this.event(
      run,
      "status",
      [
        resumeFile ? "Resuming agent session" : "Starting agent",
        `in ${workdir}`,
        remote && `on ${remote.nodeName}`,
        modelNote && `(${modelNote})`,
      ]
        .filter(Boolean)
        .join(" "),
    );
    if (run.finished) return;
    for (const note of [...runConfigNotes(settings, subagents), ...workspaceNotes]) {
      await this.event(run, "status", note);
    }
    for (const folder of missingFolders) {
      await this.event(run, "status", `Skipped missing folder ${folder}`);
    }
    if (run.finished) return;
    if (settings.gitCheckpoints) {
      // Snapshot the git folders before the agent touches them, so the card can roll its run back.
      const { saved, errors } = await createCheckpoints([workdir, ...extraFolders], {
        taskId: task.id,
        runId: created.id,
        label: "Before run",
      });
      if (saved.length > 0) {
        await this.event(run, "status", `Checkpoint saved (${saved.length} folder${saved.length === 1 ? "" : "s"})`);
      }
      for (const message of errors) await this.event(run, "error", `Checkpoint failed: ${message}`);
      if (run.finished) return;
    }

    const runConfig = remote ? await readFile(configFile, "utf8") : "";
    const agentEnv = {
      ...(await mcpAgentEnv()),
      ...(memoryOff ? MEMORY_OFF_ENV : { AGENTMEMORY_PROJECT_NAME: memoryProject }),
    };
    if (run.finished) return;
    // Remote placement: omp runs on the node, over the cluster channel. Git checkpoints, model
    // roles and the run config above stay on this primary.
    const transport = remote
      ? openRemoteRun(remote, {
          runKey: created.id,
          taskId: task.id,
          args,
          cwd: workdir,
          env: remoteChildEnv(agentEnv),
          folders: [
            ...[workdir, ...extraFolders].map((folder) => ({ path: folder, kind: "tree" as const })),
            ...[taskFiles, boardFiles, sessionDir!].map((folder) => ({ path: folder, kind: "raw" as const })),
          ],
          files: [{ path: configFile, content: runConfig }],
        })
      : undefined;
    run.placementPending = false;
    run.remote = transport?.remote ?? null;
    const proc = new OmpRpcProcess({
      command: settings.ompPath,
      args,
      cwd: workdir,
      env: childEnv(agentEnv),
      autoConfirm: run.autoConfirm,
      transport,
    });
    run.proc = proc;
    run.spawnedAt = Date.now();
    proc.on("frame", (frame) => {
      run.lastActivityAt = Date.now();
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
    // An exit reported while the process was being constructed reached no listener.
    if (proc.exited) this.enqueue(run, async () => this.onExit(run, await proc.waitExit()));

    await proc.waitReady(remote ? REMOTE_READY_TIMEOUT_MS : READY_TIMEOUT_MS);
    if (run.finished) return;

    try {
      const state = await proc.send({ type: "get_state" });
      const sessionFile = isObject(state.data) ? asString(state.data.sessionFile) : undefined;
      const sessionId = isObject(state.data) ? asString(state.data.sessionId) : undefined;
      const stateModel = isObject(state.data) && isObject(state.data.model) ? state.data.model : null;
      run.provider = (stateModel && asString(stateModel.provider)) ?? null;
      if (choice.source === "session" && isObject(state.data) && stateModel) {
        const provider = run.provider;
        const id = asString(stateModel.id);
        const level = asString(state.data.thinkingLevel);
        if (id) {
          await this.event(
            run,
            "status",
            `Model kept from the resumed session: ${provider ? `${provider}/${id}` : id}${level ? ` (thinking ${level})` : ""}`,
          );
          if (run.finished) return;
        }
      }
      if (sessionFile && sessionFile !== task.sessionFile) {
        // A node answers for a remote run: only a file inside the card's session dir is trusted.
        if (remote && !(path.isAbsolute(sessionFile) && isInside(sessionFile, sessionDir!))) {
          await this.event(run, "error", `Ignored the session file reported by ${remote.nodeName}: ${sessionFile}`);
        } else {
          run.usageFile = sessionFile;
          const updated = await repo.updateTask(task.id, { sessionFile });
          if (updated) publish({ type: "task.updated", task: updated });
        }
      } else if (sessionFile) {
        run.usageFile = sessionFile;
      }
      // Name the card's agentmemory session after the card (best effort, not awaited).
      if (sessionId && !memoryOff && agentmemoryEnabled()) {
        void tagMemorySession({ sessionId, project: memoryProject, cwd: workdir, title: `${task.title} (card ${task.id})` });
      }
    } catch (err) {
      if (run.finished) return;
      await this.event(run, "error", `Could not read the omp session state: ${errorMessage(err, run.ompPath)}`);
    }
    // On the usage chain: a scan must never read the same files concurrently.
    run.usageChain = run.usageChain.then(() => this.primeUsage(run, task.usage));
    await run.usageChain;
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
          this.refreshContext(run);
          this.refreshUsage(run);
        } else {
          this.resetDeltas(run);
        }
        break;
      }
      case "tool_execution_start":
        await this.event(run, "tool", describeToolStart(frame));
        run.loop?.start(frame.toolCallId, frame.toolName, frame.args);
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
        if (run.loop) await this.onLoop(run, run.loop.end(frame.toolCallId, frame.isError, frame.result));
        break;
      case "agent_start":
        // A new stretch of work (also a steer admitted right after the agent yielded): completion
        // waits for its own yield and settlement.
        run.yielded = false;
        run.settled = false;
        run.waitingLogged = false;
        break;
      case "agent_end": {
        if (frame.isTerminal === false) {
          // Background work (async subagents, auto-backgrounded bash) wakes the agent again when it ends.
          if (frame.awaitingAsyncWork === true && !run.waitingLogged) {
            run.waitingLogged = true;
            await this.event(run, "status", "Waiting for background work (subagents, background jobs) before finishing");
          }
          break;
        }
        const messages = Array.isArray(frame.messages) ? frame.messages : [];
        const last = messages.findLast((m): m is Json => isObject(m) && m.role === "assistant");
        if (last) {
          run.lastStopReason = asString(last.stopReason) ?? run.lastStopReason;
          run.lastError = assistantError(last) ?? run.lastError;
          if (!run.lastText) run.lastText = blockText(last.content, "text");
        }
        if (typeof frame.yielded === "boolean") {
          // omp also reports prompt_result and session_settled: a steer sent right as the agent
          // yielded may still start another turn (maybeComplete).
          run.yielded = true;
          await this.maybeComplete(run);
        } else {
          // An older omp: its terminal agent_end is the end of the run.
          await this.complete(run);
        }
        break;
      }
      case "prompt_result":
        if (frame.agentInvoked === false && (frame.id === undefined || frame.id === run.promptId)) {
          await this.complete(run);
          break;
        }
        // omp could not run the prompt (e.g. refused at its cost cap): no agent_end will follow.
        if (frame.id === run.promptId && (frame.status === "error" || frame.status === "aborted")) {
          if (!run.finished) {
            const message = isObject(frame.error) ? asString(frame.error.message) : undefined;
            await this.fail(run, frame.status === "aborted" ? "The agent run was aborted" : (message ?? "omp could not run the prompt"));
          }
          break;
        }
        // A steer's message left omp's queue and the turn it joined has yielded.
        if (typeof frame.id === "string") {
          run.pendingSteers.delete(frame.id);
          if (frame.id.startsWith(STEER_ID_PREFIX)) this.steerDelivered(run, frame.id.slice(STEER_ID_PREFIX.length));
        }
        if (frame.sessionSettled === true) run.settled = true;
        await this.maybeComplete(run);
        break;
      case "session_settled":
        run.settled = true;
        await this.maybeComplete(run);
        break;
      case "queue_update":
        await this.onQueueUpdate(run, frame);
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
      case "auto_compaction_start": {
        const reason = asString(frame.reason);
        const action = asString(frame.action);
        await this.event(
          run,
          "status",
          `Compacting conversation context${reason ? ` (${[reason, action].filter(Boolean).join(", ")})` : ""}`,
        );
        break;
      }
      case "manual_compaction_start":
        await this.event(run, "status", "Compacting conversation context (manual)");
        break;
      case "auto_compaction_end":
      case "manual_compaction_end":
        await this.onCompactionEnd(run, frame);
        break;
      case "retry_fallback_applied": {
        const to = asString(frame.to);
        if (to) run.provider = selectorProvider(to) ?? run.provider;
        await this.event(run, "status", `Switched model after an error: ${asString(frame.from) ?? "unknown model"} → ${to ?? "unknown model"}`);
        break;
      }
      case "extension_ui_request":
        await this.onUiRequest(run, frame);
        break;
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

  /**
   * `queue_update`: omp lists the steering messages still waiting for a turn boundary. A message
   * that left the list was delivered into the agent's transcript (compared as a multiset, so a
   * repeated text counts once per copy).
   */
  private async onQueueUpdate(run: ActiveRun, frame: RpcFrame): Promise<void> {
    if (!Array.isArray(frame.steering)) return;
    const steering = frame.steering.filter((text): text is string => typeof text === "string");
    const remaining = [...steering];
    const delivered: string[] = [];
    for (const text of run.queuedSteering) {
      const index = remaining.indexOf(text);
      if (index === -1) delivered.push(text);
      else remaining.splice(index, 1);
    }
    run.queuedSteering = steering;
    for (const text of delivered) {
      await this.event(run, "status", `Steering delivered to the agent: "${truncate(oneLineTrim(text), MAX_QUOTED_TEXT)}"`);
      for (const [commentId, message] of run.undeliveredSteers) {
        if (message !== text) continue;
        this.steerDelivered(run, commentId);
        break;
      }
    }
  }

  /** A steered comment reached the agent: tell the card's Activity chat once. */
  private steerDelivered(run: ActiveRun, commentId: string): void {
    if (!run.undeliveredSteers.delete(commentId)) return;
    publishSteer(run.boardId, run.taskId, commentId, "delivered");
  }

  /** `auto_compaction_end` / `manual_compaction_end`: what became of the compaction, then the new context fill. */
  private async onCompactionEnd(run: ActiveRun, frame: RpcFrame): Promise<void> {
    const failure = asString(frame.errorMessage);
    const result = isObject(frame.result) ? frame.result : null;
    if (frame.skipped === true) {
      await this.event(run, "status", `Context compaction skipped${failure ? `: ${failure}` : ""}`);
    } else if (failure) {
      await this.event(run, "error", `Context compaction failed: ${failure}${frame.willRetry === true ? "; retrying" : ""}`);
    } else if (frame.aborted === true) {
      await this.event(run, "status", "Context compaction aborted");
    } else if (result) {
      const before = asNumber(result.tokensBefore);
      const summary = oneLineTrim(asString(result.shortSummary) ?? "");
      await this.event(
        run,
        "status",
        `Context compacted${before !== undefined ? ` (${before.toLocaleString("en-US")} tokens before)` : ""}${summary ? `: ${summary}` : ""}`,
      );
    }
    this.refreshContext(run);
  }

  /**
   * An `extension_ui_request` omp sent: lib/agent/rpc.ts already answered it (a card run has no one
   * to show a dialog to), so a declined question or tool approval is logged where the user can see
   * why the agent was refused. Presentation methods (notify, setStatus, setWidget, …) are ignored.
   */
  private async onUiRequest(run: ActiveRun, frame: RpcFrame): Promise<void> {
    const method = asString(frame.method) ?? "";
    const declined =
      method === "select" || method === "input" || method === "editor" || (method === "confirm" && !run.autoConfirm);
    if (!declined) return;
    const title = truncate(oneLineTrim(asString(frame.title)?.split("\n")[0] ?? ""), MAX_QUOTED_TEXT) || method;
    // In yolo mode omp asks no tool approvals: what is left are the agent's own questions.
    const hint = run.approvalMode === "yolo" ? "" : " Use approval mode yolo for unattended tool use.";
    await this.event(
      run,
      "error",
      `Declined omp's request "${title}": card runs cannot answer prompts (approval mode ${run.approvalMode}).${hint}`,
    );
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
    if (info.error?.code === NODE_LOST_CODE) {
      await this.rescheduleLost(run, info.error.message);
      return;
    }
    await this.fail(
      run,
      info.error
        ? errorMessage(info.error, run.ompPath)
        : `omp exited unexpectedly (${describeExit(info)})`,
    );
  }

  /**
   * Cluster mode: the node running the run is gone for good. The run fails, and the card is queued
   * again at once (resuming its replicated session on whichever node gets it, possibly the same one
   * once it is back) without using an automatic retry.
   */
  private async rescheduleLost(run: ActiveRun, reason: string): Promise<void> {
    run.finished = true;
    const message = `${reason}${RESCHEDULED_SUFFIX}`;
    try {
      if (run.runId) {
        const updated = await this.repo.updateRun(run.runId, { status: "failed", error: message, endedAt: nowIso() });
        if (updated) publish({ type: "run.updated", run: updated, boardId: run.boardId });
        await this.settleSubagents(run);
        await this.event(run, "error", message);
      }
      const task = await this.repo.getTask(run.taskId);
      if (task) await this.addAgentComment(task, `Agent run lost: ${message}.`);
    } catch (err) {
      console.error(`[agent] failed to record the lost run of task ${run.taskId}:`, err);
    } finally {
      this.release(run);
      void this.queueRun(run.taskId, true).catch((err: unknown) => this.recordTaskError(run.taskId, err));
    }
  }

  /**
   * A loop the detector found (inside the run's chain): the first one steers the agent to change
   * approach, the second fails the run without a retry, which would only loop again. Settings are
   * re-read here, not per frame, so turning loop detection off mid-run stops the enforcement.
   */
  private async onLoop(run: ActiveRun, detection: LoopDetection | null): Promise<void> {
    if (!detection || run.finished) return;
    if (!(await getAppSettings(this.repo)).loopDetection) {
      run.loop = null;
      return;
    }
    run.loopStrikes += 1;
    if (run.loopStrikes > 1) {
      await this.fail(run, `Stopped: the agent kept looping (${detection.summary})`, { retry: false });
      return;
    }
    await this.event(run, "error", `Loop detected: ${detection.summary}. Asked the agent to change approach.`);
    try {
      // Steered like user feedback (see steer()); its own id keeps the response apart from the run's prompt.
      await this.sendSteer(run, `loop-${run.runId}-${run.loopStrikes}`, loopSteerMessage(detection));
    } catch (err) {
      // The second strike still stops a run that keeps looping.
      console.error(`[agent] failed to steer a looping agent for task ${run.taskId}:`, err);
    }
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
        const message = buildSteerMessage(comment, sender?.title);
        // Its own id keeps it apart from run.promptId, so its response cannot complete or fail the run.
        const taken = await this.sendSteer(run, `${STEER_ID_PREFIX}${comment.id}`, message);
        if (!taken) {
          run.restartAfter = true;
          publishSteer(run.boardId, run.taskId, comment.id, "deferred");
          await this.event(run, "status", "The agent did not take the feedback mid-run; it will be picked up by the next run");
          return;
        }
        run.undeliveredSteers.set(comment.id, message);
      } catch (err) {
        if (run.finished) {
          const task = await this.repo.getTask(run.taskId);
          if (task) await this.onComment(task, comment);
          return;
        }
        run.restartAfter = true;
        publishSteer(run.boardId, run.taskId, comment.id, "deferred");
        await this.event(
          run,
          "error",
          `Could not send feedback to the agent (it will be picked up by the next run): ${errorMessage(err, run.ompPath)}`,
        );
        return;
      }
      run.feedbackIds.add(comment.id);
      publishSteer(run.boardId, run.taskId, comment.id, "sent");
      await this.event(run, "status", "Feedback sent to the running agent (steering)");
    } catch (err) {
      console.error(`[agent] failed to steer feedback for task ${run.taskId}:`, err);
    }
  }

  /**
   * Steers a message into the running agent like typing into the omp CLI mid-run: a `prompt` with
   * streamingBehavior "steer" runs magic-keyword detection (`orchestrate`, `ultrathink`, …), which
   * the RPC `steer` command skips. Unlike the run's prompt it is answered right away, so it gets
   * the normal command timeout. Its id stays in run.pendingSteers until omp's `prompt_result` for
   * it: a steer admitted right as the agent yields starts another turn, which the run must not cut
   * short (maybeComplete). The id is added before sending, since that result can arrive before
   * the send's response is handled. Returns false when omp handled the message itself
   * (`agentInvoked: false`): no prompt_result follows, and the agent never saw it.
   */
  private async sendSteer(run: ActiveRun, id: string, message: string): Promise<boolean> {
    const proc = run.proc;
    if (!proc) return false;
    run.pendingSteers.add(id);
    let response;
    try {
      response = await proc.send(
        { id, type: "prompt", message, streamingBehavior: "steer" },
        { timeoutMs: proc.commandTimeoutMs },
      );
    } catch (err) {
      // A rejected steer gets no prompt_result: it must not hold the run open. The agent may have
      // yielded and settled meanwhile, so completion is re-checked after the caller's handling.
      run.pendingSteers.delete(id);
      this.enqueue(run, () => this.maybeComplete(run));
      throw err;
    }
    if (isObject(response.data) && response.data.agentInvoked === false) {
      run.pendingSteers.delete(id);
      this.enqueue(run, () => this.maybeComplete(run));
      return false;
    }
    return true;
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

  /**
   * Completion with an omp that reports `yielded` on agent_end: the agent yielded, omp reported the
   * session settled (no queued steer or background job can wake it) and every steer sent with
   * sendSteer got its prompt_result. A steer admitted right as the agent yields starts another turn;
   * completing on the earlier agent_end would kill that turn and mark its feedback resolved.
   */
  private async maybeComplete(run: ActiveRun): Promise<void> {
    if (run.finished || !run.yielded || !run.settled || run.pendingSteers.size > 0) return;
    await this.complete(run);
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
      // The release gate (SDLC Testing phase) sends the card back once; missing it again ships it with a
      // warning. A question for the user wins: resuming the agent would drop it unanswered.
      const latestTodos = run.stampedTodos?.list ?? (await repo.getTask(run.taskId))?.todos ?? [];
      const gate = releaseGate(sdlcProgress(latestTodos));
      const gateFollowUp = gate !== null && !run.qualityGateFollowUp && question === null;
      if (gateFollowUp) {
        const feedback = await repo.addComment({
          taskId: run.taskId,
          author: "user",
          body:
            `${QUALITY_GATE_PREFIX}${gate}. Finish the Testing phase before the card ships: ` +
            `${SDLC_PHASE_INFO.testing.gate}. Then complete the remaining SDLC phases and report.`,
        });
        publish({ type: "comment.added", comment: feedback, boardId: run.boardId });
        run.restartAfter = true;
      } else if (gate && !followUp) {
        await this.event(run, "status", `⚠ Shipped without passing the release gate: ${gate}`);
      }
      const sentBack = followUp !== null || gateFollowUp;

      if (run.runId && run.feedbackIds.size > 0) {
        const resolved = await repo.resolveComments([...run.feedbackIds], run.runId);
        for (const c of resolved) publish({ type: "comment.updated", comment: c, boardId: run.boardId });
      }

      // A card the advisor or the release gate sends back to work stays In progress.
      const task = await repo.updateTask(run.taskId, {
        ...(sentBack ? {} : { status: "done" as const, position: await topPosition(repo, run.boardId, "done", run.taskId) }),
        agentState: "idle",
        agentError: null,
        question,
        autoRetries: 0,
        retryAt: null,
      });
      if (task) publish({ type: "task.updated", task });
      // A run that restarts right away (feedback during wrap-up) cleans up at its own Done instead.
      if (!sentBack && !run.restartAfter) void this.removeTaskDocker(run);
    } catch (err) {
      console.error(`[agent] failed to record the result for task ${run.taskId}:`, err);
      retryAt = await this.writeTaskError(run.taskId, `Failed to record the agent result: ${errorMessage(err, run.ompPath)}`);
    } finally {
      this.release(run);
      if (retryAt) this.scheduleRetry(run.taskId, retryAt);
    }
  }

  /**
   * Record the run as failed and release it. `retry: false` (run guards: time limit, budget,
   * loop detection) skips the automatic retry, which would only hit the same guard again.
   */
  private async fail(run: ActiveRun, message: string, options: { retry?: boolean } = {}): Promise<void> {
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
      // Provider priority: the provider ran out of quota, so the next runs use the next provider.
      if (run.provider && isQuotaError(message)) markOutOfQuota(run.provider);
      // Feedback that arrived meanwhile starts a fresh run once this one is released.
      const failure = await this.recordFailure(run.taskId, message, !run.restartAfter && options.retry !== false);
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

  /** Removes Docker resources the agent marked as temporary for this card and left behind (docs/TASK-CLEANUP.md). */
  private async removeTaskDocker(run: ActiveRun): Promise<void> {
    try {
      const result = await removeTaskDockerResources(run.taskId);
      if (!result) return;
      const counts: [number, string][] = [
        [result.containers, "container"],
        [result.networks, "network"],
        [result.volumes, "volume"],
        [result.images, "image"],
      ];
      const parts = counts.filter(([count]) => count > 0).map(([count, noun]) => `${count} ${noun}${count === 1 ? "" : "s"}`);
      if (parts.length > 0) await this.event(run, "status", `Removed leftover Docker resources: ${parts.join(", ")}`);
      for (const message of result.errors) await this.event(run, "error", `Docker cleanup: ${message}`);
    } catch (err) {
      console.error(`[agent] Docker cleanup failed for task ${run.taskId}:`, err);
    }
  }

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
      await this.trackSdlc(run, previous, todos);
    } catch (err) {
      console.error(`[agent] failed to store the todo list of task ${run.taskId}:`, err);
    }
  }

  /**
   * Logs the SDLC progress of a stored todo update (phase entered, quality gates passed) and, for
   * a list named after SDLC phases, each new phase-order violation; each violation is steered back
   * into the live session once per run, like the loop detector's nudge. Never throws: the todo list
   * is already stored.
   */
  private async trackSdlc(run: ActiveRun, previous: readonly TodoPhase[], todos: readonly TodoPhase[]): Promise<void> {
    try {
      const after = sdlcProgress(todos);
      const change = sdlcChange(sdlcProgress(previous), after);
      for (const id of change.completed) {
        await this.event(run, "status", `✓ Quality gate passed: ${SDLC_PHASE_INFO[id].label} complete`);
      }
      if (change.entered) {
        const info = SDLC_PHASE_INFO[change.entered];
        await this.event(run, "status", `▸ SDLC phase ${info.step}/${SDLC_PHASES.length}: ${info.label}`);
      }
      // Free-form (legacy) lists are only classified for display, never enforced.
      if (!after?.canonical) return;
      for (const violation of change.violations) {
        await this.event(run, "status", `⚠ Quality gate: ${violation.message}`);
        const key = `${violation.phase}:${violation.requires}`;
        if (run.finished || run.sdlcNudges.has(key)) continue;
        run.sdlcNudges.add(key);
        try {
          // Steered like the loop detector's nudge (see onLoop); its own id keeps the response apart from the run's prompt.
          await this.sendSteer(run, `sdlc-${run.runId}-${run.sdlcNudges.size}`, sdlcSteerMessage(violation));
        } catch (err) {
          console.error(`[agent] failed to steer an SDLC quality gate for task ${run.taskId}:`, err);
        }
      }
    } catch (err) {
      console.error(`[agent] failed to track the SDLC progress of task ${run.taskId}:`, err);
    }
  }

  /**
   * Ask omp how full the run's context window is and publish a live `run.context` when it or the
   * session's spend changed; the same stats carry the session's spend for the budget guard and the
   * event's `usage`. Fire-and-forget: frames are handled serially, so the frame queue never waits
   * on it; failures (old omp, timeout, exited process) are ignored.
   */
  private refreshContext(run: ActiveRun): void {
    const proc = run.proc;
    if (run.finished || !run.runId || !proc) return;
    void proc
      .send({ type: "get_session_stats" }, { timeoutMs: CONTEXT_STATS_TIMEOUT_MS })
      .then((response) => {
        if (run.finished || !run.runId) return;
        const spent = sessionUsage(response.data);
        const spendChanged =
          spent !== null && (spent.costUsd !== run.sessionUsage.costUsd || spent.tokens !== run.sessionUsage.tokens);
        if (spent) {
          run.sessionUsage = spent;
          void this.checkBudget(run);
        }
        const usage = isObject(response.data) ? response.data.contextUsage : undefined;
        if (!isObject(usage)) return;
        const tokens = asNumber(usage.tokens);
        if (tokens === undefined || tokens < 0) return;
        const window = asNumber(usage.contextWindow) ?? 0;
        const context: ContextUsage = { tokens, contextWindow: window > 0 ? window : 0 };
        const contextChanged =
          run.context?.tokens !== context.tokens || run.context.contextWindow !== context.contextWindow;
        if (!contextChanged && !spendChanged) return;
        run.context = context;
        publish({
          type: "run.context",
          runId: run.runId,
          taskId: run.taskId,
          boardId: run.boardId,
          context,
          ...(spent ? { usage: spent } : {}),
        });
      })
      .catch(() => undefined);
  }

  /**
   * Merge a subagent update. A new subagent, a status change or its final report is persisted
   * as an `agent` run event; anything else (tool calls, token counts) is only published live.
   */
  private async trackSubagent(run: ActiveRun, patch: SubagentPatch): Promise<void> {
    if (run.finished || !run.runId) return;
    this.refreshUsage(run);
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
      // A status change or final report carries the subagent's latest spend; progress in
      // between is left to the supervisor tick (no settings read per progress frame).
      void this.checkBudget(run);
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

/** Live delivery state of a steered comment for the card's Activity chat (not persisted). */
function publishSteer(boardId: string, taskId: string, commentId: string, state: SteerState): void {
  publish({ type: "comment.steer", commentId, taskId, boardId, state });
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

/** Steer prompt for an SDLC phase-order violation: finish the required phase (its exit criteria) first. */
function sdlcSteerMessage(violation: SdlcViolation): string {
  const required = SDLC_PHASE_INFO[violation.requires];
  return (
    `Quality gate (SDLC): ${violation.message}. Finish the ${required.label} phase first ` +
    `(exit criteria: ${required.gate}), then continue with ${SDLC_PHASE_INFO[violation.phase].label}. ` +
    `Keep your todo phases in SDLC order: ${SDLC_PHASES.map((id) => SDLC_PHASE_INFO[id].label).join(", ")}.`
  );
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

/** The settings the per-run omp config overlay depends on. */
export type RunConfigSettings = Pick<
  AppSettings,
  | "browser"
  | "subagentLimits"
  | "subagentMaxConcurrency"
  | "subagentMaxDepth"
  | "subagentTimeoutMinutes"
  | "contextCompaction"
  | "contextCompactPercent"
>;

/**
 * The per-run omp config overlay (`--config`): browser control for this card and, when on, the
 * subagent limits of omp's `task` tool (Hermes-style delegation caps: subagents at once, nesting
 * depth, runtime of each) and context compaction once the context fills a share of the model's
 * window. `subagents` is the run's subagent cap (lib/agent/concurrency.ts subagentConcurrency);
 * null uses the ceiling `subagentMaxConcurrency` (a remote node's machine is not sampled here).
 * `pick` (provider priority): when its provider's model fails mid-run on a provider error — a
 * usage limit or the provider being unavailable — omp switches to the backup providers' models
 * (fallbackRetryConfig); agent-caused failures keep retrying the same model.
 */
export function runConfigOverlay(
  settings: RunConfigSettings,
  taskFiles: string,
  subagents: number | null,
  pick: ProviderPick | null = null,
): Record<string, unknown> {
  const browser =
    settings.browser === "off"
      ? { enabled: false }
      : {
          enabled: true,
          headless: settings.browser !== "visible",
          relay: settings.browser === "relay",
          screenshotDir: path.join(taskFiles, "screenshots"),
        };
  const overlay: Record<string, unknown> = { browser };
  if (settings.subagentLimits) {
    overlay.task = {
      maxConcurrency: subagents ?? settings.subagentMaxConcurrency,
      maxRecursionDepth: settings.subagentMaxDepth,
      // 0 = no limit: no runtime is set here.
      ...(settings.subagentTimeoutMinutes > 0 ? { maxRuntimeMs: settings.subagentTimeoutMinutes * 60_000 } : {}),
    };
  }
  if (settings.contextCompaction) overlay.compaction = { thresholdPercent: settings.contextCompactPercent };
  const retry = fallbackRetryConfig(pick);
  if (retry) overlay.retry = retry;
  return overlay;
}

/** Run-log line for the provider priority's pick: which provider the run uses, and why. */
function providerNote(pick: ProviderPick): string {
  const { entry } = pick;
  const until = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const using = `${entry.provider} (${entry.model})`;
  const head = pick.allOut
    ? `Provider priority: every provider is out of quota, using Main ${using}`
    : pick.index === 0
      ? `Provider priority: using Main ${using}`
      : `Provider priority: ${pick.skipped.map((s) => `${s.provider} out of quota until ${until(s.until)}`).join(", ")} → using ${using}`;
  return pick.fallbacks.length > 0 ? `${head}; if it runs out of quota: ${pick.fallbacks.join(" → ")}` : head;
}

/** Status lines for the run's log: the orchestration limits its config overlay applies. */
function runConfigNotes(settings: RunConfigSettings, subagents: number | null): string[] {
  const notes: string[] = [];
  if (settings.subagentLimits) {
    const minutes = settings.subagentTimeoutMinutes;
    notes.push(
      `Subagents: up to ${subagents ?? settings.subagentMaxConcurrency} at once, depth ${settings.subagentMaxDepth}${minutes > 0 ? `, ${minutes} min each` : ""}`,
    );
  }
  if (settings.contextCompaction) notes.push(`Context compaction at ${settings.contextCompactPercent} %`);
  return notes;
}

/** Write the card's per-run omp config overlay (runConfigOverlay); JSON is valid YAML. */
async function writeRunConfig(taskId: string, overlay: Record<string, unknown>): Promise<string> {
  const dir = path.join(dataDir(), "runtime");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `omp-config-${taskId}.yml`);
  await writeFile(file, `${JSON.stringify(overlay, null, 2)}\n`);
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

/** Cluster mode: this server is the active primary, so runs are placed across the cluster. */
function clusterActive(): boolean {
  return clusterRole() === "primary" && isPrimaryActive();
}

/**
 * The resume file inside the card's session dir: copied in when omp left it in its own sessions
 * folder (runs before cluster mode). Null for anything else (the stored path may have come from a
 * node): only a regular file, symlinks resolved, inside one of those two folders is used.
 */
async function resumeInSessionDir(file: string, sessionDir: string, ompPath: string): Promise<string | null> {
  const real = await realpath(file).catch(() => null);
  const info = real ? await stat(real).catch(() => null) : null;
  if (!real || !info?.isFile()) return null;
  if (isInside(real, await realpath(sessionDir))) return real;
  const ompSessions = await agentDir(ompPath).then(
    (dir) => realpath(path.join(dir, "sessions")),
    () => null,
  );
  if (!ompSessions || !isInside(real, ompSessions)) return null;
  const copy = path.join(sessionDir, path.basename(real));
  await copyFile(real, copy);
  return copy;
}

/** `file` lies strictly below `dir` (both absolute). */
function isInside(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** What the cluster's failback (lib/cluster/node.ts handOverPrimary) needs from the manager. */
interface RunControl {
  /** While held, the queue launches nothing (queued cards stay queued); releasing pumps again. */
  holdNewRuns(hold: boolean): void;
  activeRunCount(): number;
}

/**
 * The manager of a replica node (cluster mode): cards run on the primary, so every change is
 * refused and nothing runs here. Replaced by a full manager when the node is promoted
 * (resetAgentManager).
 */
class DormantAgentManager implements AgentManager, RunControl {
  start(): Promise<Task> {
    return Promise.reject(replicaError());
  }

  stop(): Promise<Task | null> {
    return Promise.reject(replicaError());
  }

  onTaskMoved(): Promise<void> {
    return Promise.reject(replicaError());
  }

  onComment(): Promise<void> {
    return Promise.reject(replicaError());
  }

  async onTaskDeleted(): Promise<void> {}

  stats(): { running: string[]; queued: string[] } {
    return { running: [], queued: [] };
  }

  async queueSnapshot(): Promise<QueueSnapshot> {
    const concurrency = { ...resolveConcurrency(0, 0), reason: "Replica: cards run on the primary" };
    return { limit: 0, concurrency, running: [], queued: [], planning: [] };
  }

  moveInQueue(): boolean {
    return false;
  }

  refreshQueue(): void {}

  contextUsage(): ContextUsage | null {
    return null;
  }

  holdNewRuns(): void {}

  activeRunCount(): number {
    return 0;
  }
}

function replicaError(): HttpError {
  const primary = readNodeState().primary;
  const name = primary ? `${primary.name} (${primary.httpUrl})` : "another node";
  return new HttpError(409, `This node is a replica of ${name}; use the primary`);
}

// --- Singleton -------------------------------------------------------------------------------

const g = globalThis as unknown as {
  __ompUiAgentManager?: Promise<AgentManager>;
  /** The created manager (set once its creation passed the cluster boot), for the sync controls below. */
  __ompUiAgentRuns?: RunControl;
};

async function createAgentManager(): Promise<AgentManager> {
  // The node's cluster role decides what this server does; a failed cluster boot leaves it
  // running on its own (the role stays as stored, the primary runtime inactive).
  await startCluster().catch((err: unknown) => console.error("[cluster] failed to start:", err));
  if (clusterRole() === "replica") {
    const dormant = new DormantAgentManager();
    g.__ompUiAgentRuns = dormant;
    return dormant;
  }
  const repo = await getRepo();
  await repo.abortRunningRuns("Server restarted");
  const manager = new OmpAgentManager(repo);
  g.__ompUiAgentRuns = manager;
  // Before recovery, so the first sample exists before recovered queued runs start.
  startResourceGuard({
    onChange: () => manager.refreshQueue(),
    activeRunCount: () => manager.activeRunCount(),
    queuedCount: () => manager.stats().queued.length,
  });
  // Before recovery, which may start queued runs: their traces must see the runs start.
  startTelemetryExporter(() => getAppSettings(repo));
  // Before recovery too: queued runs it starts spawn omp, which needs the saved provider keys.
  await loadAiProviderEnv(repo);
  await manager.recover();
  startCleanupScheduler(repo, manager);
  startCredentialHealthChecks(repo);
  startMcpSync(repo);
  startSchedulerService(repo, manager);
  startChatIntegrations(repo, manager);
  return manager;
}

/** Process-wide agent manager; the first call performs boot recovery. */
export async function getAgentManager(): Promise<AgentManager> {
  g.__ompUiAgentManager ??= createAgentManager().catch((err: unknown) => {
    g.__ompUiAgentManager = undefined;
    g.__ompUiAgentRuns = undefined;
    throw err;
  });
  return g.__ompUiAgentManager;
}

/**
 * Drops the process-wide manager: the next getAgentManager() creates a fresh one (cluster
 * promotion: a replica's dormant manager, which has nothing to stop, makes way for a full one).
 */
export function resetAgentManager(): void {
  g.__ompUiAgentManager = undefined;
  g.__ompUiAgentRuns = undefined;
}

/** Failback: hold (or release) new launches of the manager; a no-op before it exists or on a replica. */
export function holdNewRuns(hold: boolean): void {
  g.__ompUiAgentRuns?.holdNewRuns(hold);
}

/** Runs the manager has active right now; 0 before it exists or on a replica. */
export function activeRunCount(): number {
  return g.__ompUiAgentRuns?.activeRunCount() ?? 0;
}
