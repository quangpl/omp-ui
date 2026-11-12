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
  createTask: (input: { title: string; description?: string; start?: boolean }) => Promise<Task | null>;
  /** Listen to the board's live event stream (shared SSE connection). Returns an unsubscribe fn. */
  subscribe: (listener: BoardStreamListener) => () => void;
}

export function useBoard(boardId: string): BoardController {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  const [board, setBoard] = useState<Board | null>(null);
  const [rawTasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      setTasks(nextTasks.map(withPending));
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
    pendingMovesRef.current.clear();
    void reload();

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
        }
        emit(event);
      },
      {
        boardId,
        onReconnect: () => {
          void reload();
          emit({ type: "stream.reconnected" });
        },
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
    async (input: { title: string; description?: string; start?: boolean }): Promise<Task | null> => {
      const status: TaskStatus = input.start ? "in_progress" : "todo";
      let task: Task;
      try {
        task = await api.tasks.create(boardId, {
          title: input.title,
          description: input.description || undefined,
          status,
          position: endPosition(status),
        });
        upsertTask(task);
      } catch (err) {
        toast.error("Couldn't create card", { description: message(err) });
        return null;
      }
      // Boards without autoRun don't start agents on their own; "start now" means run it.
      if (input.start && !boardRef.current?.autoRun && task.agentState === "idle") {
        try {
          task = await api.tasks.run(task.id);
          upsertTask(task);
        } catch (err) {
          toast.error("Card created, but the agent didn't start", { description: message(err) });
        }
      }
      return task;
    },
    [boardId, endPosition, upsertTask],
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
    subscribe,
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
