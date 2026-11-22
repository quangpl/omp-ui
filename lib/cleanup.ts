// Server-only scheduled cleanup of OMP-UI's own data (Settings → Cleanup), behind
// `GET|POST /api/v1/settings/cleanup`. Runs the lib/maintenance.ts cleanups chosen in the settings
// weekly, monthly or on demand; Docker prunes stay manual on the Maintenance page. The outcome
// of the last run and the schedule's anchor persist in the settings table under `cleanup_state`.
import type { AgentManager } from "@/lib/agent/types";
import type { Repository } from "@/lib/db/types";
import { cleanupTargetInfo, runMaintenance } from "@/lib/maintenance";
import { getAppSettings, isScheduledCleanupId } from "@/lib/settings";
import {
  SCHEDULED_CLEANUP_IDS,
  type CleanupSchedule,
  type CleanupStatus,
  type MaintenanceResult,
  type ScheduledCleanupId,
} from "@/lib/types";

const STATE_KEY = "cleanup_state";
const DAY_MS = 24 * 60 * 60_000;
const PERIOD_MS: Record<Exclude<CleanupSchedule, "off">, number> = { weekly: 7 * DAY_MS, monthly: 30 * DAY_MS };
/** First due check after the server starts (lets boot recovery settle), then hourly. */
const FIRST_CHECK_MS = 60_000;
const CHECK_INTERVAL_MS = 60 * 60_000;

interface CleanupState {
  lastRunAt: string | null;
  lastTrigger: CleanupStatus["lastTrigger"];
  lastResult: MaintenanceResult | null;
  /** When the current schedule was chosen; it counts from here until the first run. */
  anchorAt: string | null;
}

interface Scheduler {
  repo: Repository;
  manager: AgentManager;
}

// On globalThis so dev hot reloads share one flag and one timer.
const g = globalThis as unknown as {
  __ompUiCleanupRunning?: boolean;
  __ompUiCleanupScheduler?: Scheduler;
};

async function readState(repo: Repository): Promise<CleanupState> {
  const empty: CleanupState = { lastRunAt: null, lastTrigger: null, lastResult: null, anchorAt: null };
  const raw = await repo.getSetting(STATE_KEY);
  if (!raw) return empty;
  try {
    const s = JSON.parse(raw) as Partial<CleanupState>;
    return {
      lastRunAt: typeof s.lastRunAt === "string" ? s.lastRunAt : null,
      lastTrigger: s.lastTrigger === "manual" || s.lastTrigger === "scheduled" ? s.lastTrigger : null,
      lastResult: s.lastResult && Array.isArray(s.lastResult.results) ? s.lastResult : null,
      anchorAt: typeof s.anchorAt === "string" ? s.anchorAt : null,
    };
  } catch {
    return empty;
  }
}

async function writeState(repo: Repository, state: CleanupState): Promise<void> {
  await repo.setSetting(STATE_KEY, JSON.stringify(state));
}

/** The state, with an anchor set to now when a schedule is on but has none yet (older data). */
async function anchoredState(repo: Repository, schedule: CleanupSchedule): Promise<CleanupState> {
  const state = await readState(repo);
  if (schedule === "off" || state.anchorAt) return state;
  const next = { ...state, anchorAt: new Date().toISOString() };
  await writeState(repo, next);
  return next;
}

/**
 * When the schedule runs next: one period after the later of the last run and the moment the
 * schedule was chosen (so enabling a schedule never runs right away). Null when off or unanchored.
 */
export function nextCleanupAt(schedule: CleanupSchedule, lastRunAt: string | null, anchorAt: string | null): Date | null {
  if (schedule === "off") return null;
  const times = [lastRunAt, anchorAt].map((t) => (t ? Date.parse(t) : NaN)).filter(Number.isFinite);
  if (times.length === 0) return null;
  return new Date(Math.max(...times) + PERIOD_MS[schedule]);
}

/**
 * `ids` if it is an array of schedulable cleanup ids (deduplicated, canonical order); null when
 * it is not, or when it is empty and `allowEmpty` is not set.
 */
export function parseCleanupIds(value: unknown, options: { allowEmpty?: boolean } = {}): ScheduledCleanupId[] | null {
  if (!Array.isArray(value) || !value.every(isScheduledCleanupId)) return null;
  if (value.length === 0 && !options.allowEmpty) return null;
  return SCHEDULED_CLEANUP_IDS.filter((id) => value.includes(id));
}

/** Restart the schedule's period from now; call when the schedule setting changes. */
export async function resetCleanupAnchor(repo: Repository): Promise<void> {
  await writeState(repo, { ...(await readState(repo)), anchorAt: new Date().toISOString() });
}

export async function getCleanupStatus(repo: Repository): Promise<CleanupStatus> {
  const settings = await getAppSettings(repo);
  const state = await anchoredState(repo, settings.cleanupSchedule);
  return {
    schedule: settings.cleanupSchedule,
    targets: settings.cleanupTargets,
    available: cleanupTargetInfo(SCHEDULED_CLEANUP_IDS),
    lastRunAt: state.lastRunAt,
    lastTrigger: state.lastTrigger,
    lastResult: state.lastResult,
    nextRunAt: nextCleanupAt(settings.cleanupSchedule, state.lastRunAt, state.anchorAt)?.toISOString() ?? null,
    running: g.__ompUiCleanupRunning === true,
  };
}

/**
 * Run the cleanups `ids` (default: the saved targets) now and record the outcome. Returns the
 * updated status, or null when a cleanup is already running (one at a time per process).
 */
export async function runCleanup(
  repo: Repository,
  manager: AgentManager,
  trigger: "manual" | "scheduled",
  ids?: readonly ScheduledCleanupId[],
): Promise<CleanupStatus | null> {
  if (g.__ompUiCleanupRunning) return null;
  g.__ompUiCleanupRunning = true;
  try {
    const targets = ids ?? (await getAppSettings(repo)).cleanupTargets;
    const result = await runMaintenance({ kind: "cleanup", ids: [...targets] }, repo, manager);
    const state = await readState(repo);
    await writeState(repo, { ...state, lastRunAt: new Date().toISOString(), lastTrigger: trigger, lastResult: result });
  } finally {
    g.__ompUiCleanupRunning = false;
  }
  return getCleanupStatus(repo);
}

/** Run the scheduled cleanup if it is due at `now`; true when it ran. */
export async function runDueCleanup(repo: Repository, manager: AgentManager, now = Date.now()): Promise<boolean> {
  const settings = await getAppSettings(repo);
  if (settings.cleanupSchedule === "off" || settings.cleanupTargets.length === 0) return false;
  const state = await anchoredState(repo, settings.cleanupSchedule);
  const next = nextCleanupAt(settings.cleanupSchedule, state.lastRunAt, state.anchorAt);
  if (!next || now < next.getTime()) return false;
  const status = await runCleanup(repo, manager, "scheduled", settings.cleanupTargets);
  for (const step of status?.lastResult?.results ?? []) {
    if (!step.ok) console.warn(`[cleanup] ${step.message}`);
  }
  return status !== null;
}

/**
 * Check for a due scheduled cleanup about a minute after start, then hourly. Idempotent: later
 * calls (a rebooted manager, a dev hot reload) only swap in the current repo and manager.
 */
export function startCleanupScheduler(repo: Repository, manager: AgentManager): void {
  const existing = g.__ompUiCleanupScheduler;
  if (existing) {
    existing.repo = repo;
    existing.manager = manager;
    return;
  }
  const scheduler: Scheduler = { repo, manager };
  g.__ompUiCleanupScheduler = scheduler;
  const check = (): void => {
    runDueCleanup(scheduler.repo, scheduler.manager).catch((err: unknown) =>
      console.error("[cleanup] scheduled cleanup failed:", err instanceof Error ? err.message : err),
    );
  };
  setTimeout(() => {
    check();
    setInterval(check, CHECK_INTERVAL_MS).unref();
  }, FIRST_CHECK_MS).unref();
}
