"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BrainIcon, ChartColumnIcon, HistoryIcon } from "lucide-react";
import { errorMessage } from "@/components/board/format";
import type { FilterOption } from "@/components/memory/controls";
import { formatCount, isMemoryUnavailable, typeLabel } from "@/components/memory/format";
import { MemoriesTab } from "@/components/memory/memories-tab";
import { MemorySetup } from "@/components/memory/memory-setup";
import { SessionsTab } from "@/components/memory/sessions-tab";
import { StatsTab } from "@/components/memory/stats-tab";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api-client";
import { MEMORY_TYPES, type MemoryStoreStats } from "@/lib/memory-types";
import type { MemoryStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

/** While a server start is in flight, re-read the status this often. */
const STARTING_POLL_MS = 3_000;

type Tab = "memories" | "sessions" | "stats";

function embeddingsLabel(embeddings: string | undefined): string {
  if (!embeddings || embeddings === "none" || embeddings === "bm25") return "Keyword search";
  return `Semantic search · ${embeddings}`;
}

/** Status line under the page intro: server health, store size, recall mode. */
function StatusLine({ status, stats }: { status: MemoryStatus | null; stats: MemoryStoreStats | null }) {
  if (!status) return <Skeleton className="h-4 w-72" />;
  const memories = stats?.counts.latestMemories ?? status.stats?.memories ?? null;
  const sessions = stats?.counts.sessions ?? status.stats?.sessions ?? null;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      <span className="flex items-center gap-2 text-foreground">
        <span className="relative flex size-2" aria-hidden="true">
          {status.healthy && (
            <span className="absolute inset-0 animate-ping rounded-full bg-success/50 motion-reduce:animate-none" />
          )}
          <span className={cn("relative size-2 rounded-full", status.healthy ? "bg-success" : "bg-destructive")} />
        </span>
        {status.healthy ? "Server healthy" : status.starting ? "Starting" : "Server down"}
      </span>
      {memories !== null && (
        <span className="tabular-nums">
          {formatCount(memories)} {memories === 1 ? "memory" : "memories"}
        </span>
      )}
      {sessions !== null && (
        <span className="tabular-nums">
          {formatCount(sessions)} {sessions === 1 ? "session" : "sessions"}
        </span>
      )}
      <span>{embeddingsLabel(stats?.embeddingProvider ?? status.embeddings)}</span>
      {status.version && <span className="tabular-nums">v{status.version}</span>}
    </p>
  );
}

/**
 * The /memory page body: setup state while agentmemory is missing or down, else the Memories,
 * Sessions and Stats tabs. `onStatus` lets the page header show the viewer link.
 */
export function MemoryView({ onStatus }: { onStatus?: (status: MemoryStatus | null) => void }) {
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [stats, setStats] = useState<MemoryStoreStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("memories");
  /** Tabs mount on first visit and then stay mounted, keeping their filters and scroll. */
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set<Tab>(["memories"]));

  const applyStatus = useCallback(
    (next: MemoryStatus) => {
      setStatus(next);
      setStatusError(null);
      onStatus?.(next);
    },
    [onStatus],
  );

  const loadStatus = useCallback(
    async (refresh = false) => {
      try {
        applyStatus(await api.memory.status(refresh));
      } catch (err) {
        setStatusError(errorMessage(err));
      }
    },
    [applyStatus],
  );

  const loadStats = useCallback(async () => {
    try {
      setStats(await api.memory.stats());
      setStatsError(null);
    } catch (err) {
      if (isMemoryUnavailable(err)) void loadStatus();
      setStatsError(errorMessage(err));
    }
  }, [loadStatus]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const healthy = status?.healthy ?? false;
  useEffect(() => {
    if (healthy) void loadStats();
  }, [healthy, loadStats]);

  // Poll while a start is booting so the page flips to the browser on its own.
  useEffect(() => {
    if (!status?.starting) return;
    const id = window.setInterval(() => void loadStatus(), STARTING_POLL_MS);
    return () => window.clearInterval(id);
  }, [status?.starting, loadStatus]);

  /** A browse request got 503: the server went away; re-check so the setup state shows. */
  const onUnavailable = useCallback(() => void loadStatus(), [loadStatus]);
  const onChanged = useCallback(() => void loadStats(), [loadStats]);

  const projects = useMemo<FilterOption[]>(
    () =>
      (stats?.projects ?? []).map((p) => ({
        value: p.value,
        label: p.boardName && p.boardName !== p.value ? `${p.value} (${p.boardName})` : p.value,
        hint: p.count > 0 ? formatCount(p.count) : undefined,
      })),
    [stats],
  );
  const types = useMemo<FilterOption[]>(() => {
    const counts = new Map((stats?.types ?? []).map((t) => [t.value, t.count]));
    const values = [...new Set<string>([...MEMORY_TYPES, ...counts.keys()])];
    return values.map((value) => ({
      value,
      label: typeLabel(value),
      hint: counts.has(value) ? formatCount(counts.get(value) ?? 0) : undefined,
    }));
  }, [stats]);

  const emptyHint = (
    <>
      Agents add memories as they work on cards: decisions, fixes and preferences saved with memory_save, plus
      lessons agentmemory distills from session observations. Run a card with OMP connected, then check the
      Sessions tab for what was captured.
    </>
  );

  return (
    <div className="@container space-y-6">
      <div className="space-y-2">
        <h1 className="sr-only">Memory</h1>
        <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
          What your agents remember across card runs, from the local agentmemory server.
        </p>
        <StatusLine status={status} stats={stats} />
      </div>

      {statusError || (status && !status.healthy) ? (
        <MemorySetup
          status={status}
          error={statusError}
          onRetry={() => void loadStatus(true)}
          onStatus={applyStatus}
        />
      ) : !status ? (
        <div className="space-y-4" aria-busy="true">
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(value) => {
            const next = value as Tab;
            setTab(next);
            setVisited((prev) => (prev.has(next) ? prev : new Set([...prev, next])));
          }}
          className="gap-5"
        >
          <TabsList
            variant="line"
            className="w-full justify-start gap-4 border-b group-data-horizontal/tabs:h-11 md:group-data-horizontal/tabs:h-9"
          >
            <TabsTrigger value="memories" className="flex-none px-1">
              <BrainIcon />
              Memories
            </TabsTrigger>
            <TabsTrigger value="sessions" className="flex-none px-1">
              <HistoryIcon />
              Sessions
            </TabsTrigger>
            <TabsTrigger value="stats" className="flex-none px-1">
              <ChartColumnIcon />
              Stats
            </TabsTrigger>
          </TabsList>
          <TabsContent value="memories" forceMount className="data-[state=inactive]:hidden">
            <MemoriesTab
              active={tab === "memories"}
              projects={projects}
              types={types}
              onUnavailable={onUnavailable}
              onChanged={onChanged}
              emptyHint={emptyHint}
            />
          </TabsContent>
          <TabsContent value="sessions" forceMount className="data-[state=inactive]:hidden">
            {visited.has("sessions") && (
              <SessionsTab
                active={tab === "sessions"}
                projects={projects}
                onUnavailable={onUnavailable}
                onChanged={onChanged}
              />
            )}
          </TabsContent>
          <TabsContent value="stats" forceMount className="data-[state=inactive]:hidden">
            <StatsTab stats={stats} error={statsError} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
