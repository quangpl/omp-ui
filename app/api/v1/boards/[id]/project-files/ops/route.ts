import path from "node:path";
import { applyFileOp } from "@/lib/project-file-ops";
import { assertFsAccess } from "@/lib/server/fs-guard";
import { json, readJson, withApi } from "@/lib/server/http";
import { requireBoard } from "@/lib/server/validate";
import type { User } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * 403 when an op path (workdir-relative or absolute, as applyFileOp resolves it) is in the data
 * directory or, since folders are moved, copied and deleted whole, contains it.
 */
function guardOpPaths(user: User, workdir: string, op: unknown): void {
  if (!op || typeof op !== "object" || Array.isArray(op)) return;
  const body = op as Record<string, unknown>;
  for (const value of [body.path, body.from, body.to]) {
    if (typeof value !== "string" || value.includes("\0")) continue;
    const raw = value.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (raw) assertFsAccess(user, path.resolve(workdir, raw), { containing: true });
  }
}

/** Create, rename/move, copy or delete a file or folder in the project folders: a `FileOp` → `{ path, kind }`. */
export const POST = withApi<{ id: string }>(async ({ req, repo, params, user }) => {
  const board = await requireBoard(repo, params.id);
  const op = await readJson(req);
  guardOpPaths(user, board.workdir, op);
  return json(await applyFileOp(board, op));
});
