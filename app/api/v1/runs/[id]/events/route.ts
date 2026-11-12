import { error, json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

/** Run log page: events with seq > `after`, ascending, at most `limit`. */
export const GET = withApi<{ id: string }>(async ({ req, repo, params }) => {
  const run = await repo.getRun(params.id);
  if (!run) return error(404, "Run not found");
  const query = new URL(req.url).searchParams;
  const afterRaw = query.get("after");
  const limitRaw = query.get("limit");
  const after = afterRaw === null || afterRaw === "" ? 0 : Number(afterRaw);
  const limit = limitRaw === null || limitRaw === "" ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(after) || after < 0) {
    return error(400, "after must be a non-negative integer");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return error(400, `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return json(await repo.listRunEvents(run.id, after, limit));
});
