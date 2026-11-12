import { fetchComposeUrl } from "@/lib/docker-catalog";
import { HttpError, json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** `?url=` → `{ yaml, url }`: downloads a compose file (GitHub/GitLab/Gist links become raw links). */
export const GET = withApi(async ({ req }) => {
  const url = new URL(req.url).searchParams.get("url")?.trim();
  if (!url) throw new HttpError(400, "url is required");
  if (url.length > 2048) throw new HttpError(400, "URL is too long");
  return json(await fetchComposeUrl(url));
});
