import { getChatAdapter } from "@/lib/server/chat/service";
import { error, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Telegram Bot API webhook; the adapter checks the secret-token header before dispatching. */
export const POST = withApi(
  async ({ req }) => {
    const adapter = getChatAdapter("telegram");
    if (!adapter) return error(404, "Telegram bot is not connected");
    return adapter.handleWebhook(req);
  },
  { auth: false },
);
