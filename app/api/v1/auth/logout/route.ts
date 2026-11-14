import { clearSessionCookie } from "@/lib/auth";
import { json, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Clears the session cookie. The event names the user (meta.user) when the request still carries a valid token. */
export const POST = withApi(
  ({ req }) => {
    securityEvent(req, "info", "logout", "Logged out");
    return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie(req) } });
  },
  { auth: false },
);
