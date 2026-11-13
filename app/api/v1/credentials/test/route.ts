import { parseCredentialInput, testCredentialInput, withFieldErrors } from "@/lib/server/credentials";
import { auditFailures, json, readJson, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * Test unsaved form values (`CredentialInput & { id?: string }`) without storing anything. With
 * `id`, secret fields left empty use that credential's stored values.
 */
export const POST = withApi(async ({ req, repo }) =>
  auditFailures(req, "credentials", "Credential test failed", () =>
    withFieldErrors(async () => {
      const { input, id } = parseCredentialInput(await readJson(req));
      const result = await testCredentialInput(repo, input, id);
      const label = input.name.trim() || input.providerId;
      const health = result.ok ? "healthy" : "failing";
      securityEvent(req, "info", "credentials", `Credential tested: ${label} (${health})`, {
        id: id ?? null,
        provider: input.providerId,
        ok: result.ok,
        latencyMs: result.latencyMs,
      });
      return json(result);
    }),
  ),
);
