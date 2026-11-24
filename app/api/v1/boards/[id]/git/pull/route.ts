import { boardFolders } from "@/lib/board-folders";
import { isGitRepo, pullLatest } from "@/lib/git";
import { HttpError, json, withApi } from "@/lib/server/http";
import { requireBoard } from "@/lib/server/validate";
import type { GitPullResult } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Header "pull latest changes": fast-forward every project repo's checked-out branch to its
 * upstream. Uncommitted changes stay; a repo that can't fast-forward reports its own error.
 */
export const POST = withApi<{ id: string }>(async ({ repo, params }) => {
  const board = await requireBoard(repo, params.id);
  // Agents edit these folders; moving HEAD underneath one would mix upstream changes into its work.
  const tasks = await repo.listTasks(board.id);
  if (tasks.some((t) => t.agentState === "queued" || t.agentState === "running")) {
    throw new HttpError(409, "Wait for the agent to finish first.");
  }

  const folders = boardFolders(board);
  const isRepo = await Promise.all(folders.map(isGitRepo));
  const repos = folders.filter((_, i) => isRepo[i]);
  if (repos.length === 0) {
    throw new HttpError(400, "This project's folders aren't git repositories, so there is nothing to pull.");
  }
  const response: GitPullResult = { results: await Promise.all(repos.map(pullLatest)) };
  return json(response);
});
