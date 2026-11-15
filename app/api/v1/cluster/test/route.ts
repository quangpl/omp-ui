import { parseJoinTarget } from "@/lib/cluster/bootstrap";
import { testClusterConnection } from "@/lib/cluster/node";
import { json, readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * Can this server reach and authenticate with the primary at `url`? Body `{ url, token }`; an empty
 * token tests with this node's stored token (a replica checking its own primary).
 */
export const POST = withApi(
  async ({ req }) => {
    const { url, token } = parseJoinTarget(await readJson(req), { allowEmptyToken: true });
    return json(await testClusterConnection(url, token));
  },
  { admin: true },
);
