"use client";

import { useEffect, useRef, useState } from "react";
import { EllipsisVertical, PanelRightOpen, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, TASK_STATUSES, type Task, type TaskStatus } from "@/lib/types";
import type { TasksByStatus } from "@/hooks/use-board";
import { EMPTY_COLUMN_TEXT } from "@/components/board/board-column";
import type { BoardMenuActions } from "@/components/board/card-context-menu";
import { quickActionsFor, runQuickAction, type QuickActionId } from "@/components/board/quick-actions";
import { TaskCard } from "@/components/board/task-card";

const SWIPE_MIN_DISTANCE = 60;

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
  const [primary, ...rest] = quickActionsFor(task);

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
          "h-11 flex-1 justify-start gap-2 rounded-none rounded-bl-lg px-3 text-[13px]",
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
            className="size-11 rounded-none rounded-br-lg border-l"
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

/** Phone layout: segmented column tabs, horizontal swipe between columns, FAB for new cards. */
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
  const listRef = useRef<HTMLDivElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const previous = useRef(active);
  const [direction, setDirection] = useState<"left" | "right" | null>(null);

  useEffect(() => {
    if (previous.current === active) return;
    setDirection(
      TASK_STATUSES.indexOf(active) > TASK_STATUSES.indexOf(previous.current) ? "left" : "right",
    );
    previous.current = active;
    listRef.current?.scrollTo({ top: 0 });
  }, [active]);

  const step = (delta: number) => {
    const next = TASK_STATUSES[TASK_STATUSES.indexOf(active) + delta];
    if (next) onActiveChange(next);
  };

  const tasks = columns[active];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label="Columns"
        className="grid shrink-0 grid-cols-3 gap-1 border-b bg-background px-2 pt-1"
      >
        {TASK_STATUSES.map((status) => {
          const selected = status === active;
          return (
            <button
              key={status}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="mobile-column-panel"
              onClick={() => onActiveChange(status)}
              className={cn(
                "relative flex min-h-11 min-w-0 items-center justify-center gap-1 px-1 text-[13px] font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                selected ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <span className="truncate">{STATUS_LABELS[status]}</span>
              <span className="shrink-0 tabular-nums opacity-70">· {columns[status].length}</span>
              <span
                aria-hidden
                className={cn(
                  "absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-foreground transition-opacity",
                  selected ? "opacity-100" : "opacity-0",
                )}
              />
            </button>
          );
        })}
      </div>

      <div
        ref={listRef}
        id="mobile-column-panel"
        role="tabpanel"
        aria-label={STATUS_LABELS[active]}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
        onTouchStart={(event) => {
          const touch = event.touches[0];
          touchStart.current = event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY } : null;
        }}
        onTouchEnd={(event) => {
          const start = touchStart.current;
          touchStart.current = null;
          const touch = event.changedTouches[0];
          if (!start || !touch) return;
          const dx = touch.clientX - start.x;
          const dy = touch.clientY - start.y;
          if (Math.abs(dx) > SWIPE_MIN_DISTANCE && Math.abs(dx) > Math.abs(dy) * 1.5) {
            step(dx < 0 ? 1 : -1);
          }
        }}
      >
        <div
          key={active}
          className={cn(
            "flex flex-col gap-2.5 px-3 pt-3 pb-[calc(6rem+env(safe-area-inset-bottom))]",
            direction && "animate-in duration-200 fade-in-0",
            direction === "left" && "slide-in-from-right-6",
            direction === "right" && "slide-in-from-left-6",
          )}
        >
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              activity={activity[task.id]}
              onOpen={() => onOpen(task.id)}
              onAnswer={() => {
                void actions.revertToTodo(task.id);
                onOpen(task.id);
              }}
              actions={
                <QuickActions task={task} onOpen={() => onOpen(task.id)} actions={actions} />
              }
            />
          ))}
          {tasks.length === 0 && (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center">
              <p className="text-sm text-muted-foreground">{EMPTY_COLUMN_TEXT[active]}</p>
              {active === "todo" && (
                <Button variant="outline" className="h-11 px-4" onClick={onAdd}>
                  <Plus />
                  Add a card
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      <Button
        size="icon"
        onClick={onAdd}
        aria-label="New card"
        className="fixed right-[calc(1rem+env(safe-area-inset-right))] bottom-[calc(1rem+env(safe-area-inset-bottom))] z-30 size-14 rounded-full shadow-lg [&_svg:not([class*='size-'])]:size-6"
      >
        <Plus />
      </Button>
    </div>
  );
}
