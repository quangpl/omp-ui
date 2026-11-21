import type { AgentManager } from "@/lib/agent/types";
import type { Repository } from "@/lib/db/types";
import { queueTaskDockerCleanup } from "@/lib/docker";
import { publish } from "@/lib/events";
import { boardFolders } from "@/lib/board-folders";
import { removeFilesFolder } from "@/lib/files";
import { removeRunSnapshots } from "@/lib/server/task-changes";
import type { Board, Task } from "@/lib/types";

/**
 * Deletes a card with its agent run, files and the git snapshots that track its changes; the
 * Docker resources its agent marked as temporary are removed in the background (lib/task-docker.ts).
 * Callers deleting several cards of one repository go one at a time: concurrent ref updates in
 * the same repository can race for its lock files.
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
  await Promise.all([removeFilesFolder("tasks", task.id), board ? removeRunSnapshots(boardFolders(board), task.id) : null]);
}
