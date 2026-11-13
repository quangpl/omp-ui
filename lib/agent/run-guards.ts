// Run guards (Settings → Orchestration): stop a run that works too long, goes silent, or spends
// more than its budget. Pure evaluation; OmpAgentManager owns the supervisor timer and the
// failing. Each guard acts only while its toggle is on, so the settings apply to running runs.
import type { AppSettings, SubagentSnapshot } from "@/lib/types";

/** How often the manager's supervisor checks the active runs (default 10 s). */
export const GUARD_TICK_MS = 10_000;
const MINUTE_MS = 60_000;

/** The supervisor's tick; `OMP_UI_GUARD_TICK_MS` shortens it in tests. */
export function guardTickMs(): number {
  return Number(process.env.OMP_UI_GUARD_TICK_MS) || GUARD_TICK_MS;
}

/** Milliseconds per settings minute; `OMP_UI_GUARD_MINUTE_MS` lets tests use tiny limits. */
export function guardMinuteMs(): number {
  return Number(process.env.OMP_UI_GUARD_MINUTE_MS) || MINUTE_MS;
}

/** Spend reported by omp: USD and tokens. */
export interface RunUsage {
  costUsd: number;
  tokens: number;
}

export interface RunGuardState extends RunUsage {
  /** When the run was launched (ms epoch). */
  launchedAt: number;
  /** When the run's omp process last sent a frame (ms epoch). */
  lastActivityAt: number;
  /** A board tool call is in flight (board_wait_for_cards may legitimately wait long). */
  waitingOnHost: boolean;
}

export interface RunGuardHit {
  kind: "time-limit" | "stall" | "budget";
  message: string;
  /** Whether the failure may be retried automatically: only a stall, which a retry can resume. */
  retry: boolean;
}

type GuardSettings = Pick<
  AppSettings,
  | "runTimeLimit"
  | "runTimeLimitMinutes"
  | "stallWatchdog"
  | "stallTimeoutMinutes"
  | "runBudget"
  | "runBudgetUsd"
  | "runBudgetTokens"
>;

const NO_RETRY = "stopped without an automatic retry.";

/** Whether any guard is on; when none is, the supervisor does no work. */
export function guardsEnabled(settings: GuardSettings): boolean {
  return settings.runTimeLimit || settings.stallWatchdog || settings.runBudget;
}

/**
 * The first guard the run trips, or null. Guards that skip the retry win over the stall
 * watchdog: retrying a run over its time limit or budget would only trip the guard again.
 */
export function evaluateRunGuards(state: RunGuardState, settings: GuardSettings, now: number): RunGuardHit | null {
  const minute = guardMinuteMs();
  if (settings.runTimeLimit && now - state.launchedAt > settings.runTimeLimitMinutes * minute) {
    return {
      kind: "time-limit",
      message: `Run time limit reached (${settings.runTimeLimitMinutes} min); ${NO_RETRY}`,
      retry: false,
    };
  }
  const budget = evaluateBudget(state, settings);
  if (budget) return budget;
  if (settings.stallWatchdog && !state.waitingOnHost && now - state.lastActivityAt > settings.stallTimeoutMinutes * minute) {
    return {
      kind: "stall",
      message: `No activity from the agent for ${settings.stallTimeoutMinutes} min (stall watchdog)`,
      retry: true,
    };
  }
  return null;
}

/** The budget guard alone: checked right when omp reports new usage, not only on the tick. */
export function evaluateBudget(usage: RunUsage, settings: GuardSettings): RunGuardHit | null {
  if (!settings.runBudget) return null;
  if (settings.runBudgetUsd > 0 && usage.costUsd > settings.runBudgetUsd) {
    return {
      kind: "budget",
      message: `Run budget exceeded: $${usage.costUsd.toFixed(2)} of $${settings.runBudgetUsd.toFixed(2)}; ${NO_RETRY}`,
      retry: false,
    };
  }
  if (settings.runBudgetTokens > 0 && usage.tokens > settings.runBudgetTokens) {
    const count = (n: number) => Math.round(n).toLocaleString("en-US");
    return {
      kind: "budget",
      message: `Run budget exceeded: ${count(usage.tokens)} of ${count(settings.runBudgetTokens)} tokens; ${NO_RETRY}`,
      retry: false,
    };
  }
  return null;
}

/** Session usage from a `get_session_stats` response (`cost` USD, `tokens.total`); null if absent. */
export function sessionUsage(data: unknown): RunUsage | null {
  if (!isObject(data)) return null;
  const cost = finite(data.cost);
  const tokens = isObject(data.tokens) ? finite(data.tokens.total) : undefined;
  if (cost === undefined && tokens === undefined) return null;
  return { costUsd: cost ?? 0, tokens: tokens ?? 0 };
}

/** The run's total spend: its omp session plus every subagent it delegated to. */
export function totalUsage(session: RunUsage, subagents: Iterable<SubagentSnapshot>): RunUsage {
  let costUsd = session.costUsd;
  let tokens = session.tokens;
  for (const agent of subagents) {
    costUsd += finite(agent.cost) ?? 0;
    tokens += finite(agent.tokens) ?? 0;
  }
  return { costUsd, tokens };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
