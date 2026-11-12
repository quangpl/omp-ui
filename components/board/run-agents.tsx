"use client";

import { useState } from "react";
import {
  ChevronRight,
  CircleCheck,
  CircleSlash,
  CircleX,
  Hourglass,
  LoaderCircle,
  Network,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SUBAGENT_STATUS_LABELS } from "@/lib/subagents";
import type { SubagentSnapshot, SubagentStatus } from "@/lib/types";
import { formatDuration } from "@/components/board/format";
import { RichText } from "@/components/board/rich-text";

/** Above this many subagents, finished ones fold away while others still work. */
const FOLD_FINISHED_OVER = 4;

/** Display order: what needs attention first. */
const STATUS_RANK: Record<SubagentStatus, number> = {
  running: 0,
  pending: 1,
  failed: 2,
  aborted: 3,
  completed: 4,
};

const STATUS_STYLE: Record<SubagentStatus, { icon: string; bar: string }> = {
  running: { icon: "text-sky-600 dark:text-sky-400", bar: "bg-sky-500" },
  pending: { icon: "text-muted-foreground", bar: "bg-muted-foreground/40" },
  completed: { icon: "text-emerald-600 dark:text-emerald-400", bar: "bg-emerald-500" },
  failed: { icon: "text-destructive", bar: "bg-destructive" },
  aborted: { icon: "text-muted-foreground", bar: "bg-muted-foreground/60" },
};

export function SubagentStatusIcon({ status, className }: { status: SubagentStatus; className?: string }) {
  const props = {
    "aria-label": SUBAGENT_STATUS_LABELS[status],
    className: cn("size-3.5 shrink-0", STATUS_STYLE[status].icon, className),
  };
  switch (status) {
    case "running":
      return <LoaderCircle {...props} className={cn(props.className, "animate-spin")} />;
    case "pending":
      return <Hourglass {...props} />;
    case "completed":
      return <CircleCheck {...props} />;
    case "failed":
      return <CircleX {...props} />;
    case "aborted":
      return <CircleSlash {...props} />;
  }
}

/** DOM id of a subagent's card, so timeline chips can jump to it. */
export function subagentAnchor(runId: string, agentId: string): string {
  return `subagent-${runId}-${agentId.replace(/[^\w-]/g, "_")}`;
}

function compareSubagents(a: SubagentSnapshot, b: SubagentSnapshot): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER) ||
    a.id.localeCompare(b.id)
  );
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function firstLine(text: string | undefined): string | undefined {
  return text
    ?.split("\n")
    .map((line) => line.replace(/^[#>*\-\s]+/, "").trim())
    .find(Boolean);
}

/** One line on what the subagent is doing now, or how it ended. */
function Activity({ agent }: { agent: SubagentSnapshot }) {
  if (agent.status === "running" && agent.currentTool) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Wrench className="size-3 shrink-0" />
        <span className="shrink-0 font-mono text-foreground/80">{agent.currentTool}</span>
        {agent.currentToolDetail && <span className="truncate">{agent.currentToolDetail}</span>}
      </span>
    );
  }
  let text: string;
  switch (agent.status) {
    case "running":
      text = agent.intent ?? agent.description ?? "Starting…";
      break;
    case "pending":
      text = "Waiting for a free slot";
      break;
    case "completed":
      text = firstLine(agent.output) ?? agent.description ?? "Finished";
      break;
    case "failed":
      text = agent.error ?? "Failed";
      break;
    case "aborted":
      text = agent.error ?? "Stopped before finishing";
      break;
  }
  return <span className={cn("truncate", agent.status === "failed" && "text-destructive")}>{text}</span>;
}

function Metrics({ agent }: { agent: SubagentSnapshot }) {
  const parts = [
    agent.toolCount ? `${agent.toolCount} tool call${agent.toolCount === 1 ? "" : "s"}` : null,
    agent.requests ? `${agent.requests} request${agent.requests === 1 ? "" : "s"}` : null,
    agent.tokens ? `${formatTokens(agent.tokens)} tokens` : null,
    agent.cost ? `$${agent.cost.toFixed(agent.cost < 0.01 ? 4 : 2)}` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return <div className="text-[11px] text-muted-foreground tabular-nums">{parts.join(" · ")}</div>;
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</h4>
      {children}
    </div>
  );
}

function SubagentCard({ runId, agent }: { runId: string; agent: SubagentSnapshot }) {
  const parent = agent.id.includes(".") ? agent.id.slice(0, agent.id.lastIndexOf(".")) : null;
  const recentOutput = agent.recentOutput?.slice().reverse();
  return (
    <li
      id={subagentAnchor(runId, agent.id)}
      data-testid="subagent"
      data-status={agent.status}
      className={cn(
        "scroll-mt-16 rounded-lg border bg-card text-sm transition-colors",
        agent.status === "running" && "border-sky-500/30",
        agent.status === "failed" && "border-destructive/30",
      )}
    >
      <details className="group/agent">
        <summary className="flex min-h-11 cursor-pointer list-none flex-col gap-0.5 px-3 py-2 select-none [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2">
            <SubagentStatusIcon status={agent.status} />
            <span className="min-w-0 truncate font-mono text-[13px] font-medium">{agent.id}</span>
            <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px] font-normal">
              {agent.agent}
            </Badge>
            {parent && (
              <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">via {parent}</span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
              {agent.durationMs ? formatDuration(agent.durationMs) : SUBAGENT_STATUS_LABELS[agent.status]}
              <ChevronRight className="size-3.5 transition-transform group-open/agent:rotate-90" />
            </span>
          </span>
          <span className="flex min-w-0 pl-5.5 text-xs text-muted-foreground">
            <Activity agent={agent} />
          </span>
          <span className="pl-5.5">
            <Metrics agent={agent} />
          </span>
        </summary>
        <div data-vaul-no-drag className="flex flex-col gap-3 border-t px-3 py-2.5">
          {agent.model && (
            <p className="text-[11px] text-muted-foreground">
              Model <span className="font-mono text-foreground/80">{agent.model}</span>
            </p>
          )}
          {agent.task && (
            <DetailSection title="Assignment">
              <div className="max-h-48 overflow-y-auto rounded-md bg-muted/50 px-2.5 py-2">
                <RichText text={agent.task} className="text-xs leading-relaxed" />
              </div>
            </DetailSection>
          )}
          {agent.recentTools && agent.recentTools.length > 0 && (
            <DetailSection title="Recent tool calls">
              <ul className="flex flex-col gap-0.5 font-mono text-xs leading-relaxed text-muted-foreground">
                {agent.status === "running" && agent.currentTool && (
                  <li className="flex gap-1.5 text-foreground/80">
                    <LoaderCircle className="mt-0.5 size-3 shrink-0 animate-spin" />
                    <span className="min-w-0 break-all">
                      {agent.currentTool}
                      {agent.currentToolDetail ? `: ${agent.currentToolDetail}` : ""}
                    </span>
                  </li>
                )}
                {agent.recentTools.map((call, i) => (
                  <li key={i} className={cn("flex gap-1.5", call.isError && "text-destructive")}>
                    <span aria-hidden className="shrink-0">
                      {call.isError ? "✗" : "▸"}
                    </span>
                    <span className="min-w-0 break-all">
                      {call.tool}
                      {call.detail ? `: ${call.detail}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </DetailSection>
          )}
          {!agent.output && recentOutput && recentOutput.length > 0 && (
            <DetailSection title="Latest output">
              <pre className="max-h-40 overflow-auto rounded-md bg-muted/50 px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                {recentOutput.join("\n")}
              </pre>
            </DetailSection>
          )}
          {agent.error && (
            <DetailSection title="Error">
              <p className="rounded-md bg-destructive/10 px-2.5 py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-destructive break-words dark:bg-destructive/20">
                {agent.error}
              </p>
            </DetailSection>
          )}
          {agent.output && (
            <DetailSection title="Report">
              <div className="max-h-96 overflow-y-auto">
                <RichText text={agent.output} className="text-sm leading-relaxed" />
              </div>
            </DetailSection>
          )}
          {!agent.task && !agent.output && !agent.error && !agent.recentTools?.length && !recentOutput?.length && (
            <p className="text-xs text-muted-foreground">No details reported yet.</p>
          )}
        </div>
      </details>
    </li>
  );
}

/**
 * The subagents an orchestrated run delegated to: who is working on what, how far along, and
 * what each reported. Active and failed agents come first; with many agents, finished ones fold.
 */
export function RunAgents({ runId, agents }: { runId: string; agents: SubagentSnapshot[] }) {
  const [showFinished, setShowFinished] = useState(false);
  const sorted = agents.slice().sort(compareSubagents);
  const counts = new Map<SubagentStatus, number>();
  for (const agent of sorted) counts.set(agent.status, (counts.get(agent.status) ?? 0) + 1);
  const active = (counts.get("running") ?? 0) + (counts.get("pending") ?? 0);
  const fold = sorted.length > FOLD_FINISHED_OVER && active > 0 && !showFinished;
  const shown = fold ? sorted.filter((a) => a.status !== "completed" && a.status !== "aborted") : sorted;
  const folded = sorted.length - shown.length;
  const statuses = (Object.keys(STATUS_RANK) as SubagentStatus[]).filter((s) => counts.has(s));

  return (
    <section aria-label="Agents" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Network className="size-3.5 text-muted-foreground" />
        <h3 className="text-xs font-medium text-muted-foreground">
          Agents <span className="tabular-nums">({sorted.length})</span>
        </h3>
        <span className="ml-auto flex flex-wrap items-center gap-x-2.5 text-[11px] text-muted-foreground tabular-nums">
          {statuses.map((status) => (
            <span key={status} className="inline-flex items-center gap-1">
              <span className={cn("size-1.5 rounded-full", STATUS_STYLE[status].bar)} />
              {counts.get(status)} {SUBAGENT_STATUS_LABELS[status].toLowerCase()}
            </span>
          ))}
        </span>
      </div>
      <div
        role="img"
        aria-label={statuses.map((s) => `${counts.get(s)} ${SUBAGENT_STATUS_LABELS[s].toLowerCase()}`).join(", ")}
        className="flex h-1 gap-px overflow-hidden rounded-full bg-muted"
      >
        {statuses.map((status) => (
          <span
            key={status}
            className={cn("h-full transition-[flex-grow]", STATUS_STYLE[status].bar, status === "running" && "animate-pulse")}
            style={{ flexGrow: counts.get(status) }}
          />
        ))}
      </div>
      <ul className="flex flex-col gap-1.5">
        {shown.map((agent) => (
          <SubagentCard key={agent.id} runId={runId} agent={agent} />
        ))}
      </ul>
      {(folded > 0 || showFinished) && sorted.length > FOLD_FINISHED_OVER && active > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start max-md:h-11"
          onClick={() => setShowFinished((value) => !value)}
        >
          {showFinished ? "Hide finished agents" : `Show ${folded} finished agent${folded === 1 ? "" : "s"}`}
        </Button>
      )}
    </section>
  );
}
