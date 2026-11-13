import { initRepo } from "@/lib/git";
import { HttpError, json, readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Run `git init` in an existing folder that is not yet a git repository. */
export const POST = withApi(async ({ req }) => {
  const body = await readJson(req);
  if (typeof body.path !== "string" || !body.path.trim()) {
    throw new HttpError(400, "Please choose the folder to initialize.");
  }
  const result = await initRepo(body.path);
  return json(result, { status: 201 });
});
