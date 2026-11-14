import {
  authenticate,
  clearLoginFailures,
  DEFAULT_ADMIN_USERNAME,
  isConfigured,
  loginRetryAfter,
  recordLoginFailure,
} from "@/lib/auth";
import { error, json, readJson, securityEvent, sessionResponse, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Attempted login names are client-controlled: bound what lands in the security log. */
const LOGGED_LOGIN_MAX = 100;

/** Sign in with a username or email; `username` omitted → "admin" (password-only clients/CLI). */
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
      securityEvent(req, "warn", "login", "Login attempted before setup");
      return error(409, "Setup is not complete yet");
    }
    const { username, password } = await readJson<{ username?: unknown; password?: unknown }>(req);
    const login = typeof username === "string" && username.trim() ? username : DEFAULT_ADMIN_USERNAME;
    const loggedLogin = login.trim().slice(0, LOGGED_LOGIN_MAX);
    const user = typeof password === "string" && password ? await authenticate(login, password) : null;
    if (!user) {
      recordLoginFailure(req);
      // Non-zero once this failure used up the allowed attempts: the client is now locked out.
      const lockedFor = loginRetryAfter(req);
      securityEvent(req, "warn", "login", "Login failed: invalid username or password", {
        login: loggedLogin,
        ...(lockedFor > 0 ? { lockedFor } : {}),
      });
      return error(401, "Invalid username or password");
    }
    clearLoginFailures(req);
    securityEvent(req, "info", "login", "Login succeeded", {
      login: loggedLogin,
      user: user.username,
      userId: user.id,
    });
    return sessionResponse(req, user);
  },
  { auth: false },
);
