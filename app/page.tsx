"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { BoardCard } from "@/components/boards/board-card";
import { BoardFormDialog } from "@/components/boards/board-form-dialog";
import { BoardsEmptyState } from "@/components/boards/boards-empty-state";
import { DeleteBoardDialog } from "@/components/boards/delete-board-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, subscribeEvents } from "@/lib/api-client";
import type { Board, BoardWithCounts } from "@/lib/types";

type FormState = { open: boolean; board: Board | null };

export default function BoardsPage() {
  const router = useRouter();
  const [boards, setBoards] = useState<BoardWithCounts[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({ open: false, board: null });
  const [deleting, setDeleting] = useState<BoardWithCounts | null>(null);

  const load = useCallback(async () => {
    try {
      setBoards(await api.boards.list());
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
        // Counts and running indicators derive from boards, tasks and runs; ignore chatty run output.
        if (event.type.startsWith("board.") || event.type.startsWith("task.") || event.type === "run.updated") {
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

      <main className="px-safe pb-safe mx-auto w-full max-w-6xl flex-1">
        <div className="px-4 py-5 sm:px-6 sm:py-8">
          {loadError && boards === null ? (
            <div className="mx-auto flex max-w-sm flex-col items-center gap-4 py-16 text-center">
              <p className="text-sm text-muted-foreground">{loadError}</p>
              <Button variant="outline" onClick={() => void load()} className="h-11 md:h-9">
                <RefreshCwIcon />
                Try again
              </Button>
            </div>
          ) : boards === null ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3" aria-busy="true" aria-label="Loading projects">
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
          ) : boards.length === 0 ? (
            <BoardsEmptyState onCreate={openCreate} />
          ) : (
            <>
              <p className="mb-4 text-sm text-muted-foreground">
                {boards.length} project{boards.length === 1 ? "" : "s"} · tap one to open its board
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
                {boards.map((board) => (
                  <BoardCard
                    key={board.id}
                    board={board}
                    onEdit={(b) => setForm({ open: true, board: b })}
                    onDelete={setDeleting}
                  />
                ))}
              </div>
            </>
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
        onDeleted={(id) => setBoards((list) => list?.filter((b) => b.id !== id) ?? list)}
      />
    </div>
  );
}
