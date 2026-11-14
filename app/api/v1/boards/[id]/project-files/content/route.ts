import path from "node:path";
import { readProjectFile, writeProjectFile } from "@/lib/project-file-content";
import { assertFsAccess } from "@/lib/server/fs-guard";
import { json, readJson, withApi } from "@/lib/server/http";
import { requireBoard } from "@/lib/server/validate";
import type { Board, User } from "@/lib/types";

export const dynamic = "force-dynamic";

/** 403 when a file id (workdir-relative or absolute, as readProjectFile resolves it) is in the data directory. */
function guardFile(user: User, board: Board, id: unknown): void {
  if (typeof id === "string" && id.trim() && !id.includes("\0")) assertFsAccess(user, path.resolve(board.workdir, id));
}

/** Text of one project file for the editor (Review tab, Files page): `?path=<id>` → `{ path, content, size, mtimeMs }`. */
export const GET = withApi<{ id: string }>(async ({ req, repo, params, user }) => {
  const board = await requireBoard(repo, params.id);
  const id = new URL(req.url).searchParams.get("path") ?? "";
  guardFile(user, board, id);
  return json(await readProjectFile(board, id));
});

/** Save an existing project file: `{ path, content, baseMtimeMs }` → fresh `{ path, content, size, mtimeMs }`; 409 if changed on disk. */
export const PUT = withApi<{ id: string }>(async ({ req, repo, params, user }) => {
  const board = await requireBoard(repo, params.id);
  const body = await readJson<{ path?: unknown; content?: unknown; baseMtimeMs?: unknown }>(req);
  guardFile(user, board, body.path);
  return json(await writeProjectFile(board, body));
});
