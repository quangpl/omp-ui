import {
  deleteCredential,
  listCredentials,
  parseCredentialUpdate,
  updateCredential,
  withFieldErrors,
} from "@/lib/server/credentials";
import { auditFailures, json, readJson, securityEvent, withApi } from "@/lib/server/http";
import { syncMcpServers } from "@/lib/server/mcp";

export const dynamic = "force-dynamic";

type Params = { id: string };

/**
 * Edit from `CredentialUpdate & { test?: boolean }`. Secret fields omitted or "" keep their stored
 * value; changed values reset health to untested unless `test` checks them right away. MCP servers
 * using the credential are re-synced (mcp.json's inlined values, the agents' secrets).
 */
export const PATCH = withApi<Params>(async ({ req, repo, params }) =>
  auditFailures(req, "credentials", "Credential update failed", () =>
    withFieldErrors(async () => {
      const { update, test } = parseCredentialUpdate(await readJson(req));
      const updated = await updateCredential(repo, params.id, update, { test });
      await syncMcpServers(repo);
      // Which parts of the request were sent (field keys only, never values).
      const changed = [
        ...Object.keys(update).filter((key) => key !== "fields" && key !== "clear"),
        ...Object.keys(update.fields ?? {}).map((key) => `fields.${key}`),
        ...(update.clear ?? []).map((key) => `clear.${key}`),
      ];
      securityEvent(req, "info", "credentials", `Credential updated: ${updated.name}`, {
        id: updated.id,
        provider: updated.providerId,
        changed: changed.join(","),
        health: updated.health,
      });
      return json(updated);
    }),
  ),
);

/** Delete the credential; MCP servers using it are switched off in mcp.json (status `error`). */
export const DELETE = withApi<Params>(async ({ req, repo, params }) =>
  auditFailures(req, "credentials", "Credential delete failed", async () => {
    // Looked up first only to name it in the security log; deleteCredential 404s when it is gone.
    const existing = (await listCredentials(repo)).credentials.find((c) => c.id === params.id);
    await deleteCredential(repo, params.id);
    await syncMcpServers(repo);
    securityEvent(req, "info", "credentials", `Credential deleted: ${existing?.name ?? params.id}`, {
      id: params.id,
      provider: existing?.providerId ?? null,
    });
    return json({ ok: true });
  }),
);
