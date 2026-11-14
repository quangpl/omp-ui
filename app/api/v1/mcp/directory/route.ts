import { json, withApi } from "@/lib/server/http";
import { parseMcpDirectoryQuery, queryMcpDirectory } from "@/lib/server/mcp-directory";

export const dynamic = "force-dynamic";

/** One page of the mcpservers.org server list (`?q=&featured=1&offset=&limit=&refresh=1`). */
export const GET = withApi(async ({ req }) =>
  json(await queryMcpDirectory(parseMcpDirectoryQuery(new URL(req.url).searchParams))),
);
