import type { UpdateTaskInput } from "@/lib/db/types";
import { publish } from "@/lib/events";
import { removeFilesFolder } from "@/lib/files";
import { error, json, readJson, withApi } from "@/lib/server/http";
import {
  parseBlockedBy,
  parseDescription,
  parsePosition,
  parseQuestionClear,
  parseStatus,
  parseTitle,
  requireTask,
} from "@/lib/server/validate";
import { removeWorkspace } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

type Params = { id: string };

export const GET = withApi<Params>(async ({ repo, params }) => {
  const task = await requireTask(repo, params.id);
  const [comments, runs] = await Promise.all([repo.listComments(task.id), repo.listRuns(task.id)]);
  return json({ task, comments, runs });
});

/** Edit or move a card. A status change runs the agent rules (start/stop) after persisting. */
export const PATCH = withApi<Params>(async ({ req, repo, manager, params }) => {
  const previous = await requireTask(repo, params.id);
  const body = await readJson(req);
  const patch: UpdateTaskInput = {};
  if (body.title !== undefined) patch.title = parseTitle(body.title);
  if (body.description !== undefined) patch.description = parseDescription(body.description);
  if (body.status !== undefined) patch.status = parseStatus(body.status);
  if (body.position !== undefined) patch.position = parsePosition(body.position);
  if (body.question !== undefined) patch.question = parseQuestionClear(body.question);
  if (body.blockedBy !== undefined) {
    patch.blockedBy = await parseBlockedBy(repo, body.blockedBy, previous.boardId, previous.id);
  }
  if (Object.keys(patch).length === 0) return json(previous);

  const task = await repo.updateTask(previous.id, patch);
  if (!task) return error(404, "Task not found");
  publish({ type: "task.updated", task });
  // New or removed blockers can let a queued card start (or hold it back).
  if (patch.blockedBy) manager.refreshQueue();
  if (task.status === previous.status) return json(task);

  await manager.onTaskMoved(task, previous.status);
  return json((await repo.getTask(task.id)) ?? task);
});

/** Deletes the card with its agent run, files and dedicated workspace (worktrees + branch). */
export const DELETE = withApi<Params>(async ({ repo, manager, params }) => {
  const task = await requireTask(repo, params.id);
  await manager.onTaskDeleted(task.id);
  await repo.deleteTask(task.id);
  publish({ type: "task.deleted", taskId: task.id, boardId: task.boardId });
  const board = await repo.getBoard(task.boardId);
  await Promise.all([removeFilesFolder("tasks", task.id), removeWorkspace(board, task)]);
  return json({ ok: true });
});
