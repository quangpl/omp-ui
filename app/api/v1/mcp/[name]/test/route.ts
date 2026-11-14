import { auditFailures, json, securityEvent, withApi } from "@/lib/server/http";
import { testMcpServer } from "@/lib/server/mcp";

export const dynamic = "force-dynamic";

type Params = { name: string };

/** Health-check the server's credential and probe the server (initialize + tools/list) now; stores the outcome. */
export const POST = withApi<Params>(async ({ req, repo, params }) =>
  auditFailures(req, "mcp", "MCP server test failed", async () => {
    const server = await testMcpServer(repo, params.name);
    securityEvent(req, "info", "mcp", `MCP server tested: ${server.name} (${server.status})`, {
      name: server.name,
      provider: server.providerId,
      status: server.status,
      tools: server.probe?.tools.length ?? null,
      latencyMs: server.probe?.latencyMs ?? null,
    });
    return json(server);
  }),
  { admin: true },
);
