import type { Trajectory } from "@/lib/agent/trajectory";
import { error, withApi } from "@/lib/server/http";
import {
  acquireExportSlot,
  buildTrajectory,
  exportSecrets,
  MAX_SESSION_BYTES,
  ndjsonStream,
  parseTrajectoryOptions,
  readSessionFile,
  sessionCompleted,
} from "@/lib/server/trajectory-export";
import { requireTask } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/**
 * The card's agent session as a Hermes-style ShareGPT trajectory: one NDJSON line download.
 * `runId` limits it to one run of the session (404 when the run is not the card's); `compress=1`
 * compresses it to `maxTokens` (default 15,250) like Hermes' trajectory compressor. Known secret
 * values (AI provider keys, MCP credentials, git host tokens, OMP-UI's own secrets) and common
 * token shapes are replaced by `[REDACTED]`. 413 above 64 MB of session; 429 while two exports run.
 */
export const GET = withApi<{ id: string }>(async ({ req, repo, params }) => {
  const task = await requireTask(repo, params.id);
  const query = new URL(req.url).searchParams;
  const options = parseTrajectoryOptions(query);

  const runId = query.get("runId");
  const run = runId ? await repo.getRun(runId) : null;
  if (runId && (!run || run.taskId !== task.id)) return error(404, "Run not found");

  const release = acquireExportSlot();
  let streaming = false;
  try {
    const session = await readSessionFile(task.sessionFile, MAX_SESSION_BYTES);
    if (session.kind === "missing") return error(404, "No agent session for this card");
    if (session.kind === "too-large") return error(413, "The agent session is too large to export");

    const completed = run ? run.status === "succeeded" : await sessionCompleted(repo, task);
    const secrets = await exportSecrets();
    let pending: Trajectory | null = buildTrajectory({ jsonl: session.text, task, run, completed, options, secrets });
    const response = ndjsonStream(req, `trajectory-${task.id}.jsonl`, release, async () => {
      const trajectory = pending;
      pending = null;
      return trajectory;
    });
    streaming = true;
    return response;
  } finally {
    // The stream frees the slot once it is handed over.
    if (!streaming) release();
  }
});
