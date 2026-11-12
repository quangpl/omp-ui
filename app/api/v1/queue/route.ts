import { HttpError, json, readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Running and queued agents across all boards (queued in start order). */
export const GET = withApi(async ({ manager }) => json(await manager.queueSnapshot()));

/** Reorder the queue: `{ taskId, position }`, position 0 starts next. */
export const POST = withApi(async ({ req, manager }) => {
  const body = await readJson(req);
  if (typeof body.taskId !== "string" || !body.taskId) throw new HttpError(400, "taskId is required");
  if (typeof body.position !== "number" || !Number.isFinite(body.position) || body.position < 0) {
    throw new HttpError(400, "position must be a number ≥ 0");
  }
  if (!manager.moveInQueue(body.taskId, body.position)) {
    throw new HttpError(409, "That card is not waiting in the queue.");
  }
  return json(await manager.queueSnapshot());
});
