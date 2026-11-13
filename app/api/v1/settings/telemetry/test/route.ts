import { exportTestSpan } from "@/lib/server/telemetry";
import { HttpError, json, readJson, withApi } from "@/lib/server/http";
import { getAppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Send one test span: `{ endpoint? }` (default: the saved `telemetryEndpoint`, so the UI can test
 * an unsaved value). Answers `{ ok, status, error }` with the collector's HTTP status; a failed
 * export is still a 200 — the result describes the collector, not this request.
 */
export const POST = withApi(async ({ req, repo }) => {
  const body = await readJson(req);
  const given = body.endpoint;
  if (given !== undefined && typeof given !== "string") throw new HttpError(400, "endpoint must be a string");
  const endpoint = (given ?? (await getAppSettings(repo)).telemetryEndpoint).trim();
  if (!endpoint) throw new HttpError(400, "No telemetry endpoint is set");
  return json(await exportTestSpan(endpoint));
});
