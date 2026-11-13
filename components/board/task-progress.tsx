"use client";

import { Circle, CircleCheck, CircleDot, CircleSlash, ListChecks } from "lucide-react";
import { DetailSection } from "@/components/board/detail-section";
import { type Task, type TaskStatus, type TodoItemStatus } from "@/lib/types";
import { progressFraction, todoProgress, type TodoProgress } from "@/lib/todos";
import { cn } from "@/lib/utils";

const RADIUS = 6.25;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const RING_TONE: Record<TaskStatus, string> = {
  todo: "text-muted-foreground",
  in_progress: "text-sky-600 dark:text-sky-400",
  done: "text-emerald-600 dark:text-emerald-400",
};

/** "3 of 7 todo items done · Now: Add tests", or the card's column when there is no todo list. */
export function progressLabel(status: TaskStatus, progress: TodoProgress | null): string {
  if (status === "done") {
    return progress ? `Done · ${progress.done} of ${progress.total} todo items done` : "Done";
  }
  if (!progress) return status === "todo" ? "To do · not started" : "In progress";
  const label = `${progress.done} of ${progress.total} todo items done`;
  return progress.current ? `${label} · Now: ${progress.current}` : label;
}

/**
 * A card's progress ring: filled by the agent's todo list when it kept one, else by the card's
 * column (To do: empty dashed ring, In progress: half, Done: full with a check).
 */
export function TaskProgressIcon({
  task,
  className,
}: {
  task: Pick<Task, "status" | "todos">;
  className?: string;
}) {
  const progress = todoProgress(task.todos);
  const fraction = progressFraction(task.status, progress);
  const label = progressLabel(task.status, progress);
  const notStarted = task.status === "todo" && fraction === 0;
  return (
    <svg
      viewBox="0 0 16 16"
      role="img"
      aria-label={label}
      className={cn("size-4 shrink-0", RING_TONE[task.status], className)}
      data-progress={Math.round(fraction * 100)}
    >
      <title>{label}</title>
      <circle
        cx="8"
        cy="8"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeDasharray={notStarted ? "2.2 2.2" : undefined}
        className={notStarted ? "opacity-70" : "opacity-20"}
      />
      {fraction > 0 && (
        <circle
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeDasharray={`${fraction * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
          transform="rotate(-90 8 8)"
          className="transition-[stroke-dasharray] duration-500 ease-out motion-reduce:transition-none"
        />
      )}
      {task.status === "done" && (
        <path
          d="M5.4 8.2 7.2 10l3.4-3.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

const ITEM_ICON: Record<TodoItemStatus, { icon: typeof Circle; className: string; label: string }> = {
  completed: { icon: CircleCheck, className: "text-emerald-600 dark:text-emerald-400", label: "Done" },
  in_progress: { icon: CircleDot, className: "text-sky-600 dark:text-sky-400", label: "In progress" },
  pending: { icon: Circle, className: "text-muted-foreground/70", label: "Pending" },
  abandoned: { icon: CircleSlash, className: "text-muted-foreground/70", label: "Dropped" },
};

/** Card detail: the agent's todo list, by phase. Renders nothing when the agent never kept one. */
export function TodoListSection({ task }: { task: Pick<Task, "status" | "todos"> }) {
  const progress = todoProgress(task.todos);
  if (!progress) return null;
  return (
    <DetailSection
      icon={ListChecks}
      title="Progress"
      action={
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground tabular-nums">
          <TaskProgressIcon task={task} className="size-3.5" />
          {progress.done} of {progress.total} done
        </span>
      }
    >
      <div className="flex flex-col gap-3 rounded-xl border px-3.5 py-3">
        {task.todos.map((phase, index) => (
          <div key={`${index}:${phase.name}`} className="flex min-w-0 flex-col gap-1.5">
            {phase.name && (
              <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{phase.name}</p>
            )}
            <ul className="flex flex-col gap-1">
              {phase.tasks.map((item, itemIndex) => {
                const { icon: Icon, className, label } = ITEM_ICON[item.status];
                return (
                  <li key={`${itemIndex}:${item.content}`} className="flex min-w-0 items-start gap-2 text-sm">
                    <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", className)} />
                    <span
                      className={cn(
                        "min-w-0 break-words",
                        item.status === "in_progress" && "font-medium",
                        (item.status === "completed" || item.status === "abandoned") &&
                          "text-muted-foreground line-through decoration-muted-foreground/50",
                      )}
                    >
                      {item.content}
                      <span className="sr-only"> ({label})</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </DetailSection>
  );
}
