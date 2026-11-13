import { connectChat, parseConnectInput } from "@/lib/server/chat/service";
import { auditFailures, json, readJson, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Validate and store the Telegram bot token, then start the bot; answers ChatPlatformStatus. */
export const POST = withApi(async ({ req, repo, manager }) =>
  auditFailures(req, "chat", "Telegram bot connect failed", async () => {
    const status = await connectChat({ repo, manager }, "telegram", parseConnectInput(await readJson(req), "telegram"));
    securityEvent(req, "info", "chat", "Telegram bot connected", { bot: status.bot?.username ?? status.bot?.name ?? null });
    return json(status);
  }),
);
