import { connectChat, parseConnectInput } from "@/lib/server/chat/service";
import { auditFailures, json, readJson, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Validate and store the Discord bot token, then start the bot; answers ChatPlatformStatus. */
export const POST = withApi(async ({ req, repo, manager }) =>
  auditFailures(req, "chat", "Discord bot connect failed", async () => {
    const status = await connectChat({ repo, manager }, "discord", parseConnectInput(await readJson(req), "discord"));
    securityEvent(req, "info", "chat", "Discord bot connected", { bot: status.bot?.username ?? status.bot?.name ?? null });
    return json(status);
  }),
  { admin: true },
);
