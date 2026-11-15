import path from "node:path";
import { listBranches, switchBranch } from "@/lib/git";
import { HttpError, json, readJson, withApi } from "@/lib/server/http";
import { requireBoard } from "@/lib/server/validate";
import type { Board } from "@/lib/types";

export const dynamic = "force-dynamic";

/** `value` resolved to one of the board's project folders, or a 400. */
function projectFolder(board: Board, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "folder is required.");
  const folder = path.resolve(value.trim());
  if (folder !== board.workdir && !board.extraFolders.includes(folder)) {
    throw new HttpError(400, `This folder is not part of the project: ${folder}`);
  }
  return folder;
}

/** Branches of one project folder (`?folder=<abs>`). */
export const GET = withApi<{ id: string }>(async ({ req, repo, params }) => {
  const board = await requireBoard(repo, params.id);
  return json(await listBranches(projectFolder(board, new URL(req.url).searchParams.get("folder"))));
});

/** Switch one project folder to an existing branch and pull it: `{ folder, branch }` → `GitSwitchResult`. */
export const POST = withApi<{ id: string }>(async ({ req, repo, params }) => {
  const board = await requireBoard(repo, params.id);
  const body = await readJson(req);
  const folder = projectFolder(board, body.folder);
  if (typeof body.branch !== "string" || !body.branch.trim()) throw new HttpError(400, "branch is required.");
  // Agents work in these folders; switching underneath one would mix its edits into another branch.
  const tasks = await repo.listTasks(board.id);
  if (tasks.some((t) => t.agentState === "queued" || t.agentState === "running")) {
    throw new HttpError(409, "Wait for the agent to finish first.");
  }
  return json(await switchBranch(folder, body.branch.trim()));
});
