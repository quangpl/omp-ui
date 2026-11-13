import { schedulerLogs } from "@/lib/scheduler";
import { json, withApi } from "@/lib/server/http";
import { requireScheduler } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

type Params = { id: string };

/** Aggregated log of the latest runs (scheduler lines + their cards' agent run events), oldest first. */
export const GET = withApi<Params>(async ({ repo, params }) => {
  const scheduler = await requireScheduler(repo, params.id);
  return json(await schedulerLogs(repo, scheduler.id));
});
