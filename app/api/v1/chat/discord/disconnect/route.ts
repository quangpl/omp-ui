import { disconnectChat } from "@/lib/server/chat/service";
import { auditFailures, json, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Stop the Discord bot and forget its token; answers ChatPlatformStatus. */
export const POST = withApi(async ({ req, repo, manager }) =>
  auditFailures(req, "chat", "Discord bot disconnect failed", async () => {
    const status = await disconnectChat({ repo, manager }, "discord");
    securityEvent(req, "info", "chat", "Discord bot disconnected");
    return json(status);
  }),
  { admin: true },
);
