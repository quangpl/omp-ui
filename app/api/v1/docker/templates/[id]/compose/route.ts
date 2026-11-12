import { getTemplateCompose } from "@/lib/docker-catalog";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** `{ yaml }` of a compose template (fetched from the catalog's repository for remote ones). */
export const GET = withApi<{ id: string }>(async ({ params }) => json({ yaml: await getTemplateCompose(params.id) }));
