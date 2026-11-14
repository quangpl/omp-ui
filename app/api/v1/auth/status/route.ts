import { isConfigured } from "@/lib/auth";
import { json, withApi } from "@/lib/server/http";
import type { AuthStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

/** `user` comes from withApi (getRequestUser): null without a valid token. */
export const GET = withApi(
  async ({ user }) => {
    const status: AuthStatus = { configured: await isConfigured(), authenticated: user !== null, user };
    return json(status);
  },
  { auth: false },
);
