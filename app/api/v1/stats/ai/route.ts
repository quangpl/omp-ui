import { ndjsonResponse, withApi } from "@/lib/server/http";
import { getAppSettings } from "@/lib/settings";
import { readAiSections } from "@/lib/stats";
import type { AiStatsEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * AI quota, prepaid balances and usage as NDJSON `AiStatsEvent`s: `providers` at once, then each part
 * the moment it is read (omp usage, omp stats and the provider APIs run side by side). With a Main
 * provider (the first of `providerPriority`) every part covers that provider only.
 * `?refresh=1` bypasses the 60 s cache.
 */
export const GET = withApi(async ({ req, repo }) => {
  const refresh = new URL(req.url).searchParams.get("refresh");
  return ndjsonResponse<AiStatsEvent>(
    async (send) => {
      const { ompPath, providerPriority } = await getAppSettings(repo);
      const main = providerPriority[0]?.provider ?? null;
      send({ type: "providers", activeProviders: main ? [main] : [] });
      const sections = readAiSections(ompPath, refresh === "1" || refresh === "true", main);
      await Promise.all([
        sections.quota.then(({ at, value }) => send({ type: "quota", at, quota: value })),
        sections.balances.then(({ at, value }) => send({ type: "balances", at, balances: value })),
        sections.usage.then(({ at, value }) => send({ type: "usage", at, usage: value })),
      ]);
    },
    (err) => ({ type: "error", message: err instanceof Error ? err.message : String(err) }),
  );
});
