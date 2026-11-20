import type { UpdateBoardInput } from "@/lib/db/types";
import { publish } from "@/lib/events";
import { pruneDefaultBranches } from "@/lib/default-branch";
import { deleteBoardWithData } from "@/lib/server/delete-board";
import { assertFsAccess } from "@/lib/server/fs-guard";
import { error, json, readJson, withApi } from "@/lib/server/http";
import {
  parseBoardName,
  parseBoolean,
  parseDefaultBranches,
  parseExtraFolders,
  parseModel,
  parsePushBranch,
  parseWorkdir,
  requireBoard,
} from "@/lib/server/validate";

export const dynamic = "force-dynamic";

type Params = { id: string };

export const GET = withApi<Params>(async ({ repo, params }) =>
  json(await requireBoard(repo, params.id)),
);

export const PATCH = withApi<Params>(async ({ req, repo, params, user }) => {
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
  // Project files are read, written and deleted through the board: never the data directory.
  if (patch.workdir) assertFsAccess(user, patch.workdir, { containing: true });
  if (body.extraFolders !== undefined) {
    for (const folder of patch.extraFolders ?? []) assertFsAccess(user, folder, { containing: true });
  }
  if (body.model !== undefined) patch.model = parseModel(body.model);
  if (body.autoRun !== undefined) patch.autoRun = parseBoolean(body.autoRun, "autoRun");
  if (body.worktrees !== undefined) patch.worktrees = parseBoolean(body.worktrees, "worktrees");
  if (body.pushBranch !== undefined) patch.pushBranch = parsePushBranch(body.pushBranch);
  // Default branches describe the project's folders: the ones a folder that left the project had
  // are dropped, so a stale entry can never name a repo again.
  const folders = [patch.workdir ?? current.workdir, ...(patch.extraFolders ?? current.extraFolders)];
  if (body.defaultBranches !== undefined) {
    patch.defaultBranches = parseDefaultBranches(body.defaultBranches, folders);
  } else {
    const pruned = pruneDefaultBranches(current.defaultBranches, folders);
    if (pruned) patch.defaultBranches = pruned;
  }
  if (body.pinned !== undefined) patch.pinned = parseBoolean(body.pinned, "pinned");
  if (Object.keys(patch).length === 0) return json(current);
  const board = await repo.updateBoard(params.id, patch);
  if (!board) return error(404, "Board not found");
  publish({ type: "board.updated", board });
  return json(board);
});

/** Stops every agent on the board, then deletes it with its files and workspaces (see deleteBoardWithData). */
export const DELETE = withApi<Params>(async ({ repo, manager, params }) => {
  await deleteBoardWithData(repo, manager, await requireBoard(repo, params.id));
  return json({ ok: true });
});
