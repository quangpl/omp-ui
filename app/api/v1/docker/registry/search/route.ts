import { parseRegistry, searchImages } from "@/lib/docker-catalog";
import { HttpError, json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** `?q=&registry=dockerhub|quay` → `HubRepository[]`. */
export const GET = withApi(async ({ req }) => {
  const query = new URL(req.url).searchParams;
  const q = query.get("q")?.trim() ?? "";
  if (!q) throw new HttpError(400, "q is required");
  if (q.length > 100) throw new HttpError(400, "Search text is too long");
  return json(await searchImages(parseRegistry(query.get("registry")), q));
}, { admin: true });
