"use client";

import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from "react";
import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
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
import { BoardColumn, COLUMN_DROPPABLE_PREFIX } from "@/components/board/board-column";
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
  isMobile: boolean;
  onOpen: (taskId: string) => void;
  moveTask: (taskId: string, status: TaskStatus, position: number) => Promise<void>;
  moveToStatus: (taskId: string, status: TaskStatus) => Promise<void>;
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
        active={props.mobileColumn}
        onActiveChange={props.onMobileColumnChange}
        onOpen={props.onOpen}
        moveToStatus={props.moveToStatus}
        onAdd={props.onAdd}
      />
    );
  }
  return (
    <DesktopBoard
      columns={props.columns}
      onOpen={props.onOpen}
      moveTask={props.moveTask}
      onQuickCreate={props.onQuickCreate}
    />
  );
}

function DesktopBoard({
  columns,
  onOpen,
  moveTask,
  onQuickCreate,
}: Pick<KanbanBoardProps, "columns" | "onOpen" | "moveTask" | "onQuickCreate">) {
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
  const [dragIds, setDragIds] = useState<ColumnIds | null>(null);
  const dragIdsRef = useRef<ColumnIds | null>(null);
  const updateDragIds = (next: ColumnIds | null) => {
    dragIdsRef.current = next;
    setDragIds(next);
  };

  const ids = dragIds ?? baseIds;

  const containerOf = (id: UniqueIdentifier, source: ColumnIds): TaskStatus | null => {
    const key = String(id);
    if (key.startsWith(COLUMN_DROPPABLE_PREFIX)) {
      const status = key.slice(COLUMN_DROPPABLE_PREFIX.length) as TaskStatus;
      return TASK_STATUSES.includes(status) ? status : null;
    }
    return TASK_STATUSES.find((status) => source[status].includes(key)) ?? null;
  };

  const reset = () => {
    setActiveId(null);
    updateDragIds(null);
  };

  const handleDragStart = ({ active }: DragStartEvent) => {
    setActiveId(String(active.id));
    updateDragIds(baseIds);
  };

  const handleDragOver = ({ active, over }: DragOverEvent) => {
    const current = dragIdsRef.current;
    if (!over || !current) return;
    const from = containerOf(active.id, current);
    const to = containerOf(over.id, current);
    if (!from || !to || from === to) return;

    const activeKey = String(active.id);
    const target = current[to].filter((id) => id !== activeKey);
    const overIndex = target.indexOf(String(over.id));
    let insertAt = target.length;
    if (overIndex >= 0) {
      const translated = active.rect.current.translated;
      const below = translated ? translated.top > over.rect.top + over.rect.height / 2 : false;
      insertAt = overIndex + (below ? 1 : 0);
    }
    target.splice(insertAt, 0, activeKey);
    updateDragIds({
      ...current,
      [from]: current[from].filter((id) => id !== activeKey),
      [to]: target,
    });
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    const current = dragIdsRef.current;
    reset();
    const task = taskById.get(String(active.id));
    if (!over || !current || !task) return;

    const status = containerOf(active.id, current);
    if (!status) return;
    let list = current[status];
    const overKey = String(over.id);
    if (!overKey.startsWith(COLUMN_DROPPABLE_PREFIX) && overKey !== task.id) {
      const from = list.indexOf(task.id);
      const to = list.indexOf(overKey);
      if (from >= 0 && to >= 0) list = arrayMove(list, from, to);
    }
    list = list.filter((id) => taskById.has(id));

    const unchanged =
      status === task.status &&
      list.length === baseIds[status].length &&
      list.every((id, i) => id === baseIds[status][i]);
    if (unchanged) return;

    const index = list.indexOf(task.id);
    const prev = index > 0 ? taskById.get(list[index - 1]) : undefined;
    const next = index >= 0 ? taskById.get(list[index + 1]) : undefined;
    void moveTask(task.id, status, positionBetween(prev, next));
  };

  const titleOf = (id: UniqueIdentifier) => taskById.get(String(id))?.title ?? "card";
  const columnLabelOf = (id: UniqueIdentifier) => {
    const status = containerOf(id, dragIdsRef.current ?? baseIds);
    return status ? STATUS_LABELS[status] : "";
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${titleOf(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${titleOf(active.id)} is over ${columnLabelOf(over.id)}.` : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? `${titleOf(active.id)} dropped in ${columnLabelOf(over.id)}.`
        : `${titleOf(active.id)} dropped.`,
    onDragCancel: ({ active }) => `Moving ${titleOf(active.id)} cancelled.`,
  };

  const activeTask = activeId ? taskById.get(activeId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={reset}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            "Press Enter to open the card. Press Space to pick it up, use the arrow keys to move it, then Space again to drop it or Escape to cancel.",
        },
      }}
    >
      <div className="grid h-full min-h-0 grid-cols-3 gap-3 p-3 lg:gap-4 lg:p-4">
        {TASK_STATUSES.map((status) => (
          <BoardColumn
            key={status}
            status={status}
            tasks={ids[status].flatMap((id) => {
              const task = taskById.get(id);
              return task ? [task] : [];
            })}
            onOpen={onOpen}
            onCreate={status === "todo" ? onQuickCreate : undefined}
          />
        ))}
      </div>
      <DragOverlay>{activeTask ? <TaskCard task={activeTask} overlay /> : null}</DragOverlay>
    </DndContext>
  );
}
