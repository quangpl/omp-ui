import { composeLogs, parseProjectName, parseTail } from "@/lib/docker";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Last `?tail=` log lines of every service, prefixed with the service name. */
export const GET = withApi<{ name: string }>(async ({ req, params }) => {
  const name = parseProjectName(params.name);
  return json({ logs: await composeLogs(name, parseTail(new URL(req.url).searchParams.get("tail"))) });
});
