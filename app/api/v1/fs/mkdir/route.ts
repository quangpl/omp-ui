import { json, readJson, withApi } from "@/lib/server/http";
import { createFolder } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** Folder picker: create the folder `name` inside the absolute folder `parent`. */
export const POST = withApi(async ({ req }) => {
  const body = await readJson(req);
  const entry = await createFolder(body.parent, body.name);
  return json(entry, { status: 201 });
});
