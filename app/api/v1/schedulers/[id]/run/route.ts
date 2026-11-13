import { fireScheduler } from "@/lib/scheduler";
import { json, withApi } from "@/lib/server/http";
import { requireScheduler } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

type Params = { id: string };

/**
 * Fire the scheduler now (works while it is disabled): creates its card like a scheduled run and
 * counts toward `maxRuns`. 201 with the history row (`status: "failed"` when the card could not
 * be created).
 */
export const POST = withApi<Params>(async ({ repo, manager, params }) => {
  const scheduler = await requireScheduler(repo, params.id);
  const now = new Date();
  return json(await fireScheduler(repo, manager, scheduler, "manual", now.toISOString(), now), { status: 201 });
});
