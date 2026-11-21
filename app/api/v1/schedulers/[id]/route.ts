import { publish } from "@/lib/events";
import { json, readJson, withApi } from "@/lib/server/http";
import { updateScheduler } from "@/lib/server/scheduler-ops";
import { requireScheduler } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

type Params = { id: string };

export const GET = withApi<Params>(async ({ repo, params }) => json(await requireScheduler(repo, params.id)));

/**
 * Edit a scheduler: `Partial<{ boardId, name, prompt, cron, timezone, enabled, maxRuns, model }>`. Its
 * next fire time is recomputed from now whenever the schedule changes (cron, timezone, enabled,
 * maxRuns). Enabling one whose run limit is reached is refused (400).
 */
export const PATCH = withApi<Params>(async ({ req, repo, params }) => {
  const current = await requireScheduler(repo, params.id);
  return json(await updateScheduler(repo, current, await readJson(req)));
});

/** Delete a scheduler and its run history; the cards it created stay (their `schedulerId` → null). */
export const DELETE = withApi<Params>(async ({ repo, params }) => {
  const scheduler = await requireScheduler(repo, params.id);
  await repo.deleteScheduler(scheduler.id);
  publish({ type: "scheduler.deleted", schedulerId: scheduler.id, boardId: scheduler.boardId });
  return json({ ok: true });
});
