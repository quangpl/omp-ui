import { json, withApi } from "@/lib/server/http";
import { requireTask } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async ({ repo, params }) => {
  const task = await requireTask(repo, params.id);
  return json(await repo.listRuns(task.id));
});
