import path from "node:path";
import { initRepo } from "@/lib/git";
import { assertFsAccess } from "@/lib/server/fs-guard";
import { HttpError, json, readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Run `git init` in an existing folder that is not yet a git repository. */
export const POST = withApi(async ({ req, user }) => {
  const body = await readJson(req);
  if (typeof body.path !== "string" || !body.path.trim()) {
    throw new HttpError(400, "Please choose the folder to initialize.");
  }
  // Writes `.git` into the folder; relative paths are rejected by initRepo.
  const folder = body.path.trim();
  if (path.isAbsolute(folder)) assertFsAccess(user, folder, { containing: true });
  const result = await initRepo(body.path);
  return json(result, { status: 201 });
});
