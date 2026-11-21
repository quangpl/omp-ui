import path from "node:path";
import { boardFolders } from "@/lib/board-folders";
import { publish } from "@/lib/events";
import { BEFORE_RESTORE_LABEL, restoreCheckpoint } from "@/lib/server/checkpoints";
import { HttpError, json, readJson, withApi } from "@/lib/server/http";
import { requireBoard, requireTask } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/**
 * Roll one folder's files back to a checkpoint `{ id, folder }`. Works whether or not new
 * checkpoints are still taken; refused while the card's agent runs (it would fight the restore).
 */
export const POST = withApi<{ id: string }>(async ({ req, repo, params }) => {
  const task = await requireTask(repo, params.id);
  if (task.agentState === "queued" || task.agentState === "running") {
    throw new HttpError(409, "Stop the agent before restoring a checkpoint.");
  }
  const body = await readJson(req);
  if (typeof body.id !== "string" || !body.id.trim()) throw new HttpError(400, "id must be a checkpoint id.");
  if (typeof body.folder !== "string" || !body.folder.trim()) throw new HttpError(400, "folder must be a folder path.");
  const board = await requireBoard(repo, task.boardId);
  const folder = path.resolve(body.folder.trim());
  const folders = boardFolders(board).map((f) => path.resolve(f));
  if (!folders.includes(folder)) throw new HttpError(400, `This folder is not part of the project: ${folder}`);

  const result = await restoreCheckpoint(folder, task.id, body.id.trim());
  if (!result) throw new HttpError(404, "Checkpoint not found.");

  const { checkpoint, undo, restored, removed } = result;
  const when = `${checkpoint.createdAt.slice(0, 16).replace("T", " ")} UTC`;
  const comment = await repo.addComment({
    taskId: task.id,
    author: "agent",
    body: [
      `**Rolled back files** in ${path.basename(folder) || folder}/ to the checkpoint "${checkpoint.label}" of ${when} (\`${checkpoint.sha.slice(0, 7)}\`):`,
      `${restored.length} file${restored.length === 1 ? "" : "s"} restored, ${removed.length} removed. Ignored files were left alone.`,
      `The files as they were just before are saved as the checkpoint "${BEFORE_RESTORE_LABEL}"; restore it to undo this.`,
    ].join(" "),
    resolved: true,
  });
  publish({ type: "comment.added", comment, boardId: task.boardId });
  publish({ type: "files.updated", boardId: task.boardId, taskId: task.id });
  const fresh = await repo.getTask(task.id);
  if (fresh) publish({ type: "task.updated", task: fresh });
  return json({ checkpoint, undo, restored: restored.length, removed: removed.length, comment });
});
