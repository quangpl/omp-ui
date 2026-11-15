import { getRequestToken, verifyToken } from "@/lib/auth";
import type { Repository } from "@/lib/db/types";
import { subscribe } from "@/lib/events";
import { withApi } from "@/lib/server/http";
import type { ServerEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Heartbeat cadence. Sent as a named `ping` event (not an SSE comment) so the browser client can
 * observe liveness: `subscribeEvents` (lib/api-client.ts) reopens the stream after ~2.5 missed
 * pings, which catches half-open connections (sleep, network switch, proxy idle drops).
 * Named events never reach `onmessage`, so consumers that only read data frames ignore it.
 */
const PING_INTERVAL_MS = 20_000;
/** `data:` without a value still dispatches the event (empty data), unlike a bare `event:` line. */
const PING_FRAME = "event: ping\ndata:\n\n";

const g = globalThis as unknown as { __ompUiEventStreams?: Set<() => void> };

/**
 * Close functions of the open streams. On SIGTERM/SIGINT they are all closed, so the server's
 * graceful shutdown (it waits for open responses) does not hang until `omp-ui stop` kills it.
 */
function openStreams(): Set<() => void> {
  if (g.__ompUiEventStreams) return g.__ompUiEventStreams;
  const streams = new Set<() => void>();
  g.__ompUiEventStreams = streams;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      for (const close of streams) close();
      // As in lib/agent/rpc.ts: keep Node's default exit when nobody else handles the signal.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
  return streams;
}

/** Board an event belongs to; null for global events (sent on every stream). */
function eventBoardId(event: ServerEvent): string | null {
  switch (event.type) {
    case "board.updated":
      return event.board.id;
    case "task.updated":
      return event.task.boardId;
    case "scheduler.updated":
      return event.scheduler.boardId;
    case "queue.updated":
    case "cluster.updated":
    case "cluster.notice":
      return null;
    default:
      return event.boardId;
  }
}

/**
 * Visibility filter of one non-admin stream: the event as the user may see it, or null to drop it.
 * Events of boards the user does not own are dropped; `queue.updated` and `cluster.updated` (each
 * node's runningTaskIds) keep only the user's task ids.
 * Ownership comes from the event's own `userId` when it carries the row, else from `repo` (scoped
 * to the user: foreign boards/tasks read as null), cached for the life of the stream.
 */
function visibilityFilter(repo: Repository, userId: string): (event: ServerEvent) => Promise<ServerEvent | null> {
  const boards = new Map<string, boolean>();
  const tasks = new Map<string, boolean>();

  const boardVisible = async (id: string): Promise<boolean> => {
    const cached = boards.get(id);
    if (cached !== undefined) return cached;
    const visible = (await repo.getBoard(id)) !== null;
    boards.set(id, visible);
    return visible;
  };
  const taskVisible = async (id: string): Promise<boolean> => {
    const cached = tasks.get(id);
    if (cached !== undefined) return cached;
    const visible = (await repo.getTask(id)) !== null;
    tasks.set(id, visible);
    return visible;
  };
  /** The ids of `ids` that name the user's own cards. */
  const own = async (ids: string[]) => {
    const visible = await Promise.all(ids.map(taskVisible));
    return ids.filter((_, i) => visible[i]);
  };
  const keepIf = (event: ServerEvent, visible: boolean) => (visible ? event : null);

  return async (event) => {
    switch (event.type) {
      case "board.updated": {
        const visible = event.board.userId === userId;
        const before = boards.get(event.board.id);
        boards.set(event.board.id, visible);
        // The board changed hands: its cards' cached visibility is stale.
        if (before !== undefined && before !== visible) tasks.clear();
        return keepIf(event, visible);
      }
      case "board.deleted": {
        const visible = await boardVisible(event.boardId);
        boards.delete(event.boardId);
        // Its cards are gone too; dropping every entry is simpler than tracking each card's board.
        tasks.clear();
        return keepIf(event, visible);
      }
      case "task.updated": {
        const visible = event.task.userId === userId;
        tasks.set(event.task.id, visible);
        return keepIf(event, visible);
      }
      case "task.deleted": {
        const visible = tasks.get(event.taskId) ?? (await boardVisible(event.boardId));
        tasks.delete(event.taskId);
        return keepIf(event, visible);
      }
      case "scheduler.updated":
        return keepIf(event, event.scheduler.userId === userId);
      case "comment.added":
      case "comment.updated":
        return keepIf(event, event.comment.userId === userId);
      case "run.updated":
        return keepIf(event, event.run.userId === userId);
      case "queue.updated": {
        // Always forwarded (possibly empty) so the client clears entries that left the queue.
        const [running, queued, drafting] = await Promise.all([
          own(event.running),
          own(event.queued),
          own(event.drafting),
        ]);
        return { ...event, running, queued, drafting };
      }
      // The cluster's state concerns every signed-in user (replica banner, node notices); the
      // cards running on each node are narrowed to the user's own.
      case "cluster.updated": {
        const nodes = await Promise.all(
          event.status.nodes.map(async (node) => ({ ...node, runningTaskIds: await own(node.runningTaskIds) })),
        );
        return { ...event, status: { ...event.status, nodes } };
      }
      case "cluster.notice":
        return event;
      default:
        return keepIf(event, await boardVisible(event.boardId));
    }
  };
}

/**
 * Server-Sent Events. `?boardId=` limits the stream to one board; omit it for everything.
 * Admins get every event; other users only those of their own boards (see visibilityFilter).
 */
export const GET = withApi(({ req, repo, user }) => {
  const boardId = new URL(req.url).searchParams.get("boardId") || null;
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const filter = user.role === "admin" ? null : visibilityFilter(repo, user.id);
      /** Serializes the async visibility checks so events reach the client in publish order. */
      let chain = Promise.resolve();
      const unsubscribe = subscribe((event) => {
        if (boardId) {
          const eventBoard = eventBoardId(event);
          if (eventBoard !== null && eventBoard !== boardId) return;
        }
        if (!filter) {
          send(`data: ${JSON.stringify(event)}\n\n`);
          return;
        }
        chain = chain.then(async () => {
          if (closed) return;
          try {
            const visible = await filter(event);
            if (visible) send(`data: ${JSON.stringify(visible)}\n\n`);
          } catch (err) {
            // A skipped event would leave the client stale; closing makes it reconnect and refetch.
            console.error(
              `[events] could not check the visibility of a ${event.type} event; closing the stream:`,
              err,
            );
            cleanup();
          }
        });
      });
      /** Set while a re-verification runs, so a slow check never overlaps the next heartbeat. */
      let verifying = false;
      /**
       * Re-verifies the session each heartbeat: a revoked token, a deactivated/deleted user or a
       * changed role closes the stream (the client reconnects, re-authenticated or rejected), so the
       * visibility filter decided at open never outlives the role it was decided for.
       */
      const reverify = async () => {
        if (verifying || closed) return;
        verifying = true;
        try {
          const current = await verifyToken(getRequestToken(req) ?? "");
          if (!current || current.id !== user.id || current.role !== user.role) cleanup();
        } catch (err) {
          console.error("[events] could not re-verify the stream's session; closing the stream:", err);
          cleanup();
        } finally {
          verifying = false;
        }
      };
      const ping = setInterval(() => {
        send(PING_FRAME);
        void reverify();
      }, PING_INTERVAL_MS);
      const onAbort = () => cleanup();

      cleanup = () => {
        if (closed) return;
        closed = true;
        openStreams().delete(cleanup);
        clearInterval(ping);
        unsubscribe();
        req.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // Already closed or cancelled by the consumer.
        }
      };

      send("retry: 3000\n: connected\n\n");
      openStreams().add(cleanup);
      if (req.signal.aborted) cleanup();
      else req.signal.addEventListener("abort", onAbort);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      // Not reused once the stream ends, so a closed stream never holds the server's shutdown.
      connection: "close",
    },
  });
});
