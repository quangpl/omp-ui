// Server-only recurring cards (Schedulers tab), behind `/api/v1/schedulers/**`. On every match of
// a scheduler's cron expression (lib/cron.ts, evaluated in the scheduler's IANA time zone) it
// creates a regular card on the scheduler's board from its prompt through the "New task" flow
// (lib/agent/compose.ts), and records the run in its history (scheduler runs). The due check runs
// every 30 s; each scheduler keeps its next fire time in `nextRunAt`.
import { createCardFromText } from "@/lib/agent/compose";
import type { AgentManager } from "@/lib/agent/types";
import { nextCronTime } from "@/lib/cron";
import type { Repository } from "@/lib/db/types";
import { publish } from "@/lib/events";
import type {
  RunEvent,
  RunEventKind,
  Scheduler,
  SchedulerLogEntry,
  SchedulerRun,
  SchedulerRunView,
  Task,
} from "@/lib/types";

/** First due check after the server starts (lets boot recovery settle), then every 30 s. */
const FIRST_CHECK_MS = 10_000;
const CHECK_INTERVAL_MS = 30_000;
/** Run event kinds shown in a scheduler's log (thinking and subagent snapshots are left out). */
const LOG_EVENT_KINDS: Record<RunEventKind, boolean> = {
  status: true,
  text: true,
  tool: true,
  error: true,
  thinking: false,
  agent: false,
};
/** Most entries a scheduler's log returns (the newest). */
const LOG_MAX_ENTRIES = 2000;
/** Page size when reading a run's events. */
const EVENT_PAGE = 500;

interface Service {
  repo: Repository;
  manager: AgentManager;
}

// On globalThis so dev hot reloads share one timer and one set of schedulers being fired.
const g = globalThis as unknown as {
  __ompUiSchedulerService?: Service;
  __ompUiSchedulersFiring?: Set<string>;
};

/** Ids of the schedulers whose due run is being fired by this process right now. */
function firing(): Set<string> {
  g.__ompUiSchedulersFiring ??= new Set();
  return g.__ompUiSchedulersFiring;
}

/**
 * Next scheduled fire time strictly after `after` (ISO), evaluated in the scheduler's time zone.
 * Null when disabled, when its run limit is reached, or when the cron expression never matches
 * again (or can no longer be evaluated).
 */
export function computeNextRunAt(
  s: Pick<Scheduler, "cron" | "timezone" | "enabled" | "maxRuns" | "runCount">,
  after: Date = new Date(),
): string | null {
  if (!s.enabled) return null;
  if (s.maxRuns !== null && s.runCount >= s.maxRuns) return null;
  try {
    return nextCronTime(s.cron, after, s.timezone)?.toISOString() ?? null;
  } catch (err) {
    console.error("[scheduler] cannot evaluate cron:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Fire `scheduler` once: create its card from the prompt (the "New task" flow, so its agent
 * starts right away), record the run, and update the scheduler (run count, last
 * outcome, next fire time; disabled once `maxRuns` is reached). A missing board or a failure to
 * create the card is recorded as a failed run, never thrown. `now` is when it fired.
 */
export async function fireScheduler(
  repo: Repository,
  manager: AgentManager,
  scheduler: Scheduler,
  trigger: SchedulerRun["trigger"],
  scheduledFor: string,
  now: Date = new Date(),
): Promise<SchedulerRunView> {
  let task: Task | null = null;
  let error: string | null = null;
  const board = await repo.getBoard(scheduler.boardId);
  if (!board) {
    error = "Project not found";
  } else {
    try {
      task = await createCardFromText({ repo, manager, board, text: scheduler.prompt, schedulerId: scheduler.id });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  const run = await repo.createSchedulerRun({
    schedulerId: scheduler.id,
    taskId: task?.id ?? null,
    trigger,
    scheduledFor,
    status: task ? "created" : "failed",
    error,
  });

  // Re-read: the scheduler may have been edited while its card was being created.
  const current = (await repo.getScheduler(scheduler.id)) ?? scheduler;
  const runCount = current.runCount + 1;
  const enabled = current.enabled && (current.maxRuns === null || runCount < current.maxRuns);
  const updated = await repo.updateScheduler(scheduler.id, {
    runCount,
    lastRunAt: now.toISOString(),
    lastStatus: run.status,
    lastTaskId: task ? task.id : current.lastTaskId,
    lastError: task ? null : error,
    enabled,
    nextRunAt: computeNextRunAt({ ...current, enabled, runCount }, now),
  });
  if (updated) publish({ type: "scheduler.updated", scheduler: updated });
  const [view] = await toRunViews(repo, [run]);
  return view;
}

/** History rows as served by the API: each run plus a live snapshot of its card (null if gone). */
export async function toRunViews(repo: Repository, runs: SchedulerRun[]): Promise<SchedulerRunView[]> {
  return Promise.all(
    runs.map(async (run): Promise<SchedulerRunView> => {
      const task = run.taskId ? await repo.getTask(run.taskId) : null;
      const lastRun = task?.lastRunId ? await repo.getRun(task.lastRunId) : null;
      return {
        ...run,
        task: task
          ? {
              id: task.id,
              title: task.title,
              status: task.status,
              agentState: task.agentState,
              agentError: task.agentError,
              lastRunId: task.lastRunId,
            }
          : null,
        runStatus: lastRun?.status ?? null,
      };
    }),
  );
}

/** Every event of an agent run, oldest first. */
async function allRunEvents(repo: Repository, runId: string): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await repo.listRunEvents(runId, after, EVENT_PAGE);
    events.push(...page);
    if (page.length < EVENT_PAGE) return events;
    after = page[page.length - 1].seq;
  }
}

/** The scheduler's own line for one of its runs. */
function runLine(run: SchedulerRun, task: Task | null): string {
  const prefix = run.trigger === "manual" ? "Manual run" : `Scheduled run for ${run.scheduledFor}`;
  if (run.status === "failed") return `${prefix} failed: ${run.error ?? "unknown error"}`;
  return task ? `${prefix} created card "${task.title}"` : `${prefix} created a card (since deleted)`;
}

/**
 * Aggregated log of a scheduler's latest `runLimit` runs, oldest first: one scheduler line per
 * run plus every status, text, tool and error event of the agent runs of the card it created (if
 * the card still exists). At most the newest 2000 entries.
 */
export async function schedulerLogs(
  repo: Repository,
  schedulerId: string,
  runLimit = 20,
): Promise<SchedulerLogEntry[]> {
  const runs = await repo.listSchedulerRuns(schedulerId, runLimit);
  const perRun = await Promise.all(
    runs.map(async (run): Promise<SchedulerLogEntry[]> => {
      const task = run.taskId ? await repo.getTask(run.taskId) : null;
      const entries: SchedulerLogEntry[] = [
        {
          at: run.createdAt,
          kind: "scheduler",
          text: runLine(run, task),
          schedulerRunId: run.id,
          taskId: run.taskId,
          runId: null,
        },
      ];
      if (!task) return entries;
      for (const agentRun of await repo.listRuns(task.id)) {
        for (const event of await allRunEvents(repo, agentRun.id)) {
          if (!LOG_EVENT_KINDS[event.kind]) continue;
          entries.push({
            at: event.createdAt,
            kind: event.kind,
            text: event.text,
            schedulerRunId: run.id,
            taskId: task.id,
            runId: agentRun.id,
          });
        }
      }
      return entries;
    }),
  );
  // Stable sort: on equal times a run's scheduler line stays ahead of its card's events.
  const entries = perRun.flat().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return entries.slice(-LOG_MAX_ENTRIES);
}

/** Enabled with a next fire time at or before `now` (checked on the listing and again once claimed). */
function isDue(s: Scheduler, now: Date): s is Scheduler & { nextRunAt: string } {
  return s.enabled && s.nextRunAt !== null && Date.parse(s.nextRunAt) <= now.getTime();
}

/**
 * Fire every enabled scheduler that is due at `now`. Each one's claim (its next fire time after
 * `now`) is saved before its card is created, so an overlapping check or a crash never fires a
 * slot twice, and slots missed while the server was down fire once. Failures are logged per
 * scheduler. Returns how many fired.
 */
export async function runDueSchedulers(repo: Repository, manager: AgentManager, now = new Date()): Promise<number> {
  const busy = firing();
  let fired = 0;
  for (const listed of await repo.listSchedulers()) {
    if (!isDue(listed, now) || busy.has(listed.id)) continue;
    busy.add(listed.id);
    try {
      // Re-read once claimed in-process: an earlier check may have fired it since the listing.
      const scheduler = await repo.getScheduler(listed.id);
      if (!scheduler || !isDue(scheduler, now)) continue;
      const slot = scheduler.nextRunAt;
      const claimed = await repo.updateScheduler(scheduler.id, { nextRunAt: computeNextRunAt(scheduler, now) });
      if (!claimed) continue;
      await fireScheduler(repo, manager, claimed, "scheduled", slot, now);
      fired++;
    } catch (err) {
      console.error(`[scheduler] scheduler ${listed.id} failed to fire:`, err instanceof Error ? err.message : err);
    } finally {
      busy.delete(listed.id);
    }
  }
  return fired;
}

/** Give enabled schedulers without a next fire time one when their cron still matches. */
async function repairNextRuns(repo: Repository, now = new Date()): Promise<void> {
  for (const scheduler of await repo.listSchedulers()) {
    if (!scheduler.enabled || scheduler.nextRunAt) continue;
    const nextRunAt = computeNextRunAt(scheduler, now);
    if (!nextRunAt) continue;
    const updated = await repo.updateScheduler(scheduler.id, { nextRunAt });
    if (updated) publish({ type: "scheduler.updated", scheduler: updated });
  }
}

/**
 * Start the due check (once per process; later calls only swap the repo and manager it uses):
 * first after 10 s, then every 30 s.
 */
export function startSchedulerService(repo: Repository, manager: AgentManager): void {
  const existing = g.__ompUiSchedulerService;
  if (existing) {
    existing.repo = repo;
    existing.manager = manager;
    return;
  }
  const service: Service = { repo, manager };
  g.__ompUiSchedulerService = service;
  repairNextRuns(repo).catch((err: unknown) =>
    console.error("[scheduler] repairing next run times failed:", err instanceof Error ? err.message : err),
  );
  const check = (): void => {
    runDueSchedulers(service.repo, service.manager).catch((err: unknown) =>
      console.error("[scheduler] due check failed:", err instanceof Error ? err.message : err),
    );
  };
  setTimeout(() => {
    check();
    setInterval(check, CHECK_INTERVAL_MS).unref();
  }, FIRST_CHECK_MS).unref();
}
