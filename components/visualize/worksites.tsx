"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { ServerIcon, TriangleAlertIcon } from "lucide-react";
import { formatDateTime, formatRelative } from "@/components/board/format";
import { boardHref, cardHref, plural } from "@/components/home/shared";
import { workerIdentity } from "@/components/visualize/game";
import { modelLabel } from "@/components/visualize/roles";
import { WorkerAvatar } from "@/components/visualize/worker-avatar";
import { type Dashboard, type DashboardBoard, type QueueEntry, TASK_STATUSES, type TaskStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Ticks on a production strip; bigger projects scale down to this many. */
const MAX_TICKS = 40;
/** Workers drawn per worksite before the rest collapse into "+N". */
const MAX_WORKERS_SHOWN = 5;

/** Strip order: shipped work on the left, untouched work on the right. */
const STRIP_ORDER = ["done", "in_progress", "todo"] as const satisfies readonly TaskStatus[];

/** Board columns, not queue state: an "in progress" card may still be waiting for a station. */
const STATUS_COPY: Record<TaskStatus, string> = {
  todo: "to do",
  in_progress: "in progress",
  done: "shipped",
};

const TICK_PAINT: Record<TaskStatus, string> = {
  done: "bg-success",
  in_progress: "bg-signal",
  todo: "bg-floor-paint shadow-[inset_0_0_0_1px_var(--color-border)]",
};

/**
 * Ticks per status: one per card up to MAX_TICKS, else scaled down to MAX_TICKS by largest
 * remainder, keeping at least one tick for every status that has cards.
 */
function stripTicks(counts: Record<TaskStatus, number>, total: number): Record<TaskStatus, number> {
  if (total <= MAX_TICKS) return counts;
  const exact = STRIP_ORDER.map((s) => (counts[s] / total) * MAX_TICKS);
  const ticks = STRIP_ORDER.map((s, i) => (counts[s] > 0 ? Math.max(1, Math.floor(exact[i])) : 0));
  let left = MAX_TICKS - ticks.reduce((sum, n) => sum + n, 0);
  while (left > 0) {
    let best = 0;
    for (let i = 1; i < ticks.length; i++) {
      if (exact[i] - ticks[i] > exact[best] - ticks[best]) best = i;
    }
    ticks[best]++;
    left--;
  }
  while (left < 0) {
    let biggest = 0;
    for (let i = 1; i < ticks.length; i++) {
      if (ticks[i] > ticks[biggest]) biggest = i;
    }
    ticks[biggest]--;
    left++;
  }
  return { done: ticks[0], in_progress: ticks[1], todo: ticks[2] };
}

/** One tick per card, painted by status, on a painted floor line. */
function ProductionStrip({ board, total }: { board: DashboardBoard; total: number }) {
  const ticks = stripTicks(board.counts, total);
  const label =
    total === 0
      ? `${board.name}: no cards`
      : `${board.name}: ${STRIP_ORDER.map((s) => `${board.counts[s]} ${STATUS_COPY[s]}`).join(", ")}`;
  return (
    <div role="img" aria-label={label} className="border-b-2 border-floor-paint pb-1">
      {total === 0 ? (
        <p className="flex h-6 items-center font-mono text-xs text-muted-foreground">No cards on site yet</p>
      ) : (
        <div className="grid h-6 grid-cols-[repeat(40,minmax(0,1fr))] gap-[3px]">
          {STRIP_ORDER.flatMap((s) =>
            Array.from({ length: ticks[s] }, (_, i) => (
              <span key={`${s}-${i}`} className={cn("h-full rounded-[1px]", TICK_PAINT[s])} />
            )),
          )}
        </div>
      )}
    </div>
  );
}

/** The workers on site right now: one robot per running card, each linking to its card; the model is in its tooltip, the cluster node under the robot. */
function Crew({ running, models }: { running: QueueEntry[]; models: ReadonlyMap<string, string | null> }) {
  if (running.length === 0) {
    return <span className="font-mono text-xs text-muted-foreground">Site quiet</span>;
  }
  const shown = running.slice(0, MAX_WORKERS_SHOWN);
  return (
    <ul aria-label={`${plural(running.length, "worker")} on site`} className="flex items-start gap-1">
      {shown.map((entry) => {
        const worker = workerIdentity(entry.taskId);
        const model = models.get(entry.taskId);
        const label = `${worker.name} on ${entry.title}${model ? `, model ${modelLabel(model)}` : ""}${entry.node ? `, running on cluster node ${entry.node.name}` : ""}`;
        return (
          <li key={entry.taskId}>
            <Link
              href={cardHref({ boardId: entry.boardId, id: entry.taskId })}
              title={label}
              aria-label={label}
              className="flex max-w-14 min-w-0 flex-col items-center gap-0.5 rounded-[3px] p-0.5 outline-none transition-transform hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-signal active:scale-[0.98]"
            >
              <WorkerAvatar hue={worker.hue} mood="working" className="size-7" />
              {entry.node && (
                <span
                  aria-hidden
                  className="inline-flex max-w-full min-w-0 items-center gap-0.5 rounded-[3px] border border-border px-0.5 font-mono text-[9px] leading-[12px] text-muted-foreground"
                >
                  <ServerIcon className="size-2 shrink-0" />
                  <span className="truncate">{entry.node.name}</span>
                </span>
              )}
            </Link>
          </li>
        );
      })}
      {running.length > shown.length && (
        <li className="self-center pl-1 font-mono text-xs text-muted-foreground tabular-nums">+{running.length - shown.length}</li>
      )}
    </ul>
  );
}

function WorksiteRow({
  board,
  running,
  models,
  now,
  index,
}: {
  board: DashboardBoard;
  running: QueueEntry[];
  /** Lead model by card id, when known. */
  models: ReadonlyMap<string, string | null>;
  now: number;
  index: number;
}) {
  const total = TASK_STATUSES.reduce((sum, s) => sum + board.counts[s], 0);
  const pct = total === 0 ? 0 : Math.round((board.counts.done / total) * 100);
  const live = running.length > 0;
  const scaled = total > MAX_TICKS;
  return (
    <li
      className="grid animate-floor-in grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-4 py-6 lg:grid-cols-[minmax(11rem,17rem)_minmax(0,1fr)_7rem] lg:items-center lg:gap-x-10"
      style={{ "--i": index } as CSSProperties}
    >
      {/* Site name, recency, attention */}
      <div className="col-start-1 row-start-1 grid min-w-0 gap-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {live && (
            <span aria-hidden className="relative flex size-2.5 shrink-0">
              <span className="absolute inset-0 animate-lamp rounded-full bg-signal" />
              <span className="relative size-2.5 rounded-full bg-signal" />
            </span>
          )}
          <Link
            href={boardHref(board.id)}
            className="-my-1 inline-block min-w-0 truncate py-1 text-xl font-semibold tracking-tight underline-offset-4 outline-none transition-transform hover:underline focus-visible:underline active:scale-[0.98] sm:text-2xl"
          >
            {board.name}
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
          <time dateTime={board.lastActivityAt} title={formatDateTime(board.lastActivityAt)}>
            Active {formatRelative(board.lastActivityAt, now)}
          </time>
          {board.attentionCount > 0 && (
            <span className="flex items-center gap-1 text-destructive tabular-nums">
              <TriangleAlertIcon aria-hidden className="size-3.5" />
              {board.attentionCount} {board.attentionCount === 1 ? "needs" : "need"} a hand
            </span>
          )}
        </div>
      </div>

      {/* Production line: strip, counts, crew */}
      <div className="col-span-2 row-start-2 grid min-w-0 gap-2.5 lg:col-span-1 lg:col-start-2 lg:row-start-1">
        <ProductionStrip board={board} total={total} />
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
            {STRIP_ORDER.map((s) => (
              <li key={s} className="flex items-center gap-1.5">
                <span aria-hidden className={cn("size-2 rounded-[1px]", TICK_PAINT[s])} />
                <span
                  className={cn(
                    "tabular-nums",
                    s === "in_progress" && board.counts[s] > 0 ? "text-signal-ink" : "text-foreground",
                  )}
                >
                  {board.counts[s]}
                </span>
                {STATUS_COPY[s]}
              </li>
            ))}
            {scaled && <li>1 tick ≈ {(total / MAX_TICKS).toFixed(1)} cards</li>}
          </ul>
          <Crew running={running} models={models} />
        </div>
      </div>

      {/* Shipped share */}
      <div className="col-start-2 row-start-1 text-right lg:col-start-3">
        <p
          className={cn(
            "text-5xl font-semibold tabular-nums tracking-[-0.05em] leading-none sm:text-6xl",
            total === 0 ? "text-muted-foreground" : pct === 100 ? "text-success" : "text-foreground",
          )}
        >
          <span key={pct} className="animate-digit-roll">
            {pct}
          </span>
          <span className="text-2xl text-muted-foreground">%</span>
        </p>
        <p className="mt-1.5 font-mono text-xs text-muted-foreground">shipped</p>
      </div>
    </li>
  );
}

/** Every project as a worksite: its production strip, crew on site, attention and recency. */
export function Worksites({ dashboard, now }: { dashboard: Dashboard; now: number }) {
  const { boards, queue } = dashboard;
  const runningByBoard = new Map<string, QueueEntry[]>();
  for (const entry of queue.running) {
    const list = runningByBoard.get(entry.boardId);
    if (list) list.push(entry);
    else runningByBoard.set(entry.boardId, [entry]);
  }
  const active = boards.filter((b) => runningByBoard.has(b.id)).length;
  const models = new Map(dashboard.live.map((agent) => [agent.taskId, agent.model]));

  return (
    <section aria-labelledby="viz-worksites" className="min-w-0">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b pb-3">
        <h2 id="viz-worksites" className="text-2xl font-semibold tracking-tight">
          Worksites
        </h2>
        <p className="font-mono text-xs text-muted-foreground tabular-nums">
          {plural(boards.length, "site")}
          {boards.length > 0 && <>, {active} with a crew on site</>}
        </p>
      </header>
      {boards.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">No worksites yet. Create a project to break ground.</p>
      ) : (
        <ul className="divide-y">
          {boards.map((board, index) => (
            <WorksiteRow
              key={board.id}
              board={board}
              running={runningByBoard.get(board.id) ?? []}
              models={models}
              now={now}
              index={index}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
