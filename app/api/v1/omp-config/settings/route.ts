import { json, withApi } from "@/lib/server/http";
import { listOmpSettings } from "@/lib/server/omp-config";
import { getAppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** Every setting omp knows: key, type, description, enum choices, default, secret. */
export const GET = withApi(async ({ req, repo }) => {
  const { ompPath } = await getAppSettings(repo);
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  return json({ settings: await listOmpSettings(ompPath, { refresh }) });
});
