import type { LogSourcesResponse } from "@/lib/log-types";
import { json, withApi } from "@/lib/server/http";
import { listLogSources } from "@/lib/server/logs";

export const dynamic = "force-dynamic";

/** Every log source in tab order, with its current and archived (`*.log.1`, ...) files. */
export const GET = withApi(async () => {
  const body: LogSourcesResponse = { sources: await listLogSources() };
  return json(body);
}, { admin: true });
