// Persistence for the chat integrations: sealed bot tokens (in AppSettings) and chat state
// (authorized users, selected boards, Telegram webhook, bot accounts) under `chat_integrations`.
import { currentTokenEpoch } from "@/lib/auth";
import type { Repository } from "@/lib/db/types";
import type { ChatBotInfo } from "@/lib/server/chat/types";
import { openSecret, sealSecret } from "@/lib/server/credentials";
import { getAppSettings, updateAppSettings } from "@/lib/settings";
import { CHAT_PLATFORMS, type AppSettings, type ChatPlatform } from "@/lib/types";

const STATE_KEY = "chat_integrations";

/** AppSettings field holding each platform's sealed bot token. */
export const CHAT_TOKEN_FIELDS = {
  telegram: "telegramBotToken",
  discord: "discordBotToken",
} as const satisfies Record<ChatPlatform, keyof AppSettings>;

/** A chat user who unlocked control with the admin password. */
export interface ChatAuthorizedUser {
  platform: ChatPlatform;
  userId: string;
  userName: string;
  /** The chat the user last logged in from; "AgentMan connected" goes there. */
  chatId: string;
  /** Admin token epoch at login; a password change bumps it and so revokes the login. */
  epoch: number;
  authorizedAt: string;
}

export interface ChatState {
  authorized: ChatAuthorizedUser[];
  /** `${platform}:${chatId}` → board id `/create` adds cards to. */
  selectedBoards: Record<string, string>;
  /** Webhook mode when both are set; otherwise long polling. */
  telegram: { webhookUrl: string | null; webhookSecret: string | null };
  /** Bot accounts behind the stored tokens. */
  bots: Partial<Record<ChatPlatform, ChatBotInfo>>;
}

/** The decrypted bot token in `settings`; null when none or undecryptable. */
export function readChatToken(settings: AppSettings, platform: ChatPlatform): string | null {
  const sealed = settings[CHAT_TOKEN_FIELDS[platform]];
  return sealed ? openSecret(sealed, `chat:${platform}`) : null;
}

export async function getChatToken(repo: Repository, platform: ChatPlatform): Promise<string | null> {
  return readChatToken(await getAppSettings(repo), platform);
}

/** Store the token sealed (never plaintext in the database); null clears it. */
export async function setChatToken(repo: Repository, platform: ChatPlatform, token: string | null): Promise<void> {
  await updateAppSettings(repo, {
    [CHAT_TOKEN_FIELDS[platform]]: token ? sealSecret(token, `chat:${platform}`) : "",
  });
}

/** Stored JSON before validation: our own shape, but any field may be missing or malformed. */
type Unchecked<T> = { [K in keyof T]?: unknown };

function isPlatform(value: unknown): value is ChatPlatform {
  return (CHAT_PLATFORMS as readonly unknown[]).includes(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parseUser(value: unknown): ChatAuthorizedUser | null {
  if (typeof value !== "object" || value === null) return null;
  const { platform, userId, userName, chatId, epoch, authorizedAt } = value as Unchecked<ChatAuthorizedUser>;
  if (!isPlatform(platform) || typeof userId !== "string" || !userId) return null;
  if (typeof chatId !== "string" || typeof epoch !== "number") return null;
  return {
    platform,
    userId,
    userName: typeof userName === "string" ? userName : "",
    chatId,
    epoch,
    authorizedAt: typeof authorizedAt === "string" ? authorizedAt : "",
  };
}

function parseBot(value: unknown): ChatBotInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const fields = value as Unchecked<ChatBotInfo>;
  if (typeof fields.id !== "string" || typeof fields.name !== "string") return null;
  const bot: ChatBotInfo = {
    id: fields.id,
    name: fields.name,
    username: stringOrNull(fields.username),
    url: stringOrNull(fields.url),
  };
  for (const key of ["applicationId", "publicKey", "ownerId"] as const) {
    const field = fields[key];
    if (typeof field === "string" && field) bot[key] = field;
  }
  return bot;
}

/** Tolerant parse: anything malformed falls back to the defaults. */
function parseState(raw: string | null): ChatState {
  const state: ChatState = {
    authorized: [],
    selectedBoards: {},
    telegram: { webhookUrl: null, webhookSecret: null },
    bots: {},
  };
  if (!raw) return state;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return state;
  }
  if (typeof parsed !== "object" || parsed === null) return state;
  const data = parsed as Unchecked<ChatState>;
  if (Array.isArray(data.authorized)) {
    state.authorized = data.authorized.map(parseUser).filter((u): u is ChatAuthorizedUser => u !== null);
  }
  if (typeof data.selectedBoards === "object" && data.selectedBoards !== null) {
    for (const [key, boardId] of Object.entries(data.selectedBoards)) {
      if (typeof boardId === "string" && boardId) state.selectedBoards[key] = boardId;
    }
  }
  if (typeof data.telegram === "object" && data.telegram !== null) {
    const telegram = data.telegram as Unchecked<ChatState["telegram"]>;
    state.telegram = {
      webhookUrl: stringOrNull(telegram.webhookUrl),
      webhookSecret: stringOrNull(telegram.webhookSecret),
    };
  }
  if (typeof data.bots === "object" && data.bots !== null) {
    const bots = data.bots as Unchecked<Record<ChatPlatform, ChatBotInfo>>;
    for (const platform of CHAT_PLATFORMS) {
      const bot = parseBot(bots[platform]);
      if (bot) state.bots[platform] = bot;
    }
  }
  return state;
}

export async function loadChatState(repo: Repository): Promise<ChatState> {
  return parseState(await repo.getSetting(STATE_KEY));
}

// Serializes read-modify-write cycles; on globalThis to survive dev HMR reloads.
const g = globalThis as unknown as { __ompUiChatStateLock?: Promise<void> };

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = (g.__ompUiChatStateLock ?? Promise.resolve()).then(fn);
  g.__ompUiChatStateLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Locked load → `fn` edits the state in place → save (skipped when `fn` throws). */
export function updateChatState<T>(repo: Repository, fn: (state: ChatState) => T): Promise<T> {
  return withLock(async () => {
    const state = await loadChatState(repo);
    const result = fn(state);
    await repo.setSetting(STATE_KEY, JSON.stringify(state));
    return result;
  });
}

/** Logged-in users whose login is still valid (made under the current admin token epoch). */
export function activeUsers(state: ChatState, platform: ChatPlatform, epoch: number): ChatAuthorizedUser[] {
  return state.authorized.filter((u) => u.platform === platform && u.epoch === epoch);
}

/** Whether the user logged in with the admin password since it last changed. */
export async function isAuthorized(repo: Repository, platform: ChatPlatform, userId: string): Promise<boolean> {
  const [state, epoch] = await Promise.all([loadChatState(repo), currentTokenEpoch()]);
  return activeUsers(state, platform, epoch).some((u) => u.userId === userId);
}

/** Record (or refresh) a login: the user's last chat and the current epoch. */
export async function authorizeUser(
  repo: Repository,
  user: Omit<ChatAuthorizedUser, "epoch" | "authorizedAt">,
): Promise<void> {
  const epoch = await currentTokenEpoch();
  await updateChatState(repo, (state) => {
    state.authorized = state.authorized.filter((u) => !(u.platform === user.platform && u.userId === user.userId));
    state.authorized.push({ ...user, epoch, authorizedAt: new Date().toISOString() });
  });
}

export async function revokeUser(repo: Repository, platform: ChatPlatform, userId: string): Promise<void> {
  await updateChatState(repo, (state) => {
    state.authorized = state.authorized.filter((u) => !(u.platform === platform && u.userId === userId));
  });
}
