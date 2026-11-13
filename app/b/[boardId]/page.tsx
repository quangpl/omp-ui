"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { toastCardAdded } from "@/components/board/card-added-toast";
import { BoardMenu } from "@/components/board/board-menu";
import type { BoardMenuActions } from "@/components/board/card-context-menu";
import { ConnectionPill } from "@/components/board/connection-status";
import { BoardBodySkeleton, KanbanBoard } from "@/components/board/kanban-board";
import { NewTaskDialog } from "@/components/board/new-task-form";
import { GitIndicator, canShip, shipLabels, shipTask } from "@/components/board/ship-actions";
import { DeleteCardDialog, TaskDetail } from "@/components/board/task-detail";
import { useNewCardTarget } from "@/components/new-card";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBoard, useGitStatus } from "@/hooks/use-board";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTaskCompletionNotifications } from "@/hooks/use-task-completion-notifications";
import { isTypingTarget } from "@/lib/hotkeys";
import { loadMobileColumn, saveMobileColumn } from "@/lib/mobile-column";
import { newCardHref, takeMobileColumnHint } from "@/lib/new-card-route";
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

  const controller = useBoard(boardId, {
    // Every way of adding a card on this board ends here: confirm it and show where it landed.
    onCardAdded: (task) => {
      setMobileColumn(task.status);
      toastCardAdded(task, { onOpen: () => openTask(task.id) });
    },
  });
  const { board, columns, tasks, loading, error, subscribe } = controller;
  useDocumentTitle(board?.name);
  const git = useGitStatus(boardId, subscribe);
  useTaskCompletionNotifications(boardId, tasks, subscribe);
  /** "New card" form open. */
  const [newCard, setNewCard] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleting, setDeleting] = useState<Task | null>(null);
  const [mobileColumn, setMobileColumn] = useState<TaskStatus>("todo");
  /** The user picked a column (tap, swipe, arrow keys): show it and reopen the board on it next time. */
  const pickMobileColumn = useCallback(
    (status: TaskStatus) => {
      setMobileColumn(status);
      saveMobileColumn(boardId, status);
    },
    [boardId],
  );

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

  // Reopen on the last column picked on this board, unless back from the phone "New card" page:
  // then show the column the new card landed in. Read after mount (storage is client-only);
  // declared before the deep-link sync so `?task=` wins.
  useEffect(() => {
    setMobileColumn(takeMobileColumnHint(boardId) ?? loadMobileColumn(boardId) ?? "todo");
  }, [boardId]);

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

  const create = async (text: string) => (await controller.createFromText(text)) !== null;

  // Phones get the full "New card" page (the board stays right behind it in history); desktop
  // the dialog. Whether it's a phone is decided at click time.
  const openNewCard = useCallback(() => {
    if (isMobile) router.push(newCardHref(boardId, { fromBoard: true }));
    else setNewCard(true);
  }, [isMobile, router, boardId]);

  // `N` and every "New card…" menu item land here while this board is open.
  useNewCardTarget(boardId, openNewCard);

  const { createTask, revertToTodo, runAgent, stopAgent, reload } = controller;
  const refreshGit = git.refresh;
  // Primitives, so menuActions (and every card) only change when shipping becomes (un)available.
  const canPush = canShip(git.statuses);
  const { prNoun, pushTarget } = shipLabels(git.statuses ?? []);
  const menuActions = useMemo<BoardMenuActions>(
    () => ({
      boardId,
      openCard: openTask,
      revertToTodo,
      runAgent,
      stopAgent,
      // The server's task.updated event strikes the card's title through once it's pushed.
      pushToMain: canPush
        ? async (taskId) => {
            await shipTask("push", taskId, { prNoun, pushTarget });
          }
        : null,
      duplicate: async (task) => {
        // A copy waits in To do even on auto-run boards: re-running a finished card is opt-in.
        await createTask({ title: `${task.title} (copy)`, description: task.description, start: false });
      },
      requestDelete: setDeleting,
      newCard: openNewCard,
      refresh: () => {
        void reload();
        void refreshGit();
      },
      openSettings: () => setSettingsOpen(true),
    }),
    [
      boardId,
      openTask,
      revertToTodo,
      runAgent,
      stopAgent,
      canPush,
      prNoun,
      pushTarget,
      createTask,
      openNewCard,
      reload,
      refreshGit,
    ],
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
            {/* Status group. Below lg (tablets, or a laptop with the sidebar open) it compacts:
                the live pill keeps its dot and the git button drops the branch name. */}
            <div className="flex min-w-0 items-center max-lg:[&_.font-mono]:hidden max-lg:[&_[role=status]>span:last-child]:sr-only">
              <ConnectionPill status={controller.connection} />
              <GitIndicator boardId={boardId} statuses={git.statuses} onChanged={() => void git.refresh()} />
            </div>
            <span aria-hidden className="mx-1 hidden h-5 w-px bg-border md:block" />
            {/* Phones use the thumb-reachable floating button instead; tablets get the icon only. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className="h-9 gap-1.5 transition-transform active:scale-[0.97] max-md:hidden max-lg:w-9 max-lg:px-0 motion-reduce:active:scale-100"
                  onClick={openNewCard}
                >
                  <Plus />
                  <span className="max-lg:sr-only">Add card</span>
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
          onQuickCreate={create}
          onAdd={openNewCard}
          mobileColumn={mobileColumn}
          onMobileColumnChange={pickMobileColumn}
        />
      </main>

      <NewTaskDialog open={newCard} onOpenChange={setNewCard} onCreate={create} />

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
    <div aria-busy="true" className="flex h-dvh animate-fade-in-soft flex-col overflow-hidden">
      <span className="sr-only">Loading project…</span>
      <div className="pt-safe border-b">
        <div className="flex h-14 items-center gap-3 px-3 sm:px-4">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
          <Skeleton className="hidden h-7 w-16 rounded-full md:block" />
          <Skeleton className="hidden h-9 w-28 lg:block" />
        </div>
      </div>
      <BoardBodySkeleton />
    </div>
  );
}
