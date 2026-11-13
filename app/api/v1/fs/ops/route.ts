import { applyFileOp } from "@/lib/project-file-ops";
import { resolveFolderRoot } from "@/lib/project-file-content";
import { json, readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** `boards/:id/project-files/ops` for any server folder (Files page): `{ root, ...FileOp }` → `{ path, kind }`. */
export const POST = withApi(async ({ req }) => {
  const { root, ...op } = await readJson<{ root?: unknown }>(req);
  return json(await applyFileOp({ workdir: await resolveFolderRoot(root), extraFolders: [] }, op));
});
