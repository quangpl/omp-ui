// Route handlers for /tasks/:id/files and /boards/:id/files (shared files of a card / a board).
import { publish } from "@/lib/events";
import {
  deleteFile,
  fileResponse,
  listFiles,
  saveUpload,
  uploadName,
  type FileScope,
} from "@/lib/files";
import { json, withApi, type ApiContext } from "@/lib/server/http";
import { requireBoard, requireTask } from "@/lib/server/validate";

/** Board the folder belongs to (404 for an unknown card/board). */
async function owner(ctx: ApiContext<{ id: string }>, scope: FileScope): Promise<{ boardId: string; taskId: string | null }> {
  if (scope === "tasks") {
    const task = await requireTask(ctx.repo, ctx.params.id);
    return { boardId: task.boardId, taskId: task.id };
  }
  const board = await requireBoard(ctx.repo, ctx.params.id);
  return { boardId: board.id, taskId: null };
}

/** GET lists the files; POST `?name=<file>` with the raw file as body uploads (replaces) one. */
export function fileListRoutes(scope: FileScope) {
  return {
    GET: withApi<{ id: string }>(async (ctx) => {
      await owner(ctx, scope);
      return json(await listFiles(scope, ctx.params.id));
    }),
    POST: withApi<{ id: string }>(async (ctx) => {
      const where = await owner(ctx, scope);
      const name = uploadName(new URL(ctx.req.url).searchParams.get("name"));
      const length = ctx.req.headers.get("content-length");
      await saveUpload(scope, ctx.params.id, name, ctx.req.body, length ? Number(length) : null);
      publish({ type: "files.updated", ...where });
      return json(await listFiles(scope, ctx.params.id), { status: 201 });
    }),
  };
}

/** GET serves one file (`?download=1` forces a download; a `Range` header gets a 206 slice); DELETE removes it. */
export function fileItemRoutes(scope: FileScope) {
  type Params = { id: string; path: string[] | string };
  const nameOf = (params: Params) => (Array.isArray(params.path) ? params.path.join("/") : params.path);
  return {
    GET: withApi<Params>(async (ctx) => {
      await owner(ctx, scope);
      const download = new URL(ctx.req.url).searchParams.get("download") === "1";
      return fileResponse(scope, ctx.params.id, nameOf(ctx.params), download, ctx.req.headers.get("range"));
    }),
    DELETE: withApi<Params>(async (ctx) => {
      const where = await owner(ctx, scope);
      await deleteFile(scope, ctx.params.id, nameOf(ctx.params));
      publish({ type: "files.updated", ...where });
      return json(await listFiles(scope, ctx.params.id));
    }),
  };
}
