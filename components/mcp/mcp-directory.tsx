"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ExternalLinkIcon, Loader2Icon, RefreshCwIcon, SearchIcon, SearchXIcon, StarIcon } from "lucide-react";
import { formatDateTime, formatRelative, useNow } from "@/components/board/format";
import { errorText } from "@/components/credentials/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api-client";
import { MCP_DIRECTORY_ORIGIN, type McpDirectoryEntry, type McpDirectoryResponse } from "@/lib/mcp-types";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 250;

/** The latest page answered plus every entry loaded so far for the current filter. */
interface Loaded {
  page: McpDirectoryResponse;
  entries: McpDirectoryEntry[];
}

function DirectoryRow({ entry, now }: { entry: McpDirectoryEntry; now: number }) {
  return (
    <li>
      <a
        href={entry.url}
        target="_blank"
        rel="noreferrer"
        className="flex min-h-14 items-center gap-3 px-3 py-2 outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 sm:px-4"
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium">{entry.name}</span>
            {entry.featured && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                <StarIcon className="size-3" aria-hidden="true" />
                Featured
              </span>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {entry.owner ? `by ${entry.owner}` : entry.path}
            {entry.updatedAt && (
              <>
                {" · "}
                <time dateTime={entry.updatedAt} title={formatDateTime(entry.updatedAt)}>
                  updated {formatRelative(entry.updatedAt, now)}
                </time>
              </>
            )}
          </p>
        </div>
        <ExternalLinkIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">(opens on mcpservers.org in a new tab)</span>
      </a>
    </li>
  );
}

/**
 * Every MCP server listed on mcpservers.org (read by the server from the site's sitemaps, cached
 * 12 h): search, a Featured filter, and pages of rows linking to each server's page there.
 */
export function McpDirectory() {
  const searchId = useId();
  const now = useNow();
  const [query, setQuery] = useState("");
  const [featured, setFeatured] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** Answers to superseded requests (an older search) are dropped. */
  const requestSeq = useRef(0);

  const load = useCallback(async (q: string, onlyFeatured: boolean, refresh = false) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const page = await api.mcp.directory({ q, featured: onlyFeatured, limit: PAGE_SIZE, refresh });
      if (seq !== requestSeq.current) return;
      setLoaded({ page, entries: page.entries });
      setError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(errorText(err, "Could not load the mcpservers.org list"));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  // First load and every filter change (search debounced).
  useEffect(() => {
    const timer = window.setTimeout(() => void load(query.trim(), featured), query ? SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [query, featured, load]);

  async function loadMore() {
    if (!loaded) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    try {
      const page = await api.mcp.directory({
        q: query.trim(),
        featured,
        offset: loaded.entries.length,
        limit: PAGE_SIZE,
      });
      if (seq !== requestSeq.current) return;
      setLoaded({ page, entries: [...loaded.entries, ...page.entries] });
    } catch (err) {
      setError(errorText(err, "Could not load more servers"));
    } finally {
      setLoadingMore(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    await load(query.trim(), featured, true);
    setRefreshing(false);
  }

  const page = loaded?.page ?? null;
  const entries = loaded?.entries ?? [];
  const chips = [
    { value: false, label: "All", count: page?.size },
    { value: true, label: "Featured", count: page?.featured },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative md:w-72 md:shrink-0">
          <label htmlFor={searchId} className="sr-only">
            Search mcpservers.org
          </label>
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name or publisher"
            className="pl-8"
          />
        </div>
        <div role="group" aria-label="Directory filter" className="flex min-w-0 items-center gap-1.5">
          {chips.map((chip) => (
            <button
              key={chip.label}
              type="button"
              aria-pressed={featured === chip.value}
              onClick={() => setFeatured(chip.value)}
              className={cn(
                "pressable inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium whitespace-nowrap text-muted-foreground ring-1 ring-inset ring-foreground/10 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 md:h-8",
                "aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:ring-0",
              )}
            >
              {chip.label}
              {chip.count !== undefined && <span className="tabular-nums opacity-60">{chip.count.toLocaleString()}</span>}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground md:ml-auto">
          {page && (
            <span>
              Updated{" "}
              <time dateTime={page.fetchedAt} title={formatDateTime(page.fetchedAt)}>
                {formatRelative(page.fetchedAt, now)}
              </time>
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="pressable-icon size-11 rounded-full text-muted-foreground hover:text-foreground md:size-8 md:rounded-lg"
                aria-label="Reload the list from mcpservers.org"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                {refreshing ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <RefreshCwIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reload from mcpservers.org</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {page?.refreshError && (
        <p role="status" className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          Could not refresh from mcpservers.org ({page.refreshError}); showing the list read{" "}
          {formatRelative(page.fetchedAt, now)}.
        </p>
      )}

      {error && (
        <p role="status" className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          {error}
          <Button
            variant="link"
            className="h-auto p-0 pl-2 text-amber-700 max-md:min-h-11 dark:text-amber-300"
            onClick={() => void load(query.trim(), featured)}
          >
            Retry
          </Button>
        </p>
      )}

      {!loaded && loading ? (
        <div className="space-y-2 rounded-2xl bg-card p-3 ring-1 ring-foreground/10" aria-label="Loading mcpservers.org">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : loaded && entries.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl bg-card px-4 py-10 text-center ring-1 ring-foreground/10">
          <SearchXIcon className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">
            No servers on mcpservers.org match {query ? `“${query}”` : "this filter"}.
          </p>
          <Button
            variant="outline"
            className="pressable h-11 md:h-8"
            onClick={() => {
              setQuery("");
              setFeatured(false);
            }}
          >
            Show all servers
          </Button>
        </div>
      ) : (
        loaded && (
          <div className={cn("space-y-3 transition-opacity", loading && "opacity-60")} aria-busy={loading}>
            <ul
              className="divide-y divide-foreground/10 overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10"
              aria-label="MCP servers on mcpservers.org"
            >
              {entries.map((entry) => (
                <DirectoryRow key={entry.path} entry={entry} now={now} />
              ))}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span aria-live="polite">
                Showing {entries.length.toLocaleString()} of {loaded.page.total.toLocaleString()}
                {query || featured ? " matching" : ""} servers from{" "}
                <a
                  href={MCP_DIRECTORY_ORIGIN}
                  target="_blank"
                  rel="noreferrer"
                  className="underline-offset-2 hover:text-foreground hover:underline"
                >
                  mcpservers.org
                </a>
              </span>
              {entries.length < loaded.page.total && (
                <Button
                  variant="outline"
                  className="pressable h-11 gap-1.5 md:h-8"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore && <Loader2Icon className="animate-spin motion-reduce:animate-none" />}
                  Load more
                </Button>
              )}
            </div>
          </div>
        )
      )}
    </div>
  );
}
