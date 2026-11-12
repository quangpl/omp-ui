import { subscribe } from "@/lib/events";
import { withApi } from "@/lib/server/http";
import type { ServerEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

const PING_INTERVAL_MS = 20_000;

function eventBoardId(event: ServerEvent): string {
  switch (event.type) {
    case "board.updated":
      return event.board.id;
    case "task.updated":
      return event.task.boardId;
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
        if (boardId && eventBoardId(event) !== boardId) return;
        send(`data: ${JSON.stringify(event)}\n\n`);
      });
      const ping = setInterval(() => send(": ping\n\n"), PING_INTERVAL_MS);
      const onAbort = () => cleanup();

      cleanup = () => {
        if (closed) return;
        closed = true;
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
      connection: "keep-alive",
    },
  });
});
