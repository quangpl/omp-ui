import { leaveCluster } from "@/lib/cluster/node";
import { auditFailures, json, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Replica → standalone; the replicated data stays as this server's own. */
export const POST = withApi(
  async ({ req }) =>
    auditFailures(req, "cluster", "Cluster leave failed", async () => {
      const status = await leaveCluster();
      securityEvent(req, "info", "cluster", "Left the cluster: this server is standalone");
      return json(status);
    }),
  { admin: true },
);
