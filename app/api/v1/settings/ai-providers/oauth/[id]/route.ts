import { answerAiOAuth, cancelAiOAuth, getAiOAuth } from "@/lib/server/ai-oauth";
import { json, readJson, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type Params = { id: string };

/** The sign-in's progress (`AiOAuthSession`); 404 once it is unknown or expired. */
export const GET = withApi<Params>(async ({ params }) => json(getAiOAuth(params.id)), { admin: true });

/**
 * Answer omp's pending question (`AiOAuthInput` `{ input }`: a pasted redirect URL or code, a
 * domain, "yes") → `AiOAuthSession`. 409 when the sign-in ended or omp is not asking anything.
 */
export const POST = withApi<Params>(async ({ req, params }) => {
  const { input } = await readJson(req);
  return json(answerAiOAuth(params.id, input));
}, { admin: true });

/** Cancel a running sign-in (stops `omp login`) → `AiOAuthSession`; a finished one is returned as is. */
export const DELETE = withApi<Params>(async ({ req, params }) => {
  const session = cancelAiOAuth(params.id);
  securityEvent(req, "info", "settings", `AI provider OAuth sign-in cancelled: ${session.label}`, {
    login: session.loginId,
  });
  return json(session);
}, { admin: true });
