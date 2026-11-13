import { readProjectFile, writeProjectFile } from "@/lib/project-file-content";
import { json, readJson, withApi } from "@/lib/server/http";
import { requireBoard } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/** Text of one project file for the Files tab: `?path=<id>` → `{ path, content, size, mtimeMs }`. */
export const GET = withApi<{ id: string }>(async ({ req, repo, params }) => {
  const board = await requireBoard(repo, params.id);
  const id = new URL(req.url).searchParams.get("path") ?? "";
  return json(await readProjectFile(board, id));
});

/** Save an existing project file: `{ path, content, baseMtimeMs }` → fresh `{ path, content, size, mtimeMs }`; 409 if changed on disk. */
export const PUT = withApi<{ id: string }>(async ({ req, repo, params }) => {
  const board = await requireBoard(repo, params.id);
  const body = await readJson<{ path?: unknown; content?: unknown; baseMtimeMs?: unknown }>(req);
  return json(await writeProjectFile(board, body));
});
