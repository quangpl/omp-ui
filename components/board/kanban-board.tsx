"use client";

import { type PointerEvent as ReactPointerEvent, useMemo, useState } from "react";
import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  type Announcements,
  PointerSensor,
  TouchSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { STATUS_LABELS, TASK_STATUSES, type Task, type TaskStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { positionBetween, type TasksByStatus } from "@/hooks/use-board";
import type { QuickCreate } from "@/components/board/inline-composer";
import { BOARD_ROOT_ATTR, useBoardHotkeys } from "@/hooks/use-board-hotkeys";
import { useCardSelection } from "@/hooks/use-card-selection";
import { BoardColumn, COLUMN_DROPPABLE_PREFIX, StatusDot } from "@/components/board/board-column";
import { useBulkRunner } from "@/components/board/bulk-actions";
import { BoardContextMenu, type BoardMenuActions } from "@/components/board/card-context-menu";
import { MobileBoard, MobileBoardSkeleton } from "@/components/board/mobile-board";
import { SelectionBar } from "@/components/board/selection-bar";
import { TaskCard } from "@/components/board/task-card";
import { Skeleton } from "@/components/ui/skeleton";

type ColumnIds = Record<TaskStatus, string[]>;

/**
 * The three columns, sized from the board area (an `@container`): once it fits three readable
 * columns (60rem) they share the width evenly; narrower areas (tablets, a laptop with the sidebar
 * open) scroll sideways inside the board, one column per snap, with the next column peeking in.
 */
const COLUMN_TRACK = cn(
  "scrollbar-subtle grid min-h-0 flex-1 grid-flow-col grid-rows-[minmax(0,1fr)] gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain p-3 lg:gap-4 lg:p-4",
  "snap-x snap-mandatory scroll-px-3 auto-cols-[minmax(15rem,80%)] @min-[40rem]:auto-cols-[minmax(16rem,40%)] lg:scroll-px-4",
  "@min-[60rem]:grid-flow-row @min-[60rem]:grid-cols-3 @min-[60rem]:snap-none",
);

/** Card placeholders per column (title lines), uneven so the skeleton reads as a real board. */
const SKELETON_CARDS: Record<TaskStatus, number[]> = {
  todo: [2, 1, 2],
  in_progress: [1, 2],
  done: [1, 1, 2, 1],
};

function CardSkeleton({ lines }: { lines: number }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 shadow-xs">
      <Skeleton className="h-3.5 w-11/12" />
      {lines > 1 && <Skeleton className="h-3.5 w-3/5" />}
      <div className="mt-1 flex items-center gap-2">
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="ml-auto h-3 w-6" />
      </div>
    </div>
  );
}

/** Initial-load placeholder shaped like the board below the header (phones and columns). */
export function BoardBodySkeleton() {
  return (
    <div aria-hidden className="flex min-h-0 flex-1 flex-col">
      <MobileBoardSkeleton />
      <div className="@container hidden min-h-0 flex-1 flex-col md:flex">
        <div className={COLUMN_TRACK}>
          {TASK_STATUSES.map((status) => (
            <div
              key={status}
              className="flex min-h-0 min-w-0 snap-start flex-col rounded-xl border bg-muted/40 dark:bg-muted/20"
            >
              <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/50 px-3.5">
                <StatusDot status={status} />
                <span className="text-[0.8125rem] font-semibold tracking-tight text-muted-foreground">
                  {STATUS_LABELS[status]}
                </span>
                <Skeleton className="h-5 w-6 rounded-full" />
              </div>
              <div className="flex flex-col gap-2 px-2 pt-2">
                {SKELETON_CARDS[status].map((lines, index) => (
                  <CardSkeleton key={index} lines={lines} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Mouse/pen drags start after 6px; touch is left to the long-press TouchSensor so columns still scroll. */
class FinePointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent }: ReactPointerEvent) =>
        nativeEvent.isPrimary && nativeEvent.button === 0 && nativeEvent.pointerType !== "touch",
    },
  ];
}

const KEYBOARD_CODES = { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] };

export interface KanbanBoardProps {
  columns: TasksByStatus;
  /** Latest agent activity line per task id. */
  activity: Record<string, string>;
  isMobile: boolean;
  /** Card clicks and the desktop right-click menus. */
  menuActions: BoardMenuActions;
  /** Reorders a card within its own column; cards never change column by drag. */
  reorderTask: (taskId: string, position: number) => Promise<void>;
  /** Inline composer submit (desktop To do column). Resolves true when the card was created. */
  onQuickCreate: QuickCreate;
  /** Opens the full "New card" form (mobile FAB). */
  onAdd: () => void;
  mobileColumn: TaskStatus;
  onMobileColumnChange: (status: TaskStatus) => void;
}

export function KanbanBoard(props: KanbanBoardProps) {
  if (props.isMobile) {
    return (
      <MobileBoard
        columns={props.columns}
        activity={props.activity}
        active={props.mobileColumn}
        onActiveChange={props.onMobileColumnChange}
        onOpen={props.menuActions.openCard}
        actions={props.menuActions}
        onAdd={props.onAdd}
      />
    );
  }
  return (
    <DesktopBoard
      columns={props.columns}
      activity={props.activity}
      menuActions={props.menuActions}
      reorderTask={props.reorderTask}
      onQuickCreate={props.onQuickCreate}
    />
  );
}

function DesktopBoard({
  columns,
  activity,
  menuActions,
  reorderTask,
  onQuickCreate,
}: Pick<KanbanBoardProps, "columns" | "activity" | "menuActions" | "reorderTask" | "onQuickCreate">) {
  const sensors = useSensors(
    useSensor(FinePointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: KEYBOARD_CODES,
    }),
  );

  const baseIds = useMemo<ColumnIds>(
    () => ({
      todo: columns.todo.map((t) => t.id),
      in_progress: columns.in_progress.map((t) => t.id),
      done: columns.done.map((t) => t.id),
    }),
    [columns],
  );
  const taskById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const status of TASK_STATUSES) for (const task of columns[status]) map.set(task.id, task);
    return map;
  }, [columns]);

  const [activeId, setActiveId] = useState<string | null>(null);

  const selection = useCardSelection(taskById);
  const bulk = useBulkRunner(menuActions);
  useBoardHotkeys(
    { ids: baseIds, taskById, dragging: activeId !== null, selection, runBulk: bulk.run },
    menuActions,
  );
  // Board order, so summaries and the bar read top-left to bottom-right.
  const selectedTasks = useMemo(
    () => TASK_STATUSES.flatMap((status) => columns[status].filter((task) => selection.selected.has(task.id))),
    [columns, selection.selected],
  );

  const containerOf = (id: UniqueIdentifier): TaskStatus | null => {
    const key = String(id);
    if (key.startsWith(COLUMN_DROPPABLE_PREFIX)) {
      const status = key.slice(COLUMN_DROPPABLE_PREFIX.length) as TaskStatus;
      return TASK_STATUSES.includes(status) ? status : null;
    }
    return TASK_STATUSES.find((status) => baseIds[status].includes(key)) ?? null;
  };

  // Reorder only: the card stays in its own column (other columns aren't drop targets, see
  // BoardColumn); a drop anywhere else is ignored.
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    const task = taskById.get(String(active.id));
    if (!over || !task) return;
    const overKey = String(over.id);
    if (overKey === task.id || overKey.startsWith(COLUMN_DROPPABLE_PREFIX)) return;
    if (containerOf(over.id) !== task.status) return;

    const list = baseIds[task.status];
    const from = list.indexOf(task.id);
    const to = list.indexOf(overKey);
    if (from < 0 || to < 0) return;
    const ordered = arrayMove(list, from, to);
    const prev = to > 0 ? taskById.get(ordered[to - 1]) : undefined;
    const next = taskById.get(ordered[to + 1]);
    void reorderTask(task.id, positionBetween(prev, next));
  };

  const titleOf = (id: UniqueIdentifier) => taskById.get(String(id))?.title ?? "card";
  /** "position 2 of 5 in In progress" for a card, or just the column name for its empty area. */
  const placeOf = (id: UniqueIdentifier) => {
    const status = containerOf(id);
    if (!status) return "";
    const index = baseIds[status].indexOf(String(id));
    const column = STATUS_LABELS[status];
    return index >= 0 ? `position ${index + 1} of ${baseIds[status].length} in ${column}` : column;
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up ${titleOf(active.id)} at ${placeOf(active.id)}. Use the up and down arrow keys to reorder it within its column.`,
    onDragOver: ({ active, over }) =>
      over ? `${titleOf(active.id)} is over ${placeOf(over.id)}.` : undefined,
    onDragEnd: ({ active, over }) =>
      over && over.id !== active.id && !String(over.id).startsWith(COLUMN_DROPPABLE_PREFIX)
        ? `${titleOf(active.id)} moved to ${placeOf(over.id)}.`
        : `${titleOf(active.id)} dropped; its order is unchanged.`,
    onDragCancel: ({ active }) => `Reordering ${titleOf(active.id)} cancelled.`,
  };

  const activeTask = activeId ? taskById.get(activeId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={({ active }: DragStartEvent) => setActiveId(String(active.id))}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            "Press Enter to open the card, X to select it, Shift+F10 for its actions menu, R to start, resume or retry its agent, S to stop it, or Z to revert it to To do; with cards selected, R, S and Z apply to all of them. Press Space to pick it up and reorder it within its column with the up and down arrow keys, then Space again to drop it or Escape to cancel.",
        },
      }}
    >
      {/* The board area is a size container: column layout follows the space next to the sidebar,
          not the viewport. */}
      <div {...{ [BOARD_ROOT_ATTR]: "" }} className="@container relative flex min-h-0 flex-1 flex-col">
        <BoardContextMenu actions={menuActions}>
          <div className={cn(COLUMN_TRACK, selectedTasks.length > 0 && "pb-20 lg:pb-20")}>
            {TASK_STATUSES.map((status) => (
              <BoardColumn
                key={status}
                status={status}
                tasks={columns[status]}
                activity={activity}
                menuActions={menuActions}
                selected={selection.selected}
                onToggleSelect={selection.toggle}
                onCreate={status === "todo" ? onQuickCreate : undefined}
              />
            ))}
          </div>
        </BoardContextMenu>
        <SelectionBar
          tasks={selectedTasks}
          canPush={menuActions.pushToMain !== null}
          pending={bulk.pending}
          onRun={(key) => bulk.run(selectedTasks, key)}
          onClear={selection.clear}
        />
      </div>
      <DragOverlay>{activeTask ? <TaskCard task={activeTask} overlay /> : null}</DragOverlay>
    </DndContext>
  );
}
