import type { Trajectory } from "@/lib/agent/trajectory";
import { withApi } from "@/lib/server/http";
import {
  acquireExportSlot,
  buildTrajectory,
  exportSecrets,
  MAX_BATCH_SESSION_BYTES,
  MAX_SESSION_BYTES,
  ndjsonStream,
  parseTrajectoryOptions,
  readSessionFile,
  sessionCompleted,
} from "@/lib/server/trajectory-export";
import { parseStatus, requireBoard } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/**
 * Batch export of the board's cards as Hermes-style ShareGPT trajectories (like Hermes' batch
 * runner output): one NDJSON line per card with a readable agent session, optionally only cards in
 * `status`. Same `compress` / `maxTokens` and secret redaction as the single-card export. Streamed:
 * one session is read and turned into its line only when the client has taken the previous one,
 * sessions over 64 MB are skipped and at most 256 MB of session input is read in total (cards
 * beyond that are left out). 429 while two exports run.
 */
export const GET = withApi<{ id: string }>(async ({ req, repo, params }) => {
  const board = await requireBoard(repo, params.id);
  const query = new URL(req.url).searchParams;
  const options = parseTrajectoryOptions(query);
  const rawStatus = query.get("status");
  const status = rawStatus === null ? null : parseStatus(rawStatus);

  const tasks = (await repo.listTasks(board.id)).filter((task) => status === null || task.status === status);
  const release = acquireExportSlot();
  let streaming = false;
  try {
    const secrets = await exportSecrets();
    let index = 0;
    let inputBytes = 0;
    const next = async (): Promise<Trajectory | null> => {
      while (index < tasks.length && !req.signal.aborted) {
        const task = tasks[index++];
        const budget = MAX_BATCH_SESSION_BYTES - inputBytes;
        const session = await readSessionFile(task.sessionFile, Math.min(MAX_SESSION_BYTES, budget));
        if (session.kind === "missing") continue;
        if (session.kind === "too-large") {
          // Over the per-card limit: skip the card; within it but over the remaining budget: done.
          if (session.bytes > MAX_SESSION_BYTES) continue;
          return null;
        }
        inputBytes += session.bytes;
        const completed = await sessionCompleted(repo, task);
        return buildTrajectory({ jsonl: session.text, task, run: null, completed, options, secrets });
      }
      return null;
    };
    const response = ndjsonStream(req, `trajectories-${board.id}.jsonl`, release, next);
    streaming = true;
    return response;
  } finally {
    // The stream frees the slot once it is handed over.
    if (!streaming) release();
  }
});
