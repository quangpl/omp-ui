import { acquireDraftSlot, draftCard } from "@/lib/agent/draft";
import { HttpError, readJson, withApi } from "@/lib/server/http";
import { parseBrief, requireBoard } from "@/lib/server/validate";
import { getAppSettings } from "@/lib/settings";
import type { DraftStreamEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

type Params = { id: string };

/**
 * Write a card from free text `{ text }` with the card-writer agent. Streams NDJSON
 * `DraftStreamEvent`s: `activity` lines while it works, then one `draft` or `error`.
 * Closing the request stops the agent.
 */
export const POST = withApi<Params>(async ({ req, repo, params }) => {
  const board = await requireBoard(repo, params.id);
  const text = parseBrief((await readJson(req)).text);
  const [settings, tasks] = await Promise.all([getAppSettings(repo), repo.listTasks(board.id)]);
  const release = acquireDraftSlot();
  if (!release) throw new HttpError(429, "Several cards are being written already. Try again in a moment.");

  const encoder = new TextEncoder();
  const abort = new AbortController();
  const onClientGone = () => abort.abort();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: DraftStreamEvent) => {
        if (abort.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          abort.abort();
        }
      };
      if (req.signal.aborted) abort.abort();
      else req.signal.addEventListener("abort", onClientGone);
      draftCard({
        text,
        board,
        tasks,
        settings,
        signal: abort.signal,
        onActivity: (line) => send({ type: "activity", text: line }),
      })
        .then(
          ({ draft, model }) => send({ type: "draft", draft, model }),
          (err: unknown) => send({ type: "error", message: err instanceof Error ? err.message : String(err) }),
        )
        .finally(() => {
          release();
          req.signal.removeEventListener("abort", onClientGone);
          try {
            controller.close();
          } catch {
            // Cancelled by the client.
          }
        });
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
});
