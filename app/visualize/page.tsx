"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Building2Icon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ControlRoom,
  formatRelative,
  LINE_GRID,
  type Pop,
  ProductionLine,
  useNow,
  WorksitesSection,
} from "@/components/visualize/factory-floor";
import { crewLevel, XP_PER_CARD } from "@/components/visualize/game";
import { useLiveFloor } from "@/components/visualize/use-live-floor";
import { WorkerAvatar } from "@/components/visualize/worker-avatar";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { api, subscribeEvents } from "@/lib/api-client";
import type { Dashboard, ServerEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Events that change anything the dashboard aggregates; chatty run output is ignored. */
const REFRESH_EVENTS: Partial<Record<ServerEvent["type"], true>> = {
  "task.updated": true,
  "task.deleted": true,
  "board.updated": true,
  "board.deleted": true,
  "queue.updated": true,
  "run.updated": true,
};
const REFRESH_DEBOUNCE_MS = 250;
const CLOCK_TICK_MS = 30_000;
const POP_MS = 2_800;

/** Placeholder shaped like the control room, the production line (zones + systems bus) and worksites. */
function LoadingSkeleton() {
  return (
    <div className="grid gap-6" aria-busy="true" aria-label="Loading the floor">
      <Skeleton className="h-64 w-full rounded-none md:h-48" />
      <div className="border">
        <Skeleton className="h-10 w-full rounded-none" />
        <div className={LINE_GRID}>
          <div className="grid content-start gap-2 border-b p-3 lg:border-r">
            <Skeleton className="h-10 w-36 rounded-none" />
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-20 w-full rounded-none" />
            ))}
          </div>
          <div className="@container grid content-start gap-3 border-b p-3 xl:border-r">
            <Skeleton className="h-10 w-44 rounded-none" />
            <div className="grid gap-4 @lg:grid-cols-2 @4xl:grid-cols-3">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-72 w-full rounded-none" />
              ))}
            </div>
          </div>
          <div className="grid content-start gap-2 border-b p-3 lg:col-span-2 xl:col-span-1">
            <Skeleton className="h-10 w-40 rounded-none" />
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-none" />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4 lg:col-span-full xl:grid-cols-8">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-none" />
            ))}
          </div>
        </div>
      </div>
      <Skeleton className="h-48 w-full rounded-none" />
    </div>
  );
}

function NoProjects() {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-4 py-16 text-center">
      <WorkerAvatar hue={272} mood="sleeping" className="size-20" />
      <div className="space-y-1">
        <p className="font-medium">The floor is empty</p>
        <p className="text-sm text-muted-foreground">
          Create a project and start a card. Its agent shows up here as a worker.
        </p>
      </div>
      <Button asChild className="h-11 md:h-9">
        <Link href="/">
          <Building2Icon />
          Go to projects
        </Link>
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export default function VisualizePage() {
  useDocumentTitle("Visualize");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pops, setPops] = useState<Pop[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow(CLOCK_TICK_MS);
  const { live, onEvent } = useLiveFloor(dashboard?.queue.running.map((entry) => entry.taskId) ?? []);
  const seen = useRef<{ finished: Set<string>; level: number } | null>(null);
  const popId = useRef(0);

  const load = useCallback(async () => {
    try {
      setDashboard(await api.dashboard());
      setUpdatedAt(Date.now());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error && err.message ? err.message : "Couldn't load the overview.");
    }
  }, []);

  // Celebrate cards shipped (and levels gained) while the page is open.
  useEffect(() => {
    if (!dashboard) return;
    const level = crewLevel(dashboard.totals.done).level;
    const previous = seen.current;
    seen.current = { finished: new Set(dashboard.finished.map((card) => card.id)), level };
    if (!previous) return;
    const fresh: Pop[] = dashboard.finished
      .filter((card) => !previous.finished.has(card.id))
      .map((card) => ({ id: ++popId.current, text: `+${XP_PER_CARD} XP · ${card.title}` }));
    if (level > previous.level) fresh.push({ id: ++popId.current, text: `Level up! Level ${level}` });
    if (fresh.length === 0) return;
    setPops((current) => [...current, ...fresh]);
    const ids = new Set(fresh.map((pop) => pop.id));
    window.setTimeout(() => setPops((current) => current.filter((pop) => !ids.has(pop.id))), POP_MS);
  }, [dashboard]);

  useEffect(() => {
    void load();
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), REFRESH_DEBOUNCE_MS);
    };
    const unsubscribe = subscribeEvents(
      (event) => {
        onEvent(event);
        if (REFRESH_EVENTS[event.type]) refresh();
      },
      { onReconnect: refresh },
    );
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [load, onEvent]);

  const attentionTotal = dashboard?.boards.reduce((sum, b) => sum + b.attentionCount, 0) ?? 0;

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader
        title="Visualize"
        subtitle="Your agents at work, live"
        actions={
          <div className="flex items-center gap-2">
            {updatedAt !== null && (
              <span className="hidden items-center gap-1.5 text-xs text-muted-foreground tabular-nums sm:flex">
                <span className="relative flex size-2" aria-hidden>
                  <span className="absolute inset-0 animate-ping rounded-full bg-success/60 motion-reduce:animate-none" />
                  <span className="relative size-2 rounded-full bg-success" />
                </span>
                Live · updated {formatRelative(new Date(updatedAt).toISOString(), now)}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-11 active:scale-[0.96] md:size-9"
              aria-label="Refresh"
              title="Refresh"
              disabled={refreshing || dashboard === null}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon className={cn(refreshing && "animate-spin motion-reduce:animate-none")} />
            </Button>
          </div>
        }
      />
      <main className="px-safe pb-safe mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 sm:px-6 md:py-8 lg:px-8">
        {loadError && dashboard === null ? (
          <div className="mx-auto flex max-w-sm flex-col items-center gap-4 py-16 text-center">
            <WorkerAvatar hue={25} mood="error" className="size-16" />
            <div className="space-y-1">
              <p className="font-medium">Couldn't load the floor</p>
              <p className="text-sm text-muted-foreground">{loadError}</p>
            </div>
            <Button variant="outline" onClick={() => void load()} className="h-11 active:scale-[0.98] md:h-9">
              <RefreshCwIcon />
              Try again
            </Button>
          </div>
        ) : dashboard === null ? (
          <LoadingSkeleton />
        ) : dashboard.boards.length === 0 ? (
          <NoProjects />
        ) : (
          <div className="grid gap-6">
            {loadError && (
              <p
                role="alert"
                className="animate-fade-in-soft flex items-center gap-2 border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                <TriangleAlertIcon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Couldn't refresh: {loadError}</span>
              </p>
            )}
            <ControlRoom dashboard={dashboard} pops={pops} />
            <ProductionLine dashboard={dashboard} live={live} now={now} attentionTotal={attentionTotal} />
            <WorksitesSection dashboard={dashboard} now={now} />
          </div>
        )}
      </main>
    </div>
  );
}
