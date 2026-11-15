import { joinScript, parseJoinTarget, requestBaseUrl } from "@/lib/cluster/bootstrap";
import { joinCluster } from "@/lib/cluster/node";
import { auditFailures, json, readJson, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * Public: the sh script of the join one-liner (`curl -fsSL <url>/api/v1/cluster/join | sh -s -- <token>`).
 * It holds this server's URL, never the token.
 */
export const GET = withApi(
  ({ req }) =>
    new Response(joinScript(requestBaseUrl(req)), {
      headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" },
    }),
  { auth: false },
);

/**
 * Make this server a replica of the primary at `url` (body `{ url, token }`). Its own data is
 * replaced by the primary's and it restarts after answering.
 */
export const POST = withApi(
  async ({ req }) =>
    auditFailures(req, "cluster", "Cluster join failed", async () => {
      const { url, token } = parseJoinTarget(await readJson(req));
      const status = await joinCluster(url, token);
      securityEvent(req, "info", "cluster", `Joined the cluster of ${url} as a replica`, { primary: url });
      return json(status);
    }),
  { admin: true },
);
