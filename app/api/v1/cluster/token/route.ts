import { clusterJoinInfo } from "@/lib/cluster/bootstrap";
import { readNodeState, rotateClusterToken } from "@/lib/cluster/node";
import { HttpError, auditFailures, json, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** The join token; 409 unless this server is the primary. */
function primaryToken(): string {
  const state = readNodeState();
  if (state.role !== "primary" || !state.token) {
    throw new HttpError(409, "This server is not the primary of a cluster; enable cluster mode first");
  }
  return state.token;
}

/** Primary: the join token and the one-liner that joins a new machine. */
export const GET = withApi(async ({ req }) => json(clusterJoinInfo(req, primaryToken())), { admin: true });

/** Primary: rotate the join token (connected nodes get the new one and stay in). */
export const POST = withApi(
  async ({ req }) =>
    auditFailures(req, "cluster", "Cluster token rotation failed", async () => {
      primaryToken();
      const token = await rotateClusterToken();
      securityEvent(req, "info", "cluster", "Cluster join token rotated");
      return json(clusterJoinInfo(req, token));
    }),
  { admin: true },
);
