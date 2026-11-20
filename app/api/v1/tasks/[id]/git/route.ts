import { boardDefaultBranch } from "@/lib/default-branch";
import { gitStatus } from "@/lib/git";
import { json, withApi } from "@/lib/server/http";
import { requireBoard, requireTask } from "@/lib/server/validate";
import { shipTargets } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

/** Git status of the folders the card ships from: its worktrees, else the project folders. */
export const GET = withApi<{ id: string }>(async ({ repo, params }) => {
  const task = await requireTask(repo, params.id);
  const board = await requireBoard(repo, task.boardId);
  const targets = await shipTargets(board, task);
  return json(
    await Promise.all(
      targets.map((t) => gitStatus(t.path, { defaultBranch: boardDefaultBranch(board, t.source) })),
    ),
  );
});
