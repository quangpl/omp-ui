import { gitStatus, pushToDefault } from "@/lib/git";
import { HttpError, json, withApi } from "@/lib/server/http";
import { requireBoard } from "@/lib/server/validate";
import type { BoardPushResult, GitRepoActionResult } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Header "quick push": commit every project folder's changes and push each repo straight to its
 * default branch. Not tied to a card, so no comment is posted.
 */
export const POST = withApi<{ id: string }>(async ({ repo, params }) => {
  const board = await requireBoard(repo, params.id);
  // Without dedicated workspaces agents edit these folders; committing mid-run would ship half-done work.
  if (!board.worktrees) {
    const tasks = await repo.listTasks(board.id);
    if (tasks.some((t) => t.agentState === "queued" || t.agentState === "running")) {
      throw new HttpError(409, "Wait for the agent to finish first.");
    }
  }

  const statuses = await Promise.all([board.workdir, ...board.extraFolders].map(gitStatus));
  const repos = statuses.filter((s) => s.isRepo);
  if (repos.length === 0) {
    throw new HttpError(400, "This project's folders aren't git repositories, so there is nothing to push.");
  }
  const files = repos.reduce((sum, s) => sum + s.changedFiles, 0);
  const message = `Update from AgentMan (${files} ${files === 1 ? "file" : "files"})`;

  const results: GitRepoActionResult[] = [];
  for (const { folder } of repos) {
    try {
      results.push((await pushToDefault(folder, message)).result);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ folder, branch: null, commit: null, url: null, output: "", error, skipped: false });
    }
  }
  const response: BoardPushResult = { results };
  return json(response);
});
