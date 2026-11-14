import { getTemplateCatalog } from "@/lib/docker-catalog";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Built-in one-click apps + the Portainer app catalog (cached 1 h; `?refresh=1` reloads). */
export const GET = withApi(async ({ req }) =>
  json(await getTemplateCatalog(new URL(req.url).searchParams.get("refresh") === "1")),
  { admin: true },
);
