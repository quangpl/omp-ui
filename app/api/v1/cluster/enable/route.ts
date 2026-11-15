import { enableCluster } from "@/lib/cluster/node";
import { auditFailures, json, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Standalone → primary of a new cluster (new join token, cluster channel listening). */
export const POST = withApi(
  async ({ req }) =>
    auditFailures(req, "cluster", "Cluster enable failed", async () => {
      const status = await enableCluster();
      securityEvent(req, "info", "cluster", "Cluster mode enabled: this server is the primary", { port: status.port });
      return json(status);
    }),
  { admin: true },
);
