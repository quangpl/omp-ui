import { imageTags } from "@/lib/docker-catalog";
import { HttpError, json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** `?repo=postgres | owner/name | quay.io/ns/name` → recent `HubTag[]`. */
export const GET = withApi(async ({ req }) => {
  const repo = new URL(req.url).searchParams.get("repo")?.trim();
  if (!repo) throw new HttpError(400, "repo is required");
  return json(await imageTags(repo));
}, { admin: true });
