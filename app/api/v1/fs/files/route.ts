import path from "node:path";
import { resolveFolderRoot } from "@/lib/project-file-content";
import { searchProjectFiles } from "@/lib/project-files";
import { assertFsAccess, withoutRestricted } from "@/lib/server/fs-guard";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 30;
/** The Files page tree lists whole directories ("dir/" queries) in one request. */
const MAX_LIMIT = 1000;
const MAX_QUERY_LENGTH = 1024;

/**
 * Files of any server folder (Files page): `?root=<abs>&q=<query>&limit=<n>` → `{ files }`.
 * Non-admins: 403 for a root inside the data directory, and hits inside it are left out.
 */
export const GET = withApi(async ({ req, user }) => {
  const search = new URL(req.url).searchParams;
  const root = await resolveFolderRoot(search.get("root"));
  assertFsAccess(user, root);
  // Spaces are meaningful in quoted mentions; only a pasted line break is noise.
  const query = (search.get("q") ?? "").replace(/[\r\n]+$/, "").slice(0, MAX_QUERY_LENGTH);
  const requested = Number.parseInt(search.get("limit") ?? "", 10);
  const limit = Number.isFinite(requested) ? Math.min(MAX_LIMIT, Math.max(1, requested)) : DEFAULT_LIMIT;
  const files = await searchProjectFiles({ workdir: root, extraFolders: [] }, query, limit);
  return json({ files: withoutRestricted(user, files, (hit) => path.resolve(root, hit.insert)) });
});
