import { HttpError, json, readJson, withApi } from "@/lib/server/http";
import { getTerminalSession } from "@/lib/server/terminal";

export const dynamic = "force-dynamic";

/** Kill a running block's process group (SIGTERM, SIGKILL after 2 s). Finished blocks: no-op. */
export const POST = withApi(async ({ req }) => {
  const { id } = await readJson<{ id?: unknown }>(req);
  if (typeof id !== "string" || !id) throw new HttpError(400, "id is required");
  getTerminalSession().cancel(id);
  return json({ ok: true });
}, { admin: true });
