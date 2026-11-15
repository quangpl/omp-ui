"use client";

import { GaugeIcon, MemoryStickIcon } from "lucide-react";
import { formatBytes } from "@/components/stats/shared";
import { formatDuration } from "@/components/board/format";
import { useLiveResources } from "@/hooks/use-board";
import type { AgentResources, Task } from "@/lib/types";

/** Memory/CPU to show for a card: the live sample of a running agent, or the last run's stored one. */
export interface AgentResourcesView {
  resources: AgentResources;
  /** True for a live sample of the running agent; false for the last run's stored sample. */
  live: boolean;
}

/**
 * A running card shows its current run's latest live sample (null until that run's first
 * `run.resources` event, which may never come where sampling is unsupported); any other card
 * shows the last run's stored sample, or null when there is none.
 */
export function useAgentResources(task: Task): AgentResourcesView | null {
  const live = useLiveResources(task.id, task.lastRunId);
  if (task.agentState === "running") return live ? { resources: live, live: true } : null;
  return task.resources ? { resources: task.resources, live: false } : null;
}

/** CPU time as a compact duration ("3m 20s"). */
const cpuTime = (resources: AgentResources) => formatDuration(resources.cpuSeconds * 1000);

const ITEM_CLASS = "inline-flex items-center gap-1 font-mono tabular-nums";

/**
 * Card meta row items: memory and CPU (live: current memory and CPU %; finished: peak memory and
 * CPU time). Both always show; the meta row wraps its right cluster when space runs short.
 */
export function CardResources({ task }: { task: Task }) {
  const view = useAgentResources(task);
  if (!view) return null;
  const { resources, live } = view;
  const memory = formatBytes(live ? resources.memoryBytes : resources.peakMemoryBytes);
  const peak = formatBytes(resources.peakMemoryBytes);
  const cpu = live ? `${Math.round(resources.cpuPercent)}%` : cpuTime(resources);
  return (
    <span
      role="group"
      aria-label={
        live
          ? `Agent resources: ${memory} memory, ${cpu} CPU`
          : `Last run: ${memory} peak memory, ${cpu} CPU time`
      }
      className="inline-flex items-center gap-2.5"
    >
      <span
        className={ITEM_CLASS}
        title={live ? `Agent memory: ${memory} now, ${peak} peak` : `Last run memory: ${peak} peak`}
      >
        <MemoryStickIcon className="size-3.5" aria-hidden />
        {memory}
      </span>
      <span
        className={ITEM_CLASS}
        title={
          live
            ? `Agent CPU: ${cpu} of one core now, ${cpuTime(resources)} CPU time so far`
            : `Last run CPU time: ${cpu}`
        }
      >
        <GaugeIcon className="size-3.5" aria-hidden />
        {cpu}
      </span>
    </span>
  );
}

/**
 * Value of the task detail's "Resources" row for a `view` from `useAgentResources`; callers
 * omit the row while there is none. Renders a primary line and a muted secondary line, each
 * truncating on its own inside the single-line `MetaItem` value; the wrapper's `title` carries
 * the full text.
 */
export function DetailResources({ view }: { view: AgentResourcesView }) {
  const { resources, live } = view;
  const peak = formatBytes(resources.peakMemoryBytes);
  const primary = live
    ? `${formatBytes(resources.memoryBytes)} · ${Math.round(resources.cpuPercent)}% CPU`
    : `${peak} peak · ${cpuTime(resources)} CPU time`;
  const secondary = live ? `peak ${peak} · ${cpuTime(resources)} CPU time` : "last run";
  const title = live
    ? `${primary} · ${secondary}`
    : `${primary} · ${secondary} · sampled ${new Date(resources.sampledAt).toLocaleString()}`;
  return (
    <span className="block min-w-0" title={title}>
      <span className="block truncate font-mono tabular-nums">{primary}</span>
      <span className="block truncate text-xs font-normal text-muted-foreground">{secondary}</span>
    </span>
  );
}
