import { isAuthenticated, isConfigured } from "@/lib/auth";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const GET = withApi(
  async ({ req }) => {
    const [configured, authenticated] = await Promise.all([isConfigured(), isAuthenticated(req)]);
    return json({ configured, authenticated });
  },
  { auth: false },
);
