import type { AgentManager } from "@/lib/agent/types";
import type { Repository } from "@/lib/db/types";
import { publish } from "@/lib/events";
import { removeFilesFolder } from "@/lib/files";
import type { Board } from "@/lib/types";
import { removeWorkspace } from "@/lib/workspaces";

/**
 * Stops every agent on the board, then deletes it (cascading tasks, comments, runs) with its
 * shared files and every card's files and dedicated workspace. Workspaces go one card at a time:
 * concurrent `git worktree remove` / `branch -D` on the same repository race for its lock files.
 */
export async function deleteBoardWithData(repo: Repository, manager: AgentManager, board: Board): Promise<void> {
  const tasks = await repo.listTasks(board.id);
  for (const task of tasks) await manager.onTaskDeleted(task.id);
  await repo.deleteBoard(board.id);
  publish({ type: "board.deleted", boardId: board.id });
  await removeFilesFolder("boards", board.id);
  for (const task of tasks) {
    await Promise.all([removeFilesFolder("tasks", task.id), removeWorkspace(board, task)]);
  }
}
