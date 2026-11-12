import { json, withApi } from "@/lib/server/http";
import { getMemoryStatus } from "@/lib/server/agentmemory";
import { getAppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** The local agentmemory server: install, health, OMP hook-up, embeddings mode and stats. `?refresh=1` re-probes the CLI. */
export const GET = withApi(async ({ req, repo }) => {
  const { ompPath } = await getAppSettings(repo);
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  return json(await getMemoryStatus(ompPath, { refresh }));
});
