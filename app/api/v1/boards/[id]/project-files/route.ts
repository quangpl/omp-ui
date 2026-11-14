import { searchProjectFiles } from "@/lib/project-files";
import { json, withApi } from "@/lib/server/http";
import { requireBoard } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 30;
/** The file tree (Review tab, Files page) lists whole directories ("dir/" queries) in one request. */
const MAX_LIMIT = 1000;
/** Long enough for an absolute directory path inside an extra project folder. */
const MAX_QUERY_LENGTH = 1024;

/** "@" mention candidates from the board's project folders: `?q=<query>&limit=<n>` → `{ files }`. */
export const GET = withApi<{ id: string }>(async ({ req, repo, params }) => {
  const board = await requireBoard(repo, params.id);
  const search = new URL(req.url).searchParams;
  // Spaces are meaningful in quoted mentions; only a pasted line break is noise.
  const query = (search.get("q") ?? "").replace(/[\r\n]+$/, "").slice(0, MAX_QUERY_LENGTH);
  const requested = Number.parseInt(search.get("limit") ?? "", 10);
  const limit = Number.isFinite(requested) ? Math.min(MAX_LIMIT, Math.max(1, requested)) : DEFAULT_LIMIT;
  return json({ files: await searchProjectFiles(board, query, limit) });
});
