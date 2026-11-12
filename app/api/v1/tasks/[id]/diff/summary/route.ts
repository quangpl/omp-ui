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

/** One/two-sentence summary of the card's changes (cached by the diff's hash). */
export const GET = withApi<{ id: string }>((ctx) => summarize(ctx, false));

/** Write the summary again (drops the cached one). */
export const POST = withApi<{ id: string }>((ctx) => summarize(ctx, true));
