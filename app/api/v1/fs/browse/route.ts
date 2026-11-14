import path from "node:path";
import { assertFsAccess } from "@/lib/server/fs-guard";
import { json, withApi } from "@/lib/server/http";
import { browse, getWorkspaceRoot } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** Folder picker: sub-folders of `?path=` (default: WORKSPACE_DIR). Non-admins: 403 inside the data directory. */
export const GET = withApi(async ({ req, user }) => {
  const raw = new URL(req.url).searchParams.get("path");
  const target = raw?.trim();
  // A relative path is browse's 400.
  if (!target) assertFsAccess(user, getWorkspaceRoot());
  else if (path.isAbsolute(target)) assertFsAccess(user, target);
  return json(await browse(raw));
});
