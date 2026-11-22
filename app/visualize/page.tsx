"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Building2Icon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { formatRelative, useNow } from "@/components/board/format";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ControlRoom } from "@/components/visualize/control-room";
import { FactoryFloor, FLOOR_GRID } from "@/components/visualize/factory-floor";
import { useLiveAgents } from "@/components/visualize/use-live-agents";
import { WorkerAvatar } from "@/components/visualize/worker-avatar";
import { Worksites } from "@/components/visualize/worksites";
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

const BLOCK = "rounded-[3px]";

/** Placeholder shaped like the control room, the factory floor and the worksites. */
function LoadingSkeleton() {
  return (
    <div className="grid gap-10 md:gap-16" aria-busy="true" aria-label="Loading">
      <div className="grid gap-10 lg:grid-cols-12 lg:gap-12">
        <div className="grid content-start gap-8 lg:col-span-7">
          <div className="flex flex-wrap items-end gap-x-10 gap-y-6">
            <Skeleton className={cn(BLOCK, "h-24 w-48")} />
            <div className="flex gap-5">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className={cn(BLOCK, "h-14 w-20")} />
              ))}
            </div>
          </div>
          <div className="grid gap-3 border-t pt-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className={cn(BLOCK, "h-10 w-full")} />
            ))}
          </div>
        </div>
        <Skeleton className={cn(BLOCK, "h-80 w-full lg:col-span-5")} />
      </div>
      <div className="flex flex-col gap-2 rounded-[3px] border p-2 md:flex-row">
        {Array.from({ length: 9 }, (_, i) => (
          <Skeleton key={i} className={cn(BLOCK, "h-14 md:h-40 md:flex-1")} />
        ))}
      </div>
      <div className={cn(FLOOR_GRID, "rounded-[3px] border p-2")}>
        <Skeleton className={cn(BLOCK, "col-span-2 h-36 xl:col-span-1 xl:col-start-1 xl:row-start-1")} />
        <Skeleton className={cn(BLOCK, "col-span-2 h-36 xl:col-span-1 xl:col-start-1 xl:row-start-2")} />
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className={cn(BLOCK, "h-36")} />
        ))}
        <Skeleton className={cn(BLOCK, "col-span-2 h-36 md:col-span-4 xl:col-span-1 xl:col-start-6 xl:row-span-2 xl:row-start-1 xl:h-auto")} />
      </div>
      <div className="grid gap-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className={cn(BLOCK, "h-16 w-full")} />
        ))}
      </div>
    </div>
  );
}

function NoProjects() {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-5 py-16 text-center">
      <WorkerAvatar hue={168} mood="sleeping" animated={false} className="size-16" />
      <div className="space-y-1">
        <p className="font-medium">No worksites yet</p>
        <p className="text-sm text-muted-foreground">Open a project and start a card. Its worker clocks in here.</p>
      </div>
      <Button asChild className="pressable h-11 w-full sm:w-auto md:h-9">
        <Link href="/">
          <Building2Icon />
          Go to projects
        </Link>
      </Button>
    </div>
  );
}

export default function VisualizePage() {
  useDocumentTitle("Visualize");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow(CLOCK_TICK_MS);
  const { live, onEvent } = useLiveAgents(dashboard?.queue.running.map((entry) => entry.taskId) ?? []);

  const load = useCallback(async () => {
    try {
      setDashboard(await api.dashboard());
      setUpdatedAt(Date.now());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error && err.message ? err.message : "Couldn't load the floor.");
    }
  }, []);

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

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader
        title="Visualize"
        subtitle="Your agent crew at work, live across every project"
        actions={
          <div className="flex items-center gap-2">
            {updatedAt !== null && (
              <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
                Updated {formatRelative(new Date(updatedAt).toISOString(), now)}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="pressable-icon size-11 md:size-9"
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
      <main className="px-safe pb-safe flex-1">
        <div className="animate-page-in mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 md:py-10 lg:px-8">
          {loadError && dashboard === null ? (
            <div role="alert" className="mx-auto flex max-w-sm flex-col items-center gap-4 py-16 text-center">
              <TriangleAlertIcon className="size-8 text-destructive" aria-hidden />
              <div className="space-y-1">
                <p className="font-medium">Couldn't load the floor</p>
                <p className="text-sm text-muted-foreground">{loadError}</p>
              </div>
              <Button variant="outline" onClick={() => void load()} className="h-11 w-full sm:w-auto md:h-9">
                <RefreshCwIcon />
                Try again
              </Button>
            </div>
          ) : dashboard === null ? (
            <LoadingSkeleton />
          ) : dashboard.boards.length === 0 ? (
            <NoProjects />
          ) : (
            <div className="grid gap-10 md:gap-16">
              {loadError && (
                <p
                  role="alert"
                  className="flex items-center gap-2 rounded-[3px] border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                >
                  <TriangleAlertIcon className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">Couldn't refresh: {loadError}</span>
                </p>
              )}
              <ControlRoom dashboard={dashboard} live={live} now={now} />
              <FactoryFloor dashboard={dashboard} live={live} now={now} />
              <Worksites dashboard={dashboard} now={now} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
