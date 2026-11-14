import { json, withApi } from "@/lib/server/http";
import { wordCompletionModel } from "@/lib/server/word-corpus";
import { getAppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * The n-gram model behind the composer's inline word completion, built from what the caller may
 * see (cached for five minutes per viewer; `?refresh=1` rebuilds the caller's own model).
 */
export const GET = withApi(async ({ req, repo }) => {
  const { ompPath } = await getAppSettings(repo);
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  return json({ model: await wordCompletionModel(repo, ompPath, { refresh }) });
});
