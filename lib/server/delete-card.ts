import type { AgentManager } from "@/lib/agent/types";
import type { Repository } from "@/lib/db/types";
import { queueTaskDockerCleanup } from "@/lib/docker";
import { publish } from "@/lib/events";
import { removeFilesFolder } from "@/lib/files";
import type { Board, Task } from "@/lib/types";
import { removeWorkspace } from "@/lib/workspaces";

/**
 * Deletes a card with its agent run, files and dedicated workspace (worktrees + branch); the
 * Docker resources its agent marked as temporary are removed in the background (lib/task-docker.ts).
 * Callers deleting several cards of one repository go one at a time: concurrent
 * `git worktree remove` / `branch -D` on the same repository race for its lock files.
 */
export async function deleteCard(
  repo: Repository,
  manager: AgentManager,
  task: Task,
  board: Board | null,
): Promise<void> {
  await manager.onTaskDeleted(task.id);
  await repo.deleteTask(task.id);
  publish({ type: "task.deleted", taskId: task.id, boardId: task.boardId });
  queueTaskDockerCleanup(task.id);
  await Promise.all([removeFilesFolder("tasks", task.id), removeWorkspace(board, task)]);
}
