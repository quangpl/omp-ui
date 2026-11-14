import { startAiOAuth } from "@/lib/server/ai-oauth";
import { json, readJson, securityEvent, withApi } from "@/lib/server/http";
import { getAppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Start an OAuth sign-in (`AiOAuthStartInput` `{ loginId }`): runs `omp login <loginId>` on the
 * server → 201 `AiOAuthSession`. 400 for a login id the catalog does not offer.
 */
export const POST = withApi(async ({ req, repo }) => {
  const { loginId } = await readJson(req);
  const { ompPath } = await getAppSettings(repo);
  const session = startAiOAuth(ompPath, loginId);
  securityEvent(req, "info", "settings", `AI provider OAuth sign-in started: ${session.label}`, {
    login: session.loginId,
  });
  return json(session, { status: 201 });
}, { admin: true });
