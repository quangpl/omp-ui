"use client";

import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { EllipsisVertical, LoaderCircle, PanelRightOpen, Plus, SearchX, Trash2 } from "lucide-react";
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
import type { BoardSearchResult } from "@/lib/board-search";
import { type CardFlip, cardLayoutKey, useCardFlip } from "@/hooks/use-card-flip";
import { EMPTY_COLUMN_ICON, EMPTY_COLUMN_TEXT, NO_MATCHES_TEXT } from "@/components/board/board-column";
import { BoardSearch } from "@/components/board/board-search";
import type { BoardMenuActions } from "@/components/board/card-context-menu";
import { quickActionsFor, runQuickAction, type QuickActionId } from "@/components/board/quick-actions";
import { TaskCard } from "@/components/board/task-card";

/** Quiet period after the last scroll event before a swipe counts as landed on a column. */
const SCROLL_SETTLE_MS = 90;

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
          "pressable h-11 flex-1 justify-start gap-2 rounded-none rounded-bl-lg px-3.5 text-[13px] font-medium active:bg-muted",
          primary.id === "stop" && "text-destructive hover:bg-destructive/10 hover:text-destructive",
        )}
        aria-label={primary.label}
        aria-busy={busy || undefined}
        title={primary.hint}
        disabled={busy}
        onClick={() => void run(primary.id)}
      >
        {busy ? (
          <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" />
        ) : (
          <primary.icon className={cn(primary.filled && "fill-current")} />
        )}
        {primary.label}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="pressable h-11 w-12 rounded-none rounded-br-lg border-l text-muted-foreground active:bg-muted"
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

/** One phone card on its FLIP layer; cards new to the board cascade in, moved ones are carried by the FLIP. */
function MobileCard({
  task,
  index,
  activity,
  flip,
  onOpen,
  actions,
  highlight,
}: {
  task: Task;
  /** Position in the column; staggers the entry animation. */
  index: number;
  activity: string | undefined;
  flip: CardFlip;
  onOpen: (taskId: string) => void;
  actions: BoardMenuActions;
  /** Title characters matched by the board search. */
  highlight: readonly number[] | undefined;
}) {
  // Same rule as the desktop columns: a card that changed column remounts on its new page and the
  // FLIP carries it there, so only cards new to the board play the entry cascade.
  const [animateIn] = useState(() => !flip.wasOnBoard(task.id));
  return (
    // FLIP layer (and the entry animation, which also holds `transform`); the card's own markup
    // stays untouched (and memoized), its press feedback lives on the card itself.
    <div
      ref={flip.register(task.id)}
      className={cn("rounded-lg", animateIn && "animate-card-in")}
      style={animateIn ? ({ "--stagger": index } as CSSProperties) : undefined}
    >
      <TaskCard
        task={task}
        activity={activity}
        onOpen={() => onOpen(task.id)}
        onAnswer={() => {
          void actions.revertToTodo(task.id);
          onOpen(task.id);
        }}
        actions={<QuickActions task={task} onOpen={() => onOpen(task.id)} actions={actions} />}
        highlight={highlight}
      />
    </div>
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
  query,
  onQueryChange,
  search,
}: {
  columns: TasksByStatus;
  activity: Record<string, string>;
  active: TaskStatus;
  onActiveChange: (status: TaskStatus) => void;
  onOpen: (taskId: string) => void;
  actions: BoardMenuActions;
  onAdd: () => void;
  /** Board search query; `columns` are already filtered by it. */
  query: string;
  onQueryChange: (query: string) => void;
  search: Pick<BoardSearchResult, "matches" | "total" | "active" | "fuzzy" | "highlights">;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);
  const settleTimer = useRef<number | undefined>(undefined);
  /** Pending rAF that writes the segment highlight's position. */
  const progressFrame = useRef<number | undefined>(undefined);
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

  // Typing a query that leaves the shown page empty jumps to the first page with matches, so
  // results never sit unseen behind another tab. Only query edits move it (not card updates), and
  // a blank query never does, so the board opens on its usual page.
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  useEffect(() => {
    const shown = columnsRef.current;
    if (!query.trim() || shown[activeRef.current].length > 0) return;
    const target = TASK_STATUSES.find((status) => shown[status].length > 0);
    if (target) onActiveChangeRef.current(target);
  }, [query]);

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

  useEffect(
    () => () => {
      window.clearTimeout(settleTimer.current);
      if (progressFrame.current !== undefined) cancelAnimationFrame(progressFrame.current);
      progressFrame.current = undefined;
    },
    [],
  );

  const onTrackScroll = () => {
    const track = trackRef.current;
    if (!track) return;
    // The segment highlight follows the finger: one style write per frame, no React render.
    if (progressFrame.current === undefined) {
      progressFrame.current = requestAnimationFrame(() => {
        progressFrame.current = undefined;
        const width = Math.max(track.clientWidth, 1);
        tablistRef.current?.style.setProperty("--column-progress", String(track.scrollLeft / width));
      });
    }
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      const landed = TASK_STATUSES[Math.round(track.scrollLeft / Math.max(track.clientWidth, 1))];
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
      <div className="glass-edge shrink-0 border-b bg-background/85 px-4 py-2 backdrop-blur-lg supports-backdrop-filter:bg-background/70">
        <BoardSearch
          value={query}
          onValueChange={onQueryChange}
          matches={search.matches}
          total={search.total}
          fuzzy={search.fuzzy}
          // Search key on the phone keyboard: the results are already showing, put the keyboard away.
          onSubmit={() => {
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          }}
          className="mb-2"
        />
        <div
          ref={tablistRef}
          role="tablist"
          aria-label="Columns"
          className="relative grid grid-cols-3 rounded-xl bg-muted p-1"
        >
          {/* Sliding segment; its position is the track's scroll progress (0–2), written per frame. */}
          <span
            aria-hidden
            className="absolute inset-y-1 left-1 w-[calc((100%-0.5rem)/3)] translate-x-[calc(var(--column-progress,0)*100%)] rounded-lg bg-background shadow-xs ring-1 ring-border/60 will-change-transform dark:bg-background/80"
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
                  "relative z-10 flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg px-1.5 text-[13px] font-medium whitespace-nowrap outline-none transition-[color,scale] duration-(--duration-press) ease-(--ease-fluid) focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.97] motion-reduce:transition-none",
                  selected ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <span className="truncate">{STATUS_LABELS[status]}</span>
                <span className="sr-only">·</span>
                <span
                  className={cn(
                    "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 font-mono text-[11px] tabular-nums transition-colors",
                    selected ? "bg-primary text-primary-foreground" : "bg-foreground/8 text-muted-foreground",
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
        className="scroll-row flex min-h-0 flex-1 snap-x snap-mandatory overflow-y-hidden"
      >
        {TASK_STATUSES.map((status) => {
          const selected = status === active;
          const tasks = columns[status];
          // While searching, an empty page means nothing here matches, not an empty column.
          const EmptyIcon = search.active ? SearchX : EMPTY_COLUMN_ICON[status];
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
              <div className="flex flex-col gap-3 px-4 pt-3 pb-[calc(6.5rem+env(safe-area-inset-bottom))]">
                {status === "done" && tasks.length > 0 && (
                  // Column-wide action; the desktop column has it in its header.
                  <Button
                    variant="ghost"
                    className="pressable -mr-2 -mb-2 h-11 gap-2 self-end px-3 text-[13px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive active:bg-destructive/10"
                    aria-label={`Delete all (${tasks.length})`}
                    onClick={() => actions.requestDeleteAll(tasks)}
                  >
                    <Trash2 aria-hidden />
                    Delete all
                  </Button>
                )}
                {tasks.map((task, index) => (
                  <MobileCard
                    key={task.id}
                    task={task}
                    index={index}
                    activity={activity[task.id]}
                    flip={flip}
                    onOpen={onOpen}
                    actions={actions}
                    highlight={search.highlights.get(task.id)}
                  />
                ))}
                {tasks.length === 0 && (
                  <div className="flex animate-fade-in-soft flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-12 text-center">
                    <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground ring-1 ring-border/60">
                      <EmptyIcon aria-hidden className="size-5" />
                    </span>
                    <p className="max-w-60 text-sm text-pretty text-muted-foreground">
                      {search.active ? NO_MATCHES_TEXT : EMPTY_COLUMN_TEXT[status]}
                    </p>
                    {status === "todo" && !search.active && (
                      <Button variant="outline" className="pressable h-11 px-4" onClick={onAdd}>
                        <Plus />
                        Add a task
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
        aria-label="New task"
        className="pressable fixed right-[calc(1rem+env(safe-area-inset-right))] bottom-[calc(1.25rem+env(safe-area-inset-bottom))] z-30 size-14 rounded-full shadow-diffuse [&_svg:not([class*='size-'])]:size-6"
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
      <div className="shrink-0 border-b px-4 py-2">
        <Skeleton className="mb-2 h-11 w-full rounded-lg" />
        <div className="relative grid grid-cols-3 rounded-xl bg-muted p-1">
          <span
            aria-hidden
            className="absolute inset-y-1 left-1 w-[calc((100%-0.5rem)/3)] rounded-lg bg-background shadow-xs ring-1 ring-border/60 dark:bg-background/80"
          />
          {TASK_STATUSES.map((status) => (
            <div
              key={status}
              className="relative flex h-11 items-center justify-center gap-1.5 text-[13px] font-medium text-muted-foreground"
            >
              {STATUS_LABELS[status]}
              <span className="h-5 w-5 rounded-full bg-foreground/8" />
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3 px-4 pt-3">
        {[2, 1, 2].map((lines, index) => (
          <div key={index} className="rounded-lg border bg-card shadow-xs">
            <div className="flex flex-col gap-2 px-3.5 pt-3 pb-2.5">
              <div className="flex items-start gap-2">
                <Skeleton className="size-4 shrink-0 rounded-full" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-11/12" />
                  {lines > 1 && <Skeleton className="h-4 w-1/2" />}
                </div>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="ml-auto h-3 w-6" />
              </div>
            </div>
            <div className="flex h-11 items-center border-t">
              <div className="flex flex-1 items-center gap-2 px-3.5">
                <Skeleton className="size-4 rounded-sm" />
                <Skeleton className="h-3.5 w-14" />
              </div>
              <div className="flex h-full w-12 items-center justify-center border-l">
                <Skeleton className="h-4 w-1" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
