// Scheduler validation and writes shared by the REST routes (`/api/v1/schedulers/**`), the
// "Create with Agent" scheduler assistant (lib/server/scheduler-assistant.ts) and the Telegram/Discord
// chat assistant (lib/server/chat/assistant.ts), so every path follows the same rules. Parsers
// throw HttpError (400 bad input, 404 unknown project or scheduler).
import { describeCron, nextCronTimes } from "@/lib/cron";
import type { CreateSchedulerInput, Repository, UpdateSchedulerInput } from "@/lib/db/types";
import { publish } from "@/lib/events";
import { computeNextRunAt } from "@/lib/scheduler";
import { HttpError } from "@/lib/server/http";
import {
  parseBrief,
  parseCronExpression,
  parseEnabled,
  parseMaxRuns,
  parseSchedulerName,
  parseTimeZone,
  requireBoard,
} from "@/lib/server/validate";
import type { Scheduler, SchedulerDraft } from "@/lib/types";

type Body = Record<string, unknown>;

/** Longest default name (the prompt's first line). */
const NAME_MAX = 100;

/**
 * Validated scheduler from a create body `{ boardId, prompt, cron, timezone?, name?, enabled?,
 * maxRuns? }`: `name` defaults to the prompt's first line, `timezone` to UTC, `enabled` to true
 * and `maxRuns` to null (forever). Nothing is saved.
 */
export async function parseNewScheduler(repo: Repository, body: Body): Promise<SchedulerDraft> {
  if (typeof body.boardId !== "string" || !body.boardId) throw new HttpError(400, "boardId is required");
  const board = await requireBoard(repo, body.boardId);
  const prompt = parseBrief(body.prompt, "prompt");
  return {
    boardId: board.id,
    // The prompt is trimmed, so its first line is not empty.
    name: body.name === undefined ? prompt.split("\n")[0].trim().slice(0, NAME_MAX).trimEnd() : parseSchedulerName(body.name),
    prompt,
    cron: parseCronExpression(body.cron),
    timezone: body.timezone === undefined ? "UTC" : parseTimeZone(body.timezone),
    enabled: body.enabled === undefined ? true : parseEnabled(body.enabled),
    maxRuns: body.maxRuns === undefined ? null : parseMaxRuns(body.maxRuns),
  };
}

/** Validate and save a new scheduler (next fire time computed right away), announcing it. */
export async function createScheduler(repo: Repository, body: Body): Promise<Scheduler> {
  const draft = await parseNewScheduler(repo, body);
  const input: CreateSchedulerInput = {
    ...draft,
    nextRunAt: computeNextRunAt({ ...draft, runCount: 0 }),
  };
  const scheduler = await repo.createScheduler(input);
  publish({ type: "scheduler.updated", scheduler });
  return scheduler;
}

/**
 * Apply `Partial<{ boardId, name, prompt, cron, timezone, enabled, maxRuns }>` to `current`. The
 * next fire time is recomputed from now whenever the schedule changes (cron, timezone, enabled,
 * maxRuns). Enabling one whose run limit is reached is refused (400). An empty patch changes nothing.
 */
export async function updateScheduler(repo: Repository, current: Scheduler, body: Body): Promise<Scheduler> {
  const patch: UpdateSchedulerInput = {};
  if (body.boardId !== undefined) {
    if (typeof body.boardId !== "string" || !body.boardId) throw new HttpError(400, "boardId is required");
    patch.boardId = (await requireBoard(repo, body.boardId)).id;
  }
  if (body.name !== undefined) patch.name = parseSchedulerName(body.name);
  if (body.prompt !== undefined) patch.prompt = parseBrief(body.prompt, "prompt");
  if (body.cron !== undefined) patch.cron = parseCronExpression(body.cron);
  if (body.timezone !== undefined) patch.timezone = parseTimeZone(body.timezone);
  if (body.enabled !== undefined) patch.enabled = parseEnabled(body.enabled);
  if (body.maxRuns !== undefined) patch.maxRuns = parseMaxRuns(body.maxRuns);
  if (Object.keys(patch).length === 0) return current;

  const next = { ...current, ...patch };
  if (next.enabled && next.maxRuns !== null && next.runCount >= next.maxRuns) {
    throw new HttpError(400, "Run limit reached: raise or clear maxRuns to enable");
  }
  const scheduleChanged = (["cron", "timezone", "enabled", "maxRuns"] as const).some(
    (key) => patch[key] !== undefined && patch[key] !== current[key],
  );
  if (scheduleChanged) patch.nextRunAt = computeNextRunAt(next);
  const scheduler = await repo.updateScheduler(current.id, patch);
  if (!scheduler) throw new HttpError(404, "Scheduler not found");
  publish({ type: "scheduler.updated", scheduler });
  return scheduler;
}

/** A schedule in words for an agent to repeat back: description, zone and the next fire times there. */
export interface ScheduleSummary {
  /** "At 09:00, Monday through Friday". */
  schedule: string;
  timezone: string;
  /** Up to `count` upcoming runs as wall-clock times in `timezone` ("Mon, Nov 17, 2026, 09:00"); fewer near the run limit. */
  nextRuns: string[];
  /** "forever" or "N more runs". */
  repeats: string;
  enabled: boolean;
}

export function scheduleSummary(
  s: Pick<Scheduler, "cron" | "timezone" | "enabled" | "maxRuns"> & { runCount?: number },
  count = 3,
  now: Date = new Date(),
): ScheduleSummary {
  const remaining = s.maxRuns === null ? count : Math.max(0, s.maxRuns - (s.runCount ?? 0));
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: s.timezone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return {
    schedule: describeCron(s.cron),
    timezone: s.timezone,
    nextRuns: nextCronTimes(s.cron, now, s.timezone, Math.min(count, remaining)).map((date) => format.format(date)),
    repeats: s.maxRuns === null ? "forever" : `${remaining} more run${remaining === 1 ? "" : "s"}`,
    enabled: s.enabled,
  };
}

/** Throw (400) when `s` would never fire: its cron matches no future date. */
export function assertScheduleMatches(s: Pick<Scheduler, "cron" | "timezone">, now: Date = new Date()): void {
  if (nextCronTimes(s.cron, now, s.timezone, 1).length === 0) {
    throw new HttpError(400, `cron "${s.cron}" never matches a future date`);
  }
}

/** JSON Schema properties of a scheduler's fields, shared by the agent tools that propose, create or edit one. */
export const SCHEDULER_TOOL_PROPERTIES = {
  prompt: {
    type: "string",
    description:
      "Self-contained task brief for the coding agent each run starts (markdown): what to do, where, how to verify, what to deliver. Never mentions the schedule.",
  },
  cron: {
    type: "string",
    description:
      'Cron expression "minute hour day-of-month month day-of-week" (e.g. "0 9 * * 1-5" = weekdays at 09:00), or @hourly/@daily/@weekly/@monthly/@yearly.',
  },
  timezone: { type: "string", description: 'IANA time zone the cron runs in, e.g. "Europe/Berlin".' },
  name: { type: "string", description: "Short label for the schedulers list (at most 60 characters); default: the prompt's first line." },
  maxRuns: {
    type: ["integer", "null"],
    minimum: 1,
    description: "Stop after this many runs (1 = once); null = forever (the default).",
  },
  enabled: { type: "boolean", description: "Active (default true); false = paused, it never fires on its own." },
} as const;

/** A saved scheduler as agent tools report it: id, name, project, schedule in words, next runs, prompt preview. */
export function schedulerForAgent(s: Scheduler, boards: { id: string; name: string }[]): Record<string, unknown> {
  const prompt = s.prompt.length > 300 ? `${s.prompt.slice(0, 299)}…` : s.prompt;
  return {
    id: s.id,
    name: s.name,
    project: boards.find((board) => board.id === s.boardId)?.name ?? s.boardId,
    cron: s.cron,
    ...scheduleSummary(s),
    runCount: s.runCount,
    ...(s.maxRuns !== null ? { maxRuns: s.maxRuns } : {}),
    ...(s.lastStatus ? { lastRun: { at: s.lastRunAt, status: s.lastStatus, ...(s.lastError ? { error: s.lastError } : {}) } } : {}),
    prompt,
  };
}
