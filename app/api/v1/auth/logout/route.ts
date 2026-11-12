import { clearSessionCookie } from "@/lib/auth";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const POST = withApi(
  ({ req }) => json({ ok: true }, { headers: { "set-cookie": clearSessionCookie(req) } }),
  { auth: false },
);
