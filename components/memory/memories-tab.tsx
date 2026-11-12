"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon, BrainIcon, CornerDownLeftIcon, LightbulbIcon, SearchXIcon } from "lucide-react";
import { errorMessage, formatDateTime, formatRelative, useNow } from "@/components/board/format";
import { FilterSelect, type FilterOption, SearchField, useDebounced } from "@/components/memory/controls";
import { isMemoryUnavailable, LAYER_LABELS, MEMORY_PANEL, RANGE_OPTIONS, typeLabel } from "@/components/memory/format";
import { MemoryDetailPanel } from "@/components/memory/memory-detail";
import { useIsWide, useMemoryHotkeys } from "@/components/memory/use-memory-hotkeys";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import type { MemoryItem, MemoryLesson } from "@/lib/memory-types";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 40;
const SEARCH_DEBOUNCE_MS = 250;
const LAYER_OPTIONS: FilterOption[] = [
  { value: "all", label: "Memories + observations" },
  { value: "memory", label: "Memories only" },
  { value: "observation", label: "Observations only" },
];

type Layer = "all" | "memory" | "observation";

interface Results {
  items: MemoryItem[];
  lessons: MemoryLesson[];
  total: number | null;
  nextCursor: string | null;
  /** The query these results answer ("" for the plain list). */
  query: string;
}

// ---------------------------------------------------------------------------------------------
// Rows

function ImportanceBar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs text-muted-foreground/60">n/a</span>;
  const level = Math.max(0, Math.min(10, value));
  return (
    <span className="flex items-center gap-1.5" title={`Importance ${level} / 10`}>
      <span className="flex h-3 items-end gap-px" aria-hidden="true">
        {[2, 4, 6, 8, 10].map((step) => (
          <span
            key={step}
            className={cn("w-1 rounded-[1px]", level >= step - 1 ? "bg-foreground/70" : "bg-foreground/15")}
            style={{ height: `${step * 10}%` }}
          />
        ))}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">{level}</span>
    </span>
  );
}

function MemoryRow({
  item,
  index,
  selected,
  open,
  now,
  showScore,
  onClick,
}: {
  item: MemoryItem;
  index: number;
  selected: boolean;
  open: boolean;
  now: number;
  showScore: boolean;
  onClick: () => void;
}) {
  const when = item.updatedAt ?? item.createdAt;
  return (
    <li className="animate-card-in" style={{ "--stagger": index % PAGE_SIZE } as React.CSSProperties}>
      <button
        type="button"
        data-memory-row={index}
        aria-current={open ? "true" : undefined}
        onClick={onClick}
        className={cn(
          "relative grid w-full grid-cols-[minmax(0,1fr)] gap-x-5 gap-y-1 px-4 py-3 text-left transition-colors outline-none",
          "@3xl:grid-cols-[6.5rem_minmax(0,1fr)_9rem_4rem_6rem] @3xl:items-center",
          "hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset",
          selected && "bg-muted/60",
          open && "bg-muted",
          "before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-primary before:opacity-0 before:transition-opacity",
          (selected || open) && "before:opacity-100",
        )}
      >
        <span className="hidden min-w-0 @3xl:block">
          <span className="block truncate text-xs font-medium">{typeLabel(item.type)}</span>
          {item.layer !== "memory" && (
            <span className="block truncate text-[11px] text-muted-foreground">{LAYER_LABELS[item.layer]}</span>
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{item.title}</span>
          {item.summary && item.summary !== item.title && (
            <span className="mt-0.5 line-clamp-2 text-sm text-muted-foreground @3xl:line-clamp-1">{item.summary}</span>
          )}
        </span>
        <span className="hidden truncate text-sm text-muted-foreground @3xl:block" title={item.project ?? undefined}>
          {item.project ?? <span className="text-muted-foreground/60">None</span>}
        </span>
        <span className="hidden @3xl:block">
          {showScore && item.score !== null ? (
            <span className="text-xs text-muted-foreground tabular-nums" title="Search relevance">
              {item.score.toFixed(2)}
            </span>
          ) : (
            <ImportanceBar value={item.importance} />
          )}
        </span>
        <span className="hidden text-right text-xs text-muted-foreground tabular-nums @3xl:block">
          {when ? (
            <time dateTime={when} title={formatDateTime(when)}>
              {formatRelative(when, now)}
            </time>
          ) : null}
        </span>
        {/* Phone / narrow meta line */}
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground @3xl:hidden">
          <span className="font-medium text-foreground/80">{typeLabel(item.type)}</span>
          {item.project && <span className="truncate">{item.project}</span>}
          {when && <time dateTime={when}>{formatRelative(when, now)}</time>}
        </span>
      </button>
    </li>
  );
}

function ListSkeleton() {
  return (
    <ul className="divide-y" aria-busy="true" aria-label="Loading memories">
      {Array.from({ length: 8 }, (_, i) => (
        <li key={i} className="grid gap-2 px-4 py-3.5 @3xl:grid-cols-[6.5rem_minmax(0,1fr)_9rem_4rem_6rem] @3xl:gap-5">
          <Skeleton className="hidden h-3.5 w-16 @3xl:block" />
          <div className="space-y-2">
            <Skeleton className="h-3.5" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
            <Skeleton className="h-3 w-4/5" />
          </div>
          <Skeleton className="hidden h-3.5 w-20 @3xl:block" />
          <Skeleton className="hidden h-3 w-10 @3xl:block" />
          <Skeleton className="hidden h-3 w-14 justify-self-end @3xl:block" />
        </li>
      ))}
    </ul>
  );
}

function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-4 px-6 py-12 sm:px-10">
      <span className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-5">
        {icon}
      </span>
      <div className="max-w-md space-y-1.5">
        <p className="text-base font-medium">{title}</p>
        <div className="text-sm leading-relaxed text-pretty text-muted-foreground">{children}</div>
      </div>
      {action}
    </div>
  );
}

/** Placeholder of the wide layout's detail column. */
function DetailPlaceholder() {
  return (
    <div className="flex flex-col gap-4 p-6 text-sm text-muted-foreground">
      <p className="text-foreground">Pick a memory to read it in full.</p>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs">
        <dt className="flex gap-1">
          <Kbd>J</Kbd>
          <Kbd>K</Kbd>
        </dt>
        <dd>Move through the list</dd>
        <dt>
          <Kbd>
            <CornerDownLeftIcon />
          </Kbd>
        </dt>
        <dd>Open the selected memory</dd>
        <dt>
          <Kbd>Esc</Kbd>
        </dt>
        <dd>Close the detail</dd>
        <dt>
          <Kbd>F</Kbd>
        </dt>
        <dd>Search</dd>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Tab

/**
 * Memories tab: the long-term memory list (newest first, filterable, paged), or hybrid search
 * results across memories and observations while the search box has text. Detail opens in a side
 * column at `xl`, in a sheet below it.
 */
export function MemoriesTab({
  active,
  projects,
  types,
  onUnavailable,
  onChanged,
  emptyHint,
}: {
  active: boolean;
  projects: FilterOption[];
  types: FilterOption[];
  onUnavailable: () => void;
  /** A memory was forgotten (refresh counts). */
  onChanged: () => void;
  /** Shown when the store has no memories at all. */
  emptyHint: React.ReactNode;
}) {
  const now = useNow();
  const wide = useIsWide();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  const [project, setProject] = useState("all");
  const [type, setType] = useState("all");
  const [range, setRange] = useState("all");
  const [layer, setLayer] = useState<Layer>("all");
  const debouncedQuery = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);

  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState(-1);
  const [openItem, setOpenItem] = useState<MemoryItem | null>(null);

  const filters = useMemo(
    () => ({
      project: project === "all" ? null : project,
      type: type === "all" ? null : type,
      range: range === "all" ? null : range,
    }),
    [project, type, range],
  );
  const filtered = filters.project !== null || filters.type !== null || filters.range !== null;
  const searching = debouncedQuery.length > 0;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const request = debouncedQuery
      ? api.memory
          .search(debouncedQuery, { ...filters, layer, limit: 40 })
          .then((r) => ({ items: r.items, lessons: r.lessons, total: r.items.length, nextCursor: null }))
      : api.memory.list({ ...filters, limit: PAGE_SIZE }).then((r) => ({ ...r, lessons: [] }));
    request
      .then((next) => {
        if (cancelled) return;
        setResults({ ...next, query: debouncedQuery });
        setSelected(-1);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isMemoryUnavailable(err)) onUnavailable();
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, filters, layer, reloadKey, onUnavailable]);

  const items = results?.items ?? [];
  const nextCursor = results?.nextCursor ?? null;

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || searching) return;
    setLoadingMore(true);
    try {
      const page = await api.memory.list({ ...filters, cursor: nextCursor, limit: PAGE_SIZE });
      setResults((prev) => {
        if (!prev) return prev;
        const seen = new Set(prev.items.map((i) => i.id));
        return {
          ...prev,
          items: [...prev.items, ...page.items.filter((i) => !seen.has(i.id))],
          nextCursor: page.nextCursor,
        };
      });
    } catch (err) {
      if (isMemoryUnavailable(err)) onUnavailable();
      setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }, [filters, loadingMore, nextCursor, onUnavailable, searching]);

  // Infinite scroll: load the next page when the end of the list comes into view.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !nextCursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, nextCursor]);

  const select = useCallback(
    (index: number) => {
      setSelected(index);
      listRef.current
        ?.querySelector<HTMLElement>(`[data-memory-row="${index}"]`)
        ?.scrollIntoView({ block: "nearest" });
      // The wide layout's detail follows the selection once it is open.
      if (wide && openItem && items[index]) setOpenItem(items[index]);
    },
    [items, openItem, wide],
  );
  const open = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return;
      setSelected(index);
      setOpenItem(item);
    },
    [items],
  );
  const close = useCallback(() => setOpenItem(null), []);

  useMemoryHotkeys({
    enabled: active,
    count: items.length,
    selected,
    onSelect: select,
    onOpen: open,
    onClose: close,
    searchRef,
  });

  const onForgotten = useCallback(
    (item: MemoryItem) => {
      setResults((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.filter((i) => i.id !== item.id),
              total: prev.total === null ? null : Math.max(0, prev.total - 1),
            }
          : prev,
      );
      setOpenItem(null);
      onChanged();
    },
    [onChanged],
  );
  const openRelated = useCallback((item: MemoryItem) => {
    setOpenItem(item);
    setSelected(-1);
  }, []);

  const clearFilters = () => {
    setProject("all");
    setType("all");
    setRange("all");
    setLayer("all");
  };

  const typeOptions = useMemo(() => {
    if (type === "all" || types.some((t) => t.value === type)) return types;
    return [...types, { value: type, label: typeLabel(type) }];
  }, [type, types]);

  const detail = openItem ? (
    <MemoryDetailPanel
      key={`${openItem.layer}:${openItem.id}`}
      item={openItem}
      onClose={close}
      onOpen={openRelated}
      onForgotten={onForgotten}
      onUnavailable={onUnavailable}
      showClose
    />
  ) : null;

  const summary = loading
    ? searching
      ? "Searching…"
      : "Loading…"
    : searching
      ? `${items.length} ${items.length === 1 ? "result" : "results"} for “${results?.query ?? debouncedQuery}”`
      : results?.total !== null && results?.total !== undefined
        ? `${results.total.toLocaleString()}${filtered ? " matching" : ""} ${results.total === 1 ? "memory" : "memories"}`
        : `${items.length}${nextCursor ? "+" : ""} ${items.length === 1 ? "memory" : "memories"} in range`;

  return (
    <div className="@container space-y-4">
      <div className="grid gap-2 @4xl:grid-cols-[minmax(0,1fr)_auto]">
        <SearchField
          inputRef={searchRef}
          value={query}
          onChange={setQuery}
          placeholder="Search memories and observations"
          busy={loading && query.trim().length > 0}
        />
        <div className="grid grid-cols-2 gap-2 @xl:flex @xl:flex-wrap">
          <FilterSelect label="Project" value={project} onChange={setProject} options={projects} allLabel="All projects" />
          <FilterSelect label="Kind" value={type} onChange={setType} options={typeOptions} allLabel="All kinds" />
          <FilterSelect label="Time range" value={range} onChange={setRange} options={RANGE_OPTIONS} />
          {searching && (
            <FilterSelect
              label="Search in"
              value={layer}
              onChange={(value) => setLayer(value as Layer)}
              options={LAYER_OPTIONS}
            />
          )}
        </div>
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,27rem)]">
        <section aria-label="Memories" className={cn(MEMORY_PANEL, "overflow-hidden")}>
          <div className="flex min-h-11 items-center justify-between gap-3 border-b px-4 py-2">
            <p className="truncate text-xs text-muted-foreground tabular-nums" aria-live="polite">
              {summary}
            </p>
            {(filtered || layer !== "all") && (
              <Button variant="ghost" size="sm" className="h-9 shrink-0 md:h-7" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </div>
          <div className="hidden grid-cols-[6.5rem_minmax(0,1fr)_9rem_4rem_6rem] gap-x-5 border-b px-4 py-2 text-[11px] font-medium text-muted-foreground @3xl:grid">
            <span>Kind</span>
            <span>Memory</span>
            <span>Project</span>
            <span>{searching ? "Score" : "Weight"}</span>
            <span className="text-right">{searching ? "Captured" : "Updated"}</span>
          </div>

          {error && !results ? (
            <div className="space-y-3 p-6">
              <p className="text-sm text-destructive">{error}</p>
              <Button variant="outline" className="h-11 md:h-8" onClick={() => setReloadKey((k) => k + 1)}>
                Try again
              </Button>
            </div>
          ) : loading && !results ? (
            <ListSkeleton />
          ) : items.length === 0 ? (
            searching ? (
              <EmptyState icon={<SearchXIcon />} title={`Nothing matches “${debouncedQuery}”`}>
                Try fewer or different words. Keyword search matches exact terms; semantic matches need an embedding
                provider (see Stats).
              </EmptyState>
            ) : filtered ? (
              <EmptyState
                icon={<SearchXIcon />}
                title="No memories match these filters"
                action={
                  <Button variant="outline" className="h-11 md:h-8" onClick={clearFilters}>
                    Clear filters
                  </Button>
                }
              >
                Widen the time range or pick another project.
              </EmptyState>
            ) : (
              <EmptyState icon={<BrainIcon />} title="No long-term memories yet">
                {emptyHint}
              </EmptyState>
            )
          ) : (
            <>
              <ul
                ref={listRef}
                className={cn("divide-y transition-opacity", loading && "opacity-60")}
                aria-busy={loading}
              >
                {items.map((item, index) => (
                  <MemoryRow
                    key={`${item.layer}:${item.id}`}
                    item={item}
                    index={index}
                    selected={index === selected}
                    open={openItem?.id === item.id}
                    now={now}
                    showScore={searching}
                    onClick={() => open(index)}
                  />
                ))}
              </ul>
              {nextCursor && !searching && (
                <div ref={sentinelRef} className="border-t p-3">
                  <Button
                    variant="ghost"
                    className="h-11 w-full text-muted-foreground md:h-9"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                  >
                    <ArrowDownIcon />
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
                </div>
              )}
              {error && results && <p className="border-t px-4 py-3 text-sm text-destructive">{error}</p>}
            </>
          )}

          {searching && (results?.lessons.length ?? 0) > 0 && (
            <div className="border-t bg-muted/30 px-4 py-4">
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <LightbulbIcon className="size-3.5" />
                Lessons
              </h3>
              <ul className="space-y-2">
                {results?.lessons.map((lesson) => (
                  <li key={lesson.id} className="text-sm leading-relaxed">
                    {lesson.content}
                    {lesson.confidence !== null && (
                      <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                        {Math.round(lesson.confidence * 100)}% confidence
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <aside
          aria-label="Memory detail"
          className={cn(
            MEMORY_PANEL,
            "sticky top-20 hidden max-h-[calc(100dvh-6.5rem)] overflow-y-auto scrollbar-subtle xl:block",
          )}
        >
          {wide && (detail ?? <DetailPlaceholder />)}
        </aside>
      </div>

      <Sheet open={!wide && openItem !== null} onOpenChange={(next) => !next && close()}>
        <SheetContent side="right" showCloseButton={false} className="w-full gap-0 overflow-y-auto p-0 sm:max-w-lg">
          <SheetTitle className="sr-only">{openItem?.title ?? "Memory"}</SheetTitle>
          <SheetDescription className="sr-only">Memory content and metadata</SheetDescription>
          {!wide && detail}
        </SheetContent>
      </Sheet>
    </div>
  );
}
