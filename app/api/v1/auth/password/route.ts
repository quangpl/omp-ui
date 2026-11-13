import { MIN_PASSWORD_LENGTH, setPassword, verifyPassword } from "@/lib/auth";
import { error, readJson, securityEvent, sessionResponse, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Change the admin password. Rotates the token epoch, so every older token stops working. */
export const POST = withApi(async ({ req }) => {
  const { current, next } = await readJson<{ current?: unknown; next?: unknown }>(req);
  if (typeof current !== "string" || !(await verifyPassword(current))) {
    securityEvent(req, "warn", "password", "Password change rejected: current password is incorrect");
    return error(403, "Current password is incorrect");
  }
  if (typeof next !== "string" || next.length < MIN_PASSWORD_LENGTH) {
    securityEvent(req, "warn", "password", "Password change rejected: new password too short");
    return error(400, `New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  await setPassword(next);
  securityEvent(req, "info", "password", "Admin password changed; all sessions revoked");
  return sessionResponse(req);
});
