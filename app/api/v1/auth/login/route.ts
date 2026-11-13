import {
  clearLoginFailures,
  isConfigured,
  loginRetryAfter,
  recordLoginFailure,
  verifyPassword,
} from "@/lib/auth";
import { error, json, readJson, securityEvent, sessionResponse, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const POST = withApi(
  async ({ req }) => {
    const retryAfter = loginRetryAfter(req);
    if (retryAfter > 0) {
      securityEvent(req, "error", "login", "Login blocked: too many failed attempts", { retryAfter });
      return json(
        { error: "Too many failed login attempts. Try again later." },
        { status: 429, headers: { "retry-after": String(retryAfter) } },
      );
    }
    if (!(await isConfigured())) {
      securityEvent(req, "warn", "login", "Login attempted before the admin password was set up");
      return error(409, "Admin password is not set up yet");
    }
    const { password } = await readJson<{ password?: unknown }>(req);
    if (typeof password !== "string" || !password || !(await verifyPassword(password))) {
      recordLoginFailure(req);
      // Non-zero once this failure used up the allowed attempts: the client is now locked out.
      const lockedFor = loginRetryAfter(req);
      securityEvent(req, "warn", "login", "Login failed: invalid password", lockedFor > 0 ? { lockedFor } : {});
      return error(401, "Invalid password");
    }
    clearLoginFailures(req);
    securityEvent(req, "info", "login", "Login succeeded");
    return sessionResponse(req);
  },
  { auth: false },
);
