import { containerLogs, parseContainerRef, parseTail } from "@/lib/docker";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Last `?tail=` (default 300, max 5000) log lines, stdout and stderr merged in time order. */
export const GET = withApi<{ id: string }>(async ({ req, params }) => {
  const ref = parseContainerRef(params.id);
  const tail = parseTail(new URL(req.url).searchParams.get("tail"));
  return json({ logs: await containerLogs(ref, tail) });
});
