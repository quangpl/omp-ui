import { json, withApi } from "@/lib/server/http";
import { browse } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** Folder picker: sub-folders of `?path=` (default: WORKSPACE_DIR). */
export const GET = withApi(async ({ req }) =>
  json(await browse(new URL(req.url).searchParams.get("path"))),
);
