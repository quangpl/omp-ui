import type { CreateBoardInput } from "@/lib/db/types";
import { publish } from "@/lib/events";
import { assertFsAccess } from "@/lib/server/fs-guard";
import { json, readJson, withApi } from "@/lib/server/http";
import {
  parseBoardName,
  parseBoolean,
  parseDefaultBranches,
  parseExtraFolders,
  parseModel,
  parsePushBranch,
  parseWorkdir,
} from "@/lib/server/validate";

export const dynamic = "force-dynamic";

export const GET = withApi(async ({ repo }) => json(await repo.listBoards()));

export const POST = withApi(async ({ req, repo, user }) => {
  const body = await readJson(req);
  const input: CreateBoardInput = {
    name: parseBoardName(body.name),
    workdir: parseWorkdir(body.workdir),
  };
  if (body.extraFolders !== undefined) {
    input.extraFolders = parseExtraFolders(body.extraFolders, input.workdir);
  }
  if (body.defaultBranches !== undefined) {
    input.defaultBranches = parseDefaultBranches(body.defaultBranches, [
      input.workdir,
      ...(input.extraFolders ?? []),
    ]);
  }
  // Project files are read, written and deleted through the board: never the data directory.
  for (const folder of [input.workdir, ...(input.extraFolders ?? [])]) {
    assertFsAccess(user, folder, { containing: true });
  }
  if (body.model !== undefined) input.model = parseModel(body.model);
  if (body.autoRun !== undefined) input.autoRun = parseBoolean(body.autoRun, "autoRun");
  if (body.pushBranch !== undefined) input.pushBranch = parsePushBranch(body.pushBranch);
  const board = await repo.createBoard(input);
  publish({ type: "board.updated", board });
  return json(board, { status: 201 });
});
