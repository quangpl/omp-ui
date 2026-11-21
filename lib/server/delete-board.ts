import type { AgentManager } from "@/lib/agent/types";
import type { Repository } from "@/lib/db/types";
import { queueTaskDockerCleanup } from "@/lib/docker";
import { publish } from "@/lib/events";
import { boardFolders } from "@/lib/board-folders";
import { removeFilesFolder } from "@/lib/files";
import { removeRunSnapshots } from "@/lib/server/task-changes";
import type { Board } from "@/lib/types";

/**
 * Stops every agent on the board, then deletes it (cascading tasks, comments, runs) with its
 * shared files and every card's files and git change snapshots; the Docker resources each card's
 * agent marked as temporary are removed in the background (lib/task-docker.ts). Snapshots go one
 * card at a time: concurrent ref updates in the same repository can race for its lock files.
 */
export async function deleteBoardWithData(repo: Repository, manager: AgentManager, board: Board): Promise<void> {
  const tasks = await repo.listTasks(board.id);
  for (const task of tasks) await manager.onTaskDeleted(task.id);
  await repo.deleteBoard(board.id);
  publish({ type: "board.deleted", boardId: board.id });
  await removeFilesFolder("boards", board.id);
  for (const task of tasks) {
    queueTaskDockerCleanup(task.id);
    await Promise.all([removeFilesFolder("tasks", task.id), removeRunSnapshots(boardFolders(board), task.id)]);
  }
}
