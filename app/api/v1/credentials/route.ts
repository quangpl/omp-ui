import { createCredential, listCredentials, parseCredentialInput, withFieldErrors } from "@/lib/server/credentials";
import { auditFailures, json, readJson, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Every credential, secrets masked, sorted by name. */
export const GET = withApi(async ({ repo }) => json(await listCredentials(repo)));

/** Create from `CredentialInput & { test?: boolean }`; `test` runs the health check first. 400 `{ error, fields }` when invalid. */
export const POST = withApi(async ({ req, repo }) =>
  auditFailures(req, "credentials", "Credential create failed", () =>
    withFieldErrors(async () => {
      const { input, test } = parseCredentialInput(await readJson(req));
      const created = await createCredential(repo, input, { test });
      securityEvent(req, "info", "credentials", `Credential created: ${created.name}`, {
        id: created.id,
        provider: created.providerId,
        health: created.health,
      });
      return json(created, { status: 201 });
    }),
  ),
);
