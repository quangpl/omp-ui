import { parseCredentialInput, testCredentialInput, withFieldErrors } from "@/lib/server/credentials";
import { json, readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * Test unsaved form values (`CredentialInput & { id?: string }`) without storing anything. With
 * `id`, secret fields left empty use that credential's stored values.
 */
export const POST = withApi(async ({ req, repo }) =>
  withFieldErrors(async () => {
    const { input, id } = parseCredentialInput(await readJson(req));
    return json(await testCredentialInput(repo, input, id));
  }),
);
