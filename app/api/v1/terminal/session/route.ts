import { json, withApi } from "@/lib/server/http";
import { getTerminalSession } from "@/lib/server/terminal";

export const dynamic = "force-dynamic";

/** Clear finished blocks and their logs; running blocks stay. Subscribers get a fresh snapshot. */
export const DELETE = withApi(() => {
  getTerminalSession().clear();
  return json({ ok: true });
}, { admin: true });
