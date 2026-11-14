// Server-side aggregate for the home dashboard (GET /api/v1/dashboard).
import { execFile } from "node:child_process";
import type { AgentManager } from "@/lib/agent/types";
import { childEnv } from "@/lib/child-env";
import { repoActor } from "@/lib/db/scoped";
import type { Repository } from "@/lib/db/types";
import { gitStatus } from "@/lib/git";
import { activityLine } from "@/lib/run-activity";
import { getAppSettings } from "@/lib/settings";
import type {
  AttentionReason,
  Board,
  Dashboard,
  DashboardActivity,
  DashboardBoard,
  DashboardCard,
  DashboardLiveAgent,
  DashboardStatsWindow,
  GitStatus,
  NeedsYouCard,
  NeedsYouReason,
  QueueSnapshot,
  Run,
  Task,
  TaskStatus,
} from "@/lib/types";

const ATTENTION_LIMIT = 12;
const FINISHED_LIMIT = 6;
const NEEDS_YOU_LIMIT = 50;
const ACTIVITY_LIMIT = 12;
const DAY_MS = 86_400_000;
const STATS_DAYS = 7;
/** Window of the per-project success rate and of the activity feed. */
const HISTORY_DAYS = 30;
/** Done cards older than this no longer ask to be pushed. */
const UNPUSHED_DAYS = 14;
const QUESTION_MAX = 280;
const GIT_TTL_MS = 15_000;
const DOCKER_TTL_MS = 5 * 60_000;
const DOCKER_TIMEOUT_MS = 5_000;
const EVENT_PAGE = 500;
/** Stored by lib/settings.ts once the settings are saved. */
const SETTINGS_KEY = "app_settings";

/** Most urgent first; a card ranks by its most urgent reason. */
const NEEDS_YOU_ORDER: readonly NeedsYouReason[] = ["question", "failed", "retrying", "feedback", "stalled", "unpushed"];

/** Why `task` needs the user, or null when it doesn't. */
export function attentionReason(task: Task): AttentionReason | null {
  if (task.agentState === "error") return "failed";
  if (task.status === "in_progress" && task.agentState === "idle") return "stalled";
  return null;
}

/** Every reason `task` waits on the user, most urgent first (see NeedsYouReason). */
export function needsYouReasons(task: Task, canPush: boolean, now: number): NeedsYouReason[] {
  if (task.agentState === "running" || task.agentState === "queued") return [];
  const reasons: NeedsYouReason[] = [];
  if (task.question) reasons.push("question");
  if (task.agentState === "error") reasons.push(task.retryAt ? "retrying" : "failed");
  if (task.openCommentCount > 0) reasons.push("feedback");
  if (task.status === "in_progress" && task.agentState === "idle") reasons.push("stalled");
  if (
    canPush &&
    task.status === "done" &&
    !task.pushedAt &&
    task.lastRunId &&
    now - Date.parse(task.updatedAt) < UNPUSHED_DAYS * DAY_MS
  ) {
    reasons.push("unpushed");
  }
  return reasons.sort((a, b) => NEEDS_YOU_ORDER.indexOf(a) - NEEDS_YOU_ORDER.indexOf(b));
}

function toCard(task: Task, boardName: string): DashboardCard {
  return {
    id: task.id,
    boardId: task.boardId,
    boardName,
    title: task.title,
    status: task.status,
    agentState: task.agentState,
    agentError: task.agentError,
    commentCount: task.commentCount,
    openCommentCount: task.openCommentCount,
    lastRunId: task.lastRunId,
    updatedAt: task.updatedAt,
  };
}

const newestFirst = (a: { updatedAt: string }, b: { updatedAt: string }) =>
  b.updatedAt.localeCompare(a.updatedAt);

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * `queue` (the manager's, which spans every user) limited to the cards of `boardIds`, the boards the
 * caller can see. The agent limit and concurrency stay machine-wide.
 */
export function visibleQueue(queue: QueueSnapshot, boardIds: ReadonlySet<string>): QueueSnapshot {
  return {
    ...queue,
    running: queue.running.filter((entry) => boardIds.has(entry.boardId)),
    queued: queue.queued.filter((entry) => boardIds.has(entry.boardId)),
    planning: queue.planning.filter((plan) => boardIds.has(plan.boardId)),
  };
}

// ---------------------------------------------------------------------------------------------
// Process-wide caches: the home page reloads the dashboard on every card change.

type SlimRun = Pick<Run, "id" | "status" | "startedAt" | "endedAt" | "error">;

interface RunEventDigest {
  /** Last seen event seq (the `after` cursor). */
  after: number;
  /** Model named by the run's status events; undefined when they named none. */
  model: string | null | undefined;
  activity: string | null;
  activityAt: string | null;
}

interface DashboardCaches {
  /** Runs per card; valid while the card's `updatedAt` is unchanged (every run start/end updates it). */
  runs: Map<string, { key: string; runs: SlimRun[] }>;
  git: Map<string, { at: number; status: Promise<GitStatus> }>;
  docker: { at: number; available: Promise<boolean> } | null;
  events: Map<string, RunEventDigest>;
}

const g = globalThis as unknown as { __ompDashboardCaches?: DashboardCaches };
const caches: DashboardCaches = (g.__ompDashboardCaches ??= {
  runs: new Map(),
  git: new Map(),
  docker: null,
  events: new Map(),
});

async function cardRuns(repo: Repository, task: Task): Promise<SlimRun[]> {
  const key = `${task.updatedAt}|${task.lastRunId ?? ""}`;
  const cached = caches.runs.get(task.id);
  if (cached?.key === key) return cached.runs;
  const runs = (await repo.listRuns(task.id)).map(({ id, status, startedAt, endedAt, error }) => ({
    id,
    status,
    startedAt,
    endedAt,
    error,
  }));
  caches.runs.set(task.id, { key, runs });
  return runs;
}

function emptyGitStatus(folder: string): GitStatus {
  return {
    folder,
    isRepo: false,
    branch: null,
    defaultBranch: null,
    remoteUrl: null,
    webUrl: null,
    provider: null,
    dirty: false,
    changedFiles: 0,
    ahead: 0,
    behind: 0,
    prCliAvailable: false,
  };
}

function cachedGitStatus(folder: string, now: number): Promise<GitStatus> {
  const cached = caches.git.get(folder);
  if (cached && now - cached.at < GIT_TTL_MS) return cached.status;
  const status = gitStatus(folder).catch(() => emptyGitStatus(folder));
  caches.git.set(folder, { at: now, status });
  return status;
}

function dockerAvailable(now: number): Promise<boolean> {
  if (caches.docker && now - caches.docker.at < DOCKER_TTL_MS) return caches.docker.available;
  const { promise, resolve } = Promise.withResolvers<boolean>();
  execFile(
    process.env.DOCKER_BIN?.trim() || "docker",
    ["version", "--format", "{{.Server.Version}}"],
    { timeout: DOCKER_TIMEOUT_MS, env: childEnv(), windowsHide: true },
    (err) => resolve(!err),
  );
  caches.docker = { at: now, available: promise };
  return promise;
}

/** Starting/auto-select status lines name the model: "… (model X, thinking Y)", "Model auto-selected: X (…)". */
function modelFromStatus(text: string): string | null | undefined {
  const auto = /^Model auto-selected: (.+?) \(/.exec(text);
  if (auto) return auto[1] === "omp default" ? null : auto[1];
  const started = /\(model ([^,)]+)[,)]/.exec(text);
  return started ? started[1] : undefined;
}

/** Model and latest activity of a run, reading only events added since the last call. */
async function runDigest(repo: Repository, runId: string): Promise<RunEventDigest> {
  const digest = caches.events.get(runId) ?? { after: 0, model: undefined, activity: null, activityAt: null };
  for (;;) {
    const events = await repo.listRunEvents(runId, digest.after, EVENT_PAGE);
    for (const event of events) {
      digest.after = event.seq;
      if (event.kind === "status") {
        const model = modelFromStatus(event.text);
        if (model !== undefined) digest.model = model;
      }
      const line = activityLine(event.kind, event.text);
      if (line) {
        digest.activity = line;
        digest.activityAt = event.createdAt;
      }
    }
    if (events.length < EVENT_PAGE) break;
  }
  caches.events.set(runId, digest);
  return digest;
}

// ---------------------------------------------------------------------------------------------

export async function buildDashboard(repo: Repository, manager: AgentManager): Promise<Dashboard> {
  const now = Date.now();
  const [boards, managerQueue, settings, storedSettings, docker] = await Promise.all([
    repo.listBoards(),
    manager.queueSnapshot(),
    getAppSettings(repo),
    repo.getSetting(SETTINGS_KEY),
    dockerAvailable(now),
  ]);
  const actor = repoActor(repo);
  // The process-wide caches may only be pruned by a caller that sees every card.
  const seesAll = !actor || actor.role === "admin";
  const queue = seesAll ? managerQueue : visibleQueue(managerQueue, new Set(boards.map((board) => board.id)));
  const [tasksByBoard, gitByBoard] = await Promise.all([
    Promise.all(boards.map((board) => repo.listTasks(board.id))),
    Promise.all(boards.map((board) => Promise.all([board.workdir, ...board.extraFolders].map((f) => cachedGitStatus(f, now))))),
  ]);

  const historyStart = now - HISTORY_DAYS * DAY_MS;
  const allTasks = tasksByBoard.flat();
  // Only cards touched in the history window (or with an agent on them) can have runs that count.
  const runsByTask = new Map<string, SlimRun[]>();
  await Promise.all(
    allTasks
      .filter(
        (task) =>
          task.lastRunId &&
          (Date.parse(task.updatedAt) >= historyStart || task.agentState === "running" || task.agentState === "queued"),
      )
      .map(async (task) => runsByTask.set(task.id, await cardRuns(repo, task))),
  );
  const liveIds = new Set(allTasks.map((task) => task.id));
  if (seesAll) for (const id of caches.runs.keys()) if (!liveIds.has(id)) caches.runs.delete(id);

  const totals: Record<TaskStatus, number> = { todo: 0, in_progress: 0, done: 0 };
  const failed: (DashboardCard & { reason: AttentionReason })[] = [];
  const stalled: (DashboardCard & { reason: AttentionReason })[] = [];
  const finished: DashboardCard[] = [];
  const needsYou: NeedsYouCard[] = [];
  const activity: DashboardActivity[] = [];
  const setup = { hasCard: false, hasRun: false, hasDone: false, hasPush: false };

  const day: DashboardStatsWindow = { runs: 0, succeeded: 0, failed: 0, avgDurationMs: null, shipped: 0, created: 0 };
  const week: DashboardStatsWindow = { ...day };
  const daily = Array.from({ length: STATS_DAYS }, () => ({ runs: 0, succeeded: 0, failed: 0, shipped: 0 }));
  const durations = { day: { sum: 0, n: 0 }, week: { sum: 0, n: 0 } };
  /** Bucket (0 = oldest) of a timestamp inside the stats window, else -1. */
  const bucketOf = (iso: string): number => {
    const age = now - Date.parse(iso);
    return age >= 0 && age < STATS_DAYS * DAY_MS ? STATS_DAYS - 1 - Math.floor(age / DAY_MS) : -1;
  };

  const activityEntry = (
    kind: DashboardActivity["kind"],
    at: string,
    task: Task,
    board: Board,
    extra: Partial<Pick<DashboardActivity, "durationMs" | "detail">> = {},
  ) => {
    if (Date.parse(at) < historyStart) return;
    activity.push({
      kind,
      at,
      taskId: task.id,
      boardId: board.id,
      boardName: board.name,
      title: task.title,
      durationMs: extra.durationMs ?? null,
      detail: extra.detail ?? null,
    });
  };

  const dashboardBoards: DashboardBoard[] = boards.map((board, i) => {
    const git = gitByBoard[i];
    const canPush = git.some((status) => status.isRepo && status.remoteUrl);
    let lastActivityAt = board.updatedAt;
    let attentionCount = 0;
    let needsYouCount = 0;
    const runs30d = { succeeded: 0, failed: 0 };

    for (const task of tasksByBoard[i]) {
      totals[task.status] += 1;
      setup.hasCard = true;
      if (task.lastRunId) setup.hasRun = true;
      if (task.status === "done") setup.hasDone = true;
      if (task.pushedAt) setup.hasPush = true;
      if (task.updatedAt > lastActivityAt) lastActivityAt = task.updatedAt;

      const reason = attentionReason(task);
      if (reason) {
        attentionCount += 1;
        (reason === "failed" ? failed : stalled).push({ ...toCard(task, board.name), reason });
      } else if (task.status === "done" && task.lastRunId) {
        finished.push(toCard(task, board.name));
      }

      const reasons = needsYouReasons(task, canPush, now);
      if (reasons.length > 0) {
        needsYouCount += 1;
        needsYou.push({
          ...toCard(task, board.name),
          reasons,
          question: task.question ? truncate(task.question.trim(), QUESTION_MAX) : null,
          retryAt: task.retryAt,
          pushedAt: task.pushedAt,
        });
      }

      // Cards created and shipped.
      const created = bucketOf(task.createdAt);
      if (created >= 0) {
        week.created += 1;
        if (created === STATS_DAYS - 1) day.created += 1;
      }
      activityEntry("created", task.createdAt, task, board, {
        detail: task.createdByTaskId ? "Created by another card's agent" : null,
      });
      if (task.pushedAt) {
        const shipped = bucketOf(task.pushedAt);
        if (shipped >= 0) {
          week.shipped += 1;
          daily[shipped].shipped += 1;
          if (shipped === STATS_DAYS - 1) day.shipped += 1;
        }
        activityEntry("pushed", task.pushedAt, task, board);
      }

      // Runs that ended.
      for (const run of runsByTask.get(task.id) ?? []) {
        if (!run.endedAt || run.status === "running") continue;
        const durationMs = Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt));
        if (Date.parse(run.endedAt) >= historyStart) {
          if (run.status === "succeeded") runs30d.succeeded += 1;
          if (run.status === "failed") runs30d.failed += 1;
        }
        activityEntry(
          run.status === "succeeded" ? "succeeded" : run.status === "failed" ? "failed" : "stopped",
          run.endedAt,
          task,
          board,
          { durationMs, detail: run.status === "failed" && run.error ? truncate(run.error.split("\n", 1)[0], 160) : null },
        );
        const bucket = bucketOf(run.endedAt);
        if (bucket < 0) continue;
        const windows = bucket === STATS_DAYS - 1 ? ([week, day] as const) : ([week] as const);
        daily[bucket].runs += 1;
        for (const w of windows) w.runs += 1;
        if (run.status === "succeeded" || run.status === "failed") {
          daily[bucket][run.status] += 1;
          for (const w of windows) w[run.status] += 1;
          durations.week.sum += durationMs;
          durations.week.n += 1;
          if (bucket === STATS_DAYS - 1) {
            durations.day.sum += durationMs;
            durations.day.n += 1;
          }
        }
      }
    }
    return { ...board, lastActivityAt, attentionCount, needsYouCount, runs30d, git };
  });

  dashboardBoards.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  day.avgDurationMs = durations.day.n > 0 ? Math.round(durations.day.sum / durations.day.n) : null;
  week.avgDurationMs = durations.week.n > 0 ? Math.round(durations.week.sum / durations.week.n) : null;

  // Live agents: run start, model and latest activity of every running/queued card.
  const taskById = new Map(allTasks.map((task) => [task.id, task]));
  const boardById = new Map(boards.map((board) => [board.id, board]));
  const live: DashboardLiveAgent[] = await Promise.all(
    [...queue.running, ...queue.queued].map(async (entry): Promise<DashboardLiveAgent> => {
      const task = taskById.get(entry.taskId);
      const board = boardById.get(entry.boardId);
      const fallbackModel = board?.model?.trim() || settings.defaultModel || null;
      const base = { taskId: entry.taskId, startedAt: null, model: fallbackModel, activity: null, activityAt: null, context: null };
      if (entry.state !== "running" || !task?.lastRunId) return base;
      const run = runsByTask.get(task.id)?.find((r) => r.id === task.lastRunId) ?? (await repo.getRun(task.lastRunId));
      if (!run || run.status !== "running") return base;
      const digest = await runDigest(repo, run.id);
      return {
        taskId: entry.taskId,
        startedAt: run.startedAt,
        model: digest.model === undefined ? fallbackModel : digest.model,
        activity: digest.activity,
        activityAt: digest.activityAt,
        context: manager.contextUsage(entry.taskId),
      };
    }),
  );
  const runningRuns = new Set(
    live.flatMap((agent) => {
      const runId = taskById.get(agent.taskId)?.lastRunId;
      return agent.startedAt && runId ? [runId] : [];
    }),
  );
  if (seesAll) for (const id of caches.events.keys()) if (!runningRuns.has(id)) caches.events.delete(id);

  needsYou.sort(
    (a, b) => NEEDS_YOU_ORDER.indexOf(a.reasons[0]) - NEEDS_YOU_ORDER.indexOf(b.reasons[0]) || newestFirst(a, b),
  );
  activity.sort((a, b) => b.at.localeCompare(a.at));

  return {
    generatedAt: new Date(now).toISOString(),
    boards: dashboardBoards,
    totals,
    attention: [...failed.sort(newestFirst), ...stalled.sort(newestFirst)].slice(0, ATTENTION_LIMIT),
    finished: finished.sort(newestFirst).slice(0, FINISHED_LIMIT),
    needsYou: needsYou.slice(0, NEEDS_YOU_LIMIT),
    needsYouTotal: needsYou.length,
    queue,
    live,
    stats: { day, week, daily },
    activity: activity.slice(0, ACTIVITY_LIMIT),
    setup: { ...setup, settingsSaved: storedSettings !== null, dockerAvailable: docker },
  };
}
