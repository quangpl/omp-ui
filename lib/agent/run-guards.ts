// Run guards (Settings → Orchestration): stop a run that works too long, goes silent, or spends
// more than its budget. Pure evaluation; OmpAgentManager owns the supervisor timer and the
// failing. Each guard acts only while its toggle is on, so the settings apply to running runs.
// The wrap-up nudge (Hermes' iteration-budget summary request) warns a run nearing its time limit
// or budget so it can finish and report instead of being cut off mid-step.
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

/** The guard settings plus the wrap-up nudge toggle and its threshold. */
export type WrapUpSettings = GuardSettings & Pick<AppSettings, "wrapUpNudge" | "wrapUpPercent">;

/** A run nearing the limit of a hard guard: which one, how much of it is used, and the numbers. */
export interface WrapUpHit {
  guard: "time" | "budget";
  /** Whole percent of the limit used (floored). */
  percent: number;
  /** Used and allowed amounts, e.g. `96 of 120 min`, `$4.10 of $5.00`, `410,000 of 500,000 tokens`. */
  detail: string;
}

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
    return {
      kind: "budget",
      message: `Run budget exceeded: ${tokenCount(usage.tokens)} of ${tokenCount(settings.runBudgetTokens)} tokens; ${NO_RETRY}`,
      retry: false,
    };
  }
  return null;
}

/**
 * The guard the run is about to trip, once it has used `wrapUpPercent` of its time limit or budget
 * (whichever is further along), or null. Null at 100 % and beyond: the hard guard stops the run then.
 * Waiting on a board tool does not matter: the time limit and the budget count regardless.
 */
export function evaluateWrapUp(state: RunGuardState, settings: WrapUpSettings, now: number): WrapUpHit | null {
  if (!settings.wrapUpNudge) return null;
  const candidates: { guard: WrapUpHit["guard"]; fraction: number; detail: string }[] = [];
  if (settings.runTimeLimit && settings.runTimeLimitMinutes > 0) {
    const minute = guardMinuteMs();
    const elapsed = Math.max(0, now - state.launchedAt);
    candidates.push({
      guard: "time",
      fraction: elapsed / (settings.runTimeLimitMinutes * minute),
      detail: `${Math.floor(elapsed / minute)} of ${settings.runTimeLimitMinutes} min`,
    });
  }
  if (settings.runBudget) {
    if (settings.runBudgetUsd > 0) {
      candidates.push({
        guard: "budget",
        fraction: state.costUsd / settings.runBudgetUsd,
        detail: `$${state.costUsd.toFixed(2)} of $${settings.runBudgetUsd.toFixed(2)}`,
      });
    }
    if (settings.runBudgetTokens > 0) {
      candidates.push({
        guard: "budget",
        fraction: state.tokens / settings.runBudgetTokens,
        detail: `${tokenCount(state.tokens)} of ${tokenCount(settings.runBudgetTokens)} tokens`,
      });
    }
  }
  const top = candidates.reduce<(typeof candidates)[number] | null>(
    (best, c) => (best && best.fraction >= c.fraction ? best : c),
    null,
  );
  if (!top || top.fraction >= 1) return null;
  // The epsilon keeps float error from flooring e.g. $2.85 of $5.00 (57 %) to 56 %.
  const percent = Math.floor(top.fraction * 100 + 1e-9);
  return percent >= settings.wrapUpPercent ? { guard: top.guard, percent, detail: top.detail } : null;
}

/** Steer prompt for a wrap-up hit: stop starting new work, land the current step, and report. */
export function wrapUpSteerMessage(hit: WrapUpHit): string {
  const limit = hit.guard === "time" ? "run time limit" : "run budget";
  return [
    `You have used ${hit.percent}% of your ${limit} (${hit.detail}). The run will be stopped when it reaches the limit.`,
    "Wrap up now: do not start new work, finish or safely pause the current step, and verify what is done.",
    "Then write your final summary with its Report, listing what is left to do.",
  ].join(" ");
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

function tokenCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
