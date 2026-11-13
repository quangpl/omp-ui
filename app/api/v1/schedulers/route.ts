import type { CreateSchedulerInput } from "@/lib/db/types";
import { publish } from "@/lib/events";
import { computeNextRunAt } from "@/lib/scheduler";
import { HttpError, json, readJson, withApi } from "@/lib/server/http";
import {
  parseBrief,
  parseCronExpression,
  parseEnabled,
  parseMaxRuns,
  parseSchedulerName,
  parseTimeZone,
  requireBoard,
} from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/** Longest default name (the prompt's first line). */
const NAME_MAX = 100;

/** All schedulers, newest first; `?boardId=` limits them to one project (404 if it doesn't exist). */
export const GET = withApi(async ({ req, repo }) => {
  const boardId = new URL(req.url).searchParams.get("boardId");
  if (boardId) await requireBoard(repo, boardId);
  return json(await repo.listSchedulers(boardId || undefined));
});

/**
 * Create a scheduler: `{ boardId, prompt, cron, timezone?, name?, enabled?, maxRuns? }`. `name`
 * defaults to the prompt's first line, `timezone` to UTC, `enabled` to true and `maxRuns` to null
 * (forever). Its next fire time is computed right away.
 */
export const POST = withApi(async ({ req, repo }) => {
  const body = await readJson(req);
  if (typeof body.boardId !== "string" || !body.boardId) throw new HttpError(400, "boardId is required");
  const board = await requireBoard(repo, body.boardId);
  const prompt = parseBrief(body.prompt, "prompt");
  const input: CreateSchedulerInput = {
    boardId: board.id,
    // The prompt is trimmed, so its first line is not empty.
    name:
      body.name === undefined ? prompt.split("\n")[0].trim().slice(0, NAME_MAX).trimEnd() : parseSchedulerName(body.name),
    prompt,
    cron: parseCronExpression(body.cron),
    timezone: body.timezone === undefined ? "UTC" : parseTimeZone(body.timezone),
    enabled: body.enabled === undefined ? true : parseEnabled(body.enabled),
    maxRuns: body.maxRuns === undefined ? null : parseMaxRuns(body.maxRuns),
  };
  input.nextRunAt = computeNextRunAt({
    cron: input.cron,
    timezone: input.timezone,
    enabled: input.enabled ?? true,
    maxRuns: input.maxRuns ?? null,
    runCount: 0,
  });
  const scheduler = await repo.createScheduler(input);
  publish({ type: "scheduler.updated", scheduler });
  return json(scheduler, { status: 201 });
});
