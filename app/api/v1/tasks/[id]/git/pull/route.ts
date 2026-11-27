import { boardFolders } from "@/lib/board-folders";
import { isGitRepo, pullLatest } from "@/lib/git";
import { HttpError, json, withApi } from "@/lib/server/http";
import { requireBoard, requireTask } from "@/lib/server/validate";
import type { GitPullResult } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Fast-forward every project repo's checked-out branch to its upstream ("Pull latest" in the card's Ship panel). */
export const POST = withApi<{ id: string }>(async ({ repo, params }) => {
  const task = await requireTask(repo, params.id);
  if (task.agentState === "queued" || task.agentState === "running") {
    throw new HttpError(409, "Wait for the agent to finish first.");
  }
  const board = await requireBoard(repo, task.boardId);
  const folders = boardFolders(board);
  const isRepo = await Promise.all(folders.map(isGitRepo));
  const repos = folders.filter((_, i) => isRepo[i]);
  if (repos.length === 0) {
    throw new HttpError(400, "The card's folders aren't git repositories, so there is nothing to pull.");
  }
  const response: GitPullResult = { results: await Promise.all(repos.map(pullLatest)) };
  return json(response);
});
