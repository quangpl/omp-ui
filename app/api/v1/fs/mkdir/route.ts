import path from "node:path";
import { assertFsAccess } from "@/lib/server/fs-guard";
import { json, readJson, withApi } from "@/lib/server/http";
import { createFolder } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** Folder picker: create the folder `name` inside the absolute folder `parent`. Non-admins: 403 in the data directory. */
export const POST = withApi(async ({ req, user }) => {
  const body = await readJson(req);
  // Malformed parents and names are createFolder's 400s.
  const parent = typeof body.parent === "string" ? body.parent.trim() : "";
  if (path.isAbsolute(parent)) {
    assertFsAccess(user, parent);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name) assertFsAccess(user, path.join(parent, name));
  }
  const entry = await createFolder(body.parent, body.name);
  return json(entry, { status: 201 });
});
