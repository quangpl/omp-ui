import { checkCredential } from "@/lib/server/credentials";
import { auditFailures, json, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type Params = { id: string };

/** Health-check a saved credential now and store the outcome: `{ credential, result }`. */
export const POST = withApi<Params>(async ({ req, repo, params }) =>
  auditFailures(req, "credentials", "Credential test failed", async () => {
    const outcome = await checkCredential(repo, params.id);
    const { credential, result } = outcome;
    securityEvent(
      req,
      "info",
      "credentials",
      `Credential tested: ${credential.name} (${result.ok ? "healthy" : "failing"})`,
      { id: credential.id, provider: credential.providerId, ok: result.ok, latencyMs: result.latencyMs },
    );
    return json(outcome);
  }),
);
