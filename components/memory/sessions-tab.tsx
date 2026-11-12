"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDownIcon, ArrowLeftIcon, ExternalLinkIcon, HistoryIcon, KanbanIcon, SearchXIcon, XIcon } from "lucide-react";
import { errorMessage, formatDateTime, formatRelative, useNow } from "@/components/board/format";
import { FilterSelect, type FilterOption, SearchField, useDebounced } from "@/components/memory/controls";
import { cardHref, isMemoryUnavailable, MEMORY_PANEL, typeLabel } from "@/components/memory/format";
import { MemoryDetailPanel } from "@/components/memory/memory-detail";
import { useIsWide, useMemoryHotkeys } from "@/components/memory/use-memory-hotkeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import type { MemoryItem, MemorySession, MemorySessionDetail } from "@/lib/memory-types";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 30;
const OBSERVATION_PAGE = 50;
const STATUS_OPTIONS: FilterOption[] = [
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "abandoned", label: "Abandoned" },
];

const STATUS_TONE: Record<string, string> = {
  active: "bg-success",
  completed: "bg-foreground/30",
  abandoned: "bg-destructive/70",
};

function sessionTitle(session: MemorySession): string {
  return session.card?.title ?? session.title ?? session.firstPrompt ?? session.id;
}

function StatusMark({ status }: { status: string }) {
  return (
    <span className="relative flex size-2 shrink-0" title={status}>
      <span className={cn("relative size-2 rounded-full", STATUS_TONE[status] ?? "bg-foreground/30")} />
    </span>
  );
}

function SessionRow({
  session,
  index,
  selected,
  open,
  now,
  onClick,
}: {
  session: MemorySession;
  index: number;
  selected: boolean;
  open: boolean;
  now: number;
  onClick: () => void;
}) {
  return (
    <li className="animate-card-in" style={{ "--stagger": index % PAGE_SIZE } as React.CSSProperties}>
      <button
        type="button"
        data-memory-row={index}
        aria-current={open ? "true" : undefined}
        onClick={onClick}
        className={cn(
          "relative flex w-full items-start gap-3 px-4 py-3 text-left transition-colors outline-none",
          "hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset",
          selected && "bg-muted/60",
          open && "bg-muted",
          "before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-primary before:opacity-0 before:transition-opacity",
          (selected || open) && "before:opacity-100",
        )}
      >
        <span className="mt-1.5">
          <StatusMark status={session.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{sessionTitle(session)}</span>
            {session.card && (
              <Badge variant="outline" className="shrink-0 gap-1 font-normal text-muted-foreground">
                <KanbanIcon />
                Card
              </Badge>
            )}
          </span>
          <span className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 text-xs text-muted-foreground tabular-nums">
            {session.project && <span className="truncate">{session.project}</span>}
            <span>
              {session.observationCount} {session.observationCount === 1 ? "observation" : "observations"}
            </span>
            {session.startedAt && (
              <time dateTime={session.startedAt} title={formatDateTime(session.startedAt)}>
                {formatRelative(session.startedAt, now)}
              </time>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

function Meta({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 truncate text-sm tabular-nums", mono && "font-mono text-xs")}>{children}</dd>
    </div>
  );
}

/** One session: card link, summary, and its observations newest first (the session timeline). */
function SessionDetailPanel({
  session,
  onClose,
  onUnavailable,
  onChanged,
}: {
  session: MemorySession;
  onClose: () => void;
  onUnavailable: () => void;
  onChanged: () => void;
}) {
  const now = useNow();
  const [detail, setDetail] = useState<MemorySessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [observation, setObservation] = useState<MemoryItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    api.memory
      .session(session.id, { limit: OBSERVATION_PAGE })
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isMemoryUnavailable(err)) onUnavailable();
        setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [session.id, onUnavailable]);

  const loadMore = async () => {
    if (!detail?.nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api.memory.session(session.id, { cursor: detail.nextCursor, limit: OBSERVATION_PAGE });
      setDetail((prev) =>
        prev ? { ...prev, observations: [...prev.observations, ...page.observations], nextCursor: page.nextCursor } : prev,
      );
    } catch (err) {
      if (isMemoryUnavailable(err)) onUnavailable();
      setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  if (observation) {
    return (
      <div>
        <div className="border-b px-3 py-2">
          <Button variant="ghost" size="sm" className="h-11 md:h-7" onClick={() => setObservation(null)}>
            <ArrowLeftIcon />
            Back to session
          </Button>
        </div>
        <MemoryDetailPanel
          key={observation.id}
          item={observation}
          onClose={() => setObservation(null)}
          onOpen={setObservation}
          onForgotten={(item) => {
            setDetail((prev) =>
              prev
                ? {
                    ...prev,
                    observations: prev.observations.filter((o) => o.id !== item.id),
                    total: Math.max(0, prev.total - 1),
                  }
                : prev,
            );
            setObservation(null);
            onChanged();
          }}
          onUnavailable={onUnavailable}
          showClose={false}
        />
      </div>
    );
  }

  const shown = detail?.session ?? session;
  return (
    <article aria-label="Session detail" className="flex flex-col">
      <header className="flex items-start gap-2 border-b px-5 pt-4 pb-4">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <StatusMark status={shown.status} />
            <span className="capitalize">{shown.status}</span>
            {shown.model && <span className="truncate">· {shown.model}</span>}
          </div>
          <h2 className="text-lg leading-snug font-semibold tracking-tight text-pretty">{sessionTitle(shown)}</h2>
          {shown.card && (
            <Button asChild variant="outline" size="sm" className="h-11 md:h-7">
              <Link href={cardHref(shown.card)}>
                <KanbanIcon />
                Open card
                <ExternalLinkIcon data-icon="inline-end" />
              </Link>
            </Button>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="-mr-2 size-11 shrink-0 text-muted-foreground md:size-8"
          aria-label="Close session"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </header>

      <div className="space-y-6 px-5 py-5">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Meta label="Project">{shown.project ?? "None"}</Meta>
          <Meta label="Observations">{shown.observationCount}</Meta>
          {shown.startedAt && (
            <Meta label="Started">
              <time dateTime={shown.startedAt} title={formatDateTime(shown.startedAt)}>
                {formatRelative(shown.startedAt, now)}
              </time>
            </Meta>
          )}
          {shown.endedAt && (
            <Meta label="Ended">
              <time dateTime={shown.endedAt} title={formatDateTime(shown.endedAt)}>
                {formatRelative(shown.endedAt, now)}
              </time>
            </Meta>
          )}
          {shown.cwd && (
            <div className="col-span-2 min-w-0">
              <Meta label="Folder" mono>
                <span title={shown.cwd}>{shown.cwd}</span>
              </Meta>
            </div>
          )}
        </dl>

        {shown.narrative && (
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">Summary</h3>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{shown.narrative}</p>
          </section>
        )}
        {!shown.narrative && shown.firstPrompt && shown.firstPrompt !== sessionTitle(shown) && (
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">First prompt</h3>
            <p className="line-clamp-6 text-sm leading-relaxed whitespace-pre-wrap">{shown.firstPrompt}</p>
          </section>
        )}

        {detail && detail.keyDecisions.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">Key decisions</h3>
            <ul className="space-y-1.5 text-sm">
              {detail.keyDecisions.map((decision, i) => (
                <li key={i} className="border-l-2 border-border pl-3 leading-relaxed">
                  {decision}
                </li>
              ))}
            </ul>
          </section>
        )}
        {detail && detail.filesModified.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">Files modified</h3>
            <ul className="space-y-1 font-mono text-xs text-muted-foreground">
              {detail.filesModified.map((file) => (
                <li key={file} className="truncate" title={file}>
                  {file}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="space-y-2">
          <h3 className="flex items-baseline justify-between text-xs font-medium text-muted-foreground">
            <span>Timeline</span>
            {detail && <span className="tabular-nums">{detail.total.toLocaleString()} captured</span>}
          </h3>
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : !detail ? (
            <div className="space-y-3" aria-busy="true">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="space-y-1.5 border-l-2 border-border pl-3">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              ))}
            </div>
          ) : detail.observations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing captured yet. Observations appear as the agent reads, edits and runs commands.
            </p>
          ) : (
            <ol className="space-y-0.5">
              {detail.observations.map((obs) => (
                <li key={obs.id}>
                  <button
                    type="button"
                    onClick={() => setObservation(obs)}
                    className="group flex min-h-11 w-full flex-col gap-0.5 border-l-2 border-border py-1.5 pr-2 pl-3 text-left transition-colors hover:border-primary hover:bg-muted/50 md:min-h-0"
                  >
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="w-20 shrink-0 truncate text-[11px] text-muted-foreground">{typeLabel(obs.type)}</span>
                      <span className="min-w-0 flex-1 truncate text-sm">{obs.title}</span>
                      {obs.createdAt && (
                        <time
                          dateTime={obs.createdAt}
                          title={formatDateTime(obs.createdAt)}
                          className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
                        >
                          {new Date(obs.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </time>
                      )}
                    </span>
                    {obs.summary && obs.summary !== obs.title && (
                      <span className="line-clamp-1 pl-22 text-xs text-muted-foreground">{obs.summary}</span>
                    )}
                  </button>
                </li>
              ))}
            </ol>
          )}
          {detail?.nextCursor && (
            <Button
              variant="ghost"
              className="h-11 w-full text-muted-foreground md:h-8"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              <ArrowDownIcon />
              {loadingMore ? "Loading…" : "Older observations"}
            </Button>
          )}
        </section>
        <p className="font-mono text-[11px] break-all text-muted-foreground/70">{shown.id}</p>
      </div>
    </article>
  );
}

/**
 * Sessions tab: agentmemory's recorded agent sessions (newest first) with their AgentMan cards, and
 * a session's timeline of captured observations.
 */
export function SessionsTab({
  active,
  projects,
  onUnavailable,
  onChanged,
}: {
  active: boolean;
  projects: FilterOption[];
  onUnavailable: () => void;
  onChanged: () => void;
}) {
  const now = useNow();
  const wide = useIsWide();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const [query, setQuery] = useState("");
  const [project, setProject] = useState("all");
  const [status, setStatus] = useState("all");
  const debouncedQuery = useDebounced(query.trim(), 250);

  const [sessions, setSessions] = useState<MemorySession[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState(-1);
  const [openSession, setOpenSession] = useState<MemorySession | null>(null);

  const filters = useMemo(
    () => ({
      project: project === "all" ? null : project,
      status: status === "all" ? null : status,
      q: debouncedQuery || undefined,
    }),
    [project, status, debouncedQuery],
  );
  const filtered = filters.project !== null || filters.status !== null || Boolean(filters.q);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.memory
      .sessions({ ...filters, limit: PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        setSessions(page.items);
        setNextCursor(page.nextCursor);
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
  }, [filters, reloadKey, onUnavailable]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api.memory.sessions({ ...filters, cursor: nextCursor, limit: PAGE_SIZE });
      setSessions((prev) => [...(prev ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (isMemoryUnavailable(err)) onUnavailable();
      setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const items = sessions ?? [];
  const select = useCallback(
    (index: number) => {
      setSelected(index);
      listRef.current?.querySelector<HTMLElement>(`[data-memory-row="${index}"]`)?.scrollIntoView({ block: "nearest" });
      if (wide && openSession && items[index]) setOpenSession(items[index]);
    },
    [items, openSession, wide],
  );
  const open = useCallback(
    (index: number) => {
      const session = items[index];
      if (!session) return;
      setSelected(index);
      setOpenSession(session);
    },
    [items],
  );
  const close = useCallback(() => setOpenSession(null), []);

  useMemoryHotkeys({
    enabled: active,
    count: items.length,
    selected,
    onSelect: select,
    onOpen: open,
    onClose: close,
    searchRef,
  });

  const detail = openSession ? (
    <SessionDetailPanel
      key={openSession.id}
      session={openSession}
      onClose={close}
      onUnavailable={onUnavailable}
      onChanged={onChanged}
    />
  ) : null;

  return (
    <div className="@container space-y-4">
      <div className="grid gap-2 @4xl:grid-cols-[minmax(0,1fr)_auto]">
        <SearchField
          inputRef={searchRef}
          value={query}
          onChange={setQuery}
          placeholder="Filter sessions by prompt, folder or id"
          busy={loading && query.trim().length > 0}
        />
        <div className="grid grid-cols-2 gap-2 @xl:flex">
          <FilterSelect label="Project" value={project} onChange={setProject} options={projects} allLabel="All projects" />
          <FilterSelect label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} allLabel="Any status" />
        </div>
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,27rem)]">
        <section aria-label="Sessions" className={cn(MEMORY_PANEL, "overflow-hidden")}>
          {error && !sessions ? (
            <div className="space-y-3 p-6">
              <p className="text-sm text-destructive">{error}</p>
              <Button variant="outline" className="h-11 md:h-8" onClick={() => setReloadKey((k) => k + 1)}>
                Try again
              </Button>
            </div>
          ) : loading && !sessions ? (
            <ul className="divide-y" aria-busy="true" aria-label="Loading sessions">
              {Array.from({ length: 7 }, (_, i) => (
                <li key={i} className="flex gap-3 px-4 py-3.5">
                  <Skeleton className="mt-1 size-2 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5" style={{ width: `${50 + ((i * 13) % 40)}%` }} />
                    <Skeleton className="h-3 w-2/5" />
                  </div>
                </li>
              ))}
            </ul>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-start gap-4 px-6 py-12 sm:px-10">
              <span className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-5">
                {filtered ? <SearchXIcon /> : <HistoryIcon />}
              </span>
              <div className="max-w-md space-y-1.5">
                <p className="text-base font-medium">{filtered ? "No sessions match" : "No sessions recorded yet"}</p>
                <p className="text-sm leading-relaxed text-pretty text-muted-foreground">
                  {filtered
                    ? "Try another project or status, or clear the filter text."
                    : "Every omp session with the agentmemory extension appears here, card runs included. Run a card to record one."}
                </p>
              </div>
            </div>
          ) : (
            <>
              <ul ref={listRef} className={cn("divide-y transition-opacity", loading && "opacity-60")} aria-busy={loading}>
                {items.map((session, index) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    index={index}
                    selected={index === selected}
                    open={openSession?.id === session.id}
                    now={now}
                    onClick={() => open(index)}
                  />
                ))}
              </ul>
              {nextCursor && (
                <div className="border-t p-3">
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
              {error && <p className="border-t px-4 py-3 text-sm text-destructive">{error}</p>}
            </>
          )}
        </section>

        <aside
          aria-label="Session detail"
          className={cn(
            MEMORY_PANEL,
            "sticky top-20 hidden max-h-[calc(100dvh-6.5rem)] overflow-y-auto scrollbar-subtle xl:block",
          )}
        >
          {wide &&
            (detail ?? (
              <p className="p-6 text-sm text-muted-foreground">
                Select a session to see its timeline. Card sessions link back to their card.
              </p>
            ))}
        </aside>
      </div>

      <Sheet open={!wide && openSession !== null} onOpenChange={(next) => !next && close()}>
        <SheetContent side="right" showCloseButton={false} className="w-full gap-0 overflow-y-auto p-0 sm:max-w-lg">
          <SheetTitle className="sr-only">{openSession ? sessionTitle(openSession) : "Session"}</SheetTitle>
          <SheetDescription className="sr-only">Session timeline</SheetDescription>
          {!wide && detail}
        </SheetContent>
      </Sheet>
    </div>
  );
}
