"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUp, FolderOpen, FolderTree, MessageSquarePlus } from "lucide-react";
import { toast } from "sonner";
import { toastCardAdded } from "@/components/board/card-added-toast";
import { useComposerAutocomplete } from "@/components/board/composer-autocomplete";
import { FilesWorkspace } from "@/components/board/files-workspace";
import { AgentStateBadge } from "@/components/board/task-card";
import { TaskProgressIcon } from "@/components/board/task-progress";
import { FolderPicker } from "@/components/folder-picker";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { createCardFromText } from "@/hooks/use-board";
import { useIsMobile } from "@/hooks/use-mobile";
import { api, subscribeEvents } from "@/lib/api-client";
import { type FileSource, fileSourceKey } from "@/lib/file-source";
import { modKeyLabel } from "@/lib/hotkeys";
import { type Board, type BoardWithCounts, STATUS_LABELS, type Task } from "@/lib/types";

/** Last source the page showed, used when `/files` is opened without one. */
const SOURCE_KEY = "omp-ui:files-source";

/** What the page edits, as kept in the URL (`?project=` / `?folder=`) and in localStorage. */
type Selection = { kind: "board"; boardId: string } | { kind: "folder"; root: string };

function readStoredSelection(): Selection | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SOURCE_KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const { kind, boardId, root } = value as Record<string, unknown>;
    if (kind === "board" && typeof boardId === "string" && boardId) return { kind, boardId };
    if (kind === "folder" && typeof root === "string" && root) return { kind, root };
  } catch {}
  return null;
}

/**
 * The Files page: edit the files of a project (workdir plus extra folders) or of any folder on the
 * server. For a project, the chat next to the editor turns each message into a new card there.
 */
export function FilesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const folderParam = searchParams.get("folder") || null;
  // A folder wins when both are in the URL.
  const projectParam = folderParam ? null : searchParams.get("project") || null;
  const isMobile = useIsMobile();

  const [boards, setBoards] = useState<BoardWithCounts[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Name of the file with unsaved edits in the workspace, else null. */
  const [dirtyFile, setDirtyFile] = useState<string | null>(null);
  /** Source switch waiting on the discard-changes confirmation; its texts stay put while it animates closed. */
  const [pending, setPending] = useState<{ open: boolean; next: Selection | null; name: string }>({
    open: false,
    next: null,
    name: "",
  });
  /** Cards created from this page (every project), oldest first; kept live while their project is shown. */
  const [created, setCreated] = useState<Task[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.boards.list().then(
      (list) => !cancelled && setBoards(list),
      (err: unknown) => {
        if (cancelled) return;
        setBoards([]);
        toast.error("Couldn't load projects", { description: err instanceof Error ? err.message : undefined });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const board = projectParam ? boards?.find((b) => b.id === projectParam) : undefined;

  const go = useCallback(
    (selection: Selection) =>
      router.replace(
        selection.kind === "board"
          ? `/files?project=${encodeURIComponent(selection.boardId)}`
          : `/files?folder=${encodeURIComponent(selection.root)}`,
        { scroll: false },
      ),
    [router],
  );

  // No source in the URL (or a project that is gone): the last one used, else the first project.
  useEffect(() => {
    if (folderParam) return;
    if (projectParam && (boards === null || boards.some((b) => b.id === projectParam))) return;
    const stored = readStoredSelection();
    if (stored?.kind === "folder") {
      go(stored);
      return;
    }
    if (boards === null) return;
    const storedBoard = stored?.kind === "board" ? boards.find((b) => b.id === stored.boardId) : undefined;
    const fallback = storedBoard ?? boards[0];
    if (fallback) go({ kind: "board", boardId: fallback.id });
    else if (projectParam) router.replace("/files", { scroll: false });
  }, [folderParam, projectParam, boards, go, router]);

  const boardId = board?.id ?? null;
  const workdir = board?.workdir ?? null;
  const extraKey = board ? board.extraFolders.join("\n") : "";

  useEffect(() => {
    const selection: Selection | null = folderParam
      ? { kind: "folder", root: folderParam }
      : boardId
        ? { kind: "board", boardId }
        : null;
    if (selection) localStorage.setItem(SOURCE_KEY, JSON.stringify(selection));
  }, [folderParam, boardId]);

  // Primitives only, so a refreshed board list keeps the same source (and the workspace's state).
  const source = useMemo<FileSource | null>(() => {
    if (folderParam) return { kind: "folder", root: folderParam };
    if (boardId && workdir !== null) {
      return { kind: "board", boardId, workdir, extraFolders: extraKey ? extraKey.split("\n") : [] };
    }
    return null;
  }, [folderParam, boardId, workdir, extraKey]);

  const switchTo = (next: Selection) => {
    if (next.kind === "board" ? next.boardId === boardId : next.root === folderParam) return;
    if (dirtyFile) setPending({ open: true, next, name: dirtyFile });
    else go(next);
  };

  const discard = () => {
    setPending((current) => ({ ...current, open: false }));
    if (pending.next) go(pending.next);
  };

  const addCard = useCallback((task: Task) => setCreated((current) => [...current, task]), []);

  // Live status of the cards created here, for the shown project only.
  const watching = boardId !== null && created.some((task) => task.boardId === boardId);
  useEffect(() => {
    if (!watching || !boardId) return;
    const update = (task: Task) =>
      setCreated((current) => (current.some((t) => t.id === task.id) ? current.map((t) => (t.id === task.id ? task : t)) : current));
    return subscribeEvents(
      (event) => {
        if (event.type === "task.updated") update(event.task);
        else if (event.type === "task.deleted") setCreated((current) => current.filter((t) => t.id !== event.taskId));
      },
      {
        boardId,
        // Events missed while the stream was down: refetch the board's cards once.
        onReconnect: () => {
          api.boards.tasks(boardId).then(
            (tasks) => tasks.forEach(update),
            () => {},
          );
        },
      },
    );
  }, [watching, boardId]);

  const boardCards = useMemo(
    () => (boardId ? created.filter((task) => task.boardId === boardId) : []),
    [created, boardId],
  );

  const renderChat = useCallback(
    (openFile: (path: string) => void) =>
      board ? <ProjectChat board={board} cards={boardCards} onCreated={addCard} openFile={openFile} /> : null,
    [board, boardCards, addCard],
  );

  let body: ReactNode;
  if (source) {
    body = (
      // Phones: the workspace stacks (tree, editor, chat) and scrolls here; desktop: it fills the height.
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain md:overflow-hidden">
        <FilesWorkspace
          key={fileSourceKey(source)}
          source={source}
          isMobile={isMobile}
          chat={source.kind === "board" ? renderChat : undefined}
          chatTitle="New task for the agent"
          onDirtyChange={setDirtyFile}
          className="md:min-h-0 md:flex-1"
        />
      </div>
    );
  } else if (boards === null || boards.length > 0) {
    // Projects loading, or about to land on the default one.
    body = (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="min-h-40 flex-1" />
      </div>
    );
  } else {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <FolderTree className="size-5" />
        </span>
        <p className="text-sm font-medium">Pick a folder to edit its files</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          No projects yet.{" "}
          <Link href="/" className="font-medium text-foreground underline underline-offset-4">
            Create a project
          </Link>{" "}
          to edit its files and ask the agent for changes, or open any folder on the server.
        </p>
        <Button className="h-11 pressable md:h-9" onClick={() => setPickerOpen(true)}>
          <FolderOpen />
          Choose folder…
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-2 py-2 md:px-3">
        <Select
          value={boardId ?? ""}
          onValueChange={(id) => switchTo({ kind: "board", boardId: id })}
          disabled={!boards?.length}
        >
          <SelectTrigger
            aria-label="Project"
            className="min-w-0 flex-1 data-[size=default]:h-11 sm:w-56 sm:flex-none md:data-[size=default]:h-9"
          >
            <SelectValue
              placeholder={boards === null ? "Loading projects…" : boards.length ? "Pick a project" : "No projects"}
            />
          </SelectTrigger>
          <SelectContent>
            {boards?.map((b) => (
              <SelectItem key={b.id} value={b.id} className="max-md:min-h-11">
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={folderParam ? "secondary" : "outline"}
          className="h-11 shrink-0 pressable md:h-9"
          onClick={() => setPickerOpen(true)}
        >
          <FolderOpen />
          Folder…
        </Button>
        <SourceLabel board={board} folder={folderParam} />
      </div>
      {body}

      <FolderPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title="Open a folder"
        initialPath={folderParam ?? workdir ?? undefined}
        onSelect={(root) => switchTo({ kind: "folder", root })}
      />
      <AlertDialog
        open={pending.open}
        onOpenChange={(next) => !next && setPending((current) => ({ ...current, open: false }))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes to {pending.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Opening another {pending.next?.kind === "folder" ? "folder" : "project"} drops your edits. Save first
              to keep them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="max-md:h-11">Keep editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" className="max-md:h-11" onClick={discard}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Where the files come from: the project's folders, or the opened folder. */
function SourceLabel({ board, folder }: { board: Board | undefined; folder: string | null }) {
  if (!folder && !board) return null;
  const path = folder ?? board?.workdir ?? "";
  const extra = folder ? 0 : (board?.extraFolders.length ?? 0);
  const title = folder
    ? folder
    : [`${board?.name}: ${path}`, ...(board?.extraFolders ?? [])].join("\n");
  return (
    <p
      className="flex min-w-0 basis-full items-center gap-1.5 px-1 text-xs text-muted-foreground sm:flex-1 sm:basis-auto"
      title={title}
    >
      <span className="shrink-0 font-medium text-foreground">{folder ? "Folder" : board?.name}</span>
      <span aria-hidden className="shrink-0">
        ·
      </span>
      <span className="min-w-0 truncate font-mono" dir="rtl">
        {/* `dir="rtl"` keeps the end of a long path visible; the LRM keeps "/" where it belongs. */}
        &lrm;{path}&lrm;
      </span>
      {extra > 0 && <span className="shrink-0">+{extra} {extra === 1 ? "folder" : "folders"}</span>}
    </p>
  );
}

/**
 * The project chat: each message becomes a new card in the project (its agent starts like a
 * "New task"), listed above the composer. "@" picks a project file and opens it in the editor.
 */
function ProjectChat({
  board,
  cards,
  onCreated,
  openFile,
}: {
  board: Board;
  /** Cards created from this page in `board`, oldest first. */
  cards: Task[];
  onCreated: (task: Task) => void;
  openFile: (path: string) => void;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Platform modifier for the send shortcut hint; read after mount (navigator isn't there on the server).
  const [modKey, setModKey] = useState("Ctrl");
  useEffect(() => setModKey(modKeyLabel()), []);
  const slash = useComposerAutocomplete(textareaRef, text, setText, {
    enabled: !sending,
    boardId: board.id,
    onPickFile: (hit) => {
      if (hit.kind === "file") openFile(hit.insert);
    },
  });

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    const task = await createCardFromText(board.id, value);
    setSending(false);
    if (!task) return;
    onCreated(task);
    setText("");
    const href = `/b/${encodeURIComponent(task.boardId)}?task=${encodeURIComponent(task.id)}`;
    toastCardAdded(task, { boardName: board.name, onOpen: () => router.push(href) });
  };

  return (
    <div className="flex min-h-full flex-col">
      {cards.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <MessageSquarePlus className="size-5" />
          </span>
          <p className="max-w-xs text-sm text-muted-foreground">
            Ask the agent to change these files. Each message starts a new card in {board.name}.
          </p>
        </div>
      ) : (
        <ol className="flex flex-1 flex-col gap-2 px-3 py-4 md:px-4" aria-label="Cards created here">
          {cards.map((task) => (
            <li key={task.id}>
              <Link
                href={`/b/${encodeURIComponent(task.boardId)}?task=${encodeURIComponent(task.id)}`}
                className="flex min-h-11 items-center gap-2.5 rounded-lg border bg-background px-3 py-2 text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 md:min-h-9"
              >
                <TaskProgressIcon task={task} />
                <span className="min-w-0 flex-1 truncate font-medium" title={task.title}>
                  {task.title}
                </span>
                {task.agentState === "idle" ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{STATUS_LABELS[task.status]}</span>
                ) : (
                  <AgentStateBadge
                    state={task.agentState}
                    retryAt={task.retryAt}
                    agentError={task.agentError}
                    className="shrink-0"
                  />
                )}
              </Link>
            </li>
          ))}
        </ol>
      )}

      <form
        className="glass-edge sticky bottom-0 z-10 border-t bg-popover/95 px-3 pt-3 pb-3 backdrop-blur supports-backdrop-filter:bg-popover/80 md:px-4"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="flex items-end gap-2 rounded-2xl border bg-background p-1.5 pl-1 shadow-xs transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
          {/* `relative` anchors the word ghost on the textarea. */}
          <div className="relative min-w-0 flex-1">
            <Textarea
              ref={textareaRef}
              value={text}
              rows={1}
              disabled={sending}
              placeholder="Describe a change — type @ to mention a file…"
              aria-label="New task for the agent"
              aria-autocomplete="list"
              aria-expanded={slash.open}
              data-suggesting={slash.suggesting || undefined}
              className="max-h-40 min-h-11 resize-none border-0 bg-transparent px-2.5 py-2.5 text-base shadow-none focus-visible:ring-0 md:min-h-9 md:py-2 md:text-sm dark:bg-transparent"
              onChange={(event) => setText(event.target.value)}
              onSelect={slash.onSelect}
              onKeyDown={(event) => {
                if (slash.onKeyDown(event)) return;
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            {slash.ghost}
          </div>
          <Button
            type="submit"
            size="icon"
            disabled={!text.trim() || sending}
            aria-label="Create card"
            title={`Create card (${modKey}+Enter)`}
            className="size-11 shrink-0 rounded-xl pressable-icon md:size-9"
          >
            <ArrowUp />
          </Button>
        </div>
        {(slash.suggestion || slash.menu) && (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {slash.suggestion}
            {slash.menu}
          </div>
        )}
        <p className="mt-1.5 flex items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">New card in {board.name}</span>
          <span className="flex shrink-0 items-center gap-1 max-md:hidden" aria-hidden>
            <KbdGroup>
              <Kbd>{modKey}</Kbd>
              <Kbd>↵</Kbd>
            </KbdGroup>
            to send
          </span>
        </p>
      </form>
    </div>
  );
}
