import { removeClusterNode } from "@/lib/cluster/node";
import { HttpError, auditFailures, json, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type Params = { id: string };

/** Primary: drop a replica from the cluster (it is told to become standalone when connected). */
export const DELETE = withApi<Params>(
  async ({ req, params }) =>
    auditFailures(req, "cluster", "Cluster node removal failed", async () => {
      if (!params.id || params.id.length > 200) throw new HttpError(400, "Invalid node id");
      await removeClusterNode(params.id);
      securityEvent(req, "info", "cluster", `Cluster node removed: ${params.id}`, { nodeId: params.id });
      return json({ ok: true });
    }),
  { admin: true },
);
