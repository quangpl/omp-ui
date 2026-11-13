"use client";

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ApiRequestError, api, subscribeEvents } from "@/lib/api-client";
import { SUBAGENT_STATUS_LABELS, parseSubagent } from "@/lib/subagents";
import {
  TASK_STATUSES,
  type Board,
  type GitStatus,
  type QueueSnapshot,
  type ServerEvent,
  type Task,
  type TaskStatus,
} from "@/lib/types";

/** Every server event for this board, plus a synthetic marker after the SSE stream reconnects. */
export type BoardStreamEvent = ServerEvent | { type: "stream.reconnected" };
export type BoardStreamListener = (event: BoardStreamEvent) => void;
export type TasksByStatus = Record<TaskStatus, Task[]>;

/** Running and queued task ids of the global agent queue (queued in start order). */
export interface QueueIds {
  running: string[];
  queued: string[];
  /** Queued cards the card writer is still writing (their run starts after). */
  drafting: string[];
}

// In-tab shared state. A board page opens one SSE connection (`useBoard`); other components
// (files panels, task cards) read these module-level stores instead of opening their own.

function createStore<T>(initial: T) {
  let value = initial;
  const watchers = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (next === value) return;
      value = next;
      for (const watcher of watchers) watcher();
    },
    subscribe(watcher: () => void) {
      watchers.add(watcher);
      return () => {
        watchers.delete(watcher);
      };
    },
  };
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

const EMPTY_QUEUE: QueueIds = { running: [], queued: [], drafting: [] };
const queueStore = createStore<QueueIds>(EMPTY_QUEUE);

/** Publish the latest agent queue (GET /queue or a `queue.updated` event) to every reader in this tab. */
export function publishQueue(queue: QueueIds | QueueSnapshot): void {
  const next: QueueIds =
    "limit" in queue
      ? {
          running: queue.running.map((e) => e.taskId),
          queued: queue.queued.map((e) => e.taskId),
          drafting: queue.queued.filter((e) => e.drafting).map((e) => e.taskId),
        }
      : queue;
  const current = queueStore.get();
  if (
    sameIds(current.running, next.running) &&
    sameIds(current.queued, next.queued) &&
    sameIds(current.drafting, next.drafting)
  ) {
    return;
  }
  queueStore.set(next);
}

/** Live agent queue ids, shared by every component in this tab. */
export function useQueueIds(): QueueIds {
  return useSyncExternalStore(queueStore.subscribe, queueStore.get, () => EMPTY_QUEUE);
}

/** 0-based start order of a queued card; -1 when it isn't waiting in the queue. */
export function useQueuePosition(taskId: string): number {
  return useSyncExternalStore(
    queueStore.subscribe,
    () => queueStore.get().queued.indexOf(taskId),
    () => -1,
  );
}

/** True while the card writer is still writing this queued card. */
export function useQueueDrafting(taskId: string): boolean {
  return useSyncExternalStore(
    queueStore.subscribe,
    () => queueStore.get().drafting.includes(taskId),
    () => false,
  );
}

const EMPTY_TASKS: ReadonlyMap<string, Task> = new Map();
const boardTasksStore = createStore<ReadonlyMap<string, Task>>(EMPTY_TASKS);

/**
 * Cards of the open board by id (empty when no board page is mounted). Pass `enabled: false`
 * to opt out of re-renders (e.g. a card with no dependencies).
 */
export function useBoardTasks(enabled = true): ReadonlyMap<string, Task> {
  return useSyncExternalStore(
    boardTasksStore.subscribe,
    () => (enabled ? boardTasksStore.get() : EMPTY_TASKS),
    () => EMPTY_TASKS,
  );
}

const streamListeners = new Set<BoardStreamListener>();
const NO_STREAMS: readonly string[] = [];
const streamBoardsStore = createStore<readonly string[]>(NO_STREAMS);

/**
 * Listen to every mounted board page's live stream (no extra SSE connection). Only boards in
 * `useBoardStreams()` are covered; components outside a board page need their own subscription.
 */
export function subscribeBoardStreams(listener: BoardStreamListener): () => void {
  streamListeners.add(listener);
  return () => {
    streamListeners.delete(listener);
  };
}

/** Ids of boards whose live stream is open in this tab (see `subscribeBoardStreams`). */
export function useBoardStreams(): readonly string[] {
  return useSyncExternalStore(streamBoardsStore.subscribe, streamBoardsStore.get, () => NO_STREAMS);
}

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
  /**
   * Create in "In progress" and make sure its agent starts. Defaults to the board's `autoRun`:
   * new cards on auto-run boards skip To do and start right away.
   */
  start?: boolean;
  /** Cards this one waits for ("Run after"). */
  blockedBy?: string[];
}

/**
 * Create a card at the end of In progress when it starts (see `NewCardInput.start`), else at the
 * end of To do, then run its agent when the board won't start it on its own. Toasts and resolves
 * `null` when the card couldn't be created.
 */
export async function createCard(
  board: Pick<Board, "id" | "autoRun">,
  input: NewCardInput,
  options: { position?: number; onCreated?: (task: Task) => void } = {},
): Promise<Task | null> {
  const start = input.start ?? board.autoRun;
  let task: Task;
  try {
    task = await api.tasks.create(board.id, {
      title: input.title,
      description: input.description || undefined,
      blockedBy: input.blockedBy?.length ? input.blockedBy : undefined,
      status: start ? "in_progress" : "todo",
      position: options.position,
    });
    options.onCreated?.(task);
  } catch (err) {
    toast.error("Couldn't create card", { description: message(err) });
    return null;
  }
  // Boards without autoRun don't start agents on their own; "start now" means run it.
  if (start && !board.autoRun && task.agentState === "idle") {
    try {
      task = await api.tasks.run(task.id);
      options.onCreated?.(task);
    } catch (err) {
      toast.error("Card created, but the agent didn't start", { description: message(err) });
    }
  }
  return task;
}

/**
 * Create a card from free text: it lands in In progress right away and its agent starts once the
 * card writer has written its title and brief (in the background). Toasts and resolves `null`
 * when the card couldn't be created.
 */
export async function createCardFromText(
  boardId: string,
  text: string,
  options: { position?: number; onCreated?: (task: Task) => void } = {},
): Promise<Task | null> {
  try {
    const task = await api.tasks.createFromText(boardId, { text, position: options.position });
    options.onCreated?.(task);
    return task;
  } catch (err) {
    toast.error("Couldn't create card", { description: message(err) });
    return null;
  }
}

interface PendingMove {
  status: TaskStatus;
  position: number;
}

/** Last live change to a card (see `useBoard`'s `liveChangesRef`). */
interface LiveChange {
  seq: number;
  deleted: boolean;
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
  /** Optimistic reorder within the card's own column; rolls back and toasts on failure. */
  reorderTask: (taskId: string, position: number) => Promise<void>;
  /** Quick action: send a card back to the bottom of To do (the server stops its agent). */
  revertToTodo: (taskId: string) => Promise<void>;
  /** Create a card; toasts and resolves `null` on failure, calls `onCardAdded` on success. */
  createTask: (input: NewCardInput) => Promise<Task | null>;
  /**
   * A card from free text, in In progress with its agent started; the card writer writes its title
   * and brief in the background. Toasts and resolves `null` on failure.
   */
  createFromText: (text: string) => Promise<Task | null>;
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
  /** Live agent queue across all boards (running + queued task ids). */
  queue: QueueIds;
}

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

/** One calm line describing what an agent is doing, from a run event / delta. */
function activityLine(kind: string, text: string): string | null {
  if (kind === "thinking") return "Thinking…";
  if (kind === "text") return "Writing…";
  if (kind === "agent") {
    const agent = parseSubagent(text);
    return agent ? `⇉ ${agent.id}: ${SUBAGENT_STATUS_LABELS[agent.status].toLowerCase()}` : null;
  }
  const firstLine = text.split("\n").find((line) => line.trim())?.trim();
  if (!firstLine) return null;
  if (kind === "tool") return firstLine.startsWith("▸") ? firstLine : `▸ ${firstLine}`;
  return firstLine;
}

export interface UseBoardOptions {
  /** Every card this controller creates (dialog, inline composer, duplicate). */
  onCardAdded?: (task: Task) => void;
}

export function useBoard(boardId: string, options: UseBoardOptions = {}): BoardController {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const onCardAddedRef = useRef(options.onCardAdded);
  onCardAddedRef.current = options.onCardAdded;

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

  /**
   * Live card changes (events, move responses) stamped with a counter. A snapshot request that
   * started before a change can't see it, so `reload` must not undo it: neither drop a card created
   * meanwhile nor bring back a card deleted meanwhile. Pruned as snapshots land.
   */
  const liveChangesRef = useRef({ seq: 0, byId: new Map<string, LiveChange>() });
  /** Snapshot in flight, and the follow-up queued behind it (see `reload`). */
  const syncRef = useRef<{ running: Promise<void> | null; queued: Promise<void> | null }>({
    running: null,
    queued: null,
  });
  /** Board this hook currently shows: a snapshot for a previous board must not land. */
  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;

  const noteLiveChange = useCallback((taskId: string, deleted: boolean) => {
    const live = liveChangesRef.current;
    live.byId.set(taskId, { seq: ++live.seq, deleted });
  }, []);

  const upsertTask = useCallback(
    (incoming: Task) => {
      if (incoming.boardId !== boardId) return;
      noteLiveChange(incoming.id, false);
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
    [boardId, withPending, noteLiveChange],
  );

  const removeTask = useCallback(
    (taskId: string) => {
      pendingMovesRef.current.delete(taskId);
      noteLiveChange(taskId, true);
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
    },
    [noteLiveChange],
  );

  const fetchSnapshot = useCallback(async () => {
    const live = liveChangesRef.current;
    const since = live.seq;
    try {
      const [nextBoard, nextTasks] = await Promise.all([
        api.boards.get(boardId),
        api.boards.tasks(boardId),
      ]);
      if (boardIdRef.current !== boardId) return;
      // Live changes since the request started: the snapshot may predate them. Older entries are
      // no longer needed (any request still to land started later), so drop them.
      const changed = new Map<string, LiveChange>();
      for (const [id, change] of live.byId) {
        if (change.seq > since) changed.set(id, change);
        else live.byId.delete(id);
      }
      setBoard(nextBoard);
      setTasks((prev) => {
        const held = new Map(prev.map((task) => [task.id, task]));
        const merged: Task[] = [];
        for (const task of nextTasks) {
          if (changed.get(task.id)?.deleted) continue;
          // A live update may have landed while this request was in flight: keep the newer copy.
          const current = held.get(task.id);
          merged.push(current && current.updatedAt > task.updatedAt ? current : withPending(task));
        }
        // Cards created live while the request was in flight aren't in the snapshot yet. Any
        // other card missing from it was deleted on the server (its event was missed).
        const inSnapshot = new Set(nextTasks.map((task) => task.id));
        for (const [id, change] of changed) {
          const current = held.get(id);
          if (!change.deleted && current && !inSnapshot.has(id)) merged.push(current);
        }
        return merged;
      });
      setError(null);
    } catch (err) {
      if (boardIdRef.current !== boardId) return;
      setError(
        err instanceof ApiRequestError && err.status === 404 ? "This project doesn't exist." : message(err),
      );
    } finally {
      if (boardIdRef.current === boardId) setLoading(false);
    }
  }, [boardId, withPending]);

  /**
   * Refetch the board and its cards. Calls while a snapshot is in flight queue exactly one
   * follow-up: the in-flight request may predate whatever prompted the call (a reconnect, the
   * stream's first open), and overlapping requests could land out of order.
   */
  const reload = useCallback((): Promise<void> => {
    const sync = syncRef.current;
    const start = (): Promise<void> => {
      if (boardIdRef.current !== boardId) return Promise.resolve();
      const running = fetchSnapshot().finally(() => {
        if (sync.running === running) sync.running = null;
      });
      sync.running = running;
      return running;
    };
    if (sync.queued) return sync.queued;
    if (!sync.running) return start();
    sync.queued = sync.running.then(() => {
      sync.queued = null;
      return start();
    });
    return sync.queued;
  }, [boardId, fetchSnapshot]);

  useEffect(() => {
    setLoading(true);
    setBoard(null);
    setTasks([]);
    setError(null);
    setActivity({});
    setConnection("connecting");
    pendingMovesRef.current.clear();
    liveChangesRef.current.byId.clear();
    // A snapshot still in flight for the previous board must not delay or absorb this one.
    syncRef.current = { running: null, queued: null };
    void reload();
    const loadQueue = () => {
      api.queue
        .get()
        .then(publishQueue)
        .catch(() => {
          // Queue badges are decorative; the next `queue.updated` event fills them in.
        });
    };
    loadQueue();
    streamBoardsStore.set([...streamBoardsStore.get(), boardId]);

    const noteActivity = (taskId: string, line: string | null) => {
      if (!line) return;
      // Same line → same state object → no re-render (deltas arrive many times per second).
      setActivity((prev) => (prev[taskId] === line ? prev : { ...prev, [taskId]: line }));
    };

    // Board listeners first, then the tab-wide fan-out (files panels…).
    const emit = (event: BoardStreamEvent) => {
      for (const listeners of [listenersRef.current, streamListeners]) {
        for (const listener of listeners) {
          try {
            listener(event);
          } catch (err) {
            console.error(err);
          }
        }
      }
    };

    const unsubscribe = subscribeEvents(
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
          case "task.activity":
            noteActivity(event.taskId, event.text);
            break;
          case "queue.updated":
            publishQueue({ running: event.running, queued: event.queued, drafting: event.drafting });
            break;
        }
        emit(event);
      },
      {
        boardId,
        // The snapshot above may predate the server-side subscription: resync once it is live.
        onFirstOpen: () => {
          void reload();
          loadQueue();
        },
        onReconnect: () => {
          void reload();
          loadQueue();
          emit({ type: "stream.reconnected" });
        },
        onStatus: setConnection,
      },
    );
    return () => {
      unsubscribe();
      const open = streamBoardsStore.get();
      const index = open.indexOf(boardId);
      if (index !== -1) streamBoardsStore.set(open.filter((_, i) => i !== index));
    };
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
  const queue = useQueueIds();

  // Share this board's cards with task cards (dependency badges) without prop drilling.
  useEffect(() => {
    const index = new Map(rawTasks.map((task) => [task.id, task]));
    boardTasksStore.set(index);
    return () => {
      if (boardTasksStore.get() === index) boardTasksStore.set(EMPTY_TASKS);
    };
  }, [rawTasks]);

  /** Position after the last card of a column (optionally ignoring one card). */
  const endPosition = useCallback((status: TaskStatus, excludeId?: string) => {
    let max: number | null = null;
    for (const task of tasksRef.current) {
      if (task.status !== status || task.id === excludeId) continue;
      if (max === null || task.position > max) max = task.position;
    }
    return max === null ? POSITION_GAP : max + POSITION_GAP;
  }, []);

  /** Optimistic status/position change; rolls back and toasts on failure. */
  const moveTask = useCallback(
    async (taskId: string, status: TaskStatus, position: number) => {
      const before = tasksRef.current.find((t) => t.id === taskId);
      if (!before) return;
      if (before.status === status && before.position === position) return;

      pendingMovesRef.current.set(taskId, { status, position });
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status, position } : t)));
      try {
        const patch = status === before.status ? { position } : { status, position };
        const updated = await api.tasks.update(taskId, patch);
        pendingMovesRef.current.delete(taskId);
        upsertTask(updated);
      } catch (err) {
        pendingMovesRef.current.delete(taskId);
        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId ? { ...t, status: before.status, position: before.position } : t,
          ),
        );
        toast.error(status === before.status ? "Couldn't reorder card" : "Couldn't revert card", {
          description: message(err),
        });
      }
    },
    [upsertTask],
  );

  const reorderTask = useCallback(
    (taskId: string, position: number) => {
      const task = tasksRef.current.find((t) => t.id === taskId);
      if (!task) return Promise.resolve();
      return moveTask(taskId, task.status, position);
    },
    [moveTask],
  );

  const revertToTodo = useCallback(
    (taskId: string) => {
      const task = tasksRef.current.find((t) => t.id === taskId);
      if (!task || task.status === "todo") return Promise.resolve();
      return moveTask(taskId, "todo", endPosition("todo", taskId));
    },
    [moveTask, endPosition],
  );

  /** Create a card at the bottom of In progress (agent starts) or To do; see `NewCardInput.start`. */
  const createTask = useCallback(
    async (input: NewCardInput): Promise<Task | null> => {
      const autoRun = boardRef.current?.autoRun ?? false;
      const start = input.start ?? autoRun;
      const task = await createCard(
        { id: boardId, autoRun },
        { ...input, start },
        { position: endPosition(start ? "in_progress" : "todo"), onCreated: upsertTask },
      );
      if (task) onCardAddedRef.current?.(task);
      return task;
    },
    [boardId, endPosition, upsertTask],
  );

  const createFromText = useCallback(
    async (text: string): Promise<Task | null> => {
      const task = await createCardFromText(boardId, text, {
        position: endPosition("in_progress"),
        onCreated: upsertTask,
      });
      if (task) onCardAddedRef.current?.(task);
      return task;
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
    reorderTask,
    revertToTodo,
    createTask,
    createFromText,
    runAgent,
    stopAgent,
    deleteTask,
    subscribe,
    activity,
    connection,
    queue,
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
