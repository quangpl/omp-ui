"use client";

import { type CSSProperties, memo, type MouseEvent, type ReactNode, type Ref, useSyncExternalStore } from "react";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import {
  Bot,
  CircleHelp,
  Clock,
  Hourglass,
  ListChecks,
  LoaderCircle,
  MessageSquare,
  MessageSquareDot,
  RotateCw,
  Sparkles,
  Timer,
  TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBoardTasks, useQueueDrafting, useQueuePosition } from "@/hooks/use-board";
import { isQuotaError } from "@/lib/quota";
import { questionPreview } from "@/lib/question";
import { formatDateTime } from "@/components/board/format";
import { CardResources } from "@/components/board/agent-resources";
import { SdlcTrack, TaskProgressIcon, TodoEta } from "@/components/board/task-progress";
import { todoProgress } from "@/lib/todos";
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
 * Phone cards (the ones with a quick-actions footer): the card dips under the thumb while its body
 * or question strip is pressed, not its footer buttons. Desktop cards lift on hover instead
 * (`card-lift`). Lives on the card itself, never on the FLIP layer around it.
 */
const PRESS_FEEDBACK =
  "transition-[border-color,box-shadow,opacity,scale] duration-(--duration-press) ease-(--ease-fluid) has-[>button:active]:scale-[0.98] motion-reduce:transition-none";

/** Animated "…" after a running state's label; decorative. */
function WorkingDots() {
  return (
    <span aria-hidden className="ml-px inline-flex">
      {[0, 1, 2].map((dot) => (
        <span key={dot} className="animate-working-dot" style={{ "--dot": dot } as CSSProperties}>
          .
        </span>
      ))}
    </span>
  );
}

/**
 * Indeterminate loading bar along a running card's top edge: a segment sliding across a faint
 * track, clipped to the card's rounded corners.
 */
function WorkingBar() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden rounded-t-lg bg-primary/15"
    >
      <span className="block h-full w-2/5 animate-working-bar rounded-full bg-primary" />
    </span>
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
  agentError = null,
  drafting = false,
  className,
}: {
  state: AgentState;
  queuePosition?: number;
  /** Failed card with an automatic retry scheduled (Task.retryAt). */
  retryAt?: string | null;
  /** Last run's error (Task.agentError); a quota error turns "Retrying" into "Waiting for quota". */
  agentError?: string | null;
  /** Queued card the card writer is still writing (`useQueueDrafting`). */
  drafting?: boolean;
  className?: string;
}) {
  if (state === "queued" && drafting) {
    return (
      <Badge
        className={cn("gap-1 bg-primary/10 text-primary dark:bg-primary/15", className)}
        title="Writing the title and brief; the agent starts next"
      >
        <Sparkles className="animate-pulse motion-reduce:animate-none" />
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
        className={cn("relative gap-1 bg-primary/10 text-primary dark:bg-primary/15", className)}
        title="The agent is working on this card"
      >
        <span aria-hidden className="pointer-events-none absolute inset-0 animate-working-shine" />
        <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" />
        {/* Own element so the label still reads exactly "Working" (e2e getByText exact). */}
        <span className="inline-flex">
          <span>Working</span>
          <WorkingDots />
        </span>
      </Badge>
    );
  }
  if (state === "error" && retryAt && isQuotaError(agentError)) {
    return (
      <Badge
        variant="secondary"
        className={cn("gap-1", className)}
        title={`Quota or usage limit reached — retrying automatically at ${new Date(retryAt).toLocaleTimeString()}`}
      >
        <Timer />
        Waiting for quota
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

/**
 * Splits `text` into alternating plain/matched runs; consecutive `indices` (ascending UTF-16
 * positions of matched characters) merge into one run.
 */
function highlightRuns(text: string, indices: readonly number[]): { text: string; match: boolean }[] {
  const runs: { text: string; match: boolean }[] = [];
  let cursor = 0;
  let i = 0;
  while (i < indices.length) {
    const start = indices[i];
    if (start < cursor || start >= text.length) {
      i++;
      continue;
    }
    let end = start + 1;
    while (i + 1 < indices.length && indices[i + 1] === end && end < text.length) {
      end++;
      i++;
    }
    i++;
    if (start > cursor) runs.push({ text: text.slice(cursor, start), match: false });
    runs.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) runs.push({ text: text.slice(cursor), match: false });
  return runs;
}

/** Card title with the board search's matched characters marked. */
function HighlightedTitle({ text, indices }: { text: string; indices: readonly number[] | undefined }) {
  if (!indices || indices.length === 0) return text;
  return highlightRuns(text, indices).map((run, i) =>
    run.match ? (
      <mark key={i} className="rounded-[3px] bg-primary/15 text-foreground">
        {run.text}
      </mark>
    ) : (
      run.text
    ),
  );
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
  /** Title character positions matched by the board search; marked in the title. */
  highlight?: readonly number[];
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
  highlight,
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
  const progress = todoProgress(task.todos, task.openCommentCount);
  const showQuickActions = Boolean(quickActions) && !overlay && !placeholder;
  const pinnedSlots = showQuickActions ? pinnedQuickActions : 0;

  return (
    <div
      data-selected={selected || undefined}
      className={cn(
        "group/card relative rounded-lg border bg-card text-card-foreground shadow-xs transition-[border-color,box-shadow,opacity]",
        done && !selected && "bg-card/70",
        !overlay && !placeholder && (actions ? PRESS_FEEDBACK : "card-lift"),
        overlay && "cursor-grabbing shadow-diffuse ring-1 ring-foreground/10 rotate-[1.5deg] scale-[1.02]",
        placeholder && "opacity-40",
        // Outline, not ring: the hover lift (card-lift) replaces box-shadow.
        selected &&
          "border-primary/60 bg-[color-mix(in_srgb,var(--card),var(--primary)_7%)] outline-2 outline-primary/30",
        className,
      )}
    >
      {task.agentState === "running" && !placeholder && <WorkingBar />}
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
          <TaskProgressIcon task={task} className="mt-px max-md:mt-0.5" />
          <span
            className={cn(
              "line-clamp-2 min-w-0 text-sm leading-snug font-medium tracking-[-0.005em] text-pretty break-words max-md:text-[0.9375rem]",
              done && "text-muted-foreground",
              task.pushedAt && "line-through",
            )}
            title={task.pushedAt ? "Pushed to main" : undefined}
          >
            <HighlightedTitle text={task.title} indices={highlight} />
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
        {/* Meta row: agent state and flags on the left, conversation, agent resources and age on the
            right. The right cluster wraps under the flags once they'd get less than `basis-20`. */}
        <span className="mt-2.5 flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="flex min-w-0 grow basis-20 flex-wrap items-center gap-1.5">
            <AgentStateBadge
              state={task.agentState}
              queuePosition={queuePosition}
              retryAt={task.retryAt}
              agentError={task.agentError}
              drafting={drafting}
            />
            <SdlcTrack task={task} />
            {waitingFor.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex h-5 items-center gap-1 rounded-full bg-secondary px-1.5 text-[11px] font-medium text-secondary-foreground">
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
          <span className="ml-auto flex shrink-0 items-center gap-2.5 text-[11px] text-muted-foreground">
            {progress && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 font-mono tabular-nums",
                  progress.done === progress.total && "text-success",
                )}
                title={`${progress.done} of ${progress.total - progress.feedback} todo items done${progress.feedback > 0 ? ` · ${progress.feedback} open feedback` : ""}${progress.current ? ` · Now: ${progress.current}` : ""}`}
              >
                <ListChecks className="size-3.5" aria-hidden />
                {progress.done}/{progress.total}
                <span className="sr-only">todo items done</span>
                <TodoEta task={task} className="before:mr-1 before:content-['·']" />
              </span>
            )}
            {task.commentCount > 0 && (
              <span
                className="inline-flex items-center gap-1 font-mono tabular-nums"
                title={`${task.commentCount} comments`}
              >
                <MessageSquare className="size-3.5" aria-hidden />
                {task.commentCount}
                <span className="sr-only">comments</span>
              </span>
            )}
            <CardResources task={task} />
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
