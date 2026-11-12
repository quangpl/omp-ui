"use client";

import type { ReactNode, Ref } from "react";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { CircleCheck, Clock, LoaderCircle, MessageSquare, MessageSquareDot, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AgentState, Task } from "@/lib/types";

/** Small pill describing the agent attached to a card; renders nothing when idle. */
export function AgentStateBadge({ state, className }: { state: AgentState; className?: string }) {
  if (state === "queued") {
    return (
      <Badge variant="secondary" className={cn("gap-1", className)}>
        <Clock />
        Queued
      </Badge>
    );
  }
  if (state === "running") {
    return (
      <Badge
        className={cn(
          "gap-1 bg-sky-500/10 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
          className,
        )}
      >
        <LoaderCircle className="animate-spin" />
        Working
      </Badge>
    );
  }
  if (state === "error") {
    return (
      <Badge variant="destructive" className={cn("gap-1", className)}>
        <TriangleAlert />
        Failed
      </Badge>
    );
  }
  return null;
}

interface TaskCardProps {
  task: Task;
  onOpen?: () => void;
  /** Rendered as the floating copy under the pointer while dragging. */
  overlay?: boolean;
  /** Dimmed placeholder left in the list while the card is being dragged. */
  placeholder?: boolean;
  /** Drag activator wiring from dnd-kit's `useSortable` (`setActivatorNodeRef`, `attributes`, `listeners`). */
  activatorRef?: Ref<HTMLButtonElement>;
  dragAttributes?: DraggableAttributes;
  dragListeners?: DraggableSyntheticListeners;
  /** Always-visible quick actions row (mobile). */
  actions?: ReactNode;
  className?: string;
}

export function TaskCard({
  task,
  onOpen,
  overlay,
  placeholder,
  activatorRef,
  dragAttributes,
  dragListeners,
  actions,
  className,
}: TaskCardProps) {
  const done = task.status === "done";
  const preview = task.description
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const hasMeta = task.agentState !== "idle" || task.commentCount > 0;

  return (
    <div
      className={cn(
        "rounded-lg border bg-card text-card-foreground shadow-xs transition-[border-color,box-shadow,opacity]",
        done && "bg-card/70",
        overlay && "cursor-grabbing shadow-lg ring-1 ring-foreground/10 rotate-[1.5deg]",
        placeholder && "opacity-40",
        className,
      )}
    >
      <button
        ref={activatorRef}
        type="button"
        {...dragAttributes}
        {...dragListeners}
        onClick={onOpen}
        className={cn(
          "block w-full touch-manipulation rounded-lg p-3 text-left outline-none select-none",
          "focus-visible:ring-3 focus-visible:ring-ring/50 md:hover:bg-muted/40",
          actions && "rounded-b-none",
        )}
      >
        <span className="flex items-start gap-2">
          {done && (
            <CircleCheck
              aria-label="Done"
              className="mt-px size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
            />
          )}
          <span
            className={cn(
              "line-clamp-2 min-w-0 text-sm leading-snug font-medium break-words",
              done && "text-muted-foreground",
            )}
          >
            {task.title}
          </span>
        </span>
        {preview && (
          <span className="mt-1 block truncate text-xs text-muted-foreground">{preview}</span>
        )}
        {hasMeta && (
          <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <AgentStateBadge state={task.agentState} />
            {task.openCommentCount > 0 && (
              <span
                className="inline-flex h-5 items-center gap-1 rounded-full bg-amber-500/12 px-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
                title={`${task.openCommentCount} open feedback`}
              >
                <MessageSquareDot className="size-3" aria-hidden />
                {task.openCommentCount}
                <span className="sr-only">open feedback</span>
              </span>
            )}
            {task.commentCount > 0 && (
              <span
                className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums"
                title={`${task.commentCount} comments`}
              >
                <MessageSquare className="size-3.5" aria-hidden />
                {task.commentCount}
                <span className="sr-only">comments</span>
              </span>
            )}
          </span>
        )}
      </button>
      {actions && <div className="flex items-center border-t">{actions}</div>}
    </div>
  );
}
