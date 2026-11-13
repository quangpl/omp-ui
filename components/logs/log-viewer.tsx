"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2Icon, RotateCcwIcon, ScrollTextIcon, TriangleAlertIcon } from "lucide-react";
import { errorMessage } from "@/components/board/format";
import { LogEntryRow } from "@/components/logs/log-entry-row";
import { filtersToQuery, hasActiveFilters, LogToolbar, type LogFilters } from "@/components/logs/log-toolbar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import type { LogEntry, LogExportFormat, LogFileInfo, LogQuery, LogSource } from "@/lib/log-types";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 100;
/** Server cap on `limit`; a refresh reloads up to this many so "Load more" pages stay on screen. */
const MAX_LIMIT = 500;
const SEARCH_DEBOUNCE_MS = 300;

interface LoadedLogs {
  entries: LogEntry[];
  total: number;
  nextOffset: number | null;
  files: LogFileInfo[];
  /** Query of the first page, reused by "Load more" so a relative time range does not shift. */
  query: LogQuery;
}

/** Why a reload runs: a filter change dims the stale list; refreshes keep the loaded page count. */
type ReloadKind = "filter" | "refresh" | "auto";

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Download via a plain link: the session cookie authenticates it; the server sends an attachment. */
function download(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * One log source: toolbar, newest-first entry list with "Load more" pagination, and loading,
 * empty and error states. Filters live in the page (one set per tab) so they survive tab switches.
 */
export function LogViewer({
  source,
  files: initialFiles,
  filters,
  onFiltersChange,
}: {
  source: LogSource;
  /** Files from `GET /logs`, used until the first page brings fresher ones. */
  files: LogFileInfo[];
  filters: LogFilters;
  onFiltersChange: (patch: Partial<LogFilters>) => void;
}) {
  const [q, setQ] = useState(() => filters.search.trim());
  const [data, setData] = useState<LoadedLogs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<ReloadKind | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  // Every reload bumps the generation; responses of older generations (and "Load more" pages
  // started before a reload) are dropped.
  const generationRef = useRef(0);
  const loadedCountRef = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    const next = filters.search.trim();
    if (next === q) return;
    const timer = window.setTimeout(() => setQ(next), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [filters.search, q]);

  const { levels, range, file, refreshMs } = filters;
  const reload = useCallback(
    async (kind: ReloadKind) => {
      const generation = ++generationRef.current;
      busyRef.current = true;
      setLoading(kind);
      const query = filtersToQuery({ levels, range, file }, q);
      const limit =
        kind === "filter" ? PAGE_SIZE : Math.min(MAX_LIMIT, Math.max(PAGE_SIZE, loadedCountRef.current));
      try {
        const page = await api.logs.list(source, { ...query, limit, offset: 0 });
        if (generation !== generationRef.current) return;
        loadedCountRef.current = page.entries.length;
        const { entries, total, nextOffset, files } = page;
        setData({ entries, total, nextOffset, files, query });
        setError(null);
        setUpdatedAt(Date.now());
      } catch (err) {
        if (generation === generationRef.current) setError(errorMessage(err));
      } finally {
        if (generation === generationRef.current) {
          busyRef.current = false;
          setLoading(null);
        }
      }
    },
    [source, q, levels, range, file],
  );

  useEffect(() => {
    void reload("filter");
  }, [reload]);

  // Auto-refresh: skipped while the browser tab is hidden or a request is in flight, and caught up
  // as soon as the tab is visible again.
  useEffect(() => {
    if (!refreshMs) return;
    const tick = () => {
      if (!document.hidden && !busyRef.current) void reload("auto");
    };
    const timer = window.setInterval(tick, refreshMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refreshMs, reload]);

  const loadMore = useCallback(async () => {
    if (!data || data.nextOffset === null) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    try {
      const page = await api.logs.list(source, { ...data.query, limit: PAGE_SIZE, offset: data.nextOffset });
      if (generation !== generationRef.current) return;
      setData((current) => {
        if (!current) return current;
        // New lines written since the first page shift offsets; drop the repeats.
        const seen = new Set(current.entries.map((entry) => entry.id));
        const entries = current.entries.concat(page.entries.filter((entry) => !seen.has(entry.id)));
        loadedCountRef.current = entries.length;
        return { ...current, entries, total: page.total, nextOffset: page.nextOffset, files: page.files };
      });
      setError(null);
    } catch (err) {
      if (generation === generationRef.current) setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }, [data, source]);

  const files = data?.files ?? initialFiles;
  const archived = useMemo(() => new Set(files.filter((f) => f.archived).map((f) => f.name)), [files]);
  const filtered = hasActiveFilters(filters);

  function exportAs(format: LogExportFormat) {
    download(api.logs.exportUrl(source, filtersToQuery(filters, filters.search.trim()), format));
  }

  return (
    <div className="flex flex-col gap-3">
      <LogToolbar
        filters={filters}
        onChange={onFiltersChange}
        files={files}
        loading={loading !== null}
        onRefresh={() => void reload("refresh")}
        onExport={exportAs}
      />

      {error && data && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <TriangleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{error}</span>
          <Button variant="ghost" size="xs" className="h-9 md:h-6" onClick={() => void reload("refresh")}>
            Retry
          </Button>
        </div>
      )}

      {data === null ? (
        error ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-10 text-center"
          >
            <TriangleAlertIcon className="size-6 text-destructive" aria-hidden="true" />
            <div>
              <p className="font-medium">Could not load logs</p>
              <p className="mt-1 text-sm text-muted-foreground">{error}</p>
            </div>
            <Button variant="outline" className="h-11 md:h-9" onClick={() => void reload("filter")}>
              {loading ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <RotateCcwIcon />}
              Retry
            </Button>
          </div>
        ) : (
          <div className="space-y-px overflow-hidden rounded-xl border" aria-busy="true" aria-label="Loading logs">
            {["w-3/4", "w-1/2", "w-5/6", "w-2/3", "w-3/5", "w-4/5", "w-1/2", "w-2/3"].map((width, i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border/60 px-3 py-3 last:border-b-0">
                <Skeleton className="h-3 w-28 shrink-0" />
                <Skeleton className="h-4 w-12 shrink-0" />
                <Skeleton className={cn("h-3", width)} />
              </div>
            ))}
          </div>
        )
      ) : data.entries.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-12 text-center">
          <ScrollTextIcon className="size-6 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="font-medium">No log entries</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {filtered
                ? "Nothing matches the current filters. Try a wider time range or fewer filters."
                : "Nothing has been logged here yet."}
            </p>
          </div>
          {filtered && (
            <Button
              variant="outline"
              className="h-11 md:h-9"
              onClick={() => onFiltersChange({ search: "", levels: [], range: "all", file: "all" })}
            >
              Clear filters
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span aria-live="polite" className="tabular-nums">
              Showing {data.entries.length.toLocaleString()} of {data.total.toLocaleString()}
              {filtered ? " matching" : ""} {data.total === 1 ? "entry" : "entries"}
            </span>
            {updatedAt && (
              <span className="tabular-nums">
                Updated <span className="font-mono">{formatClock(updatedAt)}</span>
              </span>
            )}
          </div>
          <div
            aria-busy={loading !== null}
            className={cn(
              "max-h-[min(72dvh,60rem)] overflow-y-auto overscroll-contain rounded-xl border scrollbar-subtle transition-opacity duration-200 motion-reduce:transition-none",
              loading === "filter" && "opacity-60",
            )}
          >
            <ul aria-label="Log entries">
              {data.entries.map((entry) => (
                <LogEntryRow
                  key={entry.id}
                  entry={entry}
                  archived={entry.file !== null && archived.has(entry.file)}
                />
              ))}
            </ul>
            {data.nextOffset !== null && (
              <div className="flex justify-center border-t border-border/60 p-3">
                <Button
                  variant="outline"
                  className="h-11 md:h-9"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore && <Loader2Icon className="animate-spin motion-reduce:animate-none" />}
                  Load more
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
