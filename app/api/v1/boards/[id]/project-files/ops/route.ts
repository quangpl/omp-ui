import { applyFileOp } from "@/lib/project-file-ops";
import { json, readJson, withApi } from "@/lib/server/http";
import { requireBoard } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/** Create, rename/move, copy or delete a file or folder in the project folders: a `FileOp` → `{ path, kind }`. */
export const POST = withApi<{ id: string }>(async ({ req, repo, params }) => {
  const board = await requireBoard(repo, params.id);
  return json(await applyFileOp(board, await readJson(req)));
});
