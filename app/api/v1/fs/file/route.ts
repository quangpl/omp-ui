import { readProjectFile, resolveFolderRoot, writeProjectFile } from "@/lib/project-file-content";
import { json, readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Text of one file under a server folder: `?root=<abs>&path=<rel>` → `{ path, content, size, mtimeMs }`. */
export const GET = withApi(async ({ req }) => {
  const search = new URL(req.url).searchParams;
  const root = await resolveFolderRoot(search.get("root"));
  return json(await readProjectFile({ workdir: root, extraFolders: [] }, search.get("path") ?? ""));
});

/** Save an existing file: `{ root, path, content, baseMtimeMs }` → fresh `{ path, content, size, mtimeMs }`; 409 if changed on disk. */
export const PUT = withApi(async ({ req }) => {
  const { root, ...body } = await readJson<{ root?: unknown; path?: unknown; content?: unknown; baseMtimeMs?: unknown }>(
    req,
  );
  return json(await writeProjectFile({ workdir: await resolveFolderRoot(root), extraFolders: [] }, body));
});
