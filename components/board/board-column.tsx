"use client";

import { type CSSProperties, useRef, useState } from "react";
import { CircleCheckBig, CircleDashed, Inbox, LoaderCircle, type LucideIcon, Play, Square, Trash2 } from "lucide-react";
import { useDndContext, useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, type Task, type TaskStatus } from "@/lib/types";
import { type BoardMenuActions, CardContextMenu } from "@/components/board/card-context-menu";
import { bulkTargets, useBulkRunner } from "@/components/board/bulk-actions";
import { InlineComposer, type QuickCreate } from "@/components/board/inline-composer";
import { useNewCard } from "@/components/new-card";
import {
  type QuickActionHandlers,
  type QuickActionId,
  isPinnedQuickAction,
  quickActionsFor,
  runQuickAction,
} from "@/components/board/quick-actions";
import { TaskCard } from "@/components/board/task-card";
import type { CardFlip } from "@/hooks/use-card-flip";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const COLUMN_DROPPABLE_PREFIX = "column:";

const STATUS_DOT: Record<TaskStatus, string> = {
  todo: "bg-muted-foreground/50",
  in_progress: "bg-primary",
  done: "bg-success",
};

export const EMPTY_COLUMN_TEXT: Record<TaskStatus, string> = {
  todo: "No cards yet. Add one below — an agent picks it up.",
  in_progress: "Nothing in progress. Start a card to run its agent.",
  done: "Finished cards land here.",
};

/** Icon of a column's empty state (desktop columns and phone pages). */
export const EMPTY_COLUMN_ICON: Record<TaskStatus, LucideIcon> = {
  todo: Inbox,
  in_progress: CircleDashed,
  done: CircleCheckBig,
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

/** Stop, Push to main and Retry stay on the card without hovering: each is that card's next step. */
function staysVisible(id: QuickActionId): boolean {
  return isPinnedQuickAction(id) || id === "retry";
}

/**
 * Desktop quick actions in a card's top-right corner, revealed on hover/focus. Stop (agent
 * running), Retry (agent failed) and Push to main (finished, not pushed yet) stay visible.
 * Rendered beside (not inside) the card button so the card keeps its name.
 */
export function CardQuickActionStrip({
  task,
  canPush,
  pending,
  onRun,
}: {
  task: Pick<Task, "status" | "agentState" | "retryAt" | "pushedAt">;
  canPush: boolean;
  /** Action currently in flight; all buttons are disabled meanwhile. */
  pending: QuickActionId | null;
  onRun: (id: QuickActionId) => void;
}) {
  return (
    // Reversed so the primary action sits in the corner and secondary ones grow leftwards.
    <div className="absolute top-1.5 right-1.5 z-10 flex flex-row-reverse items-center gap-1">
      {quickActionsFor(task, { canPush }).map((action) => (
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
                !staysVisible(action.id) && HIDDEN_UNTIL_CARD_ACTIVE,
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
  selected,
  onToggleSelect,
  flip,
}: {
  task: Task;
  /** Position in the column; staggers the entry animation. */
  index: number;
  activity: string | undefined;
  menuActions: BoardMenuActions;
  selected: boolean;
  onToggleSelect: (taskId: string) => void;
  flip: CardFlip;
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
  // Cards remount when their agent moves them to another column; the board's FLIP ghost carries
  // those over, so the entry animation is only for cards new to the board, and never for anything
  // mounting mid-drag.
  const [animateIn] = useState(() => active === null && !flip.wasOnBoard(task.id));
  const { pending, run } = useQuickActionRunner(task.id, menuActions);
  const canPush = menuActions.pushToMain !== null;
  // Corner slots (from the right) up to the last always-visible action; the title stays clear of them.
  const pinnedSlots = quickActionsFor(task, { canPush }).reduce(
    (slots, action, i) => (staysVisible(action.id) ? i + 1 : slots),
    0,
  );

  return (
    <CardContextMenu task={task} actions={menuActions}>
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        className="touch-manipulation rounded-lg data-[state=open]:*:ring-2 data-[state=open]:*:ring-ring/50"
      >
        {/* Entry and FLIP animations live on their own layer: they animate `transform` (the entry
            one holds it via fill-mode), which would override dnd-kit's inline transform on the
            sortable node and the placeholder opacity on the card itself. */}
        <div
          ref={flip.register(task.id)}
          className={cn("rounded-lg", animateIn && "animate-card-in")}
          style={animateIn ? ({ "--stagger": index } as CSSProperties) : undefined}
        >
          <TaskCard
            task={task}
            placeholder={isDragging}
            selected={selected}
            activity={activity}
            activatorRef={setActivatorNodeRef}
            dragAttributes={attributes}
            dragListeners={listeners}
            quickActions={<CardQuickActionStrip task={task} canPush={canPush} pending={pending} onRun={run} />}
            pinnedQuickActions={pinnedSlots}
            onOpen={(event) => {
              if (isDragging) return;
              // ⌘/Ctrl/⇧+click picks cards for a bulk quick action instead of opening one.
              if (event.metaKey || event.ctrlKey || event.shiftKey) onToggleSelect(task.id);
              else menuActions.openCard(task.id);
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
  selected,
  onToggleSelect,
  onCreate,
  flip,
}: {
  status: TaskStatus;
  tasks: Task[];
  activity: Record<string, string>;
  /** Card clicks and right-click menu actions. */
  menuActions: BoardMenuActions;
  /** Ids of the selected cards (board-wide). */
  selected: ReadonlySet<string>;
  /** ⌘/Ctrl/⇧+click on a card. */
  onToggleSelect: (taskId: string) => void;
  /** When set, shows the inline "Add a task" composer at the bottom. */
  onCreate?: QuickCreate;
  /** Board-wide card motion (see useCardFlip); each card registers its animated layer. */
  flip: CardFlip;
}) {
  const openNewCard = useNewCard();
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
  const bulk = useBulkRunner(menuActions);
  // To do offers "Start all", In progress "Stop all", Done "Delete all" (after a confirmation).
  const headerAction =
    status === "todo"
      ? {
          label: "Start all",
          icon: Play,
          destructive: false,
          tasks: bulkTargets(tasks, "R", false).map((target) => target.task),
          run: (targets: Task[]) => bulk.run(targets, "R"),
        }
      : status === "in_progress"
        ? {
            label: "Stop all",
            icon: Square,
            destructive: false,
            tasks: bulkTargets(tasks, "S", false).map((target) => target.task),
            run: (targets: Task[]) => bulk.run(targets, "S"),
          }
        : { label: "Delete all", icon: Trash2, destructive: true, tasks, run: menuActions.requestDeleteAll };

  return (
    <section
      aria-label={STATUS_LABELS[status]}
      className={cn(
        "flex min-h-0 min-w-0 snap-start flex-col rounded-xl border transition-[background-color,box-shadow] duration-200",
        highlighted ? "bg-accent/40 ring-1 ring-primary/30" : "bg-muted/40 dark:bg-muted/20",
      )}
    >
      {/* Fixed height so all three headers line up whether or not the column has a bulk action. */}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/50 pr-1.5 pl-3.5">
        <StatusDot status={status} />
        <h2 className="truncate text-[0.8125rem] font-semibold tracking-tight">{STATUS_LABELS[status]}</h2>
        <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-background px-1.5 font-mono text-[11px] font-medium text-muted-foreground tabular-nums ring-1 ring-border">
          {tasks.length}
        </span>
        {headerAction.tasks.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={`${headerAction.label} (${headerAction.tasks.length})`}
                aria-busy={bulk.pending !== null || undefined}
                disabled={bulk.pending !== null}
                onClick={() => headerAction.run(headerAction.tasks)}
                className={cn(
                  "ml-auto h-7 shrink-0 gap-1.5 px-2 text-muted-foreground active:translate-y-px",
                  headerAction.destructive
                    ? "hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/20"
                    : "hover:text-foreground",
                )}
              >
                {bulk.pending ? (
                  <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <headerAction.icon aria-hidden className={cn(!headerAction.destructive && "fill-current")} />
                )}
                {headerAction.label}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {headerAction.label} · {headerAction.tasks.length}{" "}
              {headerAction.tasks.length === 1 ? "card" : "cards"}
            </TooltipContent>
          </Tooltip>
        )}
      </header>
      <div
        ref={(node) => {
          setNodeRef(node);
          listRef.current = node;
        }}
        className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2 pb-3"
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
                selected={selected.has(task.id)}
                onToggleSelect={onToggleSelect}
                flip={flip}
              />
            ))}
            {tasks.length === 0 && <EmptyColumn status={status} onAdd={() => openNewCard()} />}
          </div>
        </SortableContext>
      </div>
      {onCreate && (
        // The composer's textarea keeps the browser's own menu (paste, spellcheck…).
        <div className="border-t border-border/60 p-2" onContextMenu={(event) => event.stopPropagation()}>
          <InlineComposer
            onSubmit={onCreate}
            boardId={menuActions.boardId}
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

/** Composed empty state: the column's icon, one line, and (To do) the way to add a card. */
function EmptyColumn({ status, onAdd }: { status: TaskStatus; onAdd: () => void }) {
  const Icon = EMPTY_COLUMN_ICON[status];
  const icon = (
    <span className="mb-1 flex size-9 items-center justify-center rounded-xl bg-background text-muted-foreground ring-1 ring-border/70 transition-colors group-hover/empty:text-primary">
      <Icon aria-hidden className="size-4" />
    </span>
  );
  if (status !== "todo") {
    return (
      <div className="flex animate-fade-in-soft flex-col items-center gap-1.5 rounded-lg border border-dashed px-3 py-7 text-center text-xs text-pretty text-muted-foreground">
        {icon}
        <p>{EMPTY_COLUMN_TEXT[status]}</p>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onAdd}
      className="group/empty pressable flex animate-fade-in-soft flex-col items-center gap-1.5 rounded-lg border border-dashed px-3 py-7 text-center text-xs text-pretty text-muted-foreground outline-none hover:border-primary/40 hover:bg-primary/5 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {icon}
      <span>{EMPTY_COLUMN_TEXT.todo}</span>
      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
        Add a task <Kbd>N</Kbd>
      </span>
    </button>
  );
}
