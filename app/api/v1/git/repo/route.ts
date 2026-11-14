import path from "node:path";
import { checkRepo } from "@/lib/git";
import { assertFsAccess } from "@/lib/server/fs-guard";
import { HttpError, json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Whether `?path=` (an existing absolute folder) is inside a git repository. */
export const GET = withApi(async ({ req, user }) => {
  const folder = new URL(req.url).searchParams.get("path");
  if (!folder?.trim()) throw new HttpError(400, "Please choose a folder.");
  // Relative paths are rejected by checkRepo.
  if (path.isAbsolute(folder.trim())) assertFsAccess(user, folder.trim());
  return json(await checkRepo(folder));
});
