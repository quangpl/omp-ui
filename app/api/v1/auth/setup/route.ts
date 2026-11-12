import { isConfigured, MIN_PASSWORD_LENGTH, setPassword } from "@/lib/auth";
import { error, readJson, sessionResponse, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const POST = withApi(
  async ({ req }) => {
    if (await isConfigured()) return error(409, "Admin password is already configured");
    const { password } = await readJson<{ password?: unknown }>(req);
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      return error(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    await setPassword(password);
    return sessionResponse(req);
  },
  { auth: false },
);
