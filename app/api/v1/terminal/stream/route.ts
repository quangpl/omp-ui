import { withApi } from "@/lib/server/http";
import { getTerminalSession } from "@/lib/server/terminal";
import { TERMINAL_PING_INTERVAL_MS, type TerminalStreamEvent } from "@/lib/terminal-types";

export const dynamic = "force-dynamic";

/** `data:` without a value still dispatches the event (empty data), unlike a bare `event:` line. */
const PING_FRAME = "event: ping\ndata:\n\n";

const g = globalThis as unknown as { __ompUiTerminalStreams?: Set<() => void> };

/**
 * Close functions of the open streams. On SIGTERM/SIGINT they are all closed, so the server's
 * graceful shutdown (it waits for open responses) does not hang. The commands themselves keep running.
 */
function openStreams(): Set<() => void> {
  if (g.__ompUiTerminalStreams) return g.__ompUiTerminalStreams;
  const streams = new Set<() => void>();
  g.__ompUiTerminalStreams = streams;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      for (const close of streams) close();
      // As in lib/agent/rpc.ts: keep Node's default exit when nobody else handles the signal.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
  return streams;
}

/**
 * Attach to the terminal session (SSE): a `snapshot` first, then live `block`/`output` events.
 * Every (re)connect starts with a fresh snapshot, so a client never needs to refetch.
 */
export const GET = withApi(({ req }) => {
  const session = getTerminalSession();
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
      const sendEvent = (event: TerminalStreamEvent) => send(`data: ${JSON.stringify(event)}\n\n`);

      send("retry: 3000\n\n");
      // Same tick: the snapshot covers exactly the output sent before, live events everything after.
      sendEvent({ type: "snapshot", snapshot: session.snapshot() });
      const unsubscribe = session.subscribe(sendEvent);
      const ping = setInterval(() => send(PING_FRAME), TERMINAL_PING_INTERVAL_MS);
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
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      // Not reused once the stream ends, so a closed stream never holds the server's shutdown.
      connection: "close",
    },
  });
});
