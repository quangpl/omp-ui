import { getChatStatus } from "@/lib/server/chat/service";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Telegram and Discord bot connection state (Settings → Chat integrations). */
export const GET = withApi(async ({ repo }) => json(await getChatStatus(repo)));
