import { deleteCredential, parseCredentialUpdate, updateCredential, withFieldErrors } from "@/lib/server/credentials";
import { json, readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type Params = { id: string };

/**
 * Edit from `CredentialUpdate & { test?: boolean }`. Secret fields omitted or "" keep their stored
 * value; changed values reset health to untested unless `test` checks them right away.
 */
export const PATCH = withApi<Params>(async ({ req, repo, params }) =>
  withFieldErrors(async () => {
    const { update, test } = parseCredentialUpdate(await readJson(req));
    return json(await updateCredential(repo, params.id, update, { test }));
  }),
);

export const DELETE = withApi<Params>(async ({ repo, params }) => {
  await deleteCredential(repo, params.id);
  return json({ ok: true });
});
