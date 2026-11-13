"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRightIcon, BotIcon, CpuIcon, LoaderCircleIcon, SquareIcon, ZapIcon } from "lucide-react";
import { toast } from "sonner";
import { errorMessage, formatDuration, formatRelative, useNow } from "@/components/board/format";
import { useNewCard } from "@/components/new-card";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { api } from "@/lib/api-client";
import type { DashboardLiveAgent, QueueEntry, QueueSnapshot } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FOCUS_RING, Panel, SectionTitle, cardHref, plural, useEntrance } from "./shared";

/** Rows shown; the rest are summarized with a link to the visual overview. */
const MAX_ROWS = 6;

/** Latest activity per card from live `run.event`s, newer than the dashboard payload's. */
export type LiveActivity = Record<string, { activity: string; at: string }>;

function AgentRow({
  entry,
  live,
  override,
  position,
  now,
  index,
}: {
  entry: QueueEntry;
  live: DashboardLiveAgent | undefined;
  override: LiveActivity[string] | undefined;
  /** 1-based place in the queue; 0 while running. */
  position: number;
  now: number;
  index: number;
}) {
  const [stopping, setStopping] = useState(false);
  const running = entry.state === "running";
  const fresh = override && (!live?.activityAt || override.at > live.activityAt) ? override : null;
  const activity = fresh?.activity ?? live?.activity ?? null;
  const activityAt = fresh?.at ?? live?.activityAt ?? null;

  const stop = async () => {
    setStopping(true);
    try {
      await api.tasks.stop(entry.taskId);
      toast(running ? "Agent stopped" : "Removed from the queue", { description: entry.title });
    } catch (err) {
      toast.error("Couldn't stop the agent", { description: errorMessage(err) });
    } finally {
      setStopping(false);
    }
  };

  const status = running
    ? null
    : entry.planning
      ? "being ordered by the smart queue"
      : entry.waitingFor.length > 0
        ? `waits for ${plural(entry.waitingFor.length, "card")}`
        : `#${position} in queue`;
  const enter = useEntrance()(index);

  return (
    <li style={enter.style} className={cn(enter.className, "flex items-start gap-2.5 py-2.5 first:pt-0 last:pb-0")}>
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-medium tabular-nums",
          running ? "bg-primary/10" : "bg-muted text-muted-foreground",
        )}
      >
        {running ? (
          <span className="relative flex size-2">
            <span className="animate-breathe absolute inset-0 rounded-full bg-primary" />
            <span className="relative size-2 rounded-full bg-primary" />
          </span>
        ) : (
          position
        )}
      </span>
      <Link
        href={cardHref({ boardId: entry.boardId, id: entry.taskId })}
        className={cn("pressable min-w-0 flex-1 rounded-md", FOCUS_RING)}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium" title={entry.title}>
            {entry.title}
          </span>
          {running && live?.startedAt && (
            <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground tabular-nums" title="Running for">
              {formatDuration(now - Date.parse(live.startedAt))}
            </span>
          )}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="max-w-[45%] shrink-0 truncate">{entry.boardName}</span>
          {live?.model && (
            <span className="inline-flex min-w-0 items-center gap-1 rounded border px-1 leading-4" title={`Model: ${live.model}`}>
              <CpuIcon className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{live.model}</span>
            </span>
          )}
          {status && <span className="truncate">· {status}</span>}
        </span>
        {running ? (
          <span
            className="mt-1 block truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
            title={activity ? `${activity}${activityAt ? ` — ${formatRelative(activityAt, now)}` : ""}` : undefined}
          >
            {activity ?? "Starting…"}
          </span>
        ) : (
          entry.planNote && <span className="mt-0.5 block truncate text-xs text-muted-foreground italic">{entry.planNote}</span>
        )}
      </Link>
      <Button
        variant="ghost"
        size="icon"
        className="size-11 shrink-0 text-muted-foreground hover:text-destructive md:size-7"
        disabled={stopping}
        onClick={() => void stop()}
        aria-label={running ? `Stop “${entry.title}”` : `Remove “${entry.title}” from the queue`}
        title={running ? "Stop the agent" : "Remove from the queue"}
      >
        {stopping ? <LoaderCircleIcon className="animate-spin" /> : <SquareIcon className="fill-current" />}
      </Button>
    </li>
  );
}

export function LiveAgents({
  queue,
  live,
  liveActivity,
}: {
  queue: QueueSnapshot;
  live: DashboardLiveAgent[];
  liveActivity: LiveActivity;
}) {
  const openNewCard = useNewCard();
  const { running, queued, limit, planning } = queue;
  // Elapsed times tick every second only while something runs.
  const now = useNow(running.length > 0 ? 1000 : 60_000);
  const busy = Math.min(running.length, limit);
  const entries = [...running, ...queued];
  const shown = entries.slice(0, MAX_ROWS);
  const liveById = new Map(live.map((agent) => [agent.taskId, agent]));

  return (
    <section aria-labelledby="home-agents">
      <SectionTitle
        id="home-agents"
        title="Live agents"
        action={
          <span className="text-xs text-muted-foreground">
            <span className="font-mono tabular-nums">
              {busy}/{limit}
            </span>{" "}
            slots{queued.length > 0 ? ` · ${queued.length} queued` : ""}
          </span>
        }
      />
      <Panel className="p-3">
        <div className="flex gap-1" role="img" aria-label={`${busy} of ${limit} agent slots busy`}>
          {Array.from({ length: limit }, (_, i) => (
            <span key={i} className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className={cn(
                  "absolute inset-0 rounded-full bg-primary opacity-0 transition-opacity duration-500 motion-reduce:transition-none",
                  i < busy && "opacity-100",
                )}
              />
            </span>
          ))}
        </div>
        {planning.length > 0 && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <LoaderCircleIcon className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Ordering the queue of {planning.map((p) => p.boardName).join(", ")}
          </p>
        )}
        {entries.length === 0 ? (
          <div className="flex items-start gap-3 pt-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <BotIcon className="size-4.5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">No agents working</p>
              <p className="text-xs text-pretty text-muted-foreground">Start a card to see its agent and current step here.</p>
              <button
                type="button"
                onClick={() => openNewCard()}
                className={cn(
                  "pressable mt-1 inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-medium text-primary hover:underline md:min-h-8",
                  FOCUS_RING,
                )}
              >
                <ZapIcon className="size-3.5" aria-hidden="true" />
                New task
                <Kbd className="hidden md:inline-flex">N</Kbd>
              </button>
            </div>
          </div>
        ) : (
          <ul className="mt-3 flex flex-col divide-y">
            {shown.map((entry, i) => (
              <AgentRow
                key={entry.taskId}
                entry={entry}
                live={liveById.get(entry.taskId)}
                override={liveActivity[entry.taskId]}
                position={entry.state === "running" ? 0 : i - running.length + 1}
                now={now}
                index={i}
              />
            ))}
          </ul>
        )}
        {entries.length > shown.length && (
          <Link
            href="/visualize"
            className={cn(
              "pressable mt-2 flex min-h-11 items-center gap-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground md:min-h-0",
              FOCUS_RING,
            )}
          >
            <span className="font-mono tabular-nums">{entries.length - shown.length}</span> more — view all
            <ArrowRightIcon className="size-3" aria-hidden="true" />
          </Link>
        )}
      </Panel>
    </section>
  );
}
