"use client";

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlignLeft,
  ArrowUp,
  CalendarClock,
  CircleHelp,
  Ellipsis,
  FileDiff,
  FolderOpen,
  LoaderCircle,
  MessageSquare,
  Paperclip,
  Rocket,
  Terminal,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useComposerAutocomplete } from "@/components/board/composer-autocomplete";
import { extractAttachments, RichText } from "@/components/board/rich-text";
import { openAttachment } from "@/components/attachment-viewer";
import { attachmentKind, isPlainClick, KIND_ICON } from "@/components/viewer/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiRequestError, api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  STATUS_LABELS,
  type Board,
  type Comment,
  type GitStatus,
  type Run,
  type Task,
} from "@/lib/types";
import { type BoardStreamListener, useQueueDrafting } from "@/hooks/use-board";
import { AgentLog } from "@/components/board/agent-log";
import { TaskProgressIcon, TodoListSection } from "@/components/board/task-progress";
import { CommentThread } from "@/components/board/comment-thread";
import { DETAIL_HEADING_CLASS, DetailSection } from "@/components/board/detail-section";
import { errorMessage, formatDateTime, formatRelative } from "@/components/board/format";
import { CodeChanges, useTaskDiff } from "@/components/board/code-changes";
import { quickActionForKey, quickActionsFor, type QuickActionId } from "@/components/board/quick-actions";
import { ShipActions, canShip, shipLabels, shipTask, useTaskGitStatus } from "@/components/board/ship-actions";
import { AgentStateBadge } from "@/components/board/task-card";
import { CreatedByNote, DelegatedCards, DependenciesSection } from "@/components/board/task-relations";
import { WorkspaceSection } from "@/components/board/task-workspace";
import { CheckpointsPanel } from "@/components/board/checkpoints-panel";
import { isQuotaError } from "@/lib/quota";
import { todoProgress } from "@/lib/todos";
import { FilesPanel } from "@/components/files-panel";
import { FilesWorkspace } from "@/components/board/files-workspace";

export interface TaskDetailProps {
  /** Selected card, or null when the panel is closed. */
  taskId: string | null;
  /** Live copy of the card from the board state (preferred over the fetched one). */
  boardTask: Task | undefined;
  /** The card's board (dedicated workspaces on/off). */
  board: Board;
  /** Every card of the board, for dependencies, delegation and agent-to-agent messages. */
  tasks: Task[];
  /** Show another card of the board in this panel. */
  onOpenTask: (taskId: string) => void;
  isMobile: boolean;
  onClose: () => void;
  subscribe: (listener: BoardStreamListener) => () => void;
  upsertTask: (task: Task) => void;
  removeTask: (taskId: string) => void;
  /** Sends the card back to To do (stopping its agent). Toasts its own errors. */
  revertToTodo: (taskId: string) => Promise<void>;
  /**
   * Git status of the board's folders (null while loading), for the Ship panel. Unused on boards
   * with dedicated workspaces: those ship from the card's own worktrees.
   */
  gitStatuses: GitStatus[] | null;
  /** Called after a push/PR so the board can re-read git status. */
  onGitChanged: () => void;
}

/** Card whose Files tab holds unsaved edits, and the edited file's name. */
interface DirtyFile {
  taskId: string;
  name: string;
}

/** Discard-edits confirmation. Its texts stay put while it animates closed. */
interface DiscardPrompt {
  open: boolean;
  /** Discard closes the panel (X, Esc, overlay, swipe); otherwise it lets an outside switch or close through. */
  close: boolean;
  /** Another card is being opened (wording). */
  nextCard: boolean;
  name: string;
}

/**
 * Card details: a right-hand sheet on desktop, a near full-height drawer on phones.
 *
 * Unsaved Files-tab edits are guarded: closing the panel asks first, and so does any switch or close
 * from outside it (J / K, card links, browser Back): the edited card stays shown meanwhile and Keep
 * editing restores its URL. Forced closes (card deleted or missing) drop the edits.
 */
export function TaskDetail(props: TaskDetailProps) {
  const { taskId, isMobile, onClose, onOpenTask } = props;
  // Changes widens the desktop sheet so diffs and their file list fit side by side; Files takes
  // nearly the whole screen for the tree, the editor and the chat.
  const [width, setWidth] = useState<DetailWidth>("normal");
  // Keep rendering the last card while the panel animates closed.
  const [shownId, setShownId] = useState(taskId);
  useEffect(() => {
    if (taskId) setShownId(taskId);
  }, [taskId]);

  const [dirty, setDirty] = useState<DirtyFile | null>(null);
  const [prompt, setPrompt] = useState<DiscardPrompt>({ open: false, close: false, nextCard: false, name: "" });
  const [prevTaskId, setPrevTaskId] = useState(taskId);
  if (taskId !== prevTaskId) {
    setPrevTaskId(taskId);
    if (dirty && taskId !== dirty.taskId) {
      setPrompt({ open: true, close: false, nextCard: taskId !== null, name: dirty.name });
    }
  }
  // Keep editing after an outside switch or close: point the URL back at the edited card.
  const leftDirty = !prompt.open && dirty !== null && taskId !== dirty.taskId;
  useEffect(() => {
    if (leftDirty && dirty) onOpenTask(dirty.taskId);
  }, [leftDirty, dirty, onOpenTask]);

  // Until the edits are discarded, the edited card stays shown (and the panel open).
  const open = taskId !== null || dirty !== null;
  const onOpenChange = (next: boolean) => {
    if (next) return;
    if (dirty) setPrompt({ open: true, close: true, nextCard: false, name: dirty.name });
    else onClose();
  };
  const forceClose = () => {
    setDirty(null);
    onClose();
  };
  const discard = () => {
    setPrompt((current) => ({ ...current, open: false }));
    setDirty(null);
    if (prompt.close) onClose();
  };

  const visibleId = dirty?.taskId ?? taskId ?? shownId;
  // While a switch waits on the confirmation, the board's selected card is the next one.
  const boardTask = props.boardTask?.id === visibleId ? props.boardTask : undefined;
  const content = visibleId ? (
    <TaskDetailBody
      key={visibleId}
      {...props}
      taskId={visibleId}
      boardTask={boardTask}
      onClose={forceClose}
      onWidthChange={setWidth}
      onDirtyChange={setDirty}
    />
  ) : null;
  const title = boardTask?.title ?? "Card";

  const discardDialog = (
    <AlertDialog
      open={prompt.open}
      onOpenChange={(next) => !next && setPrompt((current) => ({ ...current, open: false }))}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes to {prompt.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {prompt.nextCard ? "Opening another card" : "Closing the card"} drops your edits. Save first to
            keep them.
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
  );

  if (isMobile) {
    return (
      <>
        <Drawer open={open} onOpenChange={onOpenChange}>
          <DrawerContent
            className="h-[calc(100dvh-1rem-env(safe-area-inset-top))] outline-none data-[vaul-drawer-direction=bottom]:mt-0 data-[vaul-drawer-direction=bottom]:max-h-[calc(100dvh-1rem-env(safe-area-inset-top))] data-[vaul-drawer-direction=bottom]:rounded-t-2xl"
            onOpenAutoFocus={focusPanel}
            onEscapeKeyDown={keepOpenWhileEditing}
          >
            <DrawerTitle className="sr-only">{title}</DrawerTitle>
            <DrawerDescription className="sr-only">Card details, feedback and agent log</DrawerDescription>
            <DrawerClose asChild>
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-2.5 right-2 z-20 size-11 rounded-full text-muted-foreground pressable-icon hover:text-foreground"
              >
                <X />
                <span className="sr-only">Close</span>
              </Button>
            </DrawerClose>
            {content}
          </DrawerContent>
        </Drawer>
        {discardDialog}
      </>
    );
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          className={cn(
            "w-full gap-0 p-0 outline-none data-[side=right]:sm:max-w-xl",
            width === "full"
              ? "data-[side=right]:md:max-w-[min(96vw,90rem)]"
              : width === "wide"
                ? "data-[side=right]:lg:max-w-5xl"
                : "data-[side=right]:xl:max-w-2xl",
          )}
          onOpenAutoFocus={focusPanel}
          onEscapeKeyDown={keepOpenWhileEditing}
        >
          <SheetTitle className="sr-only">{title}</SheetTitle>
          <SheetDescription className="sr-only">Card details, feedback and agent log</SheetDescription>
          {content}
        </SheetContent>
      </Sheet>
      {discardDialog}
    </>
  );
}

/**
 * Opening a card must not drop the caret into the title (accidental edits, mobile keyboard).
 * Focus the dialog container instead: focus stays trapped inside and Tab reaches every control.
 */
function focusPanel(event: Event) {
  event.preventDefault();
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus({ preventScroll: true });
}

/**
 * Esc inside a text field leaves the field (fields revert their own edits) instead of closing the panel.
 * Radix sees Escape before the field does: with autocomplete suggestions or a word completion showing,
 * Escape only hides them (the field's handler) and the field keeps focus. The Files tab's CodeMirror
 * editor (a contentEditable inside `.cm-editor`) counts as a text field.
 */
function keepOpenWhileEditing(event: KeyboardEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (!target.matches("textarea, input") && !target.isContentEditable && !target.closest(".cm-editor")) return;
  event.preventDefault();
  if (target.getAttribute("aria-expanded") === "true" || target.hasAttribute("data-suggesting")) return;
  requestAnimationFrame(() => target.blur());
}

/** A copy received over SSE (`value: null` = deleted) and when it arrived (`performance.now()`). */
interface LiveCopy<T> {
  at: number;
  value: T | null;
}

/** Fetched list, with any SSE copies that arrived after the fetch started applied on top. */
function reconcile<T extends { id: string }>(
  fetched: T[],
  live: Map<string, LiveCopy<T>>,
  since: number,
): T[] {
  let result = fetched;
  for (const [id, copy] of live) {
    if (copy.at <= since) continue;
    result = copy.value ? upsertById(result, copy.value) : result.filter((item) => item.id !== id);
  }
  return result;
}

/** `incoming` unless `held` is strictly newer (out-of-order snapshots never win). */
function newerTask(held: Task | undefined, incoming: Task): Task {
  return held && held.updatedAt > incoming.updatedAt ? held : incoming;
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

interface DetailState {
  task: Task;
  comments: Comment[];
  runs: Run[];
}

/** Panel tabs in order; ] / [ step through them. */
const DETAIL_TABS = ["activity", "log", "changes", "files"] as const;
type DetailTab = (typeof DETAIL_TABS)[number];

/** Desktop sheet width: normal, wide (Changes) or nearly full screen (Files). */
type DetailWidth = "normal" | "wide" | "full";

/** Keys that scroll a focused scroll container. */
const SCROLL_KEYS: Record<string, true> = {
  PageUp: true,
  PageDown: true,
  Home: true,
  End: true,
  " ": true,
  ArrowUp: true,
  ArrowDown: true,
};

function TaskDetailBody({
  taskId,
  boardTask,
  board,
  tasks,
  onOpenTask,
  onClose,
  isMobile,
  subscribe,
  upsertTask,
  removeTask,
  revertToTodo,
  gitStatuses,
  onGitChanged,
  onWidthChange,
  onDirtyChange,
}: TaskDetailProps & {
  taskId: string;
  onWidthChange: (width: DetailWidth) => void;
  /** The Files tab's unsaved edits (null: none). */
  onDirtyChange: (dirty: DirtyFile | null) => void;
}) {
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [tab, setTab] = useState<DetailTab>("activity");
  // The Files tab mounts on first open (it lists and reads project files), then stays mounted.
  const [filesOpened, setFilesOpened] = useState(false);
  if (tab === "files" && !filesOpened) setFilesOpened(true);
  const tabsRef = useRef<HTMLDivElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef<HTMLDivElement>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [shipRequested, setShipRequested] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const deletingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Latest R/S/Z handler for the open card (set once the card is loaded).
  const quickKeyRef = useRef<((event: KeyboardEvent) => void) | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => quickKeyRef.current?.(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Copies received over SSE, with receive time. SSE is authoritative: an API response or fetch
  // that started before a live copy arrived must not overwrite it (e.g. a stale `resolved: false`).
  const liveCommentsRef = useRef(new Map<string, LiveCopy<Comment>>());
  const liveRunsRef = useRef(new Map<string, LiveCopy<Run>>());

  const load = useCallback(async () => {
    const since = performance.now();
    try {
      const data = await api.tasks.get(taskId);
      setDetail((prev) => ({
        task: newerTask(prev?.task, data.task),
        comments: reconcile(data.comments, liveCommentsRef.current, since),
        runs: reconcile(data.runs, liveRunsRef.current, since),
      }));
      upsertTask(data.task);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        toast.error("This card no longer exists", { id: `task-missing-${taskId}` });
        onCloseRef.current();
      } else {
        toast.error("Couldn't load card", { description: errorMessage(err) });
      }
    }
  }, [taskId, upsertTask]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      subscribe((event) => {
        switch (event.type) {
          case "stream.reconnected":
            void load();
            break;
          case "task.updated":
            if (event.task.id === taskId) {
              setDetail((prev) => (prev ? { ...prev, task: newerTask(prev.task, event.task) } : prev));
            }
            break;
          case "task.deleted":
            if (event.taskId === taskId && !deletingRef.current) {
              toast("This card was deleted", { id: `task-deleted-${taskId}` });
              onCloseRef.current();
            }
            break;
          case "comment.added":
          case "comment.updated":
            if (event.comment.taskId === taskId) {
              const comment = event.comment;
              liveCommentsRef.current.set(comment.id, { at: performance.now(), value: comment });
              setDetail((prev) =>
                prev ? { ...prev, comments: upsertById(prev.comments, comment) } : prev,
              );
            }
            break;
          case "comment.deleted":
            if (event.taskId === taskId) {
              const { commentId } = event;
              liveCommentsRef.current.set(commentId, { at: performance.now(), value: null });
              setDetail((prev) =>
                prev ? { ...prev, comments: prev.comments.filter((c) => c.id !== commentId) } : prev,
              );
            }
            break;
          case "run.updated":
            if (event.run.taskId === taskId) {
              const run = event.run;
              liveRunsRef.current.set(run.id, { at: performance.now(), value: run });
              setDetail((prev) => (prev ? { ...prev, runs: upsertById(prev.runs, run) } : prev));
            }
            break;
        }
      }),
    [subscribe, taskId, load],
  );

  /** Apply a comment returned by an API call started at `since`, unless SSE already delivered a newer copy. */
  const applyCommentResponse = (comment: Comment, since: number) => {
    const live = liveCommentsRef.current.get(comment.id);
    if (live && live.at > since) return;
    setDetail((prev) => (prev ? { ...prev, comments: upsertById(prev.comments, comment) } : prev));
  };

  const task = boardTask && detail ? newerTask(detail.task, boardTask) : (boardTask ?? detail?.task);
  // Dedicated workspaces: ship from the card's worktrees instead of the project folders.
  const workspaceGit = useTaskGitStatus(
    taskId,
    board.worktrees && (task?.status === "done" || shipRequested),
    task?.agentState,
  );
  const diffState = useTaskDiff(
    taskId,
    task?.agentState,
    tab === "changes" && (task?.agentState === "running" || task?.agentState === "queued"),
  );
  useEffect(
    () => onWidthChange(tab === "files" ? "full" : tab === "changes" ? "wide" : "normal"),
    [tab, onWidthChange],
  );
  // Desktop Files tab: the workspace fills exactly the scroll area below the sticky tab bar, scrolled
  // so the bar is at the top (toolbar, editor and chat composer all in view). Re-fits on resizes
  // (window, the sheet widening, the details above reflowing) until the user scrolls the panel away.
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const tabs = tabsRef.current;
    const bar = tabBarRef.current;
    const details = detailsRef.current;
    const files = filesRef.current;
    if (tab !== "files" || isMobile || !scroll || !tabs || !bar || !details || !files) return;
    // Decided from user input, not scrollTop: scroll anchoring, clamping while layout settles and
    // scrollIntoView/focus inside the workspace all move scrollTop without the user scrolling away.
    let userScrolled = false;
    const fit = () => {
      files.style.height = `${scroll.clientHeight - bar.offsetHeight}px`;
      if (userScrolled) return;
      // The Tabs root never sticks, so its top is the bar's static position (the bar's own rect
      // reads as aligned whenever it is stuck).
      const scrollerTop = scroll.getBoundingClientRect().top + scroll.clientTop;
      scroll.scrollTop = tabs.getBoundingClientRect().top - scrollerTop + scroll.scrollTop;
    };
    // Wheel/touch inside the workspace scrolls the editor, tree or chat, not the panel.
    const onPointerScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !files.contains(event.target)) userScrolled = true;
    };
    // Scrollbar drags land on the scroll container itself.
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === scroll) userScrolled = true;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target === scroll && SCROLL_KEYS[event.key] === true) userScrolled = true;
    };
    scroll.style.overflowAnchor = "none";
    fit();
    const observer = new ResizeObserver(fit);
    for (const el of [scroll, bar, details]) observer.observe(el);
    window.addEventListener("resize", fit);
    // The sheet animates to full width when this tab opens; fit once more when it settles.
    const sheet = scroll.closest("[role='dialog']");
    sheet?.addEventListener("transitionend", fit);
    scroll.addEventListener("wheel", onPointerScroll, { passive: true });
    scroll.addEventListener("touchmove", onPointerScroll, { passive: true });
    scroll.addEventListener("pointerdown", onPointerDown);
    scroll.addEventListener("keydown", onKeyDown);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
      sheet?.removeEventListener("transitionend", fit);
      scroll.removeEventListener("wheel", onPointerScroll);
      scroll.removeEventListener("touchmove", onPointerScroll);
      scroll.removeEventListener("pointerdown", onPointerDown);
      scroll.removeEventListener("keydown", onKeyDown);
      scroll.style.overflowAnchor = "";
      files.style.height = "";
    };
  }, [tab, isMobile]);
  const drafting = useQueueDrafting(taskId) && task?.agentState === "queued";

  if (!task) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" aria-busy>
        <div className={cn("flex shrink-0 flex-col gap-3 border-b pr-14", isMobile ? "px-4 pt-2 pb-3" : "px-5 pt-5 pb-4")}>
          <Skeleton className="h-7 w-3/4" />
          <div className="flex gap-2">
            <Skeleton className="h-6 w-24 rounded-full" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          {!isMobile && (
            <div className="flex gap-2">
              <Skeleton className="h-9 w-28" />
              <Skeleton className="h-9 w-36" />
            </div>
          )}
        </div>
        <div className="flex flex-col gap-5 px-4 py-5 md:px-5">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-16 w-2/3 self-end" />
          <Skeleton className="h-20 w-5/6" />
        </div>
      </div>
    );
  }

  const active = task.agentState === "running" || task.agentState === "queued";
  const shipVisible = task.status === "done" || shipRequested;
  const comments = detail
    ? detail.comments.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : [];
  const runs = detail?.runs ?? [];

  const save = async (patch: { title?: string; description?: string; blockedBy?: string[] }) => {
    try {
      const updated = await api.tasks.update(task.id, patch);
      upsertTask(updated);
      return true;
    } catch (err) {
      toast.error("Couldn't save changes", { description: errorMessage(err) });
      return false;
    }
  };

  const toggleAgent = async (start: boolean) => {
    setAgentBusy(true);
    try {
      upsertTask(start ? await api.tasks.run(task.id) : await api.tasks.stop(task.id));
    } catch (err) {
      toast.error(start ? "Couldn't start the agent" : "Couldn't stop the agent", {
        description: errorMessage(err),
      });
    } finally {
      setAgentBusy(false);
    }
  };

  // Same rule as the board: Push to main needs a project folder that is a git repo with a remote.
  const canPush = canShip(gitStatuses);

  const pushToMain = async () => {
    const outcome = await shipTask("push", task.id, shipLabels(gitStatuses ?? []));
    if (!outcome) return;
    // Brand-new comment: the SSE copy, if it already arrived, wins. task.updated strikes the title.
    applyCommentResponse(outcome.comment, Number.NEGATIVE_INFINITY);
    if (board.worktrees) workspaceGit.refresh();
    onGitChanged();
  };

  const runQuickAction = async (id: QuickActionId) => {
    if (id !== "revert" && id !== "push") return toggleAgent(id !== "stop");
    setAgentBusy(true);
    try {
      await (id === "push" ? pushToMain() : revertToTodo(task.id));
    } finally {
      setAgentBusy(false);
    }
  };

  const quickActions = quickActionsFor(task, { canPush });
  quickKeyRef.current = (event) => {
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    // Only keys pressed inside this panel (not in menus or confirm dialogs portaled above it).
    const panel = scrollRef.current?.closest("[role='dialog']");
    const target = event.target;
    if (!(target instanceof HTMLElement) || !(target === document.body || panel?.contains(target))) return;
    // Typing in a field never triggers single-key actions.
    if (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]")) return;
    // ] / [: next / previous tab.
    if ((event.key === "]" || event.key === "[") && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const index = DETAIL_TABS.indexOf(tab);
      setTab(DETAIL_TABS[(index + (event.key === "]" ? 1 : -1) + DETAIL_TABS.length) % DETAIL_TABS.length]);
      return;
    }
    if (agentBusy) return;
    const action = quickActionForKey(task, event, { canPush });
    if (!action) return;
    event.preventDefault();
    void runQuickAction(action.id);
  };

  const send = async (body: string) => {
    const since = performance.now();
    try {
      applyCommentResponse(await api.tasks.comment(task.id, body), since);
      return true;
    } catch (err) {
      toast.error("Couldn't send feedback", { description: errorMessage(err) });
      return false;
    }
  };

  /** Posts the answer as feedback, then starts the agent (a comment alone doesn't from To do). */
  const answerQuestion = async (body: string) => {
    if (!(await send(body))) return false;
    try {
      upsertTask(await api.tasks.run(task.id));
    } catch (err) {
      toast.error("Couldn't start the agent", { description: errorMessage(err) });
    }
    return true;
  };

  const dismissQuestion = async () => {
    try {
      upsertTask(await api.tasks.update(task.id, { question: null }));
    } catch (err) {
      toast.error("Couldn't dismiss the question", { description: errorMessage(err) });
    }
  };

  const setResolved = async (comment: Comment, resolved: boolean) => {
    const since = performance.now();
    try {
      applyCommentResponse(await api.comments.setResolved(comment.id, resolved), since);
    } catch (err) {
      toast.error("Couldn't update feedback", { description: errorMessage(err) });
    }
  };

  const remove = async () => {
    deletingRef.current = true;
    try {
      await api.tasks.remove(task.id);
      removeTask(task.id);
      toast.success("Card deleted");
      onClose();
    } catch (err) {
      deletingRef.current = false;
      toast.error("Couldn't delete card", { description: errorMessage(err) });
    }
  };

  const latestRun = runs.reduce<Run | null>(
    (latest, run) => (!latest || run.startedAt > latest.startedAt ? run : latest),
    null,
  );
  const todos = todoProgress(task.todos, task.openCommentCount);

  const moreMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={isMobile ? "outline" : "ghost"}
          size="icon"
          className={cn("shrink-0", isMobile ? "size-12 pressable-icon" : "size-9 pressable-icon")}
          aria-label="More card actions"
        >
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={isMobile ? "top" : "bottom"} className="w-52">
        <DropdownMenuItem className="max-md:min-h-11" disabled={shipVisible} onSelect={() => setShipRequested(true)}>
          <Rocket />
          Ship changes…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" className="max-md:min-h-11" onSelect={() => setDeleteOpen(true)}>
          <Trash2 />
          Delete card
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const actionIcon = (action: (typeof quickActions)[number], index: number) => {
    if (agentBusy && index === 0) return <LoaderCircle className="animate-spin" />;
    const Icon = action.icon;
    return <Icon className={action.filled ? "fill-current" : undefined} />;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className={cn("shrink-0 border-b", isMobile ? "px-4 pt-1.5 pb-3" : "px-5 pt-4 pb-3.5")}>
        <div className={isMobile ? "pr-11" : "pr-8"}>
          <TitleEditor task={task} onSave={(title) => save({ title })} />
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 px-1.5">
            <span
              role="status"
              aria-label="Status"
              title="Status follows the agent. Use the quick actions to change it."
              className="inline-flex h-6 items-center gap-1.5 rounded-full border bg-background px-2.5 text-xs font-medium"
            >
              <TaskProgressIcon task={task} className="size-3.5" />
              {STATUS_LABELS[task.status]}
              {todos && (
                <span
                  className="font-normal text-muted-foreground tabular-nums"
                  title={todos.feedback > 0 ? `Includes ${todos.feedback} open feedback` : undefined}
                >
                  · {todos.done}/{todos.total}
                </span>
              )}
            </span>
            <AgentStateBadge
              state={task.agentState}
              retryAt={task.retryAt}
              agentError={task.agentError}
              drafting={drafting}
            />
            {task.pushedAt && (
              <span
                title={`Pushed to main ${formatDateTime(task.pushedAt)}`}
                className="inline-flex h-6 items-center gap-1 rounded-full bg-success/10 px-2 text-xs font-medium text-success"
              >
                <Upload className="size-3" />
                Pushed
              </span>
            )}
          </div>
          {task.createdByTaskId && (
            <div className="mt-2">
              <CreatedByNote task={task} cards={tasks} onOpenCard={onOpenTask} />
            </div>
          )}
          {task.schedulerId && (
            <p className="mt-2 flex flex-wrap items-center gap-x-1 px-1.5 text-xs text-muted-foreground">
              <CalendarClock className="size-3.5 shrink-0 text-primary" />
              Created by a
              <Link
                href={`/schedulers/${encodeURIComponent(task.schedulerId)}`}
                className="relative rounded font-medium text-foreground underline-offset-2 outline-none after:absolute after:-inset-x-1 after:-inset-y-3 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                scheduler
              </Link>
            </p>
          )}
        </div>
        {!isMobile && (
          <div className="mt-3.5 flex flex-wrap items-center gap-1.5 px-0.5">
            {quickActions.map((action, index) => (
              <Tooltip key={action.id}>
                <TooltipTrigger asChild>
                  <Button
                    variant={index === 0 && action.id !== "stop" ? "default" : "outline"}
                    className="h-9 px-3.5 pressable"
                    disabled={agentBusy}
                    onClick={() => void runQuickAction(action.id)}
                  >
                    {actionIcon(action, index)}
                    {action.label}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {action.hint} <Kbd>{action.shortcut}</Kbd>
                </TooltipContent>
              </Tooltip>
            ))}
            <div className="ml-auto">{moreMenu}</div>
          </div>
        )}
      </header>

      <div ref={scrollRef} className="scrollbar-subtle min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
        <div ref={detailsRef} className="flex min-w-0 animate-fade-in-soft flex-col gap-6 px-4 pt-4 pb-6 md:px-5 md:pt-5">
          {task.agentState === "error" && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>
                {task.retryAt
                  ? `${isQuotaError(task.agentError) ? "Waiting for quota" : "Agent failed"} — retrying automatically (retry ${task.autoRetries})`
                  : "Agent failed"}
              </AlertTitle>
              <AlertDescription className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
                {task.agentError || "The last run ended with an error."}
                {task.retryAt && (
                  <span className="mt-1 block text-muted-foreground" title={formatDateTime(task.retryAt)}>
                    Next attempt{" "}
                    {Date.parse(task.retryAt) - Date.now() < 45_000 ? "in a few seconds" : formatRelative(task.retryAt)}
                    ; Stop cancels it.
                  </span>
                )}
              </AlertDescription>
            </Alert>
          )}

          {task.question && (
            <QuestionPanel question={task.question} onAnswer={answerQuestion} onDismiss={dismissQuestion} />
          )}

          {shipVisible && (
            <ShipActions
              task={task}
              statuses={board.worktrees ? workspaceGit.statuses : gitStatuses}
              fromWorkspace={board.worktrees}
              onShipped={(comment) => {
                // Brand-new comment: the SSE copy, if it already arrived, wins.
                applyCommentResponse(comment, Number.NEGATIVE_INFINITY);
                if (board.worktrees) workspaceGit.refresh();
                onGitChanged();
              }}
            />
          )}

          <dl className="grid grid-cols-1 divide-y divide-border/70 border-y border-border/70 text-sm md:grid-cols-2 md:gap-x-6 md:gap-y-3 md:divide-y-0 md:py-3.5">
            <MetaItem label="Created">
              <time dateTime={task.createdAt} title={formatDateTime(task.createdAt)}>
                {formatRelative(task.createdAt)}
              </time>
            </MetaItem>
            <MetaItem label="Updated">
              <time dateTime={task.updatedAt} title={formatDateTime(task.updatedAt)}>
                {formatRelative(task.updatedAt)}
              </time>
            </MetaItem>
            <MetaItem label="Agent runs">
              {latestRun ? (
                <span className="font-mono tabular-nums">
                  {runs.length}
                  <span className="text-muted-foreground" title={formatDateTime(latestRun.startedAt)}>
                    {" "}
                    · last {formatRelative(latestRun.startedAt)}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">{detail ? "None yet" : "…"}</span>
              )}
            </MetaItem>
            <MetaItem label="Pushed to main">
              {task.pushedAt ? (
                <time dateTime={task.pushedAt} title={formatDateTime(task.pushedAt)}>
                  {formatRelative(task.pushedAt)}
                </time>
              ) : (
                <span className="text-muted-foreground">Not yet</span>
              )}
            </MetaItem>
          </dl>

          <TodoListSection task={task} />

          <DescriptionEditor task={task} onSave={(description) => save({ description })} />

          <DependenciesSection
            task={task}
            cards={tasks}
            onOpenCard={onOpenTask}
            onChange={(blockedBy) => save({ blockedBy })}
          />
          <DelegatedCards task={task} cards={tasks} onOpenCard={onOpenTask} />
          {board.worktrees && <WorkspaceSection task={task} onRemoved={workspaceGit.refresh} />}
          <CheckpointsPanel task={task} onRestored={workspaceGit.refresh} />
          <DetailSection icon={Paperclip} title="Files">
            <p className="text-xs text-muted-foreground">
              The agent reads these files and saves its outputs and screenshots here.
            </p>
            <FilesPanel
              scope="tasks"
              id={task.id}
              emptyHint="No files yet. Add files for the agent or let it save results here."
            />
          </DetailSection>
        </div>

        <Tabs ref={tabsRef} value={tab} onValueChange={(value) => setTab(value as DetailTab)} className="gap-0">
          <div
            ref={tabBarRef}
            className="glass-edge sticky top-0 z-10 border-y bg-popover/95 backdrop-blur supports-backdrop-filter:bg-popover/85"
          >
            <div className="scroll-row">
              <TabsList
                variant="line"
                className="w-max min-w-full justify-start gap-1 px-2 group-data-horizontal/tabs:h-12 md:px-3 md:group-data-horizontal/tabs:h-11"
              >
                <TabsTrigger value="activity" className={TAB_TRIGGER_CLASS}>
                  <MessageSquare />
                  Activity
                  {comments.length > 0 && <TabCount>{comments.length}</TabCount>}
                </TabsTrigger>
                <TabsTrigger value="log" className={TAB_TRIGGER_CLASS}>
                  <Terminal />
                  Agent log
                  {active ? (
                    <span aria-label="Agent active" className="relative flex size-1.5">
                      <span aria-hidden className="absolute inset-0 rounded-full bg-primary animate-breathe" />
                      <span className="relative size-1.5 rounded-full bg-primary" />
                    </span>
                  ) : (
                    runs.length > 0 && <TabCount>{runs.length}</TabCount>
                  )}
                </TabsTrigger>
                <TabsTrigger value="changes" className={TAB_TRIGGER_CLASS}>
                  <FileDiff />
                  Changes
                  {diffState.diff && diffState.diff.stats.files > 0 && (
                    <TabCount>{diffState.diff.stats.files}</TabCount>
                  )}
                </TabsTrigger>
                <TabsTrigger value="files" className={TAB_TRIGGER_CLASS}>
                  <FolderOpen />
                  Files
                </TabsTrigger>
                <span className="ml-auto hidden items-center gap-1 pr-1 text-[11px] text-muted-foreground lg:flex" aria-hidden>
                  <Kbd>[</Kbd>
                  <Kbd>]</Kbd>
                  switch tabs
                </span>
              </TabsList>
            </div>
          </div>
          <TabsContent value="activity" className="min-w-0">
            {detail ? (
              <CommentThread
                task={task}
                comments={comments}
                cards={tasks}
                onOpenCard={onOpenTask}
                onSend={send}
                onSetResolved={setResolved}
                runs={runs}
              />
            ) : (
              <ThreadSkeleton />
            )}
          </TabsContent>
          <TabsContent value="log" forceMount className="min-w-0 data-[state=inactive]:hidden">
            {detail ? (
              <AgentLog runs={runs} subscribe={subscribe} scrollRef={scrollRef} visible={tab === "log"} />
            ) : (
              <ThreadSkeleton />
            )}
          </TabsContent>
          <TabsContent value="changes" forceMount className="min-w-0 data-[state=inactive]:hidden">
            <CodeChanges taskId={task.id} active={active} visible={tab === "changes"} state={diffState} />
          </TabsContent>
          {/* Stays mounted once opened so the open file and its unsaved edits survive tab switches.
              Desktop: sized by the fit effect; sticky inside a parent of its own height, so it never
              moves, but CodeMirror stops scrolling ancestors at a sticky element (typing scrolls the
              editor only). */}
          <TabsContent value="files" forceMount className="min-w-0 data-[state=inactive]:hidden">
            {filesOpened && (
              <div ref={filesRef} className={isMobile ? undefined : "sticky top-0 h-[calc(100dvh-7rem)] min-h-96"}>
                <FilesWorkspace
                  board={board}
                  isMobile={isMobile}
                  onDirtyChange={(name) => onDirtyChange(name ? { taskId, name } : null)}
                  chat={(openFile) =>
                    detail ? (
                      <CommentThread
                        task={task}
                        comments={comments}
                        cards={tasks}
                        onOpenCard={onOpenTask}
                        onSend={send}
                        onSetResolved={setResolved}
                        runs={runs}
                        boardId={task.boardId}
                        onPickFile={(hit) => {
                          if (hit.kind === "file") openFile(hit.insert);
                        }}
                      />
                    ) : (
                      <ThreadSkeleton />
                    )
                  }
                />
              </div>
            )}
          </TabsContent>
        </Tabs>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t px-4 pt-5 pb-6 md:px-5 md:py-4">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            Deletes the card, its feedback and agent logs.
          </p>
          <Button variant="destructive" className="h-11 pressable max-md:w-full md:h-8" onClick={() => setDeleteOpen(true)}>
            <Trash2 />
            Delete card
          </Button>
          <DeleteCardDialog
            title={task.title}
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            onConfirm={remove}
          />
        </footer>
      </div>

      {isMobile && (
        <div className="glass-edge flex shrink-0 items-center gap-2 border-t bg-popover/95 px-3 pt-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] backdrop-blur supports-backdrop-filter:bg-popover/85">
          {quickActions.map((action, index) =>
            index === 0 ? (
              <Button
                key={action.id}
                variant={action.id === "stop" ? "outline" : "default"}
                className="h-12 min-w-0 flex-1 text-[15px] pressable"
                disabled={agentBusy}
                onClick={() => void runQuickAction(action.id)}
              >
                {actionIcon(action, index)}
                <span className="truncate">{action.label}</span>
              </Button>
            ) : (
              <Button
                key={action.id}
                variant="outline"
                size="icon"
                aria-label={action.label}
                title={action.hint}
                className="size-12 shrink-0 pressable-icon"
                disabled={agentBusy}
                onClick={() => void runQuickAction(action.id)}
              >
                {actionIcon(action, index)}
              </Button>
            ),
          )}
          {moreMenu}
        </div>
      )}
    </div>
  );
}

const TAB_TRIGGER_CLASS =
  "flex-none gap-1.5 px-3 group-data-horizontal/tabs:after:bottom-[-3px] max-md:min-w-11";

/** Count pill in a tab label. */
function TabCount({ children }: { children: number }) {
  return (
    <span className="min-w-5 rounded-full bg-muted px-1.5 py-px text-center font-mono text-[11px] font-medium text-muted-foreground tabular-nums">
      {children}
    </span>
  );
}

/** One label/value row of the card's details grid. */
function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 py-2.5 md:flex-col md:items-start md:justify-start md:gap-0.5 md:py-0">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium tabular-nums md:text-left">{children}</dd>
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-4 p-4">
      <Skeleton className="h-14 w-2/3 self-end" />
      <Skeleton className="h-20 w-5/6" />
    </div>
  );
}

/** The question the agent left for the user, with an inline answer composer. */
function QuestionPanel({
  question,
  onAnswer,
  onDismiss,
}: {
  question: string;
  /** Sends the answer as feedback and resumes the agent; resolves true when it was sent. */
  onAnswer: (body: string) => Promise<boolean>;
  /** Clears the question without answering. */
  onDismiss: () => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    const ok = await onAnswer(text);
    setBusy(false);
    if (ok) setBody("");
  };

  return (
    <section
      aria-label="Agent question"
      className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 md:p-4"
    >
      <div className="flex items-center gap-2">
        <CircleHelp aria-hidden className="size-4 shrink-0 text-amber-700 dark:text-amber-300" />
        <h3 className="flex-1 text-sm font-semibold text-amber-900 dark:text-amber-200">
          The agent has a question
        </h3>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void onDismiss()}
          title="Hide the question without answering"
          className="h-8 px-2 text-xs text-muted-foreground max-md:h-11 max-md:px-3"
        >
          Dismiss
        </Button>
      </div>
      <RichText text={question} className="mt-2 text-sm" />
      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Textarea
          value={body}
          rows={1}
          disabled={busy}
          placeholder="Type your answer…"
          aria-label="Answer"
          className="max-h-40 min-h-11 resize-none bg-background text-base md:text-base"
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <Button
          type="submit"
          disabled={!body.trim() || busy}
          className="h-11 shrink-0 pressable md:h-9"
          title="Send answer; the agent continues (Ctrl/⌘+Enter)"
        >
          <ArrowUp />
          Answer
        </Button>
      </form>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Sent as feedback; the agent continues with it.
      </p>
    </section>
  );
}

function TitleEditor({ task, onSave }: { task: Task; onSave: (title: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(task.title);
  const editingRef = useRef(false);

  useEffect(() => {
    if (!editingRef.current) setDraft(task.title);
  }, [task.title]);

  const commit = async () => {
    editingRef.current = false;
    const value = draft.replace(/\s+/g, " ").trim();
    if (!value) {
      setDraft(task.title);
      return;
    }
    setDraft(value);
    if (value !== task.title && !(await onSave(value))) setDraft(task.title);
  };

  return (
    <Textarea
      rows={1}
      value={draft}
      maxLength={500}
      aria-label={task.pushedAt ? "Card title (pushed to main)" : "Card title"}
      title={task.pushedAt ? `Pushed to main ${new Date(task.pushedAt).toLocaleString()}` : undefined}
      className={cn(
        "max-h-32 min-h-0 resize-none overflow-y-auto border-transparent bg-transparent px-1.5 py-1 text-lg leading-snug font-semibold tracking-tight shadow-none hover:border-input md:text-xl dark:bg-transparent",
        task.pushedAt && "line-through decoration-2",
      )}
      onFocus={() => {
        editingRef.current = true;
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          editingRef.current = false;
          setDraft(task.title);
          const field = event.currentTarget;
          // Blur after the revert has rendered so the blur handler doesn't save the stale draft.
          requestAnimationFrame(() => field.blur());
        }
      }}
    />
  );
}

function DescriptionEditor({
  task,
  onSave,
}: {
  task: Task;
  onSave: (description: string) => Promise<boolean>;
}) {
  // `base` is the server value the draft was started from; remote edits replace a clean draft.
  const [base, setBase] = useState(task.description);
  const [draft, setDraft] = useState(task.description);
  const [saving, setSaving] = useState(false);
  const dirty = draft !== base;
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  // "/" skills and shortcuts, "@" project files, "skill://" skill names, like the new-card composer.
  const slash = useComposerAutocomplete(fieldRef, draft, setDraft, { boardId: task.boardId });
  // The textarea can't open links, so files linked in the saved description get preview chips.
  const linked = useMemo(() => extractAttachments(base), [base]);

  useEffect(() => {
    if (task.description === base) return;
    if (!dirty) setDraft(task.description);
    setBase(task.description);
    // Only react to remote changes of the description; `base`/`dirty` are read, not tracked.
  }, [task.description]);

  const save = async () => {
    setSaving(true);
    const value = draft.trim();
    if (await onSave(value)) {
      setBase(value);
      setDraft(value);
    }
    setSaving(false);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label htmlFor={`description-${task.id}`} className={cn(DETAIL_HEADING_CLASS, "min-h-9")}>
        <AlignLeft aria-hidden />
        Description
      </label>
      {/* `relative` anchors the word ghost on the textarea. */}
      <div className="relative">
        <Textarea
          id={`description-${task.id}`}
          ref={fieldRef}
          value={draft}
          placeholder="Add more detail for the agent: context, acceptance criteria, files to look at…"
          className="max-h-[50dvh] min-h-24 resize-none leading-relaxed"
          aria-autocomplete="list"
          aria-expanded={slash.open}
          data-suggesting={slash.suggesting || undefined}
          onChange={(event) => setDraft(event.target.value)}
          onSelect={slash.onSelect}
          onKeyDown={(event) => {
            if (slash.onKeyDown(event)) return;
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && dirty) {
              event.preventDefault();
              void save();
            } else if (event.key === "Escape" && dirty) {
              event.preventDefault();
              setDraft(base);
            }
          }}
        />
        {slash.ghost}
      </div>
      {slash.suggestion}
      {slash.menu}
      {linked.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Linked files</span>
          {linked.map((file, index) => {
            const KindIcon = KIND_ICON[attachmentKind(file)];
            return (
              <a
                key={file.url}
                href={file.url}
                target="_blank"
                rel="noopener noreferrer"
                title={`Preview ${file.name}`}
                onClick={(event) => {
                  if (!isPlainClick(event)) return;
                  event.preventDefault();
                  openAttachment({ ...file, list: linked, index });
                }}
                className="inline-flex max-w-full items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-xs font-medium pressable hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none max-md:min-h-11 max-md:px-2.5 max-md:text-sm"
              >
                <KindIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">{file.name}</span>
              </a>
            );
          })}
        </div>
      )}
      {dirty && (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" className="h-11 pressable max-md:flex-1 md:h-8" disabled={saving} onClick={() => setDraft(base)}>
            Cancel
          </Button>
          <Button className="h-11 pressable max-md:flex-1 md:h-8" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}

export function DeleteCardDialog({
  title,
  open,
  onOpenChange,
  onConfirm,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this card?</AlertDialogTitle>
          <AlertDialogDescription>
            &ldquo;{title}&rdquo; and its comments and agent logs will be removed. A running agent is
            stopped. Files in the project are not touched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="max-md:h-11">Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="max-md:h-11"
            onClick={() => void onConfirm()}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
