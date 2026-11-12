import { json, withApi } from "@/lib/server/http";
import { requireTask } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/** Start (or queue) the agent; the card moves to In progress. */
export const POST = withApi<{ id: string }>(async ({ repo, manager, params }) => {
  const task = await requireTask(repo, params.id);
  const started = await manager.start(task.id);
  return json((await repo.getTask(task.id)) ?? started);
});
