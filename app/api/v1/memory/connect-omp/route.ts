import { json, withApi } from "@/lib/server/http";
import { connectOmp } from "@/lib/server/agentmemory";
import { getAppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** `agentmemory connect omp --with-mcp`: install agentmemory's OMP extension, skills and MCP toolset into omp's agent dir. */
export const POST = withApi(async ({ repo }) => {
  const { ompPath } = await getAppSettings(repo);
  return json(await connectOmp(ompPath));
}, { admin: true });
