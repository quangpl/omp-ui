"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Ellipsis,
  MessageSquare,
  Play,
  Rocket,
  RotateCcw,
  Square,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ApiRequestError, api } from "@/lib/api-client";
import {
  STATUS_LABELS,
  TASK_STATUSES,
  type Comment,
  type GitStatus,
  type Run,
  type Task,
  type TaskStatus,
} from "@/lib/types";
import type { BoardStreamListener } from "@/hooks/use-board";
import { AgentLog } from "@/components/board/agent-log";
import { StatusDot } from "@/components/board/board-column";
import { CommentThread } from "@/components/board/comment-thread";
import { errorMessage, formatDateTime, formatRelative } from "@/components/board/format";
import { ShipActions } from "@/components/board/ship-actions";
import { AgentStateBadge } from "@/components/board/task-card";

export interface TaskDetailProps {
  /** Selected card, or null when the panel is closed. */
  taskId: string | null;
  /** Live copy of the card from the board state (preferred over the fetched one). */
  boardTask: Task | undefined;
  isMobile: boolean;
  onClose: () => void;
  subscribe: (listener: BoardStreamListener) => () => void;
  upsertTask: (task: Task) => void;
  removeTask: (taskId: string) => void;
  moveToStatus: (taskId: string, status: TaskStatus) => Promise<void>;
  /** Git status of the board's folders (null while loading), for the Ship panel. */
  gitStatuses: GitStatus[] | null;
  /** Called after a push/PR so the board can re-read git status. */
  onGitChanged: () => void;
}

/** Card details: a right-hand sheet on desktop, a near full-height drawer on phones. */
export function TaskDetail(props: TaskDetailProps) {
  const { taskId, isMobile, onClose } = props;
  // Keep rendering the last card while the panel animates closed.
  const [shownId, setShownId] = useState(taskId);
  useEffect(() => {
    if (taskId) setShownId(taskId);
  }, [taskId]);

  const open = taskId !== null;
  const onOpenChange = (next: boolean) => {
    if (!next) onClose();
  };
  const visibleId = taskId ?? shownId;
  const content = visibleId ? (
    <TaskDetailBody key={visibleId} {...props} taskId={visibleId} />
  ) : null;
  const title = props.boardTask?.title ?? "Card";

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent
          className="h-[95dvh] outline-none data-[vaul-drawer-direction=bottom]:max-h-[95dvh]"
          onOpenAutoFocus={focusPanel}
          onEscapeKeyDown={keepOpenWhileEditing}
        >
          <DrawerTitle className="sr-only">{title}</DrawerTitle>
          <DrawerDescription className="sr-only">Card details, feedback and agent log</DrawerDescription>
          <DrawerClose asChild>
            <Button variant="ghost" size="icon" className="absolute top-2 right-2 z-20 size-11">
              <X />
              <span className="sr-only">Close</span>
            </Button>
          </DrawerClose>
          {content}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full gap-0 p-0 outline-none data-[side=right]:sm:max-w-xl"
        onOpenAutoFocus={focusPanel}
        onEscapeKeyDown={keepOpenWhileEditing}
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        <SheetDescription className="sr-only">Card details, feedback and agent log</SheetDescription>
        {content}
      </SheetContent>
    </Sheet>
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

/** Esc inside a text field leaves the field (fields revert their own edits) instead of closing the panel. */
function keepOpenWhileEditing(event: KeyboardEvent) {
  const target = event.target;
  if (target instanceof HTMLElement && target.matches("textarea, input")) {
    event.preventDefault();
    requestAnimationFrame(() => target.blur());
  }
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

function TaskDetailBody({
  taskId,
  boardTask,
  onClose,
  subscribe,
  upsertTask,
  removeTask,
  moveToStatus,
  gitStatuses,
  onGitChanged,
}: TaskDetailProps & { taskId: string }) {
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [tab, setTab] = useState<"activity" | "log">("activity");
  const [agentBusy, setAgentBusy] = useState(false);
  const [shipRequested, setShipRequested] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const deletingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const load = useCallback(async () => {
    try {
      const data = await api.tasks.get(taskId);
      setDetail(data);
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
              setDetail((prev) => (prev ? { ...prev, task: event.task } : prev));
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
              setDetail((prev) =>
                prev ? { ...prev, comments: upsertById(prev.comments, event.comment) } : prev,
              );
            }
            break;
          case "comment.deleted":
            if (event.taskId === taskId) {
              setDetail((prev) =>
                prev
                  ? { ...prev, comments: prev.comments.filter((c) => c.id !== event.commentId) }
                  : prev,
              );
            }
            break;
          case "run.updated":
            if (event.run.taskId === taskId) {
              setDetail((prev) => (prev ? { ...prev, runs: upsertById(prev.runs, event.run) } : prev));
            }
            break;
        }
      }),
    [subscribe, taskId, load],
  );

  const task = boardTask ?? detail?.task;

  if (!task) {
    return (
      <div className="flex flex-col gap-4 p-4 pr-14">
        <Skeleton className="h-7 w-3/4" />
        <div className="flex gap-2">
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-9 w-28" />
        </div>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-16 w-2/3 self-end" />
        <Skeleton className="h-20 w-5/6" />
      </div>
    );
  }

  const active = task.agentState === "running" || task.agentState === "queued";
  const shipVisible = task.status === "done" || shipRequested;
  const comments = detail
    ? detail.comments.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : [];
  const runs = detail?.runs ?? [];

  const save = async (patch: { title?: string; description?: string }) => {
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

  const send = async (body: string) => {
    try {
      const comment = await api.tasks.comment(task.id, body);
      setDetail((prev) => (prev ? { ...prev, comments: upsertById(prev.comments, comment) } : prev));
      return true;
    } catch (err) {
      toast.error("Couldn't send feedback", { description: errorMessage(err) });
      return false;
    }
  };

  const setResolved = async (comment: Comment, resolved: boolean) => {
    try {
      const updated = await api.comments.setResolved(comment.id, resolved);
      setDetail((prev) => (prev ? { ...prev, comments: upsertById(prev.comments, updated) } : prev));
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

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="flex flex-col gap-3 px-4 pt-3 pb-4 md:pt-4">
        <div className="pr-12">
          <TitleEditor task={task} onSave={(title) => save({ title })} />
          <p className="mt-0.5 px-1.5 text-xs text-muted-foreground">
            Created <span title={formatDateTime(task.createdAt)}>{formatRelative(task.createdAt)}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={task.status}
            onValueChange={(value) => void moveToStatus(task.id, value as TaskStatus)}
          >
            <SelectTrigger
              aria-label="Status"
              className="min-w-36 data-[size=default]:h-11 md:data-[size=default]:h-9"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TASK_STATUSES.map((status) => (
                <SelectItem key={status} value={status} className="max-md:min-h-11">
                  <StatusDot status={status} />
                  {STATUS_LABELS[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <AgentStateBadge state={task.agentState} />
          <div className="ml-auto flex items-center gap-1">
            {active ? (
              <Button
                variant="outline"
                className="h-11 px-4 md:h-9"
                disabled={agentBusy}
                onClick={() => void toggleAgent(false)}
              >
                <Square className="fill-current" />
                Stop
              </Button>
            ) : (
              <Button
                className="h-11 px-4 md:h-9"
                disabled={agentBusy}
                onClick={() => void toggleAgent(true)}
              >
                <Play className="fill-current" />
                Run agent
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-11 md:size-9" aria-label="More card actions">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  className="max-md:min-h-11"
                  disabled={shipVisible}
                  onSelect={() => setShipRequested(true)}
                >
                  <Rocket />
                  Ship changes…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  className="max-md:min-h-11"
                  onSelect={() => setDeleteOpen(true)}
                >
                  <Trash2 />
                  Delete card
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {task.agentState === "error" && (
          <Alert variant="destructive" className="has-data-[slot=alert-action]:pr-24">
            <TriangleAlert />
            <AlertTitle>Agent failed</AlertTitle>
            <AlertDescription className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
              {task.agentError || "The last run ended with an error."}
            </AlertDescription>
            <AlertAction>
              <Button
                size="sm"
                variant="outline"
                className="max-md:h-11"
                disabled={agentBusy}
                onClick={() => void toggleAgent(true)}
              >
                <RotateCcw />
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )}

        {shipVisible && (
          <ShipActions
            task={task}
            statuses={gitStatuses}
            onShipped={(comment) => {
              setDetail((prev) =>
                prev ? { ...prev, comments: upsertById(prev.comments, comment) } : prev,
              );
              onGitChanged();
            }}
          />
        )}

        <DescriptionEditor task={task} onSave={(description) => save({ description })} />
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as "activity" | "log")} className="gap-0">
        <div className="sticky top-0 z-10 border-b bg-popover px-4 pb-2">
          <TabsList className="w-full group-data-horizontal/tabs:h-11 md:group-data-horizontal/tabs:h-9">
            <TabsTrigger value="activity">
              <MessageSquare />
              Activity
              {comments.length > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">{comments.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="log">
              <Terminal />
              Agent log
              {active && (
                <span aria-label="Agent active" className="size-1.5 animate-pulse rounded-full bg-sky-500" />
              )}
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="activity">
          {detail ? (
            <CommentThread
              task={task}
              comments={comments}
              onSend={send}
              onSetResolved={setResolved}
            />
          ) : (
            <ThreadSkeleton />
          )}
        </TabsContent>
        <TabsContent value="log" forceMount className="data-[state=inactive]:hidden">
          {detail ? (
            <AgentLog runs={runs} subscribe={subscribe} scrollRef={scrollRef} visible={tab === "log"} />
          ) : (
            <ThreadSkeleton />
          )}
        </TabsContent>
      </Tabs>

      <footer className="flex items-center justify-between gap-3 border-t px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <span className="text-xs text-muted-foreground">
          Updated {formatRelative(task.updatedAt)}
        </span>
        <Button variant="destructive" className="h-11 md:h-8" onClick={() => setDeleteOpen(true)}>
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
  );
}

function ThreadSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <Skeleton className="h-14 w-2/3 self-end" />
      <Skeleton className="h-20 w-5/6" />
    </div>
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
      aria-label="Card title"
      className="min-h-0 resize-none border-transparent bg-transparent px-1.5 py-1 text-lg leading-snug font-semibold shadow-none hover:border-input md:text-lg dark:bg-transparent"
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
    <div className="flex flex-col gap-2">
      <label htmlFor={`description-${task.id}`} className="px-0.5 text-xs font-medium text-muted-foreground">
        Description
      </label>
      <Textarea
        id={`description-${task.id}`}
        value={draft}
        placeholder="Add more detail for the agent: context, acceptance criteria, files to look at…"
        className="max-h-[50dvh] min-h-20 resize-none"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && dirty) {
            event.preventDefault();
            void save();
          } else if (event.key === "Escape" && dirty) {
            event.preventDefault();
            setDraft(base);
          }
        }}
      />
      {dirty && (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" className="h-11 md:h-8" disabled={saving} onClick={() => setDraft(base)}>
            Cancel
          </Button>
          <Button className="h-11 md:h-8" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}

function DeleteCardDialog({
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
