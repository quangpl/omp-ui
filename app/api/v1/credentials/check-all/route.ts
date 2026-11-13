import { checkAllCredentials } from "@/lib/server/credentials";
import { auditFailures, json, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Health-check every credential now (including those with autoCheck off); answers the new list. */
export const POST = withApi(async ({ req, repo }) =>
  auditFailures(req, "credentials", "Credential check-all failed", async () => {
    const list = await checkAllCredentials(repo);
    const failing = list.credentials.filter((c) => c.health === "failing").length;
    securityEvent(
      req,
      "info",
      "credentials",
      `Credentials checked: ${list.credentials.length} (${failing} failing)`,
      { count: list.credentials.length, failing },
    );
    return json(list);
  }),
);
