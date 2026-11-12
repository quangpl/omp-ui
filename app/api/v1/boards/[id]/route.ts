import type { UpdateBoardInput } from "@/lib/db/types";
import { publish } from "@/lib/events";
import { removeFilesFolder } from "@/lib/files";
import { error, json, readJson, withApi } from "@/lib/server/http";
import {
  parseBoardName,
  parseBoolean,
  parseExtraFolders,
  parseModel,
  parseWorkdir,
  requireBoard,
} from "@/lib/server/validate";
import { removeWorkspace } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

type Params = { id: string };

export const GET = withApi<Params>(async ({ repo, params }) =>
  json(await requireBoard(repo, params.id)),
);

export const PATCH = withApi<Params>(async ({ req, repo, params }) => {
  const current = await requireBoard(repo, params.id);
  const body = await readJson(req);
  const patch: UpdateBoardInput = {};
  if (body.name !== undefined) patch.name = parseBoardName(body.name);
  if (body.workdir !== undefined) patch.workdir = parseWorkdir(body.workdir);
  if (body.extraFolders !== undefined) {
    patch.extraFolders = parseExtraFolders(body.extraFolders, patch.workdir ?? current.workdir);
  } else if (patch.workdir && current.extraFolders.includes(patch.workdir)) {
    // The new main folder can no longer also be an extra folder.
    patch.extraFolders = current.extraFolders.filter((f) => f !== patch.workdir);
  }
  if (body.model !== undefined) patch.model = parseModel(body.model);
  if (body.autoRun !== undefined) patch.autoRun = parseBoolean(body.autoRun, "autoRun");
  if (body.worktrees !== undefined) patch.worktrees = parseBoolean(body.worktrees, "worktrees");
  if (Object.keys(patch).length === 0) return json(current);
  const board = await repo.updateBoard(params.id, patch);
  if (!board) return error(404, "Board not found");
  publish({ type: "board.updated", board });
  return json(board);
});

/**
 * Stops every agent on the board, then deletes it (cascading tasks, comments, runs) with its
 * shared files and every card's files and dedicated workspace.
 */
export const DELETE = withApi<Params>(async ({ repo, manager, params }) => {
  const board = await requireBoard(repo, params.id);
  const tasks = await repo.listTasks(params.id);
  for (const task of tasks) await manager.onTaskDeleted(task.id);
  await repo.deleteBoard(params.id);
  publish({ type: "board.deleted", boardId: params.id });
  await removeFilesFolder("boards", board.id);
  for (const task of tasks) {
    await Promise.all([removeFilesFolder("tasks", task.id), removeWorkspace(board, task)]);
  }
  return json({ ok: true });
});
