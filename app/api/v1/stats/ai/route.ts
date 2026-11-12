import { json, withApi } from "@/lib/server/http";
import { getAppSettings } from "@/lib/settings";
import { getAiStats } from "@/lib/stats";

export const dynamic = "force-dynamic";

export const GET = withApi(async ({ req, repo }) => {
  const refresh = new URL(req.url).searchParams.get("refresh");
  const { ompPath } = await getAppSettings(repo);
  return json(await getAiStats(ompPath, { refresh: refresh === "1" || refresh === "true" }));
});
