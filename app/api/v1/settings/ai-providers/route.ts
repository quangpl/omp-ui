import { getAiProvider } from "@/lib/ai-providers";
import { getAiProviders, parseAiProviderUpdate, updateAiProvider } from "@/lib/server/ai-providers";
import { withFieldErrors } from "@/lib/server/credentials";
import { auditFailures, json, readJson, securityEvent, withApi } from "@/lib/server/http";
import { getAppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** Every AI provider with its auth status, secrets masked; `refresh=1` re-runs `omp models` and `omp usage`. */
export const GET = withApi(async ({ req, repo }) => {
  const { ompPath } = await getAppSettings(repo);
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  return json(await getAiProviders(repo, ompPath, { refresh }));
});

/** Save/clear a provider's values (`AiProviderUpdate`). 400 `{ error, fields }` (keyed by env var) when invalid. */
export const PATCH = withApi(async ({ req, repo }) =>
  auditFailures(req, "settings", "AI provider update failed", () =>
    withFieldErrors(async () => {
      const update = parseAiProviderUpdate(await readJson(req));
      const { ompPath } = await getAppSettings(repo);
      const response = await updateAiProvider(repo, ompPath, update);
      const name = getAiProvider(update.providerId)?.name ?? update.providerId;
      securityEvent(req, "info", "settings", `AI provider credentials updated: ${name}`, {
        provider: update.providerId,
        saved: Object.entries(update.values ?? {})
          .filter(([, value]) => value.trim())
          .map(([envVar]) => envVar)
          .join(", "),
        cleared: (update.clear ?? []).join(", "),
      });
      return json(response);
    }),
  ),
  { admin: true },
);
