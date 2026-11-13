"use client";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { CircleCheckBig, CircleDashed, EllipsisVertical, Inbox, type LucideIcon, PanelRightOpen, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, TASK_STATUSES, type Task, type TaskStatus } from "@/lib/types";
import type { TasksByStatus } from "@/hooks/use-board";
import { cardLayoutKey, useCardFlip } from "@/hooks/use-card-flip";
import { EMPTY_COLUMN_TEXT } from "@/components/board/board-column";
import type { BoardMenuActions } from "@/components/board/card-context-menu";
import { quickActionsFor, runQuickAction, type QuickActionId } from "@/components/board/quick-actions";
import { TaskCard } from "@/components/board/task-card";

/** Quiet period after the last scroll event before a swipe counts as landed on a column. */
const SCROLL_SETTLE_MS = 90;

const EMPTY_ICON: Record<TaskStatus, LucideIcon> = {
  todo: Inbox,
  in_progress: CircleDashed,
  done: CircleCheckBig,
};

const tabId = (status: TaskStatus) => `mobile-column-tab-${status}`;
const panelId = (status: TaskStatus) => `mobile-column-${status}`;

/** Card footer: the primary quick action one tap away; open card + the rest in the overflow menu. */
function QuickActions({
  task,
  onOpen,
  actions,
}: {
  task: Task;
  onOpen: () => void;
  actions: BoardMenuActions;
}) {
  const [busy, setBusy] = useState(false);
  const [primary, ...rest] = quickActionsFor(task, { canPush: actions.pushToMain !== null });

  const run = async (id: QuickActionId) => {
    setBusy(true);
    try {
      await runQuickAction(id, task.id, actions);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        className={cn(
          "h-11 flex-1 justify-start gap-2 rounded-none rounded-bl-lg px-3.5 text-[13px] font-medium active:bg-muted",
          primary.id === "stop" && "text-destructive hover:bg-destructive/10 hover:text-destructive",
        )}
        aria-label={primary.label}
        title={primary.hint}
        disabled={busy}
        onClick={() => void run(primary.id)}
      >
        <primary.icon className={cn(primary.filled && "fill-current")} />
        {primary.label}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-12 rounded-none rounded-br-lg border-l text-muted-foreground active:bg-muted"
            aria-label={`More actions for ${task.title}`}
          >
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem className="min-h-11" onSelect={onOpen}>
            <PanelRightOpen />
            Open card
          </DropdownMenuItem>
          {rest.length > 0 && <DropdownMenuSeparator />}
          {rest.map((action) => (
            <DropdownMenuItem
              key={action.id}
              className="min-h-11"
              disabled={busy}
              onSelect={() => void run(action.id)}
            >
              <action.icon className={cn(action.filled && "fill-current")} />
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/**
 * Phone layout: a sticky segmented column switcher over a horizontally snapping track with one
 * full-width column per page (swipe or tap a segment), and a floating button for new cards.
 */
export function MobileBoard({
  columns,
  activity,
  active,
  onActiveChange,
  onOpen,
  actions,
  onAdd,
}: {
  columns: TasksByStatus;
  activity: Record<string, string>;
  active: TaskStatus;
  onActiveChange: (status: TaskStatus) => void;
  onOpen: (taskId: string) => void;
  actions: BoardMenuActions;
  onAdd: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);
  const settleTimer = useRef<number | undefined>(undefined);
  const placedRef = useRef(false);
  const activeIndex = TASK_STATUSES.indexOf(active);
  const activeRef = useRef(active);
  activeRef.current = active;
  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;
  // Cards glide when they change column or order: siblings on the visible page slide, a card
  // leaving it flies off toward its new page, and one that arrived on another page glides in once
  // that page is shown.
  const flip = useCardFlip(cardLayoutKey(columns), { disabled: false });

  // Bring the track to the active column when it changes from outside the track (segment tap,
  // a new card landing in another column, a deep-linked card). Swipes already sit there. The
  // segment highlight then follows the track's scroll events, so it glides along with it.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior: ScrollBehavior = placedRef.current && !reduceMotion ? "smooth" : "instant";
    placedRef.current = true;
    const left = activeIndex * track.clientWidth;
    if (Math.abs(track.scrollLeft - left) < 2) {
      tablistRef.current?.style.setProperty("--column-progress", String(activeIndex));
      return;
    }
    track.scrollTo({ left, behavior });
  }, [activeIndex]);

  useEffect(() => () => window.clearTimeout(settleTimer.current), []);

  const onTrackScroll = () => {
    const track = trackRef.current;
    if (!track) return;
    const width = Math.max(track.clientWidth, 1);
    // The segment highlight follows the finger; no React render per frame.
    tablistRef.current?.style.setProperty("--column-progress", String(track.scrollLeft / width));
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      const landed = TASK_STATUSES[Math.round(track.scrollLeft / width)];
      if (landed && landed !== activeRef.current) onActiveChangeRef.current(landed);
    }, SCROLL_SETTLE_MS);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = TASK_STATUSES.length - 1;
    const target =
      event.key === "ArrowRight"
        ? Math.min(activeIndex + 1, last)
        : event.key === "ArrowLeft"
          ? Math.max(activeIndex - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : -1;
    if (target < 0) return;
    event.preventDefault();
    const next = TASK_STATUSES[target];
    onActiveChange(next);
    document.getElementById(tabId(next))?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b bg-background/85 px-3 py-2 backdrop-blur-lg supports-backdrop-filter:bg-background/70">
        <div
          ref={tablistRef}
          role="tablist"
          aria-label="Columns"
          className="relative grid grid-cols-3 rounded-xl bg-muted p-1"
        >
          {/* Sliding segment; its position is the track's scroll progress (0–2). */}
          <span
            aria-hidden
            className="absolute inset-y-1 left-1 w-[calc((100%-0.5rem)/3)] translate-x-[calc(var(--column-progress,0)*100%)] rounded-lg bg-background shadow-sm ring-1 ring-border/60 will-change-transform"
          />
          {TASK_STATUSES.map((status) => {
            const selected = status === active;
            const count = columns[status].length;
            return (
              <button
                key={status}
                id={tabId(status)}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={panelId(status)}
                tabIndex={selected ? 0 : -1}
                onClick={() => onActiveChange(status)}
                onKeyDown={onTabKeyDown}
                className={cn(
                  "relative z-10 flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg px-1.5 text-[13px] font-medium whitespace-nowrap outline-none transition-[color,transform] duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.97] motion-reduce:active:scale-100",
                  selected ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <span className="truncate">{STATUS_LABELS[status]}</span>
                <span className="sr-only">·</span>
                <span
                  className={cn(
                    "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] tabular-nums transition-colors",
                    selected ? "bg-foreground text-background" : "bg-foreground/8 text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div
        ref={trackRef}
        onScroll={onTrackScroll}
        className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {TASK_STATUSES.map((status) => {
          const selected = status === active;
          const tasks = columns[status];
          const EmptyIcon = EMPTY_ICON[status];
          return (
            <div
              key={status}
              id={panelId(status)}
              role="tabpanel"
              aria-labelledby={tabId(status)}
              // Neighbouring columns are only visible mid-swipe: keep them out of focus and the a11y tree.
              aria-hidden={!selected}
              inert={!selected}
              className="h-full w-full shrink-0 snap-start snap-always overflow-x-hidden overflow-y-auto overscroll-y-contain"
            >
              <div className="flex flex-col gap-3 px-3 pt-3 pb-[calc(6.5rem+env(safe-area-inset-bottom))]">
                {tasks.map((task) => (
                  // FLIP layer; the card's own markup stays untouched (and memoized).
                  <div key={task.id} ref={flip.register(task.id)} className="rounded-lg">
                    <TaskCard
                      task={task}
                      activity={activity[task.id]}
                      onOpen={() => onOpen(task.id)}
                      onAnswer={() => {
                        void actions.revertToTodo(task.id);
                        onOpen(task.id);
                      }}
                      actions={<QuickActions task={task} onOpen={() => onOpen(task.id)} actions={actions} />}
                    />
                  </div>
                ))}
                {tasks.length === 0 && (
                  <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
                    <span className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                      <EmptyIcon aria-hidden className="size-5" />
                    </span>
                    <p className="max-w-60 text-sm text-pretty text-muted-foreground">{EMPTY_COLUMN_TEXT[status]}</p>
                    {status === "todo" && (
                      <Button variant="outline" className="h-11 px-4" onClick={onAdd}>
                        <Plus />
                        Add a card
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Thumb-reachable, clear of the home indicator; the panels pad their ends so it never
          covers a card's quick actions. */}
      <Button
        size="icon"
        onClick={onAdd}
        aria-label="New card"
        className="fixed right-[calc(1rem+env(safe-area-inset-right))] bottom-[calc(1.25rem+env(safe-area-inset-bottom))] z-30 size-14 rounded-2xl shadow-lg shadow-primary/25 transition-transform duration-150 active:scale-95 motion-reduce:active:scale-100 [&_svg:not([class*='size-'])]:size-6"
      >
        <Plus />
      </Button>
    </div>
  );
}

/** Phone half of the board's initial-load skeleton: column switcher and a few cards. */
export function MobileBoardSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col md:hidden">
      <div className="shrink-0 border-b px-3 py-2">
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1">
          {TASK_STATUSES.map((status) => (
            <div key={status} className="flex h-11 items-center justify-center gap-1.5 text-[13px] font-medium text-muted-foreground">
              {STATUS_LABELS[status]}
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3 px-3 pt-3">
        {[2, 1, 2].map((lines, index) => (
          <div key={index} className="rounded-lg border bg-card shadow-xs">
            <div className="flex flex-col gap-2 p-3.5">
              <Skeleton className="h-4 w-11/12" />
              {lines > 1 && <Skeleton className="h-4 w-1/2" />}
              <div className="mt-1 flex items-center gap-2">
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="ml-auto h-3 w-6" />
              </div>
            </div>
            <div className="flex h-11 items-center border-t px-3.5">
              <Skeleton className="h-3.5 w-14" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
