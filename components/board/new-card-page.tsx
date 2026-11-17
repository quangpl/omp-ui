"use client";

import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FolderX, X } from "lucide-react";
import { toast } from "sonner";
import { toastCardAdded } from "@/components/board/card-added-toast";
import { type CreateFromText, NewTaskForm } from "@/components/board/new-task-form";
import { ProjectField } from "@/components/board/project-field";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { createCardFromText } from "@/hooks/use-board";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useKeyboardViewport } from "@/hooks/use-keyboard-viewport";
import { api } from "@/lib/api-client";
import { LAST_BOARD_KEY, newCardHref, setMobileColumnHint } from "@/lib/new-card-route";
import type { BoardWithCounts } from "@/lib/types";
import { cn } from "@/lib/utils";

/** sessionStorage: text typed before switching project, picked up by the page for that project. */
const DRAFT_KEY = "omp-ui:new-card-draft";

function stashDraft(boardId: string, text: string): void {
  if (!text.trim()) return;
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ boardId, text }));
  } catch {
    // Storage unavailable: the new project's page just starts empty.
  }
}

function takeDraft(boardId: string): string {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw === null) return "";
    sessionStorage.removeItem(DRAFT_KEY);
    const draft = JSON.parse(raw) as { boardId?: unknown; text?: unknown };
    return draft.boardId === boardId && typeof draft.text === "string" ? draft.text : "";
  } catch {
    return "";
  }
}

/**
 * Phone "New task" screen for `boardId` (`/b/[boardId]/new`): header with Cancel, the project
 * picker, then the form filling the rest. Only the textarea scrolls. Leaving goes back when the
 * board is right behind it in history (`?from=board`), else replaces this entry with the board.
 */
export function NewCardScreen({ boardId }: { boardId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromBoard = searchParams.get("from") === "board";
  const boardPath = `/b/${encodeURIComponent(boardId)}`;
  useDocumentTitle("New task");
  const keyboard = useKeyboardViewport();

  const [boards, setBoards] = useState<BoardWithCounts[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** Starting text; null until read on mount, since sessionStorage only exists on the client. */
  const [draft, setDraft] = useState<string | null>(null);
  const textRef = useRef("");

  useEffect(() => {
    const text = takeDraft(boardId);
    textRef.current = text;
    setDraft(text);
  }, [boardId]);

  useEffect(() => {
    let cancelled = false;
    setBoards(null);
    setLoadFailed(false);
    api.boards
      .list()
      .then((list) => {
        if (!cancelled) setBoards(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadFailed(true);
        toast.error("Couldn't load projects", {
          description: err instanceof Error ? err.message : undefined,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const board = boards?.find((b) => b.id === boardId);

  const leave = useCallback(() => {
    if (fromBoard) router.back();
    else router.replace(boardPath);
  }, [fromBoard, router, boardPath]);

  const switchProject = (id: string) => {
    if (id === boardId) return;
    stashDraft(id, textRef.current);
    router.replace(newCardHref(id));
  };

  const create: CreateFromText = async (text, { parallelize, ignoreMemory }) => {
    const task = await createCardFromText(boardId, text, { parallelize, ignoreMemory });
    if (!task) return false;
    localStorage.setItem(LAST_BOARD_KEY, boardId);
    setMobileColumnHint(boardId, task.status);
    toastCardAdded(task, {
      onOpen: () => router.push(`${boardPath}?task=${encodeURIComponent(task.id)}`),
    });
    leave();
    return true;
  };

  // The card still goes to the route's project, so a failed list only costs the picker.
  const projectField = loadFailed ? (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 py-2 pr-2 pl-3 text-sm text-destructive"
    >
      <span>Couldn&apos;t load projects. The card still goes to this one.</span>
      <Button
        type="button"
        variant="outline"
        className="h-11 shrink-0 pressable md:h-8"
        onClick={() => setAttempt((n) => n + 1)}
      >
        Retry
      </Button>
    </div>
  ) : (
    <ProjectField boards={boards} value={boardId} onValueChange={switchProject} />
  );

  return (
    <div
      className={cn(
        "flex h-dvh flex-col overflow-hidden bg-background",
        // Pin to the visible area (fixed elements are laid out against the layout viewport).
        keyboard && "fixed inset-x-0 top-0 z-30",
      )}
      style={
        keyboard
          ? ({
              height: keyboard.height,
              transform: `translateY(${keyboard.top}px)`,
              // The keyboard covers the home indicator, so the bottom bar needs no inset for it.
              "--new-card-bottom-inset": "0px",
            } as CSSProperties)
          : undefined
      }
    >
      <NewCardHeader subtitle={board?.name}>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 rounded-full text-muted-foreground pressable-icon hover:text-foreground md:size-9 md:rounded-lg"
          aria-label="Cancel"
          onClick={leave}
        >
          <X className="size-5" />
        </Button>
      </NewCardHeader>
      {boards !== null && !board ? (
        <MissingProject boards={boards} onPick={switchProject} />
      ) : draft === null ? (
        <NewCardBodySkeleton />
      ) : (
        <NewTaskForm
          layout="page"
          className="animate-fade-in-soft motion-reduce:animate-none"
          projectField={projectField}
          initialText={draft}
          onTextChange={(text) => {
            textRef.current = text;
          }}
          onSubmit={create}
          boardId={boardId}
        />
      )}
    </div>
  );
}

function NewCardHeader({ subtitle, children }: { subtitle?: string; children: ReactNode }) {
  return (
    <header className="pt-safe px-safe shrink-0 border-b bg-background">
      <div className="mx-auto flex h-14 w-full max-w-2xl items-center gap-1 px-1.5 sm:px-3">
        {children}
        <div className="min-w-0 flex-1 px-1">
          <h1 className="truncate text-[0.95rem] leading-tight font-semibold tracking-tight sm:text-base">New task</h1>
          {subtitle && <p className="truncate text-xs leading-tight text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
    </header>
  );
}

/** The route's project doesn't exist (deleted, or a stale link): offer the others instead. */
function MissingProject({ boards, onPick }: { boards: BoardWithCounts[]; onPick: (boardId: string) => void }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pt-10 sm:px-6 animate-fade-in-soft motion-reduce:animate-none">
      <div className="flex flex-col items-start gap-2">
        <span className="mb-1 flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <FolderX className="size-5" aria-hidden />
        </span>
        <h2 className="text-base font-semibold tracking-tight">Project not found</h2>
        <p className="max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
          {boards.length > 0
            ? "This project doesn't exist anymore. Pick another one for the card."
            : "This project doesn't exist anymore, and there are no others yet."}
        </p>
      </div>
      {boards.length > 0 && <ProjectField boards={boards} value="" onValueChange={onPick} />}
      <Button asChild variant="outline" className="h-11 self-start pressable md:h-9">
        <Link href="/">All projects</Link>
      </Button>
    </div>
  );
}

/** Placeholder matching the form's layout, so nothing jumps when it mounts. */
function NewCardBodySkeleton() {
  return (
    <div aria-busy="true" className="flex min-h-0 flex-1 flex-col">
      <span className="sr-only">Loading…</span>
      <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-4 px-4 pt-4 pb-3 sm:px-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-11 w-full md:h-9" />
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="min-h-24 w-full flex-1" />
        </div>
      </div>
      <div className="px-safe shrink-0 border-t">
        <div className="mx-auto flex w-full max-w-2xl px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-6">
          <Skeleton className="h-12 w-full md:ml-auto md:h-10 md:w-32" />
        </div>
      </div>
    </div>
  );
}

/** Suspense fallback for the route while search params resolve. */
export function NewCardPageSkeleton() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <NewCardHeader>
        <Skeleton className="size-11 shrink-0 rounded-full md:size-9 md:rounded-lg" />
      </NewCardHeader>
      <NewCardBodySkeleton />
    </div>
  );
}
