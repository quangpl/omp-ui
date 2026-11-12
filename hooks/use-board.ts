"use client";

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ApiRequestError, api, subscribeEvents } from "@/lib/api-client";
import {
  TASK_STATUSES,
  type Board,
  type GitStatus,
  type ServerEvent,
  type Task,
  type TaskStatus,
} from "@/lib/types";

/** Every server event for this board, plus a synthetic marker after the SSE stream reconnects. */
export type BoardStreamEvent = ServerEvent | { type: "stream.reconnected" };
export type BoardStreamListener = (event: BoardStreamEvent) => void;
export type TasksByStatus = Record<TaskStatus, Task[]>;

/** Spacing between neighbouring positions when appending to a column. */
export const POSITION_GAP = 1024;

export function compareTasks(a: Task, b: Task): number {
  return a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export function groupTasks(tasks: Task[]): TasksByStatus {
  const groups: TasksByStatus = { todo: [], in_progress: [], done: [] };
  for (const task of tasks) groups[task.status]?.push(task);
  for (const status of TASK_STATUSES) groups[status].sort(compareTasks);
  return groups;
}

/** Position for a card dropped between `prev` and `next` (either may be missing). */
export function positionBetween(prev: Task | undefined, next: Task | undefined): number {
  if (prev && next) return (prev.position + next.position) / 2;
  if (prev) return prev.position + POSITION_GAP;
  if (next) return next.position - POSITION_GAP;
  return POSITION_GAP;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

export interface NewCardInput {
  title: string;
  description?: string;
  /** Create in "In progress" and make sure its agent starts. */
  start?: boolean;
}

/**
 * Create a card at the end of To do (In progress when `start`), then run its agent when the
 * board won't start it on its own. Toasts and resolves `null` when the card couldn't be created.
 */
export async function createCard(
  board: Pick<Board, "id" | "autoRun">,
  input: NewCardInput,
  options: { position?: number; onCreated?: (task: Task) => void } = {},
): Promise<Task | null> {
  let task: Task;
  try {
    task = await api.tasks.create(board.id, {
      title: input.title,
      description: input.description || undefined,
      status: input.start ? "in_progress" : "todo",
      position: options.position,
    });
    options.onCreated?.(task);
  } catch (err) {
    toast.error("Couldn't create card", { description: message(err) });
    return null;
  }
  // Boards without autoRun don't start agents on their own; "start now" means run it.
  if (input.start && !board.autoRun && task.agentState === "idle") {
    try {
      task = await api.tasks.run(task.id);
      options.onCreated?.(task);
    } catch (err) {
      toast.error("Card created, but the agent didn't start", { description: message(err) });
    }
  }
  return task;
}

interface PendingMove {
  status: TaskStatus;
  position: number;
}

export interface BoardController {
  board: Board | null;
  setBoard: Dispatch<SetStateAction<Board | null>>;
  /** All cards, sorted by position (ties broken by creation time). */
  tasks: Task[];
  /** Cards per column, each sorted by position. */
  columns: TasksByStatus;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  setTasks: Dispatch<SetStateAction<Task[]>>;
  /** Insert or replace a card from an API response / event (stale snapshots are ignored). */
  upsertTask: (task: Task) => void;
  removeTask: (taskId: string) => void;
  /** Optimistic move; rolls back and toasts on failure. */
  moveTask: (taskId: string, status: TaskStatus, position: number) => Promise<void>;
  /** Move a card to the bottom of another column. */
  moveToStatus: (taskId: string, status: TaskStatus) => Promise<void>;
  /** Create a card; toasts and resolves `null` on failure. */
  createTask: (input: NewCardInput) => Promise<Task | null>;
  /** Start / stop a card's agent; toasts on failure. */
  runAgent: (taskId: string) => Promise<void>;
  stopAgent: (taskId: string) => Promise<void>;
  /** Delete a card; toasts on success and failure. */
  deleteTask: (taskId: string) => Promise<void>;
  /** Listen to the board's live event stream (shared SSE connection). Returns an unsubscribe fn. */
  subscribe: (listener: BoardStreamListener) => () => void;
  /** Latest one-line agent activity per task id ("▸ bash: npm test", "Writing…"); show while running. */
  activity: Record<string, string>;
  /** State of the live event stream. */
  connection: ConnectionStatus;
}

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

/** One calm line describing what an agent is doing, from a run event / delta. */
function activityLine(kind: string, text: string): string | null {
  if (kind === "thinking") return "Thinking…";
  if (kind === "text") return "Writing…";
  const firstLine = text.split("\n").find((line) => line.trim())?.trim();
  if (!firstLine) return null;
  if (kind === "tool") return firstLine.startsWith("▸") ? firstLine : `▸ ${firstLine}`;
  return firstLine;
}

export function useBoard(boardId: string): BoardController {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  const [board, setBoard] = useState<Board | null>(null);
  const [rawTasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<Record<string, string>>({});
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");

  const listenersRef = useRef(new Set<BoardStreamListener>());
  const pendingMovesRef = useRef(new Map<string, PendingMove>());
  const tasksRef = useRef(rawTasks);
  tasksRef.current = rawTasks;
  const boardRef = useRef(board);
  boardRef.current = board;

  /** Keep optimistic status/position while a move request is in flight. */
  const withPending = useCallback((task: Task): Task => {
    const pending = pendingMovesRef.current.get(task.id);
    return pending ? { ...task, ...pending } : task;
  }, []);

  const upsertTask = useCallback(
    (incoming: Task) => {
      if (incoming.boardId !== boardId) return;
      setTasks((prev) => {
        const index = prev.findIndex((t) => t.id === incoming.id);
        if (index === -1) return [...prev, withPending(incoming)];
        // Ignore out-of-order snapshots older than what we already have.
        if (incoming.updatedAt < prev[index].updatedAt) return prev;
        const next = prev.slice();
        next[index] = withPending(incoming);
        return next;
      });
    },
    [boardId, withPending],
  );

  const removeTask = useCallback((taskId: string) => {
    pendingMovesRef.current.delete(taskId);
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
  }, []);

  const reload = useCallback(async () => {
    try {
      const [nextBoard, nextTasks] = await Promise.all([
        api.boards.get(boardId),
        api.boards.tasks(boardId),
      ]);
      setBoard(nextBoard);
      // A live update may have landed while this request was in flight: keep the newer copy.
      setTasks((prev) => {
        const held = new Map(prev.map((task) => [task.id, task]));
        return nextTasks.map((task) => {
          const current = held.get(task.id);
          return current && current.updatedAt > task.updatedAt ? current : withPending(task);
        });
      });
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.status === 404 ? "This project doesn't exist." : message(err),
      );
    } finally {
      setLoading(false);
    }
  }, [boardId, withPending]);

  useEffect(() => {
    setLoading(true);
    setBoard(null);
    setTasks([]);
    setError(null);
    setActivity({});
    setConnection("connecting");
    pendingMovesRef.current.clear();
    void reload();

    const noteActivity = (taskId: string, line: string | null) => {
      if (!line) return;
      // Same line → same state object → no re-render (deltas arrive many times per second).
      setActivity((prev) => (prev[taskId] === line ? prev : { ...prev, [taskId]: line }));
    };

    const emit = (event: BoardStreamEvent) => {
      for (const listener of listenersRef.current) {
        try {
          listener(event);
        } catch (err) {
          console.error(err);
        }
      }
    };

    return subscribeEvents(
      (event) => {
        switch (event.type) {
          case "task.updated":
            upsertTask(event.task);
            break;
          case "task.deleted":
            if (event.boardId === boardId) removeTask(event.taskId);
            break;
          case "board.updated":
            if (event.board.id === boardId) setBoard(event.board);
            break;
          case "board.deleted":
            if (event.boardId === boardId) {
              toast("This project was deleted", { id: `board-deleted-${boardId}` });
              routerRef.current.replace("/");
            }
            break;
          case "run.event":
            noteActivity(event.event.taskId, activityLine(event.event.kind, event.event.text));
            break;
          case "run.delta":
            noteActivity(event.taskId, activityLine(event.kind, event.text));
            break;
        }
        emit(event);
      },
      {
        boardId,
        onReconnect: () => {
          void reload();
          emit({ type: "stream.reconnected" });
        },
        onStatus: setConnection,
      },
    );
  }, [boardId, reload, upsertTask, removeTask]);

  /** Listen to the board's live event stream (shared SSE connection). Returns an unsubscribe fn. */
  const subscribe = useCallback((listener: BoardStreamListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const tasks = useMemo(() => rawTasks.slice().sort(compareTasks), [rawTasks]);
  const columns = useMemo(() => groupTasks(rawTasks), [rawTasks]);

  /** Position after the last card of a column (optionally ignoring one card). */
  const endPosition = useCallback((status: TaskStatus, excludeId?: string) => {
    let max: number | null = null;
    for (const task of tasksRef.current) {
      if (task.status !== status || task.id === excludeId) continue;
      if (max === null || task.position > max) max = task.position;
    }
    return max === null ? POSITION_GAP : max + POSITION_GAP;
  }, []);

  const moveTask = useCallback(
    async (taskId: string, status: TaskStatus, position: number) => {
      const before = tasksRef.current.find((t) => t.id === taskId);
      if (!before) return;
      if (before.status === status && before.position === position) return;

      pendingMovesRef.current.set(taskId, { status, position });
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status, position } : t)));
      try {
        const updated = await api.tasks.update(taskId, { status, position });
        pendingMovesRef.current.delete(taskId);
        upsertTask(updated);
      } catch (err) {
        pendingMovesRef.current.delete(taskId);
        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId ? { ...t, status: before.status, position: before.position } : t,
          ),
        );
        toast.error("Couldn't move card", { description: message(err) });
      }
    },
    [upsertTask],
  );

  /** Move a card to the bottom of another column. */
  const moveToStatus = useCallback(
    (taskId: string, status: TaskStatus) => {
      const task = tasksRef.current.find((t) => t.id === taskId);
      if (!task || task.status === status) return Promise.resolve();
      return moveTask(taskId, status, endPosition(status, taskId));
    },
    [moveTask, endPosition],
  );

  /** Create a card at the bottom of To do, or In progress when `start` is set (and start its agent). */
  const createTask = useCallback(
    (input: NewCardInput): Promise<Task | null> => {
      const status: TaskStatus = input.start ? "in_progress" : "todo";
      return createCard(
        { id: boardId, autoRun: boardRef.current?.autoRun ?? false },
        input,
        { position: endPosition(status), onCreated: upsertTask },
      );
    },
    [boardId, endPosition, upsertTask],
  );

  const runAgent = useCallback(
    async (taskId: string) => {
      try {
        upsertTask(await api.tasks.run(taskId));
      } catch (err) {
        toast.error("Couldn't start the agent", { description: message(err) });
      }
    },
    [upsertTask],
  );

  const stopAgent = useCallback(
    async (taskId: string) => {
      try {
        upsertTask(await api.tasks.stop(taskId));
      } catch (err) {
        toast.error("Couldn't stop the agent", { description: message(err) });
      }
    },
    [upsertTask],
  );

  const deleteTask = useCallback(
    async (taskId: string) => {
      try {
        await api.tasks.remove(taskId);
        removeTask(taskId);
        toast.success("Card deleted");
      } catch (err) {
        toast.error("Couldn't delete card", { description: message(err) });
      }
    },
    [removeTask],
  );

  return {
    board,
    setBoard,
    tasks,
    columns,
    loading,
    error,
    reload,
    setTasks,
    upsertTask,
    removeTask,
    moveTask,
    moveToStatus,
    createTask,
    runAgent,
    stopAgent,
    deleteTask,
    subscribe,
    activity,
    connection,
  };
}

/** Wait after the last card change before re-reading git status (agents touch many files). */
const GIT_REFRESH_DELAY_MS = 1500;

export interface GitStatusState {
  /** One entry per project folder (workdir first); null until first load. Empty on error. */
  statuses: GitStatus[] | null;
  refresh: () => Promise<void>;
}

/**
 * Git status of a board's folders. Re-fetched (debounced) whenever a card changes, when the
 * board's folders change, and after the event stream reconnects.
 */
export function useGitStatus(
  boardId: string,
  subscribe: (listener: BoardStreamListener) => () => void,
): GitStatusState {
  const [statuses, setStatuses] = useState<GitStatus[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatuses(await api.git.status(boardId));
    } catch {
      // Git info is decorative here; the indicator simply hides when it can't be read.
      setStatuses([]);
    }
  }, [boardId]);

  useEffect(() => {
    setStatuses(null);
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe((event) => {
      if (
        event.type === "task.updated" ||
        event.type === "board.updated" ||
        event.type === "stream.reconnected"
      ) {
        clearTimeout(timer);
        timer = setTimeout(() => void refresh(), GIT_REFRESH_DELAY_MS);
      }
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh, subscribe]);

  return { statuses, refresh };
}
