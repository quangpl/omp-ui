"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsUpIcon,
  HourglassIcon,
  ListOrderedIcon,
  LoaderCircleIcon,
  SquareIcon,
} from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/components/board/format";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { publishQueue } from "@/hooks/use-board";
import { useIsMobile } from "@/hooks/use-mobile";
import { api, subscribeEvents } from "@/lib/api-client";
import type { QueueEntry, QueueSnapshot } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Coalesce bursts of task/queue events into one refetch. */
const REFRESH_DELAY_MS = 250;

/** The global agent queue: fetched on mount, refreshed live on queue/task changes. */
function useQueueSnapshot() {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  /** Latest request; older responses are dropped. */
  const requestRef = useRef(0);

  const apply = useCallback((next: QueueSnapshot) => {
    requestRef.current += 1;
    setSnapshot(next);
    publishQueue(next);
  }, []);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const next = await api.queue.get();
      if (request !== requestRef.current) return;
      setSnapshot(next);
      publishQueue(next);
    } catch {
      // The queue button is secondary UI; keep the last snapshot until the next event.
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
        if (event.type === "queue.updated") {
          publishQueue({ running: event.running, queued: event.queued, drafting: event.drafting });
          schedule();
        } else if (event.type === "task.updated" || event.type === "task.deleted") {
          schedule();
        }
      },
      { onReconnect: schedule },
    );
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh]);

  return { snapshot, refresh, apply };
}

function QueueRow({
  entry,
  index,
  last,
  busy,
  onMove,
  onStop,
  onNavigate,
}: {
  entry: QueueEntry;
  /** Position in the queued list; -1 for running entries. */
  index: number;
  last: boolean;
  busy: boolean;
  onMove: (position: number) => void;
  onStop: () => void;
  onNavigate: () => void;
}) {
  const queued = entry.state === "queued";
  /** Held until the planner has ordered this card's project. */
  const planning = queued && entry.planning;
  const waiting = entry.waitingFor.length;
  const iconButton = "pressable-icon size-11 shrink-0 text-muted-foreground md:size-8";

  return (
    <li className="flex min-h-14 items-center gap-2 py-1.5 md:min-h-0">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-medium tabular-nums",
          queued ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary",
        )}
        aria-hidden
      >
        {queued ? index + 1 : <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" />}
      </span>
      <Link
        href={`/b/${encodeURIComponent(entry.boardId)}?task=${encodeURIComponent(entry.taskId)}`}
        onClick={onNavigate}
        className="pressable min-w-0 flex-1 rounded-md py-1 outline-none [-webkit-tap-highlight-color:transparent] focus-visible:ring-3 focus-visible:ring-ring/50 md:py-0"
      >
        <span className="block truncate text-sm font-medium" title={entry.title}>
          {entry.title}
        </span>
        {entry.planNote && (
          <span className="block truncate text-xs text-muted-foreground/80" title={entry.planNote}>
            {entry.planNote}
          </span>
        )}
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">{entry.boardName}</span>
          {queued && entry.drafting && <span className="shrink-0 italic">Writing the card…</span>}
          {planning && <span className="shrink-0 italic">Planning…</span>}
          {waiting > 0 && (
            <span className="inline-flex shrink-0 items-center gap-1 text-primary">
              <HourglassIcon className="size-3" aria-hidden />
              Waiting for {waiting} card{waiting === 1 ? "" : "s"}
            </span>
          )}
        </span>
      </Link>
      {queued && (
        <>
          {index > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={iconButton}
                  disabled={busy}
                  onClick={() => onMove(0)}
                  aria-label={`Run “${entry.title}” next`}
                >
                  <ChevronsUpIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Run next</TooltipContent>
            </Tooltip>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={iconButton}
            disabled={busy || index === 0}
            onClick={() => onMove(index - 1)}
            aria-label={`Move “${entry.title}” up`}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={iconButton}
            disabled={busy || last}
            onClick={() => onMove(index + 1)}
            aria-label={`Move “${entry.title}” down`}
          >
            <ArrowDownIcon />
          </Button>
        </>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(iconButton, "hover:text-destructive")}
            disabled={busy}
            onClick={onStop}
            aria-label={`Stop “${entry.title}”`}
          >
            <SquareIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{queued ? "Remove from queue" : "Stop"}</TooltipContent>
      </Tooltip>
    </li>
  );
}

/** Running and queued agents across every project, with reordering and stop controls. */
export function QueuePanel({
  snapshot,
  onChanged,
  onRefresh,
  onNavigate,
}: {
  snapshot: QueueSnapshot | null;
  /** A move returned the new queue. */
  onChanged: (snapshot: QueueSnapshot) => void;
  onRefresh: () => Promise<void>;
  /** A card link was followed (close the popover / drawer). */
  onNavigate: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const move = async (taskId: string, position: number) => {
    setBusyId(taskId);
    try {
      onChanged(await api.queue.move(taskId, position));
    } catch (err) {
      toast.error("Couldn't reorder the queue", { description: errorMessage(err) });
    } finally {
      setBusyId(null);
    }
  };

  const stop = async (taskId: string) => {
    setBusyId(taskId);
    try {
      await api.tasks.stop(taskId);
      await onRefresh();
    } catch (err) {
      toast.error("Couldn't stop the agent", { description: errorMessage(err) });
    } finally {
      setBusyId(null);
    }
  };

  if (!snapshot) {
    return (
      <div className="flex flex-col gap-3" role="status" aria-label="Loading queue">
        <Skeleton className="h-3 w-32" />
        <ul className="divide-y">
          {Array.from({ length: 3 }, (_, i) => (
            <li key={i} className="flex min-h-14 items-center gap-2 py-1.5 md:min-h-0">
              <Skeleton className="size-6 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-1">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const sections: { title: string; entries: QueueEntry[] }[] = [
    { title: "Running", entries: snapshot.running },
    { title: "Queued", entries: snapshot.queued },
  ];

  /** Projects whose queued cards the planner is ordering right now. */
  const planningProjects = snapshot.planning.map((p) => p.boardName).join(", ");

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {snapshot.limit} at a time · change it in Settings
      </p>
      {snapshot.concurrency?.boundBy === "load" && (
        <p className="text-xs text-pretty text-amber-700 dark:text-amber-400" role="status">
          {snapshot.concurrency.reason}
        </p>
      )}
      {snapshot.planning.length > 0 && (
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
          <span className="truncate" title={planningProjects}>
            Planning run order for {planningProjects}…
          </span>
        </p>
      )}
      {snapshot.running.length === 0 && snapshot.queued.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <ListOrderedIcon className="size-5" aria-hidden />
          </span>
          <p className="text-sm text-muted-foreground">No agents running or queued.</p>
        </div>
      ) : (
        sections.map(
          ({ title, entries }) =>
            entries.length > 0 && (
              <section key={title} className="min-w-0">
                <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {title} · <span className="font-mono tabular-nums">{entries.length}</span>
                </h3>
                <ul className="divide-y">
                  {entries.map((entry, i) => (
                    <QueueRow
                      key={entry.taskId}
                      entry={entry}
                      index={entry.state === "queued" ? i : -1}
                      last={i === entries.length - 1}
                      busy={busyId === entry.taskId}
                      onMove={(position) => void move(entry.taskId, position)}
                      onStop={() => void stop(entry.taskId)}
                      onNavigate={onNavigate}
                    />
                  ))}
                </ul>
              </section>
            ),
        )
      )}
    </div>
  );
}

/** Header button with a running + queued count; opens the queue (popover on desktop, drawer on phones). */
export function QueueButton() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const { snapshot, refresh, apply } = useQueueSnapshot();
  const count = snapshot ? snapshot.running.length + snapshot.queued.length : 0;

  const trigger = (
    <Button
      variant="ghost"
      size="icon"
      className="pressable-icon relative size-11 rounded-full md:size-9"
      aria-label={count > 0 ? `Agent queue, ${count} active` : "Agent queue"}
      onClick={isMobile ? () => setOpen(true) : undefined}
    >
      <ListOrderedIcon className="size-5 md:size-4" />
      {count > 0 && (
        <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-mono text-[10px] leading-none font-semibold text-primary-foreground tabular-nums md:top-0 md:right-0">
          {count}
        </span>
      )}
    </Button>
  );

  const panel = (
    <QueuePanel
      snapshot={snapshot}
      onChanged={apply}
      onRefresh={refresh}
      onNavigate={() => setOpen(false)}
    />
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent className="data-[vaul-drawer-direction=bottom]:max-h-[85dvh]">
            <DrawerHeader className="text-left">
              <DrawerTitle className="text-lg font-semibold tracking-tight">Agent queue</DrawerTitle>
              <DrawerDescription>Running and queued agents across all projects.</DrawerDescription>
            </DrawerHeader>
            <div className="overflow-y-auto overscroll-contain px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              {panel}
            </div>
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="scrollbar-subtle max-h-[70dvh] w-96 overflow-y-auto">
        <div className="text-sm font-semibold tracking-tight">Agent queue</div>
        {panel}
      </PopoverContent>
    </Popover>
  );
}
