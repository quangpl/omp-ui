"use client";

import { Circle, CircleCheck, CircleDot, CircleSlash, ListChecks } from "lucide-react";
import { DetailSection } from "@/components/board/detail-section";
import { formatEta, useNow } from "@/components/board/format";
import { type Task, type TaskStatus, type TodoItemStatus, type TodoPhase } from "@/lib/types";
import { progressFraction, todoEta, todoProgress, type TodoProgress } from "@/lib/todos";
import { cn } from "@/lib/utils";

/**
 * "~12m": estimated time until a running agent finishes its todo list, at the pace of the items
 * it completed. Nothing while the agent isn't running or before its first completed item.
 * `verbose` also shows "left".
 */
export function TodoEta({
  task,
  verbose = false,
  className,
}: {
  task: Pick<Task, "agentState" | "todos">;
  verbose?: boolean;
  className?: string;
}) {
  // Only running cards start a clock.
  if (task.agentState !== "running") return null;
  return <RunningTodoEta todos={task.todos} verbose={verbose} className={className} />;
}

function RunningTodoEta({ todos, verbose, className }: { todos: TodoPhase[]; verbose: boolean; className?: string }) {
  const now = useNow(30_000);
  const eta = todoEta(todos, now);
  if (eta === null) return null;
  const label = formatEta(eta);
  return (
    <span
      className={cn("tabular-nums", className)}
      title={`About ${label} left, at the pace of the completed todo items`}
    >
      ~{label}
      <span className={verbose ? undefined : "sr-only"}> left</span>
    </span>
  );
}

const RADIUS = 6.25;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const RING_TONE: Record<TaskStatus, string> = {
  todo: "text-muted-foreground",
  in_progress: "text-primary",
  done: "text-success",
};

/**
 * "3 of 7 todo items done · Now: Add tests", or the card's column when there is no todo list.
 * Open feedback counted as pending items reads "7 of 7 todo items done · 1 open feedback".
 */
export function progressLabel(status: TaskStatus, progress: TodoProgress | null): string {
  if (status === "done") {
    return progress ? `Done · ${progress.done} of ${progress.total - progress.feedback} todo items done` : "Done";
  }
  if (!progress) return status === "todo" ? "To do · not started" : "In progress";
  let label = `${progress.done} of ${progress.total - progress.feedback} todo items done`;
  if (progress.feedback > 0) label += ` · ${progress.feedback} open feedback`;
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
  task: Pick<Task, "status" | "todos" | "openCommentCount">;
  className?: string;
}) {
  const progress = todoProgress(task.todos, task.openCommentCount);
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
  completed: { icon: CircleCheck, className: "text-success", label: "Done" },
  in_progress: { icon: CircleDot, className: "text-primary", label: "In progress" },
  pending: { icon: Circle, className: "text-muted-foreground/70", label: "Pending" },
  abandoned: { icon: CircleSlash, className: "text-muted-foreground/70", label: "Dropped" },
};

/** Card detail: the agent's todo list, by phase. Renders nothing when the agent never kept one. */
export function TodoListSection({
  task,
}: {
  task: Pick<Task, "status" | "agentState" | "todos" | "openCommentCount">;
}) {
  const progress = todoProgress(task.todos, task.openCommentCount);
  if (!progress) return null;
  return (
    <DetailSection
      icon={ListChecks}
      title="Progress"
      action={
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground tabular-nums">
          <TaskProgressIcon task={task} className="size-3.5" />
          {progress.done} of {progress.total - progress.feedback} done
          {progress.feedback > 0 && (
            <span className="before:mr-1.5 before:content-['·']">{progress.feedback} open feedback</span>
          )}
          <TodoEta task={task} verbose className="before:mr-1.5 before:content-['·']" />
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
