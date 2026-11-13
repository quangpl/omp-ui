import { clientIp } from "@/lib/auth";
import { HttpError, json, readJson, withApi } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log-store";
import { parseLogQuery, queryLogs, requireLogSource } from "@/lib/server/logs";

export const dynamic = "force-dynamic";

type Params = { source: string };

/** Longest page path recorded by POST. */
const PAGE_PATH_MAX = 512;

/**
 * One page of a source, newest first: `?limit=&offset=&level=warn,error&since=&until=&q=&file=`
 * (see `LogQuery`). Unknown source → 404, bad parameters → 400.
 */
export const GET = withApi<Params>(async ({ req, repo, params }) => {
  const source = requireLogSource(params.source);
  return json(await queryLogs(repo, source, parseLogQuery(new URL(req.url).searchParams)));
});

/** Record a page view `{ path }` in the access log (only the "access" source accepts POST). */
export const POST = withApi<Params>(async ({ req, params }) => {
  const source = requireLogSource(params.source);
  if (source !== "access") throw new HttpError(405, `Log source "${source}" is read-only`);
  const body = await readJson<{ path?: unknown }>(req);
  const raw = body.path;
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.length > PAGE_PATH_MAX) {
    throw new HttpError(400, `path must be a string starting with "/" (at most ${PAGE_PATH_MAX} characters)`);
  }
  // Query strings and fragments may carry tokens: keep the path only.
  const pagePath = raw.split(/[?#]/, 1)[0];
  void logEvent("access", {
    level: "info",
    category: "page",
    message: `Viewed ${pagePath}`,
    meta: { path: pagePath, ip: clientIp(req) },
  });
  return new Response(null, { status: 204 });
});
