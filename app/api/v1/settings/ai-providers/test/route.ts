import { parseAiProviderTestInput, testAiProvider } from "@/lib/server/ai-providers";
import { withFieldErrors } from "@/lib/server/credentials";
import { json, readJson, withApi } from "@/lib/server/http";
import { getAppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Test a provider (`AiProviderTestInput`): the effective values, with non-empty `values` in place
 * of saved ones (never stored). 400 when there is nothing to test.
 */
export const POST = withApi(async ({ req, repo }) =>
  withFieldErrors(async () => {
    const input = parseAiProviderTestInput(await readJson(req));
    const { ompPath } = await getAppSettings(repo);
    return json(await testAiProvider(repo, ompPath, input));
  }),
  { admin: true },
);
