import {
  clearLoginFailures,
  isConfigured,
  loginRetryAfter,
  recordLoginFailure,
  verifyPassword,
} from "@/lib/auth";
import { error, json, readJson, sessionResponse, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const POST = withApi(
  async ({ req }) => {
    const retryAfter = loginRetryAfter(req);
    if (retryAfter > 0) {
      return json(
        { error: "Too many failed login attempts. Try again later." },
        { status: 429, headers: { "retry-after": String(retryAfter) } },
      );
    }
    if (!(await isConfigured())) return error(409, "Admin password is not set up yet");
    const { password } = await readJson<{ password?: unknown }>(req);
    if (typeof password !== "string" || !password || !(await verifyPassword(password))) {
      recordLoginFailure(req);
      return error(401, "Invalid password");
    }
    clearLoginFailures(req);
    return sessionResponse(req);
  },
  { auth: false },
);
