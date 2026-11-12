"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { useNow } from "@/components/board/format";
import { BoardFormDialog } from "@/components/boards/board-form-dialog";
import { BoardsEmptyState } from "@/components/boards/boards-empty-state";
import { DeleteBoardDialog } from "@/components/boards/delete-board-dialog";
import { ActivityFeed } from "@/components/home/activity-feed";
import {
  DashboardSkeleton,
  GettingStarted,
  Overview,
  QuickActions,
  RefreshError,
  useSetupPrefs,
} from "@/components/home/dashboard-sections";
import { LiveAgents, type LiveActivity } from "@/components/home/live-agents";
import { NeedsYouList } from "@/components/home/needs-you";
import { ProjectsSection } from "@/components/home/project-card";
import { EntranceContext } from "@/components/home/shared";
import { StatsPanel } from "@/components/home/stats-panel";
import { Button } from "@/components/ui/button";
import { api, subscribeEvents } from "@/lib/api-client";
import { activityLine } from "@/lib/run-activity";
import type { Board, BoardWithCounts, Dashboard } from "@/lib/types";

type FormState = { open: boolean; board: Board | null };

export default function HomePage() {
  const router = useRouter();
  const now = useNow();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [liveActivity, setLiveActivity] = useState<LiveActivity>({});
  const [form, setForm] = useState<FormState>({ open: false, board: null });
  const [deleting, setDeleting] = useState<BoardWithCounts | null>(null);
  const setupPrefs = useSetupPrefs();
  // The entrance cascade plays once, when the dashboard first appears; later refreshes swap rows in place.
  const [entering, setEntering] = useState(true);
  const loaded = dashboard !== null;
  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => setEntering(false), 900);
    return () => window.clearTimeout(timer);
  }, [loaded]);

  const load = useCallback(async () => {
    try {
      const next = await api.dashboard();
      setDashboard(next);
      setLoadError(null);
      // Live activity only matters for cards that still have an agent.
      const live = new Set(next.live.map((agent) => agent.taskId));
      setLiveActivity((prev) => Object.fromEntries(Object.entries(prev).filter(([taskId]) => live.has(taskId))));
    } catch (err) {
      setLoadError(err instanceof Error && err.message ? err.message : "Could not load the dashboard.");
    }
  }, []);

  useEffect(() => {
    void load();
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 300);
    };
    const unsubscribe = subscribeEvents(
      (event) => {
        // A run's progress updates its "Live agents" row in place; no refetch.
        if (event.type === "run.event") {
          const line = activityLine(event.event.kind, event.event.text);
          if (line) {
            setLiveActivity((prev) => ({ ...prev, [event.event.taskId]: { activity: line, at: event.event.createdAt } }));
          }
          return;
        }
        // Everything else shown derives from boards, tasks, runs, the queue and comment counts.
        if (
          event.type.startsWith("board.") ||
          event.type.startsWith("task.") ||
          event.type.startsWith("comment.") ||
          event.type === "run.updated" ||
          event.type === "queue.updated"
        ) {
          refresh();
        }
      },
      { onReconnect: refresh },
    );
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [load]);

  const openCreate = () => setForm({ open: true, board: null });
  const setup = dashboard?.setup;
  const setupComplete = Boolean(setup?.hasCard && setup.hasRun && setup.hasPush && setup.settingsSaved);
  const showSetup = Boolean(dashboard && !setupPrefs.dismissed);
  const steps = dashboard && showSetup && <GettingStarted dashboard={dashboard} prefs={setupPrefs} />;

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader
        title="Projects"
        actions={
          <Button
            onClick={openCreate}
            className="size-11 rounded-full p-0 sm:mr-1 sm:h-9 sm:w-auto sm:rounded-lg sm:px-3"
            aria-label="New project"
          >
            <PlusIcon className="size-5 sm:size-4" />
            <span className="hidden sm:inline">New project</span>
          </Button>
        }
      />

      <main className="px-safe pb-safe flex-1">
        <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 md:py-8 lg:px-8">
          <div className="@container/home">
            {loadError && dashboard === null ? (
              <div
                role="alert"
                className="animate-fade-in-soft mx-auto flex max-w-sm flex-col items-center gap-4 py-16 text-center"
              >
                <p className="text-sm font-medium">Couldn&apos;t load the dashboard</p>
                <p className="-mt-3 text-sm text-muted-foreground">{loadError}</p>
                <Button variant="outline" onClick={() => void load()} className="h-11 md:h-9">
                  <RefreshCwIcon />
                  Try again
                </Button>
              </div>
            ) : dashboard === null ? (
              <DashboardSkeleton />
            ) : dashboard.boards.length === 0 ? (
              <BoardsEmptyState onCreate={openCreate} />
            ) : (
              <EntranceContext.Provider value={entering}>
                {/*
                  One grid, three shapes (container widths, so the sidebar's share is accounted for):
                  - narrow: a single column ordered by urgency — needs you, live agents, quick actions,
                    projects, stats, activity (unfinished steps first, finished ones last);
                  - medium: quick actions move up under the greeting, stats and activity pair up;
                  - wide: a work column and a 21rem side column (live agents, stats, activity).
                  The column wrappers are `display: contents` until wide, so `order` reaches every section.
                */}
                <div className="grid grid-cols-1 items-start gap-6 @2xl/home:grid-cols-2 @5xl/home:grid-cols-[minmax(0,1fr)_21rem] @5xl/home:gap-x-8">
                  {loadError && (
                    <div className="col-span-full min-w-0">
                      <RefreshError message={loadError} onRetry={() => void load()} />
                    </div>
                  )}
                  <div className="col-span-full min-w-0">
                    <Overview dashboard={dashboard} now={now} />
                  </div>
                  <div className="order-4 col-span-full min-w-0 @xl/home:order-none">
                    <QuickActions onCreateProject={openCreate} />
                  </div>

                  <div className="contents @5xl/home:order-1 @5xl/home:flex @5xl/home:min-w-0 @5xl/home:flex-col @5xl/home:gap-8">
                    {!setupComplete && steps && <div className="order-1 col-span-full min-w-0">{steps}</div>}
                    <div className="order-2 col-span-full min-w-0">
                      <NeedsYouList
                        cards={dashboard.needsYou}
                        total={dashboard.needsYouTotal}
                        boards={dashboard.boards}
                        now={now}
                      />
                    </div>
                    <div className="order-5 col-span-full min-w-0">
                      <ProjectsSection
                        boards={dashboard.boards}
                        now={now}
                        onEdit={(b) => setForm({ open: true, board: b })}
                        onDelete={setDeleting}
                      />
                    </div>
                    {setupComplete && steps && <div className="order-8 col-span-full min-w-0">{steps}</div>}
                  </div>

                  <div className="contents @5xl/home:order-1 @5xl/home:flex @5xl/home:min-w-0 @5xl/home:flex-col @5xl/home:gap-8">
                    <div className="order-3 col-span-full min-w-0">
                      <LiveAgents queue={dashboard.queue} live={dashboard.live} liveActivity={liveActivity} />
                    </div>
                    <div className="order-6 min-w-0">
                      <StatsPanel stats={dashboard.stats} />
                    </div>
                    <div className="order-7 min-w-0">
                      <ActivityFeed items={dashboard.activity} now={now} />
                    </div>
                  </div>
                </div>
              </EntranceContext.Provider>
            )}
          </div>
        </div>
      </main>

      <BoardFormDialog
        open={form.open}
        board={form.board}
        onOpenChange={(open) => setForm((f) => ({ ...f, open }))}
        onSaved={(saved, created) => {
          if (created) router.push(`/b/${saved.id}`);
          else void load();
        }}
      />

      <DeleteBoardDialog
        board={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        onDeleted={(id) =>
          setDashboard((d) => (d ? { ...d, boards: d.boards.filter((b) => b.id !== id) } : d))
        }
      />
    </div>
  );
}
