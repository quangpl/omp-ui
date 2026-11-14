import { parseResourceName, removeVolume } from "@/lib/docker";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const DELETE = withApi<{ name: string }>(async ({ params }) => {
  await removeVolume(parseResourceName(params.name, "volume"));
  return json({ ok: true });
}, { admin: true });
