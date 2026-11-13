import type { UpdateSchedulerInput } from "@/lib/db/types";
import { publish } from "@/lib/events";
import { computeNextRunAt } from "@/lib/scheduler";
import { HttpError, error, json, readJson, withApi } from "@/lib/server/http";
import {
  parseBrief,
  parseCronExpression,
  parseEnabled,
  parseMaxRuns,
  parseSchedulerName,
  parseTimeZone,
  requireBoard,
  requireScheduler,
} from "@/lib/server/validate";

export const dynamic = "force-dynamic";

type Params = { id: string };

export const GET = withApi<Params>(async ({ repo, params }) => json(await requireScheduler(repo, params.id)));

/**
 * Edit a scheduler: `Partial<{ boardId, name, prompt, cron, timezone, enabled, maxRuns }>`. Its
 * next fire time is recomputed from now whenever the schedule changes (cron, timezone, enabled,
 * maxRuns). Enabling one whose run limit is reached is refused (400).
 */
export const PATCH = withApi<Params>(async ({ req, repo, params }) => {
  const current = await requireScheduler(repo, params.id);
  const body = await readJson(req);
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
  if (Object.keys(patch).length === 0) return json(current);

  const next = { ...current, ...patch };
  if (next.enabled && next.maxRuns !== null && next.runCount >= next.maxRuns) {
    throw new HttpError(400, "Run limit reached: raise or clear maxRuns to enable");
  }
  const scheduleChanged = (["cron", "timezone", "enabled", "maxRuns"] as const).some(
    (key) => patch[key] !== undefined && patch[key] !== current[key],
  );
  if (scheduleChanged) patch.nextRunAt = computeNextRunAt(next);
  const scheduler = await repo.updateScheduler(params.id, patch);
  if (!scheduler) return error(404, "Scheduler not found");
  publish({ type: "scheduler.updated", scheduler });
  return json(scheduler);
});

/** Delete a scheduler and its run history; the cards it created stay (their `schedulerId` → null). */
export const DELETE = withApi<Params>(async ({ repo, params }) => {
  const scheduler = await requireScheduler(repo, params.id);
  await repo.deleteScheduler(scheduler.id);
  publish({ type: "scheduler.deleted", schedulerId: scheduler.id, boardId: scheduler.boardId });
  return json({ ok: true });
});
