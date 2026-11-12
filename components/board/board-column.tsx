"use client";

import { useRef } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, type Task, type TaskStatus } from "@/lib/types";
import { type BoardMenuActions, CardContextMenu } from "@/components/board/card-context-menu";
import { InlineComposer } from "@/components/board/inline-composer";
import { TaskCard } from "@/components/board/task-card";

export const COLUMN_DROPPABLE_PREFIX = "column:";

const STATUS_DOT: Record<TaskStatus, string> = {
  todo: "bg-muted-foreground/50",
  in_progress: "bg-sky-500",
  done: "bg-emerald-500",
};

export const EMPTY_COLUMN_TEXT: Record<TaskStatus, string> = {
  todo: "No cards yet.",
  in_progress: "Nothing in progress. Move a card here to start its agent.",
  done: "Finished cards land here.",
};

export function StatusDot({ status, className }: { status: TaskStatus; className?: string }) {
  return (
    <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[status], className)} />
  );
}

function SortableTaskCard({
  task,
  activity,
  menuActions,
}: {
  task: Task;
  activity: string | undefined;
  menuActions: BoardMenuActions;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, data: { type: "task", status: task.status } });

  return (
    <CardContextMenu task={task} actions={menuActions}>
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        className="touch-manipulation rounded-lg data-[state=open]:*:ring-2 data-[state=open]:*:ring-ring/50"
      >
        <TaskCard
          task={task}
          placeholder={isDragging}
          activity={activity}
          activatorRef={setActivatorNodeRef}
          dragAttributes={attributes}
          dragListeners={listeners}
          onOpen={() => {
            if (!isDragging) menuActions.openCard(task.id);
          }}
        />
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
  onCreate?: (title: string) => Promise<boolean>;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `${COLUMN_DROPPABLE_PREFIX}${status}`,
    data: { type: "column", status },
  });
  const listRef = useRef<HTMLDivElement | null>(null);

  return (
    <section
      aria-label={STATUS_LABELS[status]}
      className="flex min-h-0 min-w-0 flex-col rounded-xl border bg-muted/40 dark:bg-muted/20"
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
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2 transition-colors",
          isOver && "bg-muted/60",
        )}
      >
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <div className="flex min-h-full flex-col gap-2 pt-0.5">
            {tasks.map((task) => (
              <SortableTaskCard
                key={task.id}
                task={task}
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
