import { json, withApi } from "@/lib/server/http";
import { startMemoryServer } from "@/lib/server/agentmemory";
import { getAppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** Start the agentmemory server (`agentmemory`) unless it is healthy; answers within a minute, `starting` while it boots. */
export const POST = withApi(async ({ repo }) => {
  const { ompPath } = await getAppSettings(repo);
  return json(await startMemoryServer(ompPath));
});
