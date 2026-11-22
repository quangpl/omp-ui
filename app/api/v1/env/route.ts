import { listEnvVars, parseEnvVarsInput, setEnvVars } from "@/lib/server/env-vars";
import { auditFailures, json, readJson, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Every custom environment variable with its value (admin only), sorted by key. */
export const GET = withApi(async ({ repo }) => json(await listEnvVars(repo)), { admin: true });

/** Add or overwrite variables from `{ vars: { KEY: "value" } }`; answers the whole list. 400 when a key or value is invalid. */
export const PUT = withApi(
  async ({ req, repo }) =>
    auditFailures(req, "settings", "Environment variables update failed", async () => {
      const vars = parseEnvVarsInput(await readJson(req));
      const response = await setEnvVars(repo, vars);
      securityEvent(req, "info", "settings", "Environment variables saved", { keys: Object.keys(vars).join(", ") });
      return json(response);
    }),
  { admin: true },
);
