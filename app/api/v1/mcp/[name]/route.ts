import { auditFailures, json, readJson, securityEvent, withApi } from "@/lib/server/http";
import { listMcpServers, parseMcpServerUpdate, removeMcpServer, updateMcpServer } from "@/lib/server/mcp";

export const dynamic = "force-dynamic";

type Params = { name: string };

/** Enable/disable a server or switch it to another saved credential of the same provider (`McpServerUpdate`). */
export const PATCH = withApi<Params>(async ({ req, repo, params }) =>
  auditFailures(req, "mcp", "MCP server update failed", async () => {
    const update = parseMcpServerUpdate(await readJson(req));
    const updated = await updateMcpServer(repo, params.name, update);
    securityEvent(req, "info", "mcp", `MCP server updated: ${updated.name}`, {
      name: updated.name,
      provider: updated.providerId,
      // Which parts of the request were sent (keys only).
      changed: Object.keys(update).join(","),
      enabled: updated.enabled,
      credentialId: updated.credentialId,
    });
    return json(updated);
  }),
  { admin: true },
);

/** Remove the server from mcp.json; `?deleteCredential=1` also deletes its credential. */
export const DELETE = withApi<Params>(async ({ req, repo, params }) =>
  auditFailures(req, "mcp", "MCP server remove failed", async () => {
    const deleteCredential = new URL(req.url).searchParams.get("deleteCredential") === "1";
    // Looked up first only to name its provider in the security log; removeMcpServer 404s when it is gone.
    const existing = (await listMcpServers(repo)).servers.find((s) => s.name === params.name);
    await removeMcpServer(repo, params.name, { deleteCredential });
    securityEvent(req, "info", "mcp", `MCP server removed: ${params.name}`, {
      name: params.name,
      provider: existing?.providerId ?? null,
      credentialId: existing?.credentialId ?? null,
      deleteCredential,
    });
    return json({ ok: true });
  }),
  { admin: true },
);
