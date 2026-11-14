import { json, withApi } from "@/lib/server/http";
import { syncMcpServers } from "@/lib/server/mcp";

export const dynamic = "force-dynamic";

/** Rewrite every managed entry in mcp.json and reload the agents' MCP secrets; problems are reported in `configError`. */
export const POST = withApi(async ({ repo }) => json(await syncMcpServers(repo)));
