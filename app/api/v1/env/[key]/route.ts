import { deleteEnvVar } from "@/lib/server/env-vars";
import { auditFailures, json, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Delete one variable; answers the new list. 404 when it does not exist. */
export const DELETE = withApi<{ key: string }>(
  async ({ req, repo, params }) =>
    auditFailures(req, "settings", "Environment variable delete failed", async () => {
      const response = await deleteEnvVar(repo, params.key);
      securityEvent(req, "info", "settings", `Environment variable deleted: ${params.key}`, { key: params.key });
      return json(response);
    }),
  { admin: true },
);
