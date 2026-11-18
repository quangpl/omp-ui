import { HttpError, json, withApi } from "@/lib/server/http";
import { requireBoard, requireTask } from "@/lib/server/validate";
import { discardChangesIn } from "@/lib/server/git-actions";
import type { GitDiscardResult } from "@/lib/types";
import { shipFolders } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

/** Discard the task's uncommitted changes in the folders it ships from (worktrees, else project folders). */
export const POST = withApi<{ id: string }>(async ({ repo, params }) => {
  const task = await requireTask(repo, params.id);
  if (task.agentState === "queued" || task.agentState === "running") {
    throw new HttpError(409, "Wait for the agent to finish first.");
  }
  const board = await requireBoard(repo, task.boardId);
  const folders = await shipFolders(board, task);
  const results = await discardChangesIn(folders);
  if (results.length === 0) {
    throw new HttpError(400, "The card's folders aren't git repositories, so there is nothing to discard.");
  }
  const response: GitDiscardResult = { results };
  return json(response);
});
