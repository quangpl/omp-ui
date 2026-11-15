import { getClusterStatus } from "@/lib/cluster/node";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * This server's view of the cluster (role, nodes, notices); any signed-in user (replica banner,
 * stats). Non-admins see only their own cards among each node's runningTaskIds.
 */
export const GET = withApi(async ({ repo, user }) => {
  const status = await getClusterStatus();
  if (user.role === "admin") return json(status);
  // `repo` is scoped to the user: other users' cards read as null.
  const nodes = await Promise.all(
    status.nodes.map(async (node) => {
      const visible = await Promise.all(node.runningTaskIds.map(async (id) => (await repo.getTask(id)) !== null));
      return { ...node, runningTaskIds: node.runningTaskIds.filter((_, i) => visible[i]) };
    }),
  );
  return json({ ...status, nodes });
});
