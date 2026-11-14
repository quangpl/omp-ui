import { getCleanupStatus, parseCleanupIds, runCleanup } from "@/lib/cleanup";
import { HttpError, json, readJson, withApi } from "@/lib/server/http";
import { getAppSettings } from "@/lib/settings";
import { SCHEDULED_CLEANUP_IDS, type ScheduledCleanupId } from "@/lib/types";

export const dynamic = "force-dynamic";

/** The scheduled cleanup: schedule, targets, last outcome and next run (CleanupStatus). */
export const GET = withApi(async ({ repo }) => json(await getCleanupStatus(repo)), { admin: true });

/** Clean up now: `{ ids? }` (default: the saved targets); answers the updated CleanupStatus. */
export const POST = withApi(async ({ req, repo, manager }) => {
  const body = await readJson(req);
  let ids: ScheduledCleanupId[] | null;
  if (body.ids === undefined) {
    ids = (await getAppSettings(repo)).cleanupTargets;
    if (ids.length === 0) throw new HttpError(400, "No cleanup targets are selected");
  } else {
    ids = parseCleanupIds(body.ids);
    if (!ids) throw new HttpError(400, `ids must be a non-empty array of: ${SCHEDULED_CLEANUP_IDS.join(", ")}`);
  }
  const status = await runCleanup(repo, manager, "manual", ids);
  if (!status) throw new HttpError(409, "A cleanup is already running");
  return json(status);
}, { admin: true });
