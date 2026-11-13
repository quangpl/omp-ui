import { resolveFolderRoot } from "@/lib/project-file-content";
import { searchProjectFiles } from "@/lib/project-files";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 30;
/** The Files page tree lists whole directories ("dir/" queries) in one request. */
const MAX_LIMIT = 1000;
const MAX_QUERY_LENGTH = 1024;

/** Files of any server folder (Files page): `?root=<abs>&q=<query>&limit=<n>` → `{ files }`. */
export const GET = withApi(async ({ req }) => {
  const search = new URL(req.url).searchParams;
  const root = await resolveFolderRoot(search.get("root"));
  // Spaces are meaningful in quoted mentions; only a pasted line break is noise.
  const query = (search.get("q") ?? "").replace(/[\r\n]+$/, "").slice(0, MAX_QUERY_LENGTH);
  const requested = Number.parseInt(search.get("limit") ?? "", 10);
  const limit = Number.isFinite(requested) ? Math.min(MAX_LIMIT, Math.max(1, requested)) : DEFAULT_LIMIT;
  return json({ files: await searchProjectFiles({ workdir: root, extraFolders: [] }, query, limit) });
});
