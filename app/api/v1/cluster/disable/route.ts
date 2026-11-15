import { disableCluster } from "@/lib/cluster/node";
import { auditFailures, json, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Primary or replica → standalone (the cluster channel closes). */
export const POST = withApi(
  async ({ req }) =>
    auditFailures(req, "cluster", "Cluster disable failed", async () => {
      const status = await disableCluster();
      securityEvent(req, "info", "cluster", "Cluster mode disabled: this server is standalone");
      return json(status);
    }),
  { admin: true },
);
