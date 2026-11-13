// How a robot on the Visualize page feels: run tallies and context fill turned into fatigue,
// load, heat, "mana" (context left), a thinking state, a call for help and one mood to draw.
import type { ContextUsage, SubagentSnapshot, SubagentToolCall } from "@/lib/types";
import type { AgentStats, LiveAgent } from "./use-live-agents";
import type { WorkerMood } from "./worker-avatar";

/** Idle: calm pondering; solving: deep thinking on a productive run; stuck: going in circles. */
export type Thinking = "idle" | "solving" | "stuck";
export type HelpReason = "errors" | "retrying" | "stalled" | "failed";

export interface Vitals {
  mood: WorkerMood;
  /** 0..1: tool calls, run time and model requests. */
  fatigue: number;
  /** 0..1 cognitive load: busy subagents, tool rate, context fill. */
  load: number;
  /** 0..1: recent failures, the same tool hammered, retries. */
  heat: number;
  /** 0..1 context window left; null when unknown. */
  mana: number | null;
  /** Null when not in a thinking state. */
  thinking: Thinking | null;
  help: { reason: HelpReason; text: string } | null;
  /** One short human line: "Running hot: 4 of the last 10 calls failed". */
  feeling: string;
  /** Tooltip lines: "Fatigue 62% · 48 tool calls in 23m", "Mana 40% · 80k / 200k tokens". */
  notes: string[];
}

/** Context window assumed when the model's is unknown. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

const MINUTE = 60_000;

/** Fatigue is full at any of these: tool calls, minutes of run time, model requests. */
const TIRING_TOOLS = 120;
const TIRING_MINUTES = 60;
const TIRING_REQUESTS = 80;
/** Heat is full when HEAT_FULL_ERRORS of the last HEAT_WINDOW tool calls failed. */
const HEAT_WINDOW = 10;
const HEAT_FULL_ERRORS = 4;
/**
 * The same tool STREAK_MIN+ times in a row with a failure among them adds STREAK_HEAT, plus
 * STREAK_STEP_HEAT per extra call (a streak of clean reads is just reading).
 */
const STREAK_MIN = 4;
const STREAK_HEAT = 0.3;
const STREAK_STEP_HEAT = 0.1;
/** Heat per model retry while errors are unresolved or a retry is under way. */
const RETRY_HEAT = 0.15;
/**
 * Load is full at BUSY_FULL busy subagents or RATE_FULL tool calls a minute (busy agents burst
 * 10-20); a full context adds CONTEXT_LOAD.
 */
const BUSY_FULL = 4;
const RATE_FULL = 30;
const CONTEXT_LOAD = 0.4;
/** The tool rate is averaged over at least this many minutes, so a first burst is not a flood. */
const RATE_MIN_SPAN = 2;
/** Tool calls this recent count towards the tool rate. */
const RATE_WINDOW_MS = 5 * MINUTE;
/** A thinking stretch shorter than this is a pause, not yet deep thought. */
const THINK_SETTLE_MS = 10_000;
/** Deep thinking ("solving") needs progress at most this long before the stretch began. */
const FOCUS_PROGRESS_MS = 3 * MINUTE;
/** Thinking or no progress this long with unresolved errors = stuck; longer clean thinking = pondering. */
const STUCK_MS = 4 * MINUTE;
/** The same tool this many times in a row with failures among them = stuck. */
const STUCK_STREAK = 5;
/** Unresolved errors that make an agent ask for help. */
const HELP_ERRORS = 3;
/** No event this long (not thinking, no busy subagents) = stalled. */
const STALL_MS = 6 * MINUTE;
/** Energized: fatigue under FRESH_FATIGUE, no heat, ENERGY_TOOLS calls in ENERGY_WINDOW_MS (subagents: ENERGY_RATE a minute). */
const FRESH_FATIGUE = 0.2;
const ENERGY_WINDOW_MS = 2 * MINUTE;
const ENERGY_TOOLS = 3;
const ENERGY_RATE = 1.5;
/** Mood thresholds. */
const OVERHEATED = 0.6;
const OVERLOADED = 0.75;
const TIRED = 0.7;
const LOW_MANA = 0.15;
const STRESSED_HEAT = 0.3;
const STRESSED_BOTH = 0.5;

const NO_STATS: AgentStats = { toolCount: 0, errorCount: 0, retryCount: 0, recentTools: [], unresolvedErrors: 0 };

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const pct = (value: number) => `${Math.round(value * 100)}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** 40s, 12m, 1h 5m. */
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)}h ${rest}m` : `${minutes / 60}h`;
}

/** 950, 80k, 1.2M. */
function tokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

interface Streak {
  tool: string;
  count: number;
  /** A failure among the streak's calls. */
  failing: boolean;
}

/** The run of identical tool names at the newest end of `tools` (newest first). */
function streakOf(tools: readonly { tool: string; error?: boolean }[]): Streak {
  const tool = tools[0]?.tool ?? "";
  let count = 0;
  let failing = false;
  for (const call of tools) {
    if (call.tool !== tool) break;
    count++;
    failing ||= Boolean(call.error);
  }
  return { tool, count, failing };
}

function streakHeat(streak: Streak): number {
  return streak.failing && streak.count >= STREAK_MIN ? STREAK_HEAT + STREAK_STEP_HEAT * (streak.count - STREAK_MIN) : 0;
}

/** Everything a feeling or tooltip line may cite. */
interface Facts {
  fatigue: number;
  load: number;
  heat: number;
  mana: number | null;
  thinking: Thinking | null;
  help: Vitals["help"];
  energized: boolean;
  toolCount: number;
  durationMs: number;
  requests?: number;
  /** Failed calls among the `recentCount` newest. */
  errorsRecent: number;
  recentCount: number;
  streak: Streak;
  busy: number;
  /** Tool calls a minute. */
  rate: number;
  context: { tokens: number; window: number } | null;
  thinkingMs: number;
  stuckWhy?: string;
  errorDetail?: string;
  /** Why it is energized: "5 tool calls in the last 2m". */
  energy: string;
}

/** The one mood to draw; the strongest signal wins. */
function pickMood(f: Facts): WorkerMood {
  if (f.help) return "needs-help";
  if (f.thinking === "stuck") return "stuck";
  if (f.heat >= OVERHEATED) return "overheated";
  if (f.load >= OVERLOADED) return "overloaded";
  if (f.fatigue >= TIRED || (f.mana !== null && f.mana < LOW_MANA)) return "tired";
  if (f.heat >= STRESSED_HEAT || (f.fatigue >= STRESSED_BOTH && f.load >= STRESSED_BOTH)) return "stressed";
  if (f.thinking === "solving") return "focused";
  if (f.thinking === "idle") return "thinking";
  if (f.energized) return "energized";
  return "working";
}

function feelingOf(mood: WorkerMood, f: Facts): string {
  const failures = `${f.errorsRecent} of the last ${plural(f.recentCount, "call")} failed`;
  switch (mood) {
    case "error":
      return f.errorDetail ? `Hit an error: ${f.errorDetail}` : "Hit an error";
    case "needs-help":
      return f.help ? `Needs help: ${f.help.text}` : "Needs help";
    case "stuck":
      return f.stuckWhy ?? "Stuck";
    case "overheated":
      return f.streak.failing && f.streak.count >= STREAK_MIN
        ? `Running hot: ${f.streak.tool} ${f.streak.count} times in a row, ${failures}`
        : `Running hot: ${failures}`;
    case "overloaded": {
      const parts = [
        f.busy > 0 && `${plural(f.busy, "helper")} busy`,
        f.rate >= 1 && `${Math.round(f.rate)} tool calls a minute`,
        f.context && `${pct(1 - (f.mana ?? 1))} context used`,
      ].filter(Boolean);
      return `Overloaded: ${parts.join(", ") || "a lot going on"}`;
    }
    case "tired":
      return f.mana !== null && f.mana < LOW_MANA
        ? `Low on mana: ${pct(f.mana)} context left`
        : `Getting tired: ${plural(f.toolCount, "tool call")} in ${duration(f.durationMs)}`;
    case "stressed":
      return f.heat >= STRESSED_HEAT ? `Under pressure: ${failures}` : "Under pressure: busy and getting tired";
    case "focused":
      return `Deep in thought for ${duration(f.thinkingMs)}`;
    case "thinking":
      return f.thinkingMs >= STUCK_MS ? `Pondering for ${duration(f.thinkingMs)}` : "Thinking it over";
    case "energized":
      return `Energized: ${f.energy}`;
    case "waiting":
      return "Waiting for its turn";
    case "happy":
      return `Done: ${plural(f.toolCount, "tool call")} in ${duration(f.durationMs)}`;
    case "sleeping":
      return "Stopped before finishing";
    default:
      if (f.toolCount === 0) return "Getting started";
      return `Working steadily: ${plural(f.toolCount, "tool call")}${f.durationMs >= 1000 ? ` in ${duration(f.durationMs)}` : " so far"}`;
  }
}

function vitalsOf(mood: WorkerMood, f: Facts): Vitals {
  const notes = [
    `Fatigue ${pct(f.fatigue)} · ${plural(f.toolCount, "tool call")} in ${duration(f.durationMs)}${f.requests ? ` · ${plural(f.requests, "request")}` : ""}`,
    `Load ${pct(f.load)} · ${f.busy > 0 ? `${plural(f.busy, "helper")} busy · ` : ""}${f.rate.toFixed(1)} tools/min`,
    `Heat ${pct(f.heat)} · ${f.recentCount ? `${f.errorsRecent} of the last ${plural(f.recentCount, "call")} failed` : "no tool calls yet"}${f.streak.count >= STREAK_MIN ? ` · ${f.streak.tool} ×${f.streak.count} in a row` : ""}`,
    f.context && f.mana !== null
      ? `Mana ${pct(f.mana)} · ${tokenCount(f.context.tokens)} / ${tokenCount(f.context.window)} tokens`
      : "Mana unknown",
  ];
  if (f.help) notes.push(`Needs help: ${f.help.text}`);
  return {
    mood,
    fatigue: f.fatigue,
    load: f.load,
    heat: f.heat,
    mana: f.mana,
    thinking: f.thinking,
    help: f.help,
    feeling: feelingOf(mood, f),
    notes,
  };
}

/** Context fill → window used and mana left. */
function manaOf(tokens: number | undefined, window: number): Pick<Facts, "context" | "mana"> {
  if (tokens === undefined) return { context: null, mana: null };
  return { context: { tokens, window }, mana: clamp(1 - tokens / window) };
}

/** Card agent. context: DashboardLiveAgent.context or LiveAgent.context (newer wins). */
export function agentVitals(agent: LiveAgent | undefined, now: number, context?: ContextUsage | null): Vitals {
  const stats = agent?.stats ?? NO_STATS;
  const time = (iso: string | undefined) => (iso ? Date.parse(iso) : undefined);
  const startedAt = time(agent?.startedAt);
  const durationMs = startedAt === undefined ? 0 : Math.max(0, now - startedAt);

  const tools = stats.recentTools;
  const newestFirst = [...tools].reverse();
  const recent = newestFirst.slice(0, HEAT_WINDOW);
  const errorsRecent = recent.filter((t) => t.error).length;
  const streak = streakOf(newestFirst);
  const unresolved = stats.unresolvedErrors;
  const retrying = agent?.activity?.icon === "status" && agent.activity.label.startsWith("Retrying");
  const retryHeat = unresolved > 0 || retrying ? stats.retryCount * RETRY_HEAT : 0;
  const heat = clamp(errorsRecent / HEAT_FULL_ERRORS + streakHeat(streak) + retryHeat);

  // Live context events are newer than the dashboard snapshot.
  const usage = agent?.context ?? context ?? null;
  const { context: fill, mana } = manaOf(usage?.tokens, usage?.contextWindow || DEFAULT_CONTEXT_WINDOW);
  const busy = Object.values(agent?.helpers ?? {}).filter((h) => h.status === "running" || h.status === "pending").length;
  const rateTools = tools.filter((t) => now - Date.parse(t.at) <= RATE_WINDOW_MS);
  const rate = rateTools.length / Math.max(RATE_MIN_SPAN, rateTools.length > 0 ? (now - Date.parse(rateTools[0].at)) / MINUTE : 0);
  const load = clamp(busy / BUSY_FULL + rate / RATE_FULL + (mana === null ? 0 : (1 - mana) * CONTEXT_LOAD));
  const fatigue = clamp(Math.max(stats.toolCount / TIRING_TOOLS, durationMs / MINUTE / TIRING_MINUTES));

  // Thinking: deep thought on a productive run vs going in circles.
  const thinkingNow = agent?.activity?.icon === "think";
  const thinkStart = thinkingNow ? (time(stats.thinkingSince) ?? now) : now;
  const thinkingMs = Math.max(0, now - thinkStart);
  const progressAt = time(stats.lastProgressAt) ?? startedAt;
  const sinceProgress = progressAt === undefined ? 0 : Math.max(0, now - progressAt);
  let thinking: Thinking | null = null;
  let stuckWhy: string | undefined;
  if (streak.failing && streak.count >= STUCK_STREAK) {
    thinking = "stuck";
    stuckWhy = `Stuck: ${streak.tool} ${streak.count} times in a row, still failing`;
  } else if (unresolved > 0 && (thinkingMs > STUCK_MS || sinceProgress > STUCK_MS)) {
    thinking = "stuck";
    stuckWhy =
      thinkingMs > STUCK_MS
        ? `Stuck: thinking for ${duration(thinkingMs)} with ${plural(unresolved, "unresolved error")}`
        : `Stuck: no progress for ${duration(sinceProgress)}, ${plural(unresolved, "unresolved error")}`;
  } else if (thinkingNow) {
    const productive = progressAt !== undefined && thinkStart - progressAt <= FOCUS_PROGRESS_MS;
    thinking = productive && thinkingMs >= THINK_SETTLE_MS && thinkingMs <= STUCK_MS ? "solving" : "idle";
  }

  const lastEventAt = time(stats.lastEventAt) ?? startedAt;
  let help: Vitals["help"] = null;
  if (unresolved >= HELP_ERRORS) {
    help = { reason: "errors", text: `${plural(unresolved, "error")} in a row without progress` };
  } else if (retrying) {
    help = { reason: "retrying", text: `retrying the model (${stats.retryCount} ${stats.retryCount === 1 ? "retry" : "retries"} so far)` };
  } else if (agent && !thinkingNow && busy === 0 && lastEventAt !== undefined && now - lastEventAt > STALL_MS) {
    help = { reason: "stalled", text: `no sign of life for ${duration(now - lastEventAt)}` };
  }

  const fresh = tools.filter((t) => now - Date.parse(t.at) <= ENERGY_WINDOW_MS).length;
  const facts: Facts = {
    fatigue,
    load,
    heat,
    mana,
    thinking,
    help,
    energized: fatigue < FRESH_FATIGUE && heat === 0 && fresh >= ENERGY_TOOLS,
    toolCount: stats.toolCount,
    durationMs,
    errorsRecent,
    recentCount: recent.length,
    streak,
    busy,
    rate,
    context: fill,
    thinkingMs,
    stuckWhy,
    errorDetail: agent?.activity?.icon === "error" ? agent.activity.detail : undefined,
    energy: `${plural(fresh, "tool call")} in the last ${duration(ENERGY_WINDOW_MS)}`,
  };
  // The latest failure shows as an error unless it is part of a bigger trouble.
  const picked = pickMood(facts);
  const bigger = picked === "needs-help" || picked === "stuck" || picked === "overheated";
  return vitalsOf(agent?.activity?.icon === "error" && !bigger ? "error" : picked, facts);
}

/** Subagent. Window = parentContextWindow || DEFAULT_CONTEXT_WINDOW. Completed→happy, failed→error+help, pending→waiting. */
export function subagentVitals(sub: SubagentSnapshot, now: number, parentContextWindow?: number): Vitals {
  const toolCount = sub.toolCount ?? 0;
  const durationMs = sub.durationMs ?? 0;
  const minutes = durationMs / MINUTE;
  const tools: SubagentToolCall[] = sub.recentTools ?? [];
  const recent = tools.slice(0, HEAT_WINDOW).map((t) => ({ tool: t.tool, error: t.isError }));
  const errorsRecent = recent.filter((t) => t.error).length;
  const streak = streakOf(recent);
  const heat = clamp(errorsRecent / HEAT_FULL_ERRORS + streakHeat(streak));

  const { context, mana } = manaOf(sub.contextTokens, parentContextWindow || DEFAULT_CONTEXT_WINDOW);
  const rate = toolCount / Math.max(RATE_MIN_SPAN, minutes);
  const load = clamp(rate / RATE_FULL + (mana === null ? 0 : (1 - mana) * CONTEXT_LOAD));
  const fatigue = clamp(Math.max(toolCount / TIRING_TOOLS, minutes / TIRING_MINUTES, (sub.requests ?? 0) / TIRING_REQUESTS));

  const stuck = sub.status === "running" && streak.failing && streak.count >= STUCK_STREAK;
  let help: Vitals["help"] = null;
  if (sub.status === "failed") {
    const reason = sub.error?.split("\n")[0].trim().slice(0, 120);
    help = { reason: "failed", text: reason ? `failed: ${reason}` : "failed" };
  } else if (sub.status === "running" && recent.length >= HELP_ERRORS && recent.slice(0, HELP_ERRORS).every((t) => t.error)) {
    help = { reason: "errors", text: `the last ${HELP_ERRORS} tool calls failed` };
  }

  const facts: Facts = {
    fatigue,
    load,
    heat,
    mana,
    thinking: stuck ? "stuck" : null,
    help,
    energized: fatigue < FRESH_FATIGUE && heat === 0 && toolCount >= ENERGY_TOOLS && rate >= ENERGY_RATE,
    toolCount,
    durationMs,
    requests: sub.requests,
    errorsRecent,
    recentCount: recent.length,
    streak,
    busy: 0,
    rate,
    context,
    thinkingMs: 0,
    stuckWhy: stuck ? `Stuck: ${streak.tool} ${streak.count} times in a row, still failing` : undefined,
    errorDetail: sub.error?.split("\n")[0].trim() || undefined,
    energy: `${rate.toFixed(1)} tool calls a minute`,
  };
  const mood: WorkerMood =
    sub.status === "completed"
      ? "happy"
      : sub.status === "failed"
        ? "error"
        : sub.status === "aborted"
          ? "sleeping"
          : sub.status === "pending"
            ? "waiting"
            : pickMood(facts);
  return vitalsOf(mood, facts);
}

/** Text tone of a mood: red when the worker is in trouble, amber when it is straining. */
export function moodTone(mood: WorkerMood): "error" | "strain" | undefined {
  switch (mood) {
    case "error":
    case "needs-help":
    case "overheated":
      return "error";
    case "tired":
    case "stressed":
    case "overloaded":
    case "stuck":
      return "strain";
    default:
      return undefined;
  }
}
