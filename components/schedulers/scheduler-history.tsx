"use client";

import Link from "next/link";
import { CalendarClock, CircleCheck, Hand, TriangleAlert } from "lucide-react";
import { formatDateTime, formatRelative } from "@/components/board/format";
import { AgentStateBadge } from "@/components/board/task-card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { STATUS_LABELS, type RunStatus, type SchedulerRunView } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Link to a card: the board page opens its detail panel from `?task=`. */
export const schedulerCardHref = (boardId: string, taskId: string) =>
  `/b/${encodeURIComponent(boardId)}?task=${encodeURIComponent(taskId)}`;

const RUN_STATUS: Record<RunStatus, { label: string; className: string }> = {
  running: { label: "Agent running", className: "bg-primary/10 text-primary" },
  succeeded: { label: "Agent done", className: "bg-success/10 text-success" },
  failed: { label: "Agent failed", className: "bg-destructive/10 text-destructive" },
  aborted: { label: "Agent stopped", className: "bg-muted text-muted-foreground" },
};

/** A manual run's slot is the click time; only show the creation time when it differs noticeably. */
const SLOT_DRIFT_MS = 60_000;

/** Trigger of a run: fired by its cron schedule or by "Run now". */
export function TriggerBadge({ trigger }: { trigger: SchedulerRunView["trigger"] }) {
  return trigger === "manual" ? (
    <Badge variant="outline" className="gap-1">
      <Hand />
      Manual
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1">
      <CalendarClock />
      Scheduled
    </Badge>
  );
}

/** Whether a run created its card. */
export function RunResultBadge({ status }: { status: SchedulerRunView["status"] }) {
  return status === "created" ? (
    <Badge className="gap-1 bg-success/10 text-success">
      <CircleCheck />
      Card created
    </Badge>
  ) : (
    <Badge variant="destructive" className="gap-1">
      <TriangleAlert />
      Failed
    </Badge>
  );
}

/** Live state of the created card: its agent's state, else its latest run, else its column. */
function CardState({ run }: { run: SchedulerRunView }) {
  const task = run.task;
  if (!task) {
    return run.taskId ? (
      <Badge variant="secondary" title="The card was deleted after it was created">
        Deleted
      </Badge>
    ) : null;
  }
  if (task.agentState !== "idle") {
    return <AgentStateBadge state={task.agentState} agentError={task.agentError} />;
  }
  const runStatus = run.runStatus ? RUN_STATUS[run.runStatus] : null;
  return (
    <>
      <Badge variant="outline">{STATUS_LABELS[task.status]}</Badge>
      {runStatus && <Badge className={runStatus.className}>{runStatus.label}</Badge>}
    </>
  );
}

/**
 * Run history of a scheduler, newest first: when it fired, how (schedule or "Run now"), whether
 * the card was created (else the error) and the card with its live agent state. `boardId` is the
 * scheduler's project, where its cards live.
 */
export function SchedulerHistory({
  runs,
  boardId,
  now,
}: {
  /** null while loading. */
  runs: SchedulerRunView[] | null;
  boardId: string;
  now: number;
}) {
  if (runs === null) {
    return (
      <ul className="divide-y rounded-xl border" aria-busy="true" aria-label="Loading history">
        {[0, 1, 2].map((i) => (
          <li key={i} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-start sm:gap-4 sm:px-4">
            <div className="space-y-1.5 sm:w-48 sm:shrink-0">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-20" />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex gap-1.5">
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-5 w-24 rounded-full" />
              </div>
              <Skeleton className="h-4 max-w-full" style={{ width: `${12 + ((i * 5) % 9)}rem` }} />
            </div>
          </li>
        ))}
      </ul>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="flex animate-fade-in-soft flex-col items-center rounded-xl border border-dashed px-4 py-10 text-center">
        <CalendarClock className="size-6 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">No runs yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Each time the schedule fires (or you click Run now) a card is created and listed here.
        </p>
      </div>
    );
  }
  return (
    <ul className="divide-y rounded-xl border">
      {runs.map((run, index) => {
        const drift = Math.abs(new Date(run.createdAt).getTime() - new Date(run.scheduledFor).getTime());
        return (
          <li
            key={run.id}
            className="flex animate-card-in flex-col gap-2 px-3 py-3 content-auto [contain-intrinsic-size:auto_5.5rem] sm:flex-row sm:items-start sm:gap-4 sm:px-4"
            style={{ "--stagger": index } as React.CSSProperties}
          >
            <div className="shrink-0 sm:w-48">
              <p className="font-mono text-[0.8125rem] font-medium tabular-nums" title={formatDateTime(run.scheduledFor)}>
                {formatDateTime(run.scheduledFor)}
              </p>
              <p className="text-xs text-muted-foreground" title={formatDateTime(run.createdAt)}>
                {formatRelative(run.createdAt, now)}
                {drift > SLOT_DRIFT_MS && ` · ran ${formatDateTime(run.createdAt)}`}
              </p>
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <TriggerBadge trigger={run.trigger} />
                <RunResultBadge status={run.status} />
                <CardState run={run} />
              </div>
              {run.task ? (
                <Link
                  href={schedulerCardHref(boardId, run.task.id)}
                  className="block rounded text-sm font-medium break-words underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {run.task.title || "Untitled card"}
                </Link>
              ) : (
                run.taskId && <p className="text-sm text-muted-foreground">The card was deleted.</p>
              )}
              {run.error && (
                <p
                  className={cn(
                    "font-mono text-xs break-words whitespace-pre-wrap",
                    run.status === "failed" ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {run.error}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
