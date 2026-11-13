import { listCheckpoints } from "@/lib/server/checkpoints";
import { json, withApi } from "@/lib/server/http";
import { requireBoard, requireTask } from "@/lib/server/validate";
import { getAppSettings } from "@/lib/settings";
import { shipFolders } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

/**
 * The card's git checkpoints in the folders its agent works in (its worktrees, else the project
 * folders), newest first. `enabled` says whether new runs still take them.
 */
export const GET = withApi<{ id: string }>(async ({ repo, params }) => {
  const task = await requireTask(repo, params.id);
  const board = await requireBoard(repo, task.boardId);
  const [checkpoints, settings] = await Promise.all([
    listCheckpoints(await shipFolders(board, task), task.id),
    getAppSettings(repo),
  ]);
  return json({ checkpoints, enabled: settings.gitCheckpoints });
});
