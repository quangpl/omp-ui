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
  const iconButton = "size-11 shrink-0 text-muted-foreground md:size-8";

  return (
    <li className="flex items-center gap-2 py-1.5">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium tabular-nums",
          queued ? "bg-muted text-muted-foreground" : "bg-sky-500/10 text-sky-700 dark:text-sky-300",
        )}
        aria-hidden
      >
        {queued ? index + 1 : <LoaderCircleIcon className="size-3.5 animate-spin" />}
      </span>
      <Link
        href={`/b/${encodeURIComponent(entry.boardId)}?task=${encodeURIComponent(entry.taskId)}`}
        onClick={onNavigate}
        className="min-w-0 flex-1 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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
            <span className="inline-flex shrink-0 items-center gap-1 text-violet-700 dark:text-violet-300">
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
    return <p className="py-6 text-center text-sm text-muted-foreground">Loading queue…</p>;
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
      {snapshot.planning.length > 0 && (
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" aria-hidden />
          <span className="truncate" title={planningProjects}>
            Planning run order for {planningProjects}…
          </span>
        </p>
      )}
      {snapshot.running.length === 0 && snapshot.queued.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No agents running or queued.</p>
      ) : (
        sections.map(
          ({ title, entries }) =>
            entries.length > 0 && (
              <section key={title} className="min-w-0">
                <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {title} · {entries.length}
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
      className="relative size-11 rounded-full md:size-9"
      aria-label={count > 0 ? `Agent queue, ${count} active` : "Agent queue"}
      onClick={isMobile ? () => setOpen(true) : undefined}
    >
      <ListOrderedIcon className="size-5 md:size-4" />
      {count > 0 && (
        <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-semibold text-primary-foreground tabular-nums md:top-0 md:right-0">
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
              <DrawerTitle className="text-lg">Agent queue</DrawerTitle>
              <DrawerDescription>Agents running and waiting to start, across all projects.</DrawerDescription>
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
      <PopoverContent align="end" className="max-h-[70dvh] w-96 overflow-y-auto">
        <div className="text-sm font-medium">Agent queue</div>
        {panel}
      </PopoverContent>
    </Popover>
  );
}
