import path from "node:path";
import { applyFileOp } from "@/lib/project-file-ops";
import { resolveFolderRoot } from "@/lib/project-file-content";
import { assertFsAccess } from "@/lib/server/fs-guard";
import { json, readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * `boards/:id/project-files/ops` for any server folder (Files page): `{ root, ...FileOp }` → `{ path, kind }`.
 * Non-admins: 403 when the root or any op path is in the data directory or contains it.
 */
export const POST = withApi(async ({ req, user }) => {
  const { root, ...op } = await readJson<{ root?: unknown; path?: unknown; from?: unknown; to?: unknown }>(req);
  const workdir = await resolveFolderRoot(root);
  assertFsAccess(user, workdir);
  // Same resolution as applyFileOp: absolute paths as is, others under the root; malformed ones are its 400s.
  for (const target of [op.path, op.from, op.to]) {
    if (typeof target === "string" && target.trim()) {
      assertFsAccess(user, path.resolve(workdir, target), { containing: true });
    }
  }
  return json(await applyFileOp({ workdir, extraFolders: [] }, op));
});
