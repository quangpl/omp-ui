"use client";

import { memo, type MouseEvent, type ReactNode, type Ref, useSyncExternalStore } from "react";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import {
  Bot,
  CircleCheck,
  CircleHelp,
  Clock,
  Hourglass,
  LoaderCircle,
  MessageSquare,
  MessageSquareDot,
  RotateCw,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBoardTasks, useQueueDrafting, useQueuePosition } from "@/hooks/use-board";
import { questionPreview } from "@/lib/question";
import { formatDateTime } from "@/components/board/format";
import { cn } from "@/lib/utils";
import type { AgentState, Task } from "@/lib/types";

// One shared minute clock for every card's age label, instead of a timer per card.
const minuteListeners = new Set<() => void>();
let minuteNow = Date.now();
let minuteTimer: number | undefined;

function subscribeMinute(listener: () => void): () => void {
  minuteListeners.add(listener);
  if (minuteTimer === undefined) {
    minuteNow = Date.now();
    minuteTimer = window.setInterval(() => {
      minuteNow = Date.now();
      for (const notify of minuteListeners) notify();
    }, 60_000);
  }
  return () => {
    minuteListeners.delete(listener);
    if (minuteListeners.size === 0) {
      window.clearInterval(minuteTimer);
      minuteTimer = undefined;
    }
  };
}

const getMinuteNow = () => minuteNow;

const AGE_UNITS: Array<[suffix: string, seconds: number]> = [
  ["y", 31_536_000],
  ["mo", 2_592_000],
  ["w", 604_800],
  ["d", 86_400],
  ["h", 3_600],
  ["m", 60],
];

/** Compact age for the card meta row: "now", "12m", "3h", "2d"… */
function shortAge(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const seconds = Math.max(0, (now - time) / 1000);
  for (const [suffix, size] of AGE_UNITS) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${suffix}`;
  }
  return "now";
}

/** Time since the card last changed; re-renders on the shared minute clock only. */
function CardAge({ iso }: { iso: string }) {
  const now = useSyncExternalStore(subscribeMinute, getMinuteNow, getMinuteNow);
  const label = shortAge(iso, now);
  if (!label) return null;
  return (
    <time dateTime={iso} title={`Updated ${formatDateTime(iso)}`} className="tabular-nums">
      <span className="sr-only">updated </span>
      {label}
    </time>
  );
}

/**
 * Small pill describing the agent attached to a card; renders nothing when idle.
 * `queuePosition` (0-based) turns "Queued" into "#N in queue".
 */
export function AgentStateBadge({
  state,
  queuePosition = -1,
  retryAt = null,
  drafting = false,
  className,
}: {
  state: AgentState;
  queuePosition?: number;
  /** Failed card with an automatic retry scheduled (Task.retryAt). */
  retryAt?: string | null;
  /** Queued card the card writer is still writing (`useQueueDrafting`). */
  drafting?: boolean;
  className?: string;
}) {
  if (state === "queued" && drafting) {
    return (
      <Badge
        className={cn("gap-1 bg-violet-500/10 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300", className)}
        title="The card agent is writing the title and brief; the agent starts right after"
      >
        <Sparkles className="animate-pulse" />
        Writing card
      </Badge>
    );
  }
  if (state === "queued") {
    return (
      <Badge variant="secondary" className={cn("gap-1", className)}>
        <Clock />
        {queuePosition >= 0 ? `#${queuePosition + 1} in queue` : "Queued"}
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
  if (state === "error" && retryAt) {
    return (
      <Badge
        className={cn("gap-1 bg-amber-500/10 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300", className)}
        title={`Failed — retrying automatically at ${new Date(retryAt).toLocaleTimeString()}`}
      >
        <RotateCw />
        Retrying
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
  /** Card click; the event lets callers treat modifier clicks differently (desktop multi-select). */
  onOpen?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Rendered as the floating copy under the pointer while dragging. */
  overlay?: boolean;
  /** Dimmed placeholder left in the list while the card is being dragged. */
  placeholder?: boolean;
  /** Picked for a bulk quick action (desktop multi-select). */
  selected?: boolean;
  /** Drag activator wiring from dnd-kit's `useSortable` (`setActivatorNodeRef`, `attributes`, `listeners`). */
  activatorRef?: Ref<HTMLButtonElement>;
  dragAttributes?: DraggableAttributes;
  dragListeners?: DraggableSyntheticListeners;
  /** Latest agent activity line; shown under the title while the agent runs. */
  activity?: string;
  /**
   * Click handler of the question strip (shown when the agent left a question): send the card
   * back to To do and open it on the question. Without it the strip renders inert (drag overlay).
   */
  onAnswer?: () => void;
  /** Always-visible quick actions row (mobile). */
  actions?: ReactNode;
  /** Desktop hover/focus quick-action strip, pinned to the card's top-right corner (outside the card button). */
  quickActions?: ReactNode;
  /**
   * Corner slots of `quickActions` that stay visible (Stop, Retry, Push to main), counted from the
   * right; the title keeps clear of them.
   */
  pinnedQuickActions?: number;
  className?: string;
}

export const TaskCard = memo(function TaskCard({
  task,
  onOpen,
  overlay,
  placeholder,
  selected = false,
  activatorRef,
  dragAttributes,
  dragListeners,
  activity,
  onAnswer,
  actions,
  quickActions,
  pinnedQuickActions = 0,
  className,
}: TaskCardProps) {
  const done = task.status === "done";
  const preview = task.description
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const queuePosition = useQueuePosition(task.id);
  const drafting = useQueueDrafting(task.id) && task.agentState === "queued";
  // Only cards with dependencies re-render when other cards change.
  const boardTasks = useBoardTasks(task.blockedBy.length > 0 && !done);
  const waitingFor = done
    ? []
    : task.blockedBy
        .map((id) => boardTasks.get(id))
        .filter((blocker): blocker is Task => blocker !== undefined && blocker.status !== "done");
  const showQuickActions = Boolean(quickActions) && !overlay && !placeholder;
  const pinnedSlots = showQuickActions ? pinnedQuickActions : 0;

  return (
    <div
      data-selected={selected || undefined}
      className={cn(
        "group/card relative rounded-lg border bg-card text-card-foreground shadow-xs transition-[border-color,box-shadow,opacity]",
        done && !selected && "bg-card/70",
        !overlay && !placeholder && "card-lift",
        overlay && "cursor-grabbing shadow-xl ring-1 ring-foreground/10 rotate-[1.5deg] scale-[1.02]",
        placeholder && "opacity-40",
        // Outline, not ring: the hover lift (card-lift) replaces box-shadow.
        selected &&
          "border-primary/60 bg-[color-mix(in_srgb,var(--card),var(--primary)_7%)] outline-2 outline-primary/30",
        className,
      )}
    >
      <button
        ref={activatorRef}
        type="button"
        data-task-id={overlay ? undefined : task.id}
        {...dragAttributes}
        {...dragListeners}
        onClick={onOpen}
        className={cn(
          "block w-full touch-manipulation rounded-lg px-3 pt-2.5 pb-2.5 text-left outline-none select-none max-md:px-3.5 max-md:pt-3",
          "transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 md:hover:bg-muted/40",
          (actions || task.question) && "rounded-b-none",
        )}
      >
        <span className={cn("flex items-start gap-2", pinnedSlots === 1 && "pr-7", pinnedSlots > 1 && "pr-14")}>
          {done && (
            <CircleCheck
              aria-label="Done"
              className="mt-px size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
            />
          )}
          <span
            className={cn(
              "line-clamp-2 min-w-0 text-sm leading-snug font-medium tracking-[-0.005em] text-pretty break-words max-md:text-[0.9375rem]",
              done && "text-muted-foreground",
              task.pushedAt && "line-through",
            )}
            title={task.pushedAt ? "Pushed to main" : undefined}
          >
            {task.title}
            {task.pushedAt && <span className="sr-only"> (pushed to main)</span>}
            {selected && <span className="sr-only"> (selected)</span>}
          </span>
        </span>
        {(task.agentState === "running" || drafting) && activity ? (
          <span
            className="mt-1 block truncate font-mono text-[11px] leading-4 text-muted-foreground"
            title={activity}
          >
            {activity}
          </span>
        ) : (
          preview && (
            <span className="mt-1 block truncate text-xs leading-4 text-muted-foreground">{preview}</span>
          )
        )}
        {/* Meta row: agent state and flags on the left, conversation and age on the right. */}
        <span className="mt-2.5 flex min-h-5 items-center gap-2">
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <AgentStateBadge
              state={task.agentState}
              queuePosition={queuePosition}
              retryAt={task.retryAt}
              drafting={drafting}
            />
            {waitingFor.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex h-5 items-center gap-1 rounded-full bg-violet-500/10 px-1.5 text-[11px] font-medium text-violet-700 dark:bg-violet-400/15 dark:text-violet-300">
                    <Hourglass className="size-3" aria-hidden />
                    Waiting for {waitingFor.length}
                    <span className="sr-only">
                      {waitingFor.length === 1 ? " card: " : " cards: "}
                      {waitingFor.map((blocker) => blocker.title).join(", ")}
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="flex-col items-start gap-0.5">
                  <span className="font-medium">Starts after:</span>
                  {waitingFor.map((blocker) => (
                    <span key={blocker.id} className="max-w-60 truncate">
                      {blocker.title}
                    </span>
                  ))}
                </TooltipContent>
              </Tooltip>
            )}
            {Boolean(task.createdByTaskId) && (
              <span
                className="inline-flex size-5 items-center justify-center rounded-full bg-muted text-muted-foreground"
                title="Created by an agent"
              >
                <Bot className="size-3" aria-hidden />
                <span className="sr-only">Created by an agent</span>
              </span>
            )}
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
          </span>
          <span className="flex shrink-0 items-center gap-2.5 text-[11px] text-muted-foreground">
            {task.commentCount > 0 && (
              <span
                className="inline-flex items-center gap-1 tabular-nums"
                title={`${task.commentCount} comments`}
              >
                <MessageSquare className="size-3.5" aria-hidden />
                {task.commentCount}
                <span className="sr-only">comments</span>
              </span>
            )}
            <CardAge iso={task.updatedAt} />
          </span>
        </span>
      </button>
      {task.question && (
        <button
          type="button"
          onClick={onAnswer}
          disabled={!onAnswer}
          title={task.question}
          className={cn(
            "flex w-full items-start gap-2 border-t border-amber-500/25 bg-amber-500/10 px-3 py-2 text-left outline-none max-md:px-3.5 max-md:py-2.5",
            !actions && "rounded-b-lg",
            onAnswer &&
              "transition-colors hover:bg-amber-500/20 focus-visible:ring-3 focus-visible:ring-ring/50",
          )}
        >
          <CircleHelp aria-hidden className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-semibold text-amber-800 dark:text-amber-200">
              The agent has a question
            </span>
            <span className="line-clamp-2 text-xs break-words text-amber-900/90 dark:text-amber-100/90">
              {questionPreview(task.question)}
            </span>
            <span className="sr-only">Answer it: moves the card back to To do and opens it</span>
          </span>
          {onAnswer && (
            <span className="mt-0.5 shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-200">
              Answer
            </span>
          )}
        </button>
      )}
      {showQuickActions && quickActions}
      {actions && <div className="flex items-stretch border-t">{actions}</div>}
    </div>
  );
});
