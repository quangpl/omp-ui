import { LOG_EXPORT_FORMATS, type LogExportFormat } from "@/lib/log-types";
import { HttpError, withApi } from "@/lib/server/http";
import {
  formatLogEntryText,
  MAX_EXPORT_ENTRIES,
  parseLogQuery,
  readLogWindow,
  requireLogSource,
} from "@/lib/server/logs";

export const dynamic = "force-dynamic";

type Params = { source: string };

const CONTENT_TYPES: Record<LogExportFormat, string> = {
  json: "application/json; charset=utf-8",
  ndjson: "application/x-ndjson; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

/** `yyyymmdd-hhmmss` (UTC) for download names. */
function fileStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

/**
 * Download every matching entry of a source, newest first (at most MAX_EXPORT_ENTRIES):
 * `?format=json|ndjson|txt` plus the GET filters (`limit`/`offset` are ignored).
 */
export const GET = withApi<Params>(async ({ req, repo, params }) => {
  const source = requireLogSource(params.source);
  const search = new URL(req.url).searchParams;
  const format = (search.get("format")?.trim() || "json") as LogExportFormat;
  if (!LOG_EXPORT_FORMATS.includes(format)) {
    throw new HttpError(400, `format must be one of ${LOG_EXPORT_FORMATS.join(", ")}`);
  }
  search.delete("limit");
  search.delete("offset");
  const { filter } = parseLogQuery(search);
  const { entries } = await readLogWindow(repo, source, filter, 0, MAX_EXPORT_ENTRIES);
  const body =
    format === "json"
      ? JSON.stringify(entries, null, 2)
      : entries.map((e) => (format === "ndjson" ? JSON.stringify(e) : formatLogEntryText(e))).join("\n") +
        (entries.length ? "\n" : "");
  return new Response(body, {
    headers: {
      "content-type": CONTENT_TYPES[format],
      "content-disposition": `attachment; filename="omp-ui-${source}-${fileStamp(new Date())}.${format}"`,
      "cache-control": "no-store",
    },
  });
}, { admin: true });
