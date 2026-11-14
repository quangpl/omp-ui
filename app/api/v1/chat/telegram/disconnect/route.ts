import { disconnectChat } from "@/lib/server/chat/service";
import { auditFailures, json, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Stop the Telegram bot and forget its token; answers ChatPlatformStatus. */
export const POST = withApi(async ({ req, repo, manager }) =>
  auditFailures(req, "chat", "Telegram bot disconnect failed", async () => {
    const status = await disconnectChat({ repo, manager }, "telegram");
    securityEvent(req, "info", "chat", "Telegram bot disconnected");
    return json(status);
  }),
  { admin: true },
);
