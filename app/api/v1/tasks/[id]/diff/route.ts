import { json, withApi } from "@/lib/server/http";
import { taskDiff } from "@/lib/server/git-diff";
import { requireBoard, requireTask } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/** The card's code changes: per folder it works in, uncommitted changes plus commits ahead of the base branch. */
export const GET = withApi<{ id: string }>(async ({ repo, params }) => {
  const task = await requireTask(repo, params.id);
  const board = await requireBoard(repo, task.boardId);
  return json(await taskDiff(board, task, true));
});
