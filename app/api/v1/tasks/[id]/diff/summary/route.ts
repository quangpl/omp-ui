import { diffSummary } from "@/lib/server/diff-summary";
import { taskDiff } from "@/lib/server/git-diff";
import { json, withApi, type ApiContext } from "@/lib/server/http";
import { requireBoard, requireTask } from "@/lib/server/validate";
import { getAppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** How long a request waits for the summary agent before answering the fallback with `pending: true`. */
const WAIT_MS = 15_000;

async function summarize({ repo, params }: ApiContext<{ id: string }>, force: boolean): Promise<Response> {
  const task = await requireTask(repo, params.id);
  const board = await requireBoard(repo, task.boardId);
  const [diff, settings] = await Promise.all([taskDiff(board, task), getAppSettings(repo)]);
  return json(await diffSummary(diff, { board, task, settings }, { force, waitMs: WAIT_MS }));
}

/** The cached one/two-sentence summary of the card's changes (by the diff's hash), else the file-count line. Never starts the summary agent. */
export const GET = withApi<{ id: string }>((ctx) => summarize(ctx, false));

/** Write the summary with the summary agent (drops the cached one). */
export const POST = withApi<{ id: string }>((ctx) => summarize(ctx, true));
