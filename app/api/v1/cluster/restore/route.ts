import { restoreCluster } from "@/lib/cluster/node";
import { auditFailures, HttpError, json, readJson, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * Replica: restore the link to the primary. Body `{ restart?: boolean }` (optional): false
 * reconnects now with the backoff reset; true restarts this server through bin/supervisor.mjs.
 */
export const POST = withApi(
  async ({ req }) =>
    auditFailures(req, "cluster", "Cluster restore failed", async () => {
      const body = await readJson(req);
      const restart = body.restart === undefined ? false : body.restart;
      if (typeof restart !== "boolean") throw new HttpError(400, "restart must be a boolean");
      const status = await restoreCluster({ restart });
      securityEvent(
        req,
        "info",
        "cluster",
        restart ? "Restarting this replica to restore the cluster link" : "Reconnecting this replica to the primary",
      );
      return json(status);
    }),
  { admin: true },
);
