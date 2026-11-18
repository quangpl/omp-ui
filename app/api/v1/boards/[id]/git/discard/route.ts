import { HttpError, json, withApi } from "@/lib/server/http";
import { requireBoard } from "@/lib/server/validate";
import { discardChangesIn } from "@/lib/server/git-actions";
import type { GitDiscardResult } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Header "discard all changes": roll every project repo's working tree back to HEAD — tracked,
 * staged and untracked files. Not tied to a card, so no comment is posted. Unpushed commits and
 * git checkpoints are kept.
 */
export const POST = withApi<{ id: string }>(async ({ repo, params }) => {
  const board = await requireBoard(repo, params.id);
  // Without dedicated workspaces agents edit these folders; discarding mid-run would destroy live work.
  if (!board.worktrees) {
    const tasks = await repo.listTasks(board.id);
    if (tasks.some((t) => t.agentState === "queued" || t.agentState === "running")) {
      throw new HttpError(409, "Wait for the agent to finish first.");
    }
  }

  const results = await discardChangesIn([board.workdir, ...board.extraFolders]);
  if (results.length === 0) {
    throw new HttpError(400, "This project's folders aren't git repositories, so there is nothing to discard.");
  }
  const response: GitDiscardResult = { results };
  return json(response);
});
