import { json, withApi } from "@/lib/server/http";
import { requireTask } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/** Abort the running/queued agent; the card stays in its column. */
export const POST = withApi<{ id: string }>(async ({ repo, manager, params }) => {
  const task = await requireTask(repo, params.id);
  const stopped = await manager.stop(task.id);
  return json((await repo.getTask(task.id)) ?? stopped ?? task);
});
