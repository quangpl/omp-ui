import { json, readJson, withApi } from "@/lib/server/http";
import { parseSchedulerChatRequest, runSchedulerAssistant } from "@/lib/server/scheduler-assistant";
import type { SchedulerChatEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * One turn of "Create with Agent": `SchedulerChatRequest` in, NDJSON `SchedulerChatEvent`s out
 * (`activity` lines while the scheduler assistant works, then one `done` with its reply and the
 * draft it proposed, or one `error`). Saves nothing. Closing the request cancels the assistant.
 * 400 for a malformed body or when the user has no project.
 */
export const POST = withApi(async ({ req, repo }) => {
  const request = parseSchedulerChatRequest(await readJson(req));
  if ((await repo.listBoards()).length === 0) {
    return json({ error: "There are no projects yet: create a project first." }, { status: 400 });
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.signal.addEventListener("abort", abort, { once: true });
  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(output) {
      const send = (event: SchedulerChatEvent) => {
        if (!open) return;
        try {
          output.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
        }
      };
      runSchedulerAssistant({
        repo,
        request,
        signal: controller.signal,
        onActivity: (text) => send({ type: "activity", text }),
      })
        .then(
          (result) => send({ type: "done", ...result }),
          (err: unknown) => send({ type: "error", error: err instanceof Error ? err.message : String(err) }),
        )
        .finally(() => {
          req.signal.removeEventListener("abort", abort);
          if (!open) return;
          open = false;
          try {
            output.close();
          } catch {
            // Client went away.
          }
        });
    },
    cancel() {
      open = false;
      controller.abort();
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
