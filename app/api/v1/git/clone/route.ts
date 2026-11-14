import path from "node:path";
import { cloneRepo } from "@/lib/git";
import { assertFsAccess } from "@/lib/server/fs-guard";
import { HttpError, json, readJson, withApi } from "@/lib/server/http";
import { getWorkspaceRoot } from "@/lib/workspace";

export const dynamic = "force-dynamic";

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, `${field} must be text.`);
  return value.trim() || null;
}

/** Clone a repository into WORKSPACE_DIR/<name>. */
export const POST = withApi(async ({ req, user }) => {
  const body = await readJson(req);
  if (typeof body.url !== "string" || !body.url.trim()) {
    throw new HttpError(400, "Please enter the repository address to clone.");
  }
  // A local source repository is read; the destination is a new folder directly in
  // WORKSPACE_DIR (409 if it exists), so it can only reach the data directory from inside it.
  const url = body.url.trim();
  if (path.isAbsolute(url)) assertFsAccess(user, url);
  assertFsAccess(user, getWorkspaceRoot());
  const result = await cloneRepo({
    url: body.url,
    name: optionalString(body.name, "name"),
    branch: optionalString(body.branch, "branch"),
  });
  return json(result, { status: 201 });
});
