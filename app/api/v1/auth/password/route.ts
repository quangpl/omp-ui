import { MIN_PASSWORD_LENGTH, setUserPassword, verifyUserPassword } from "@/lib/auth";
import { error, readJson, securityEvent, sessionResponse, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * Change the caller's password. Bumps their token epoch, so their other sessions and chat logins stop
 * working; the answer carries a fresh token for this one. Other users' sessions are untouched.
 */
export const POST = withApi(async ({ req, user }) => {
  const { current, next } = await readJson<{ current?: unknown; next?: unknown }>(req);
  if (typeof current !== "string" || !(await verifyUserPassword(user.id, current))) {
    securityEvent(req, "warn", "password", "Password change rejected: current password is incorrect");
    return error(403, "Current password is incorrect");
  }
  if (typeof next !== "string" || next.length < MIN_PASSWORD_LENGTH) {
    securityEvent(req, "warn", "password", "Password change rejected: new password too short");
    return error(400, `New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  await setUserPassword(user.id, next);
  securityEvent(req, "info", "password", "Password changed; other sessions revoked");
  return sessionResponse(req, user);
});
