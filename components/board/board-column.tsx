"use client";

import { type CSSProperties, useRef, useState } from "react";
import { useDndContext, useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, type Task, type TaskStatus } from "@/lib/types";
import { type BoardMenuActions, CardContextMenu } from "@/components/board/card-context-menu";
import { InlineComposer, type QuickCreate } from "@/components/board/inline-composer";
import {
  type QuickActionHandlers,
  type QuickActionId,
  quickActionsFor,
  runQuickAction,
} from "@/components/board/quick-actions";
import { TaskCard } from "@/components/board/task-card";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const COLUMN_DROPPABLE_PREFIX = "column:";

const STATUS_DOT: Record<TaskStatus, string> = {
  todo: "bg-muted-foreground/50",
  in_progress: "bg-sky-500",
  done: "bg-emerald-500",
};

export const EMPTY_COLUMN_TEXT: Record<TaskStatus, string> = {
  todo: "No cards yet.",
  in_progress: "Nothing in progress. Start a card to run its agent.",
  done: "Finished cards land here.",
};

export function StatusDot({ status, className }: { status: TaskStatus; className?: string }) {
  return (
    <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[status], className)} />
  );
}

/** Runs a card's quick actions one at a time; `pending` is the action in flight. */
function useQuickActionRunner(taskId: string, handlers: QuickActionHandlers) {
  const [pending, setPending] = useState<QuickActionId | null>(null);
  const busy = useRef(false);
  const run = (id: QuickActionId) => {
    if (busy.current) return;
    busy.current = true;
    setPending(id);
    void runQuickAction(id, taskId, handlers).finally(() => {
      busy.current = false;
      setPending(null);
    });
  };
  return { pending, run };
}

const HIDDEN_UNTIL_CARD_ACTIVE =
  "pointer-events-none opacity-0 group-hover/card:pointer-events-auto group-hover/card:opacity-100 group-focus-within/card:pointer-events-auto group-focus-within/card:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100";

/**
 * Desktop quick actions in a card's top-right corner, revealed on hover/focus. Stop stays visible
 * while the agent runs. Rendered beside (not inside) the card button so the card keeps its name.
 */
export function CardQuickActionStrip({
  task,
  pending,
  onRun,
}: {
  task: Pick<Task, "status" | "agentState">;
  /** Action currently in flight; all buttons are disabled meanwhile. */
  pending: QuickActionId | null;
  onRun: (id: QuickActionId) => void;
}) {
  return (
    // Reversed so the primary action sits in the corner and secondary ones grow leftwards.
    <div className="absolute top-1.5 right-1.5 z-10 flex flex-row-reverse items-center gap-1">
      {quickActionsFor(task).map((action) => (
        <Tooltip key={action.id}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={action.label}
              aria-keyshortcuts={action.shortcut}
              aria-busy={pending === action.id || undefined}
              disabled={pending !== null}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onRun(action.id);
              }}
              className={cn(
                "inline-flex size-7 items-center justify-center rounded-md border bg-card/95 shadow-sm backdrop-blur outline-none transition-[opacity,color,background-color]",
                "hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
                "disabled:cursor-wait disabled:*:opacity-50 [&_svg]:size-3.5",
                action.id === "revert" ? "text-muted-foreground" : "text-foreground",
                action.id !== "stop" && HIDDEN_UNTIL_CARD_ACTIVE,
              )}
            >
              <action.icon
                aria-hidden
                className={cn(action.filled && "fill-current")}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {action.label}
            <Kbd>{action.shortcut}</Kbd>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function SortableTaskCard({
  task,
  index,
  activity,
  menuActions,
}: {
  task: Task;
  /** Position in the column; staggers the entry animation. */
  index: number;
  activity: string | undefined;
  menuActions: BoardMenuActions;
}) {
  const {
    active,
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, data: { type: "task", status: task.status } });
  // Cards remount when their agent moves them to another column; skip the entry animation for
  // anything mounting mid-drag.
  const [animateIn] = useState(() => active === null);
  const { pending, run } = useQuickActionRunner(task.id, menuActions);

  return (
    <CardContextMenu task={task} actions={menuActions}>
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        className="touch-manipulation rounded-lg data-[state=open]:*:ring-2 data-[state=open]:*:ring-ring/50"
      >
        {/* Entry animation lives on its own layer: it animates `transform` (and holds it via
            fill-mode), which would override dnd-kit's inline transform on the sortable node
            and the placeholder opacity on the card itself. */}
        <div
          className={cn("rounded-lg", animateIn && "animate-card-in")}
          style={animateIn ? ({ "--stagger": index } as CSSProperties) : undefined}
        >
          <TaskCard
            task={task}
            placeholder={isDragging}
            activity={activity}
            activatorRef={setActivatorNodeRef}
            dragAttributes={attributes}
            dragListeners={listeners}
            quickActions={<CardQuickActionStrip task={task} pending={pending} onRun={run} />}
            onOpen={() => {
              if (!isDragging) menuActions.openCard(task.id);
            }}
            onAnswer={() => {
              if (isDragging) return;
              void menuActions.revertToTodo(task.id);
              menuActions.openCard(task.id);
            }}
          />
        </div>
      </div>
    </CardContextMenu>
  );
}

/** Desktop/tablet column: header, independently scrolling sortable list, optional composer. */
export function BoardColumn({
  status,
  tasks,
  activity,
  menuActions,
  onCreate,
}: {
  status: TaskStatus;
  tasks: Task[];
  activity: Record<string, string>;
  /** Card clicks and right-click menu actions. */
  menuActions: BoardMenuActions;
  /** When set, shows the inline "Add a card" composer at the bottom. */
  onCreate?: QuickCreate;
}) {
  // Cards only reorder within their own column: while a card is dragged, every other column
  // (its body and its cards) stops being a drop target.
  const { active } = useDndContext();
  const dragStatus = active?.data.current?.status as TaskStatus | undefined;
  const foreign = dragStatus !== undefined && dragStatus !== status;
  const { setNodeRef, isOver } = useDroppable({
    id: `${COLUMN_DROPPABLE_PREFIX}${status}`,
    data: { type: "column", status },
    disabled: foreign,
  });
  const highlighted = isOver && dragStatus === status;
  const listRef = useRef<HTMLDivElement | null>(null);

  return (
    <section
      aria-label={STATUS_LABELS[status]}
      className={cn(
        "flex min-h-0 min-w-0 flex-col rounded-xl border transition-[background-color,box-shadow] duration-200",
        highlighted ? "bg-accent/40 ring-1 ring-primary/30" : "bg-muted/40 dark:bg-muted/20",
      )}
    >
      <header className="flex items-center gap-2 px-3.5 pt-3 pb-2">
        <StatusDot status={status} />
        <h2 className="text-sm font-semibold">{STATUS_LABELS[status]}</h2>
        <span className="rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground tabular-nums ring-1 ring-border">
          {tasks.length}
        </span>
      </header>
      <div
        ref={(node) => {
          setNodeRef(node);
          listRef.current = node;
        }}
        className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2"
      >
        <SortableContext
          items={tasks.map((t) => t.id)}
          strategy={verticalListSortingStrategy}
          disabled={{ draggable: false, droppable: foreign }}
        >
          <div className="flex min-h-full flex-col gap-2 pt-0.5">
            {tasks.map((task, index) => (
              <SortableTaskCard
                key={task.id}
                task={task}
                index={index}
                activity={activity[task.id]}
                menuActions={menuActions}
              />
            ))}
            {tasks.length === 0 && (
              <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                {EMPTY_COLUMN_TEXT[status]}
              </p>
            )}
          </div>
        </SortableContext>
      </div>
      {onCreate && (
        // The composer's textarea keeps the browser's own menu (paste, spellcheck…).
        <div className="border-t border-border/60 p-2" onContextMenu={(event) => event.stopPropagation()}>
          <InlineComposer
            onSubmit={onCreate}
            onAdded={() =>
              requestAnimationFrame(() => {
                const list = listRef.current;
                if (list) list.scrollTop = list.scrollHeight;
              })
            }
          />
        </div>
      )}
    </section>
  );
}
