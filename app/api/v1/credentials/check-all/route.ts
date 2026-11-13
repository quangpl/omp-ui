import { checkAllCredentials } from "@/lib/server/credentials";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Health-check every credential now (including those with autoCheck off); answers the new list. */
export const POST = withApi(async ({ repo }) => json(await checkAllCredentials(repo)));
