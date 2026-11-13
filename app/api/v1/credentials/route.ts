import { createCredential, listCredentials, parseCredentialInput, withFieldErrors } from "@/lib/server/credentials";
import { json, readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Every credential, secrets masked, sorted by name. */
export const GET = withApi(async ({ repo }) => json(await listCredentials(repo)));

/** Create from `CredentialInput & { test?: boolean }`; `test` runs the health check first. 400 `{ error, fields }` when invalid. */
export const POST = withApi(async ({ req, repo }) =>
  withFieldErrors(async () => {
    const { input, test } = parseCredentialInput(await readJson(req));
    return json(await createCredential(repo, input, { test }), { status: 201 });
  }),
);
