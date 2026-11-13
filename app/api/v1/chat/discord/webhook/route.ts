import { getChatAdapter } from "@/lib/server/chat/service";
import { error, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Discord Interactions Endpoint URL: Ed25519-signed by Discord, so no admin auth. */
export const POST = withApi(
  async ({ req }) => {
    const adapter = getChatAdapter("discord");
    if (!adapter) return error(404, "Discord bot is not connected");
    return adapter.handleWebhook(req);
  },
  { auth: false },
);
