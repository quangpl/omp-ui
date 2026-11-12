"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PlusIcon, RadarIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { useNow } from "@/components/board/format";
import { BoardCard } from "@/components/boards/board-card";
import { BoardFormDialog } from "@/components/boards/board-form-dialog";
import { BoardsEmptyState } from "@/components/boards/boards-empty-state";
import { DeleteBoardDialog } from "@/components/boards/delete-board-dialog";
import {
  AgentsNow,
  AttentionList,
  GettingStarted,
  Overview,
  QuickActions,
  RecentResults,
  useSetupDismissed,
} from "@/components/home/dashboard-sections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, subscribeEvents } from "@/lib/api-client";
import type { Board, BoardWithCounts, Dashboard, DashboardBoard } from "@/lib/types";

type FormState = { open: boolean; board: Board | null };

/** Show the project filter once scanning the grid gets slow. */
const FILTER_THRESHOLD = 5;

function DashboardSkeleton() {
  return (
    <div className="animate-fade-in-soft flex flex-col gap-6" aria-busy="true" aria-label="Loading projects">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[5.5rem] rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex flex-col gap-4 rounded-xl border bg-card p-4">
            <div className="space-y-2">
              <Skeleton className="h-5 w-2/5" />
              <Skeleton className="h-3.5 w-3/4" />
            </div>
            <div className="flex gap-1.5">
              <Skeleton className="h-6 w-16 rounded-full" />
              <Skeleton className="h-6 w-24 rounded-full" />
              <Skeleton className="h-6 w-14 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProjectsSection({
  boards,
  now,
  onEdit,
  onDelete,
}: {
  boards: DashboardBoard[];
  now: number;
  onEdit: (board: Board) => void;
  onDelete: (board: BoardWithCounts) => void;
}) {
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const shown = query
    ? boards.filter((b) =>
        [b.name, b.workdir, ...b.extraFolders].some((text) => text.toLowerCase().includes(query)),
      )
    : boards;

  return (
    <section aria-labelledby="home-projects">
      <div className="mb-3 flex flex-wrap items-end gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <h2 id="home-projects" className="text-sm font-semibold tracking-tight">
            Your projects
          </h2>
          <p className="text-xs text-muted-foreground">
            {boards.length} project{boards.length === 1 ? "" : "s"} · tap one to open its board · most
            recently active first
          </p>
        </div>
        {boards.length >= FILTER_THRESHOLD && (
          <div className="relative w-full sm:w-56">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter projects"
              aria-label="Filter projects"
              className="h-11 pl-8 md:h-8"
            />
          </div>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          No project matches “{filter.trim()}”.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
          {shown.map((board, index) => (
            <BoardCard
              key={board.id}
              board={board}
              now={now}
              onEdit={onEdit}
              onDelete={onDelete}
              className="animate-card-in"
              style={{ "--stagger": index } as CSSProperties}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default function HomePage() {
  const router = useRouter();
  const now = useNow();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({ open: false, board: null });
  const [deleting, setDeleting] = useState<BoardWithCounts | null>(null);
  const [setupDismissed, dismissSetup] = useSetupDismissed();

  const load = useCallback(async () => {
    try {
      setDashboard(await api.dashboard());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error && err.message ? err.message : "Could not load projects.");
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
        // Everything shown derives from boards, tasks, runs, the queue and comment counts;
        // ignore chatty run output.
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
  const attentionTotal = useMemo(
    () => dashboard?.boards.reduce((sum, b) => sum + b.attentionCount, 0) ?? 0,
    [dashboard],
  );
  const setup = dashboard?.setup;
  const showSetup = Boolean(setup && !setupDismissed && !(setup.hasCard && setup.hasRun && setup.hasDone));

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

      <main className="px-safe pb-safe mx-auto w-full max-w-7xl flex-1">
        <div className="px-4 py-5 sm:px-6 sm:py-8">
          {loadError && dashboard === null ? (
            <div className="animate-fade-in-soft mx-auto flex max-w-sm flex-col items-center gap-4 py-16 text-center">
              <p className="text-sm text-muted-foreground">{loadError}</p>
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
            <div className="flex flex-col gap-7">
              <Overview dashboard={dashboard} now={now} />
              <QuickActions onCreateProject={openCreate} />

              <div className="grid grid-cols-1 gap-7 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-6">
                <div className="flex min-w-0 flex-col gap-7">
                  {showSetup && setup && (
                    <GettingStarted
                      setup={setup}
                      firstBoardId={dashboard.boards[0]?.id}
                      onDismiss={dismissSetup}
                    />
                  )}
                  {dashboard.attention.length > 0 && (
                    <AttentionList cards={dashboard.attention} total={attentionTotal} now={now} />
                  )}
                  <ProjectsSection
                    boards={dashboard.boards}
                    now={now}
                    onEdit={(b) => setForm({ open: true, board: b })}
                    onDelete={setDeleting}
                  />
                </div>

                <aside className="flex min-w-0 flex-col gap-7" aria-label="Activity">
                  <AgentsNow queue={dashboard.queue} />
                  <RecentResults cards={dashboard.finished} now={now} />
                  <Link
                    href="/visualize"
                    className="card-lift flex min-h-11 items-center gap-2.5 rounded-xl border bg-card px-3 py-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <RadarIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">Visual overview</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        Every project and agent at a glance
                      </span>
                    </span>
                  </Link>
                </aside>
              </div>
            </div>
          )}
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
