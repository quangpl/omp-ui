import { toRunViews } from "@/lib/scheduler";
import { json, withApi } from "@/lib/server/http";
import { requireScheduler } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

type Params = { id: string };

/** Run history (latest 200), newest first, each with a live snapshot of the card it created. */
export const GET = withApi<Params>(async ({ repo, params }) => {
  const scheduler = await requireScheduler(repo, params.id);
  return json(await toRunViews(repo, await repo.listSchedulerRuns(scheduler.id, 200)));
});
