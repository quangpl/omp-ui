import { json, withApi } from "@/lib/server/http";
import { listOmpModels } from "@/lib/server/omp-config";
import { getAppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** Chat models omp can use, for the model fields' suggestions (cached for 5 minutes). */
export const GET = withApi(async ({ req, repo }) => {
  const { ompPath } = await getAppSettings(repo);
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  return json({ models: await listOmpModels(ompPath, { refresh }) });
});
