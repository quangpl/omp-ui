import { HttpError, json, withApi } from "@/lib/server/http";
import { requireBoard, requireTask } from "@/lib/server/validate";
import { getWorkspace, removeWorkspace } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

type Params = { id: string };

/** The card's dedicated workspace: one entry per project folder. */
export const GET = withApi<Params>(async ({ repo, params }) => {
  const task = await requireTask(repo, params.id);
  const board = await requireBoard(repo, task.boardId);
  return json(await getWorkspace(board, task));
});

/** Delete the card's worktrees and their local branch (uncommitted work in them is lost). */
export const DELETE = withApi<Params>(async ({ repo, params }) => {
  const task = await requireTask(repo, params.id);
  if (task.agentState === "queued" || task.agentState === "running") {
    throw new HttpError(409, "Stop the agent before removing its workspace.");
  }
  const board = await requireBoard(repo, task.boardId);
  const problems = await removeWorkspace(board, task);
  if (problems.length > 0) throw new HttpError(500, `Could not remove the workspace: ${problems.join("; ")}`);
  return json(await getWorkspace(board, task));
});
