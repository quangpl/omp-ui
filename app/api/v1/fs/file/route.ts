import path from "node:path";
import { readProjectFile, resolveFolderRoot, writeProjectFile } from "@/lib/project-file-content";
import { assertFsAccess } from "@/lib/server/fs-guard";
import { json, readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Text of one file under a server folder: `?root=<abs>&path=<rel>` → `{ path, content, size, mtimeMs }`. */
export const GET = withApi(async ({ req, user }) => {
  const search = new URL(req.url).searchParams;
  const root = await resolveFolderRoot(search.get("root"));
  const file = search.get("path") ?? "";
  assertFsAccess(user, root);
  // Same resolution as resolveProjectFile: absolute ids as is, others under the root.
  if (file) assertFsAccess(user, path.resolve(root, file));
  return json(await readProjectFile({ workdir: root, extraFolders: [] }, file));
});

/** Save an existing file: `{ root, path, content, baseMtimeMs }` → fresh `{ path, content, size, mtimeMs }`; 409 if changed on disk. */
export const PUT = withApi(async ({ req, user }) => {
  const { root, ...body } = await readJson<{ root?: unknown; path?: unknown; content?: unknown; baseMtimeMs?: unknown }>(
    req,
  );
  const workdir = await resolveFolderRoot(root);
  assertFsAccess(user, workdir);
  if (typeof body.path === "string" && body.path) assertFsAccess(user, path.resolve(workdir, body.path));
  return json(await writeProjectFile({ workdir, extraFolders: [] }, body));
});
