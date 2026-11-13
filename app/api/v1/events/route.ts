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
      return null;
    default:
      return event.boardId;
  }
}

/** Server-Sent Events. `?boardId=` limits the stream to one board; omit it for everything. */
export const GET = withApi(({ req }) => {
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
      const unsubscribe = subscribe((event) => {
        if (boardId) {
          const eventBoard = eventBoardId(event);
          if (eventBoard !== null && eventBoard !== boardId) return;
        }
        send(`data: ${JSON.stringify(event)}\n\n`);
      });
      const ping = setInterval(() => send(PING_FRAME), PING_INTERVAL_MS);
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
