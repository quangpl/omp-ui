"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { BoardMenu } from "@/components/board/board-menu";
import type { BoardMenuActions } from "@/components/board/card-context-menu";
import { ConnectionPill } from "@/components/board/connection-status";
import { KanbanBoard } from "@/components/board/kanban-board";
import { NewTaskDialog, type NewTaskInput } from "@/components/board/new-task-form";
import { GitIndicator } from "@/components/board/ship-actions";
import { DeleteCardDialog, TaskDetail } from "@/components/board/task-detail";
import { useNewCardTarget } from "@/components/new-card";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBoard, useGitStatus } from "@/hooks/use-board";
import { useIsMobile } from "@/hooks/use-mobile";
import { isTypingTarget } from "@/lib/hotkeys";
import { TASK_STATUSES, type Board, type Task, type TaskStatus } from "@/lib/types";

export default function BoardPage() {
  return (
    <Suspense fallback={<BoardSkeleton />}>
      <BoardScreen />
    </Suspense>
  );
}

function boardSubtitle(board: Board): string {
  const extra = board.extraFolders.length;
  return extra > 0 ? `${board.workdir} +${extra} folder${extra === 1 ? "" : "s"}` : board.workdir;
}

function BoardScreen() {
  const params = useParams<{ boardId: string }>();
  const boardId = String(params.boardId);
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedTaskId = searchParams.get("task");
  const isMobile = useIsMobile();

  const controller = useBoard(boardId);
  const { board, columns, tasks, loading, error, subscribe } = controller;
  const git = useGitStatus(boardId, subscribe);
  /** Open "New card" form; `start` presets "Start agent now" (else the board's auto-run). */
  const [newCard, setNewCard] = useState<{ start?: boolean } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleting, setDeleting] = useState<Task | null>(null);
  const [mobileColumn, setMobileColumn] = useState<TaskStatus>("todo");

  // Detail open state lives in `?task=<id>`; opening pushes a history entry so Back closes it.
  const pushedRef = useRef(false);
  const boardPath = `/b/${encodeURIComponent(boardId)}`;

  const openTask = useCallback(
    (taskId: string) => {
      pushedRef.current = true;
      router.push(`${boardPath}?task=${encodeURIComponent(taskId)}`, { scroll: false });
    },
    [router, boardPath],
  );

  const closeTask = useCallback(() => {
    if (pushedRef.current) {
      pushedRef.current = false;
      router.back();
    } else {
      router.replace(boardPath, { scroll: false });
    }
  }, [router, boardPath]);

  /** Show another card in the open panel; replaces the entry so Back still closes the panel. */
  const switchTask = useCallback(
    (taskId: string) => {
      router.replace(`${boardPath}?task=${encodeURIComponent(taskId)}`, { scroll: false });
    },
    [router, boardPath],
  );

  useEffect(() => {
    if (!selectedTaskId) pushedRef.current = false;
  }, [selectedTaskId]);

  // A deep-linked card on a phone: show the column it lives in behind the drawer.
  const syncedDeepLinkRef = useRef(false);
  const selectedTask = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) : undefined;
  useEffect(() => {
    if (syncedDeepLinkRef.current || !selectedTask) return;
    syncedDeepLinkRef.current = true;
    setMobileColumn(selectedTask.status);
  }, [selectedTask]);

  // J / K flip through the board's cards (column order) while the detail panel is open.
  useEffect(() => {
    if (!selectedTaskId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.key !== "j" && event.key !== "k") return;
      if (isTypingTarget(event.target)) return;
      // Only while the panel itself has focus, not e.g. the delete confirmation on top of it.
      const inPanel =
        event.target instanceof Element &&
        event.target.closest('[data-slot="sheet-content"], [data-slot="drawer-content"]');
      if (!inPanel) return;
      const ordered = TASK_STATUSES.flatMap((status) => columns[status]);
      const index = ordered.findIndex((t) => t.id === selectedTaskId);
      if (index < 0) return;
      const next = ordered[index + (event.key === "j" ? 1 : -1)];
      if (next) {
        event.preventDefault();
        switchTask(next.id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedTaskId, columns, switchTask]);

  const create = async (input: NewTaskInput) => {
    const task = await controller.createTask(input);
    if (task) setMobileColumn(task.status);
    return task !== null;
  };

  // `N` / `Shift+N` and every "New card…" menu item land here while this board is open.
  useNewCardTarget(boardId, ({ start }) => setNewCard({ start }));

  const { createTask, revertToTodo, runAgent, stopAgent, reload } = controller;
  const refreshGit = git.refresh;
  const menuActions = useMemo<BoardMenuActions>(
    () => ({
      boardId,
      openCard: openTask,
      revertToTodo,
      runAgent,
      stopAgent,
      duplicate: async (task) => {
        // A copy waits in To do even on auto-run boards: re-running a finished card is opt-in.
        const copy = await createTask({
          title: `${task.title} (copy)`,
          description: task.description,
          start: false,
        });
        if (copy) setMobileColumn(copy.status);
      },
      requestDelete: setDeleting,
      newCard: (start) => setNewCard({ start }),
      refresh: () => {
        void reload();
        void refreshGit();
      },
      openSettings: () => setSettingsOpen(true),
    }),
    [boardId, openTask, revertToTodo, runAgent, stopAgent, createTask, reload, refreshGit],
  );

  if (!board) {
    if (loading) return <BoardSkeleton />;
    return (
      <div className="flex h-dvh flex-col">
        <AppHeader title="Project" backHref="/" />
        <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-sm text-muted-foreground">{error ?? "This project couldn't be loaded."}</p>
          <div className="flex gap-2">
            <Button variant="outline" className="h-11 md:h-9" onClick={() => void controller.reload()}>
              Try again
            </Button>
            <Button asChild className="h-11 md:h-9">
              <Link href="/">All projects</Link>
            </Button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <AppHeader
        title={board.name}
        subtitle={boardSubtitle(board)}
        backHref="/"
        actions={
          <>
            <ConnectionPill status={controller.connection} />
            <GitIndicator boardId={boardId} statuses={git.statuses} onChanged={() => void git.refresh()} />
            {/* Phones use the thumb-reachable floating button instead. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button className="h-9 max-md:hidden" onClick={() => setNewCard({})}>
                  <Plus />
                  Add card
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                New card <Kbd>N</Kbd>
              </TooltipContent>
            </Tooltip>
            <BoardMenu
              board={board}
              onUpdated={controller.setBoard}
              onRefresh={menuActions.refresh}
              settingsOpen={settingsOpen}
              onSettingsOpenChange={setSettingsOpen}
            />
          </>
        }
      />
      <main className="flex min-h-0 flex-1 flex-col">
        <KanbanBoard
          columns={columns}
          activity={controller.activity}
          isMobile={isMobile}
          menuActions={menuActions}
          reorderTask={controller.reorderTask}
          onQuickCreate={async (text, progress) => (await controller.createFromText(text, progress)) !== null}
          onAdd={() => setNewCard({})}
          mobileColumn={mobileColumn}
          onMobileColumnChange={setMobileColumn}
        />
      </main>

      <NewTaskDialog
        open={newCard !== null}
        onOpenChange={(open) => !open && setNewCard(null)}
        isMobile={isMobile}
        boardId={boardId}
        defaultStart={newCard?.start ?? board.autoRun}
        onCreate={create}
      />

      <DeleteCardDialog
        title={deleting?.title ?? ""}
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await controller.deleteTask(deleting.id);
        }}
      />

      <TaskDetail
        taskId={selectedTaskId}
        boardTask={selectedTask}
        board={board}
        tasks={tasks}
        onOpenTask={switchTask}
        isMobile={isMobile}
        onClose={closeTask}
        subscribe={subscribe}
        upsertTask={controller.upsertTask}
        removeTask={controller.removeTask}
        revertToTodo={controller.revertToTodo}
        gitStatuses={git.statuses}
        onGitChanged={() => void git.refresh()}
      />
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex h-dvh animate-fade-in-soft flex-col overflow-hidden">
      <div className="pt-safe border-b">
        <div className="flex h-14 items-center gap-3 px-3 sm:px-4">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 border-b px-2 py-2 md:hidden">
        {TASK_STATUSES.map((status) => (
          <Skeleton key={status} className="h-7" />
        ))}
      </div>
      <div className="flex flex-col gap-2.5 p-3 md:hidden">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-lg" />
        ))}
      </div>
      <div className="hidden min-h-0 flex-1 grid-cols-3 gap-3 p-3 md:grid lg:gap-4 lg:p-4">
        {TASK_STATUSES.map((status) => (
          <div key={status} className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-20 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}
