"use client";

import Link from "next/link";
import { CheckIcon, MinusIcon } from "lucide-react";
import { formatCount, MEMORY_PANEL, typeLabel } from "@/components/memory/format";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { MemoryFacet, MemoryStoreStats } from "@/lib/memory-types";
import { cn } from "@/lib/utils";

function Figure({ label, value, note }: { label: string; value: number | null; note?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
        {value === null ? <span className="text-muted-foreground/60">n/a</span> : formatCount(value)}
      </dd>
      {note && <dd className="text-xs text-muted-foreground">{note}</dd>}
    </div>
  );
}

/** Horizontal share bars; the longest row spans the full width. */
function Breakdown({
  title,
  rows,
  empty,
  format = (v) => v,
}: {
  title: string;
  rows: (MemoryFacet & { note?: string })[];
  empty: string;
  format?: (value: string) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section className={cn(MEMORY_PANEL, "p-5")}>
      <h3 className="mb-4 text-sm font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row, i) => (
            <li key={row.value} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  {format(row.value)}
                  {row.note && <span className="ml-2 text-xs text-muted-foreground">{row.note}</span>}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatCount(row.count)}</span>
              </div>
              <div
                className="h-1 origin-left animate-card-in rounded-full bg-foreground/60"
                style={{ width: `${Math.max(2, (row.count / max) * 100)}%`, "--stagger": i } as React.CSSProperties}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function recallMode(embeddings: string): { label: string; detail: string } {
  if (!embeddings || embeddings === "none" || embeddings === "bm25") {
    return {
      label: "Keyword recall (BM25)",
      detail:
        "No embedding provider, so recall matches words, not meaning. Set EMBEDDING_PROVIDER=local in ~/.agentmemory/.env for free on-device semantic search.",
    };
  }
  return {
    label: "Hybrid recall",
    detail: `BM25 keywords fused with ${embeddings} vectors, so related wording still matches.`,
  };
}

/** Store totals, recall mode, feature flags and per-project / per-kind breakdowns. */
export function StatsTab({ stats, error }: { stats: MemoryStoreStats | null; error: string | null }) {
  if (error && !stats) return <p className="text-sm text-destructive">{error}</p>;
  if (!stats) {
    return (
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]" aria-busy="true">
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }
  const { counts } = stats;
  const mode = recallMode(stats.embeddingProvider);
  const superseded = counts.memories - counts.latestMemories;
  const memoryProjects = stats.projects.filter((p) => p.count > 0);

  return (
    <div className="@container space-y-6">
      <div className="grid gap-6 @4xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section className={cn(MEMORY_PANEL, "animate-card-in p-6 sm:p-8")}>
          <p className="text-xs font-medium text-muted-foreground">Long-term memories</p>
          <p className="mt-2 text-6xl leading-none font-semibold tracking-tighter tabular-nums">
            {formatCount(counts.latestMemories)}
          </p>
          {superseded > 0 && (
            <p className="mt-2 text-sm text-muted-foreground">
              plus {formatCount(superseded)} superseded {superseded === 1 ? "version" : "versions"}
            </p>
          )}
          <dl className="mt-8 grid grid-cols-2 gap-6 border-t pt-6 @xl:grid-cols-4">
            <Figure
              label="Sessions"
              value={counts.sessions}
              note={counts.activeSessions > 0 ? `${counts.activeSessions} active` : undefined}
            />
            <Figure label="Observations" value={counts.observations} />
            <Figure label="Lessons" value={counts.lessons} />
            <Figure
              label="Graph nodes"
              value={counts.graphNodes}
              note={counts.graphEdges !== null ? `${formatCount(counts.graphEdges)} edges` : undefined}
            />
          </dl>
        </section>

        <section className={cn(MEMORY_PANEL, "animate-card-in p-6 [--stagger:1]")}>
          <p className="text-xs font-medium text-muted-foreground">Recall</p>
          <p className="mt-2 text-lg font-semibold tracking-tight">{mode.label}</p>
          <p className="mt-1 text-sm leading-relaxed text-pretty text-muted-foreground">{mode.detail}</p>
          <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">LLM provider</dt>
              <dd className="mt-0.5">{!stats.provider || stats.provider === "noop" ? "None (keyless)" : stats.provider}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Server</dt>
              <dd className="mt-0.5 tabular-nums">{stats.version ? `agentmemory ${stats.version}` : "agentmemory"}</dd>
            </div>
          </dl>
          {stats.flags.length > 0 && (
            <ul className="mt-5 space-y-2 border-t pt-4">
              {stats.flags.map((flag) => (
                <li key={flag.key} className="flex items-center gap-2 text-sm">
                  {flag.enabled ? (
                    <CheckIcon className="size-4 shrink-0 text-success" />
                  ) : (
                    <MinusIcon className="size-4 shrink-0 text-muted-foreground/60" />
                  )}
                  <span className={cn("min-w-0 truncate", !flag.enabled && "text-muted-foreground")}>{flag.label}</span>
                </li>
              ))}
            </ul>
          )}
          <Button asChild variant="link" className="mt-3 h-11 px-0 md:h-8">
            <Link href="/settings#memory">Memory settings</Link>
          </Button>
        </section>
      </div>

      <div className="grid gap-6 @3xl:grid-cols-3">
        <Breakdown
          title="Memories by project"
          rows={memoryProjects.map((p) => ({ ...p, note: p.boardName && p.boardName !== p.value ? p.boardName : undefined }))}
          empty="No project-scoped memories yet."
        />
        <Breakdown title="Memories by kind" rows={stats.types} empty="No memories yet." format={typeLabel} />
        <Breakdown title="Sessions by project" rows={stats.sessionProjects} empty="No sessions recorded yet." />
      </div>
    </div>
  );
}
