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
import { positionBetween, type TasksByStatus } from "@/hooks/use-board";
import { useBoardHotkeys } from "@/hooks/use-board-hotkeys";
import { BoardColumn, COLUMN_DROPPABLE_PREFIX } from "@/components/board/board-column";
import { BoardContextMenu, type BoardMenuActions } from "@/components/board/card-context-menu";
import { MobileBoard } from "@/components/board/mobile-board";
import { TaskCard } from "@/components/board/task-card";

type ColumnIds = Record<TaskStatus, string[]>;

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
  onQuickCreate: (title: string) => Promise<boolean>;
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

  useBoardHotkeys({ ids: baseIds, taskById, dragging: activeId !== null }, menuActions);

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
            "Press Enter to open the card, Shift+F10 for its actions menu, R to start, resume or retry its agent, S to stop it, or Z to revert it to To do. Press Space to pick it up and reorder it within its column with the up and down arrow keys, then Space again to drop it or Escape to cancel.",
        },
      }}
    >
      <BoardContextMenu actions={menuActions}>
        <div className="grid h-full min-h-0 grid-cols-3 gap-3 p-3 lg:gap-4 lg:p-4">
          {TASK_STATUSES.map((status) => (
            <BoardColumn
              key={status}
              status={status}
              tasks={columns[status]}
              activity={activity}
              menuActions={menuActions}
              onCreate={status === "todo" ? onQuickCreate : undefined}
            />
          ))}
        </div>
      </BoardContextMenu>
      <DragOverlay>{activeTask ? <TaskCard task={activeTask} overlay /> : null}</DragOverlay>
    </DndContext>
  );
}
