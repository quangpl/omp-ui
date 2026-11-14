import { createFirstAdmin, DEFAULT_ADMIN_USERNAME, isConfigured, MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { error, HttpError, readJson, securityEvent, sessionResponse, withApi } from "@/lib/server/http";
import { parseEmail, parseUsername } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/** First-run setup: create the first admin account (only while no user exists) and sign it in. */
export const POST = withApi(
  async ({ req }) => {
    if (await isConfigured()) {
      securityEvent(req, "warn", "password", "Setup rejected: setup is already complete");
      return error(409, "Setup is already complete");
    }
    const body = await readJson<{ username?: unknown; email?: unknown; password?: unknown }>(req);
    let username: string;
    let email: string | null;
    try {
      username =
        body.username === undefined || body.username === null ? DEFAULT_ADMIN_USERNAME : parseUsername(body.username);
      email = parseEmail(body.email);
    } catch (err) {
      if (err instanceof HttpError) securityEvent(req, "warn", "password", `Setup rejected: ${err.message}`);
      throw err;
    }
    const { password } = body;
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      securityEvent(req, "warn", "password", "Setup rejected: password too short");
      return error(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const user = await createFirstAdmin({ username, email, password });
    // sessionResponse remembers the new user, so this event already names them.
    const response = await sessionResponse(req, user);
    securityEvent(req, "info", "password", "Setup completed: admin account created");
    return response;
  },
  { auth: false },
);
