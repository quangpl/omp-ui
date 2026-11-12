import { listOmpSkills } from "@/lib/omp-skills";
import { json, withApi } from "@/lib/server/http";
import { getAppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** The omp skills a card can pick with "/" in the composer (cached for a minute). */
export const GET = withApi(async ({ req, repo }) => {
  const { ompPath } = await getAppSettings(repo);
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  return json({ skills: await listOmpSkills(ompPath, { refresh }) });
});
