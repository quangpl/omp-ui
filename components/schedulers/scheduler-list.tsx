"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { CalendarClock, Plus, RotateCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { errorMessage, formatDateTime, formatRelative, useNow } from "@/components/board/format";
import { RunResultBadge, schedulerCardHref } from "@/components/schedulers/scheduler-history";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, subscribeEvents } from "@/lib/api-client";
import { describeCron } from "@/lib/cron";
import type { Scheduler } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Coalesce bursts of focus/reconnect refetches into one. */
const REFRESH_DELAY_MS = 250;

/** Newest first, like the API. */
function byNewest(a: Scheduler, b: Scheduler): number {
  return b.createdAt.localeCompare(a.createdAt);
}

/** Replace `scheduler` in `list` (or add it), keeping newest-first order. */
function upsert(list: Scheduler[], scheduler: Scheduler): Scheduler[] {
  const rest = list.filter((s) => s.id !== scheduler.id);
  return [...rest, scheduler].sort(byNewest);
}

/**
 * Every scheduler with its project names: fetched on mount, kept live from `scheduler.*` events,
 * refetched when the tab regains focus or the event stream reconnects. `setSchedulers` is for
 * optimistic edits.
 */
function useSchedulers() {
  const [schedulers, setSchedulers] = useState<Scheduler[] | null>(null);
  const [projects, setProjects] = useState<Map<string, string>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  /** Latest request; older responses are dropped (bumped by optimistic edits too). */
  const requestRef = useRef(0);
  /** Project ids known, to refetch the names when a scheduler moves to a new project. */
  const projectIdsRef = useRef<ReadonlySet<string>>(new Set());

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const [list, boards] = await Promise.all([api.schedulers.list(), api.boards.list()]);
      if (request !== requestRef.current) return;
      setSchedulers([...list].sort(byNewest));
      setProjects(new Map(boards.map((board) => [board.id, board.name])));
      projectIdsRef.current = new Set(boards.map((board) => board.id));
      setError(null);
    } catch (err) {
      if (request !== requestRef.current) return;
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), REFRESH_DELAY_MS);
    };
    const unsubscribe = subscribeEvents(
      (event) => {
        if (event.type === "scheduler.updated") {
          setSchedulers((prev) => (prev ? upsert(prev, event.scheduler) : prev));
          if (!projectIdsRef.current.has(event.scheduler.boardId)) schedule();
        } else if (event.type === "scheduler.deleted") {
          setSchedulers((prev) => (prev ? prev.filter((s) => s.id !== event.schedulerId) : prev));
        }
      },
      { onReconnect: schedule, onFirstOpen: schedule },
    );
    window.addEventListener("focus", schedule);
    return () => {
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", schedule);
    };
  }, [refresh]);

  return { schedulers, setSchedulers, projects, error, refresh, requestRef };
}

/**
 * The `/schedulers` list: each scheduler with its project, schedule, status, next run, last
 * result and run count, plus an Enabled switch. The whole row opens the scheduler.
 */
export function SchedulerList() {
  const { schedulers, setSchedulers, projects, error, refresh, requestRef } = useSchedulers();
  const now = useNow();
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [retrying, setRetrying] = useState(false);

  const setEnabled = async (scheduler: Scheduler, enabled: boolean) => {
    if (pending.has(scheduler.id)) return;
    setPending((prev) => new Set(prev).add(scheduler.id));
    requestRef.current += 1;
    setSchedulers((prev) => prev && prev.map((s) => (s.id === scheduler.id ? { ...s, enabled } : s)));
    try {
      const updated = await api.schedulers.update(scheduler.id, { enabled });
      requestRef.current += 1;
      setSchedulers((prev) => prev && upsert(prev, updated));
    } catch (err) {
      requestRef.current += 1;
      setSchedulers((prev) =>
        prev && prev.map((s) => (s.id === scheduler.id ? { ...s, enabled: scheduler.enabled } : s)),
      );
      toast.error(errorMessage(err));
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(scheduler.id);
        return next;
      });
    }
  };

  const retry = async () => {
    setRetrying(true);
    await refresh();
    setRetrying(false);
  };

  if (schedulers === null) {
    if (error) {
      return (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-10 text-center">
          <TriangleAlert className="mx-auto size-6 text-destructive" aria-hidden />
          <p className="mt-2 text-sm font-medium">Couldn&apos;t load schedulers</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" className="mt-4 h-11 md:h-9" onClick={() => void retry()} disabled={retrying}>
            <RotateCw className={cn(retrying && "animate-spin")} aria-hidden />
            Retry
          </Button>
        </div>
      );
    }
    return (
      <ul className="space-y-3" aria-busy="true" aria-label="Loading schedulers">
        {[0, 1, 2].map((i) => (
          <li key={i} className="rounded-xl border bg-card p-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:gap-6">
              <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-5 max-w-full" style={{ width: `${10 + ((i * 5) % 7)}rem` }} />
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-4 w-56 max-w-full" />
                </div>
                <Skeleton className="h-6 w-16 rounded-full lg:hidden" />
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-[minmax(7rem,auto)_minmax(0,1fr)_auto] lg:w-[28rem] lg:shrink-0">
                <Skeleton className="h-9" />
                <Skeleton className="h-9 w-14 justify-self-end sm:justify-self-auto" />
                <Skeleton className="col-span-2 h-9 sm:col-span-1 sm:col-start-2 sm:row-start-1" />
              </div>
              <Skeleton className="hidden h-6 w-16 rounded-full lg:block" />
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (schedulers.length === 0) {
    return (
      <div className="flex animate-fade-in-soft flex-col items-center rounded-xl border border-dashed px-4 py-12 text-center">
        <CalendarClock className="mx-auto size-7 text-muted-foreground" aria-hidden />
        <p className="mt-3 text-base font-medium">No schedulers yet</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          Create a card on a schedule: every run makes a regular card on the project that goes through the normal
          agent flow.
        </p>
        <Button asChild className="mt-5 h-11 md:h-9">
          <Link href="/schedulers/new">
            <Plus aria-hidden />
            New scheduler
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {schedulers.map((scheduler, index) => (
        <SchedulerRow
          key={scheduler.id}
          index={index}
          scheduler={scheduler}
          projectName={projects.get(scheduler.boardId) ?? null}
          now={now}
          pending={pending.has(scheduler.id)}
          onEnabledChange={(enabled) => void setEnabled(scheduler, enabled)}
        />
      ))}
    </ul>
  );
}

/** Enabled / Disabled / Limit reached. */
function StatusBadge({ scheduler }: { scheduler: Scheduler }) {
  if (scheduler.maxRuns !== null && scheduler.runCount >= scheduler.maxRuns) {
    return (
      <Badge variant="secondary" title={`Ran ${scheduler.runCount} of ${scheduler.maxRuns} times`}>
        Limit reached
      </Badge>
    );
  }
  return scheduler.enabled ? (
    <Badge className="bg-success/10 text-success">
      <span className="relative flex size-1.5" aria-hidden>
        <span className="absolute inset-0 animate-breathe rounded-full bg-success motion-reduce:animate-none" />
        <span className="relative size-1.5 rounded-full bg-success" />
      </span>
      Enabled
    </Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground">
      Disabled
    </Badge>
  );
}

/** The cron expression in words; the raw expression if it can't be described. */
function scheduleText(cron: string): string {
  try {
    return describeCron(cron);
  } catch {
    return cron;
  }
}

function SchedulerRow({
  index,
  scheduler,
  projectName,
  now,
  pending,
  onEnabledChange,
}: {
  index: number;
  scheduler: Scheduler;
  /** null when its project isn't known (yet). */
  projectName: string | null;
  now: number;
  pending: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const switchId = useId();
  const href = `/schedulers/${encodeURIComponent(scheduler.id)}`;
  const failed = scheduler.lastStatus === "failed";

  return (
    <li
      className="relative animate-card-in rounded-xl border bg-card transition-[background-color,scale] duration-200 ease-(--ease-fluid) hover:bg-muted/40 has-[a:active]:scale-[0.985] motion-reduce:transition-none"
      style={{ "--stagger": index } as React.CSSProperties}
    >
      <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:gap-6">
        <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <Link
                href={href}
                className="min-w-0 truncate font-medium outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
              >
                {scheduler.name}
              </Link>
              <StatusBadge scheduler={scheduler} />
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground">{projectName ?? "Unknown project"}</p>
            <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm">
              <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">
                {scheduleText(scheduler.cron)}{" "}
                <span className="text-muted-foreground">({scheduler.timezone})</span>
              </span>
            </p>
          </div>
          {/* Narrow: the switch sits next to the name; lg+ it moves to the row's end. */}
          <EnabledSwitch
            id={`${switchId}-sm`}
            className="lg:hidden"
            scheduler={scheduler}
            pending={pending}
            onEnabledChange={onEnabledChange}
          />
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-[minmax(7rem,auto)_minmax(0,1fr)_auto] lg:w-[28rem] lg:shrink-0">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Next run</dt>
            <dd className="mt-0.5 font-mono text-[0.8125rem] tabular-nums">
              {scheduler.nextRunAt ? (
                <span title={formatDateTime(scheduler.nextRunAt)}>{formatRelative(scheduler.nextRunAt, now)}</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </dd>
          </div>
          <div className="col-span-2 min-w-0 row-start-2 sm:col-span-1 sm:row-start-auto">
            <dt className="text-xs text-muted-foreground">Last result</dt>
            <dd className="mt-0.5">
              {scheduler.lastStatus ? (
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <RunResultBadge status={scheduler.lastStatus} />
                    {scheduler.lastRunAt && (
                      <span className="font-mono text-xs text-muted-foreground tabular-nums" title={formatDateTime(scheduler.lastRunAt)}>
                        {formatRelative(scheduler.lastRunAt, now)}
                      </span>
                    )}
                    {!failed && scheduler.lastTaskId && (
                      <Link
                        href={schedulerCardHref(scheduler.boardId, scheduler.lastTaskId)}
                        className="relative z-10 -my-2 inline-flex min-h-11 items-center text-xs font-medium underline underline-offset-4 hover:text-foreground md:min-h-0 md:py-2"
                      >
                        Open card
                      </Link>
                    )}
                  </div>
                  {failed && scheduler.lastError && (
                    <p className="line-clamp-2 text-xs break-words text-destructive" title={scheduler.lastError}>
                      {scheduler.lastError}
                    </p>
                  )}
                </div>
              ) : (
                <span className="text-muted-foreground">Never run</span>
              )}
            </dd>
          </div>
          <div className="min-w-0 row-start-1 col-start-2 sm:row-start-auto sm:col-start-auto">
            <dt className="text-xs text-muted-foreground">Runs</dt>
            <dd className="mt-0.5 font-mono text-[0.8125rem] tabular-nums">
              {scheduler.runCount.toLocaleString()}
              {scheduler.maxRuns !== null && (
                <span className="text-muted-foreground"> / {scheduler.maxRuns.toLocaleString()}</span>
              )}
            </dd>
          </div>
        </dl>

        <EnabledSwitch
          id={`${switchId}-md`}
          className="hidden lg:flex"
          scheduler={scheduler}
          pending={pending}
          onEnabledChange={onEnabledChange}
        />
      </div>
    </li>
  );
}

/** Enabled toggle above the row link, with a 44px touch target. */
function EnabledSwitch({
  id,
  className,
  scheduler,
  pending,
  onEnabledChange,
}: {
  id: string;
  className?: string;
  scheduler: Scheduler;
  pending: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "relative z-10 -my-2 flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-lg px-1 text-xs text-muted-foreground lg:min-w-[5.5rem] lg:justify-end",
        pending && "cursor-progress",
        className,
      )}
    >
      <span>{scheduler.enabled ? "On" : "Off"}</span>
      <Switch
        id={id}
        checked={scheduler.enabled}
        disabled={pending}
        aria-label={`Enable ${scheduler.name}`}
        onCheckedChange={onEnabledChange}
      />
    </label>
  );
}
