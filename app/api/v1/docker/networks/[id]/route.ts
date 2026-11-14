import { parseResourceName, removeNetwork } from "@/lib/docker";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const DELETE = withApi<{ id: string }>(async ({ params }) => {
  await removeNetwork(parseResourceName(params.id, "network"));
  return json({ ok: true });
}, { admin: true });
