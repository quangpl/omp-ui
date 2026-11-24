import { buildAgentHub } from "@/lib/agent-hub";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * Visualize page's agent hub: the subagents of the 60 most recent runs (latest persisted state each,
 * newest activity first) and their combined activity log, like the roster of omp's Agent Hub.
 */
export const GET = withApi(async ({ repo }) => json(await buildAgentHub(repo)));
