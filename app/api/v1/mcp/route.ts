import { withFieldErrors } from "@/lib/server/credentials";
import { auditFailures, json, readJson, securityEvent, withApi } from "@/lib/server/http";
import { connectMcpServer, listMcpServers, parseMcpConnectInput } from "@/lib/server/mcp";

export const dynamic = "force-dynamic";

/** Connected servers (sorted by name), mcp.json's path and problems, and the entries AgentMan does not manage. */
export const GET = withApi(async ({ repo }) => json(await listMcpServers(repo)));

/**
 * Connect a catalog server from `McpConnectInput`: reuse a saved credential or save a new one, then
 * write the entry to omp's mcp.json. 400 `{ error, fields }` when the new credential is invalid.
 */
export const POST = withApi(async ({ req, repo }) =>
  auditFailures(req, "mcp", "MCP server connect failed", () =>
    withFieldErrors(async () => {
      const input = parseMcpConnectInput(await readJson(req));
      const result = await connectMcpServer(repo, input);
      const { server } = result;
      securityEvent(req, "info", "mcp", `MCP server connected: ${server.name}`, {
        name: server.name,
        provider: server.providerId,
        credentialId: server.credentialId,
        newCredential: input.credential !== undefined,
        status: server.status,
      });
      return json(result, { status: 201 });
    }),
  ),
  { admin: true },
);
