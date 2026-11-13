// Owns the running chat bots: connect / disconnect from Settings, status, and boot start.
import { randomBytes } from "node:crypto";
import type { AgentManager } from "@/lib/agent/types";
import { currentTokenEpoch } from "@/lib/auth";
import type { Repository } from "@/lib/db/types";
import { handleChatMessage } from "@/lib/server/chat/commands";
import { createDiscordAdapter, validateDiscordToken } from "@/lib/server/chat/discord";
import { startChatRelay } from "@/lib/server/chat/relay";
import {
  CHAT_TOKEN_FIELDS,
  activeUsers,
  loadChatState,
  readChatToken,
  setChatToken,
  updateChatState,
  type ChatState,
} from "@/lib/server/chat/store";
import { createTelegramAdapter, validateTelegramToken } from "@/lib/server/chat/telegram";
import {
  ChatTokenError,
  type ChatAdapter,
  type ChatAdapterOptions,
  type ChatBotInfo,
  type ChatEnv,
} from "@/lib/server/chat/types";
import { HttpError } from "@/lib/server/http";
import { getAppSettings } from "@/lib/settings";
import {
  CHAT_PLATFORMS,
  type AppSettings,
  type ChatConnectionState,
  type ChatPlatform,
  type ChatPlatformStatus,
  type ChatStatusResponse,
} from "@/lib/types";

/** Path of the Telegram webhook route; a webhook URL given as a base gets it appended. */
const TELEGRAM_WEBHOOK_PATH = "/api/v1/chat/telegram/webhook";
const MAX_TOKEN_LENGTH = 512;
const CONNECTED_TEXT = "AgentMan connected ✅ — just tell me what you want, e.g. \"show my boards\".";
const OWNER_TEXT = "AgentMan connected ✅ — send /login <admin password> here to take control.";

type DiscordAdapter = ChatAdapter & { sendDirect(userId: string, text: string): Promise<void> };
type TelegramWebhook = { url: string; secret: string } | null;

interface ChatRegistry {
  adapters: Map<ChatPlatform, ChatAdapter>;
  /** State of platforms without a running adapter (a failed boot start). */
  status: Map<ChatPlatform, { state: ChatConnectionState; error: string | null }>;
  /** Serializes boot, connect and disconnect. */
  queue: Promise<void>;
  booted?: boolean;
}

// Process-wide; on globalThis so running bots survive dev HMR reloads.
const g = globalThis as unknown as { __ompUiChat?: ChatRegistry };
const registry: ChatRegistry = (g.__ompUiChat ??= {
  adapters: new Map(),
  status: new Map(),
  queue: Promise.resolve(),
});

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = registry.queue.then(fn);
  registry.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The running bot for `platform` (webhook routes, relay, commands); null when not connected. */
export function getChatAdapter(platform: ChatPlatform): ChatAdapter | null {
  return registry.adapters.get(platform) ?? null;
}

/**
 * Connect body of POST /chat/<platform>/connect: a non-empty `token` (trimmed, ≤ 512 chars) and,
 * for Telegram, an optional `webhookUrl` (empty or null → long polling).
 */
export function parseConnectInput(
  body: Record<string, unknown>,
  platform: ChatPlatform,
): { token: string; webhookUrl: string | null } {
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token || token.length > MAX_TOKEN_LENGTH) throw new HttpError(400, "Paste the bot token");
  const webhookUrl = body.webhookUrl;
  if (webhookUrl !== undefined && webhookUrl !== null && typeof webhookUrl !== "string") {
    throw new HttpError(400, "webhookUrl must be a string");
  }
  return { token, webhookUrl: platform === "telegram" && webhookUrl ? webhookUrl : null };
}

/** An https URL of the webhook route: the full route URL, or a base URL (origin or path prefix) it is appended to. */
function normalizeWebhookUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new HttpError(400, "Webhook URL must be a full https:// URL");
  }
  if (url.protocol !== "https:") throw new HttpError(400, "Webhook URL must use https:// (Telegram requires it)");
  url.search = "";
  url.hash = "";
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = base.endsWith(TELEGRAM_WEBHOOK_PATH) ? base : `${base}${TELEGRAM_WEBHOOK_PATH}`;
  return url.toString();
}

/** Ask the platform whose token it is; throws ChatTokenError (a clear reason) when it rejects it. */
function checkToken(platform: ChatPlatform, token: string): Promise<ChatBotInfo> {
  return platform === "telegram" ? validateTelegramToken(token) : validateDiscordToken(token);
}

/** Create, register and start the adapter; on failure it is unregistered and the error recorded, then rethrown. */
async function launch(
  env: ChatEnv,
  platform: ChatPlatform,
  token: string,
  bot: ChatBotInfo,
  webhook: TelegramWebhook,
): Promise<ChatAdapter> {
  startChatRelay(env);
  const options: ChatAdapterOptions = {
    token,
    bot,
    onMessage: (msg) => handleChatMessage(env, msg),
    onStateChange: (state, error) => {
      // The registered adapter's state() is authoritative; a replaced or stopped one is ignored.
      if (registry.adapters.get(platform) !== adapter) return;
      if (state === "error" && error) console.error(`[chat] ${platform}: ${error}`);
    },
  };
  const adapter: ChatAdapter =
    platform === "telegram" ? createTelegramAdapter({ ...options, webhook }) : createDiscordAdapter(options);
  // Registered before start() so webhook updates arriving during setup reach it.
  registry.adapters.set(platform, adapter);
  registry.status.delete(platform);
  try {
    await adapter.start();
  } catch (err) {
    if (registry.adapters.get(platform) === adapter) registry.adapters.delete(platform);
    registry.status.set(platform, { state: "error", error: errorMessage(err) });
    await adapter.stop().catch(() => undefined);
    throw err;
  }
  return adapter;
}

/** Stop and unregister the platform's adapter (unregistered first, so its last state changes are ignored). */
async function stopAdapter(platform: ChatPlatform): Promise<void> {
  const adapter = registry.adapters.get(platform);
  registry.status.delete(platform);
  if (!adapter) return;
  registry.adapters.delete(platform);
  await adapter.stop().catch((err: unknown) => {
    console.error(`[chat] ${platform}: stopping the bot failed:`, errorMessage(err));
  });
}

function hasSendDirect(adapter: ChatAdapter): adapter is DiscordAdapter {
  return typeof (adapter as Partial<DiscordAdapter>).sendDirect === "function";
}

/** Tell logged-in users (their last chat) and, on Discord, the app owner that the bot is up. Never throws. */
async function announce(repo: Repository, platform: ChatPlatform, adapter: ChatAdapter): Promise<void> {
  const [state, epoch] = await Promise.all([loadChatState(repo), currentTokenEpoch()]);
  const users = activeUsers(state, platform, epoch);
  for (const chatId of new Set(users.map((u) => u.chatId))) {
    await adapter.send(chatId, CONNECTED_TEXT).catch((err: unknown) => {
      console.error(`[chat] ${platform}: cannot notify chat ${chatId}:`, errorMessage(err));
    });
  }
  const ownerId = adapter.bot.ownerId;
  if (ownerId && hasSendDirect(adapter) && !users.some((u) => u.userId === ownerId)) {
    await adapter.sendDirect(ownerId, OWNER_TEXT).catch((err: unknown) => {
      console.error(`[chat] ${platform}: cannot message the bot owner:`, errorMessage(err));
    });
  }
}

function platformStatus(
  settings: AppSettings,
  state: ChatState,
  epoch: number,
  platform: ChatPlatform,
): ChatPlatformStatus {
  const token = readChatToken(settings, platform);
  const adapter = registry.adapters.get(platform);
  const live: { state: ChatConnectionState; error: string | null } = adapter?.state() ??
    registry.status.get(platform) ?? { state: "disconnected", error: null };
  const bot = state.bots[platform];
  return {
    platform,
    configured: !!settings[CHAT_TOKEN_FIELDS[platform]],
    state: live.state,
    error: live.error,
    bot: bot ? { id: bot.id, name: bot.name, username: bot.username } : null,
    botUrl: bot?.url ?? null,
    mode: adapter?.mode ?? null,
    webhookUrl: platform === "telegram" ? state.telegram.webhookUrl : null,
    tokenHint: token ? token.slice(-4) : null,
    authorizedUsers: activeUsers(state, platform, epoch).length,
  };
}

export async function getChatStatus(repo: Repository): Promise<ChatStatusResponse> {
  const [settings, state, epoch] = await Promise.all([getAppSettings(repo), loadChatState(repo), currentTokenEpoch()]);
  return {
    telegram: platformStatus(settings, state, epoch, "telegram"),
    discord: platformStatus(settings, state, epoch, "discord"),
  };
}

/**
 * Validate the token (400 with the platform's reason when rejected), replace any running bot,
 * store the sealed token + bot account, start the bot and announce it to logged-in users.
 * Telegram: a `webhookUrl` selects webhook mode (new random secret), otherwise long polling.
 */
export async function connectChat(
  env: ChatEnv,
  platform: ChatPlatform,
  input: { token: string; webhookUrl?: string | null },
): Promise<ChatPlatformStatus> {
  const token = input.token.trim();
  const rawWebhookUrl = input.webhookUrl?.trim();
  const webhookUrl = platform === "telegram" && rawWebhookUrl ? normalizeWebhookUrl(rawWebhookUrl) : null;
  return serialized(async () => {
    let adapter: ChatAdapter;
    try {
      const bot = await checkToken(platform, token);
      await stopAdapter(platform);
      await setChatToken(env.repo, platform, token);
      const webhook: TelegramWebhook = webhookUrl ? { url: webhookUrl, secret: randomBytes(24).toString("hex") } : null;
      await updateChatState(env.repo, (state) => {
        state.bots[platform] = bot;
        if (platform === "telegram") {
          state.telegram = { webhookUrl: webhook?.url ?? null, webhookSecret: webhook?.secret ?? null };
        }
      });
      adapter = await launch(env, platform, token, bot, webhook);
    } catch (err) {
      if (err instanceof ChatTokenError) throw new HttpError(400, err.message);
      throw err;
    }
    void announce(env.repo, platform, adapter).catch((err: unknown) => {
      console.error(`[chat] ${platform}: announcing the connection failed:`, errorMessage(err));
    });
    return (await getChatStatus(env.repo))[platform];
  });
}

/** Stop the bot and forget its token and account; logged-in users stay authorized for a reconnect. */
export function disconnectChat(env: ChatEnv, platform: ChatPlatform): Promise<ChatPlatformStatus> {
  return serialized(async () => {
    await stopAdapter(platform);
    await setChatToken(env.repo, platform, null);
    await updateChatState(env.repo, (state) => {
      delete state.bots[platform];
      if (platform === "telegram") state.telegram = { webhookUrl: null, webhookSecret: null };
    });
    return (await getChatStatus(env.repo))[platform];
  });
}

/** Boot start of one stored bot; never throws (failures end up in its status). */
async function bootPlatform(env: ChatEnv, platform: ChatPlatform): Promise<void> {
  try {
    const settings = await getAppSettings(env.repo);
    // Connected or disconnected from Settings while boot was queued.
    if (registry.adapters.has(platform) || !settings[CHAT_TOKEN_FIELDS[platform]]) return;
    const token = readChatToken(settings, platform);
    if (!token) {
      registry.status.set(platform, {
        state: "error",
        error: "The stored bot token cannot be decrypted (was the credentials key changed?). Paste it again.",
      });
      return;
    }
    const state = await loadChatState(env.repo);
    let bot = state.bots[platform];
    if (!bot) {
      const checked = await checkToken(platform, token);
      await updateChatState(env.repo, (s) => {
        s.bots[platform] = checked;
      });
      bot = checked;
    }
    const { webhookUrl, webhookSecret } = state.telegram;
    const webhook: TelegramWebhook =
      platform === "telegram" && webhookUrl && webhookSecret ? { url: webhookUrl, secret: webhookSecret } : null;
    await launch(env, platform, token, bot, webhook);
  } catch (err) {
    console.error(`[chat] ${platform}: starting the bot failed:`, errorMessage(err));
    registry.status.set(platform, { state: "error", error: errorMessage(err) });
  }
}

/**
 * Start the bots of stored tokens, once per process (called when the agent manager boots).
 * Costs one settings read when no token is stored; never throws.
 */
export function startChatIntegrations(repo: Repository, manager: AgentManager): void {
  if (registry.booted) return;
  registry.booted = true;
  const env: ChatEnv = { repo, manager };
  void getAppSettings(repo)
    .then((settings) => {
      for (const platform of CHAT_PLATFORMS) {
        if (settings[CHAT_TOKEN_FIELDS[platform]]) void serialized(() => bootPlatform(env, platform));
      }
    })
    .catch((err: unknown) => {
      console.error("[chat] startup failed:", errorMessage(err));
    });
}
