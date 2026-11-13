// Server-only contract between the chat integration pieces:
// - platform adapters (telegram.ts, discord.ts) talk to the chat app's API;
// - commands.ts parses and runs `/create`, `/boards`, … (identical on every platform);
// - relay.ts streams agent output of watched cards back to chats;
// - service.ts owns the running adapters (connect, disconnect, status, boot);
// - store.ts persists sealed tokens and chat state.
import type { AgentManager } from "@/lib/agent/types";
import type { Repository } from "@/lib/db/types";
import type { ChatConnectionState, ChatPlatform } from "@/lib/types";

/** Bot account behind a validated token. */
export interface ChatBotInfo {
  id: string;
  name: string;
  username: string | null;
  /** Telegram: https://t.me/<username>; Discord: OAuth2 invite URL (bot + applications.commands scopes). */
  url: string | null;
  /** Discord only: application id (for slash commands and interaction follow-ups). */
  applicationId?: string;
  /** Discord only: hex Ed25519 public key that signs interaction webhooks. */
  publicKey?: string;
  /** Discord only: user id of the application owner (DMed "AgentMan connected" on connect). */
  ownerId?: string;
}

/** A token the platform rejected, or that could not be checked; `message` is shown to the user. */
export class ChatTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatTokenError";
  }
}

/** Sends to a chat. Plain text (no parse mode); callers keep text within `maxMessageLength`. */
export interface ChatTransport {
  readonly platform: ChatPlatform;
  /** Telegram 4096, Discord 2000. */
  readonly maxMessageLength: number;
  /** Post a message; resolves to its message id (null when the platform gave none). Throws on failure. */
  send(chatId: string, text: string): Promise<string | null>;
  /** Replace a message's text. Throws on failure ("message is not modified" is not a failure). */
  edit(chatId: string, messageId: string, text: string): Promise<void>;
  /** Best effort; never throws (e.g. no permission to delete a user's message). */
  deleteMessage(chatId: string, messageId: string): Promise<void>;
}

/** A message (or Discord slash command, rewritten as `/name args`) the bot received. */
export interface IncomingChatMessage {
  platform: ChatPlatform;
  /** Where replies and streamed output go: Telegram chat id, Discord channel id (DM or server). */
  chatId: string;
  /** Who sent it: Telegram user id, Discord user id. Authorization is per user. */
  userId: string;
  userName: string;
  /** Raw text, e.g. "/create Fix login" (a leading bot mention / `@botname` suffix already removed). */
  text: string;
  /** Platform message id (to delete a `/login <password>` message); null for slash commands. */
  messageId: string | null;
  /** Direct message / private chat. */
  isPrivate: boolean;
  /**
   * Answer this message: a normal message in the chat, or the interaction response for a Discord
   * slash command (`ephemeral`: only the sender sees it; ignored elsewhere). Long text is split
   * by the adapter. Never throws (failures are logged).
   */
  reply(text: string, options?: { ephemeral?: boolean }): Promise<void>;
}

export type ChatMessageHandler = (message: IncomingChatMessage) => Promise<void>;

/** A running bot connection for one platform (created by service.ts with a validated token). */
export interface ChatAdapter extends ChatTransport {
  readonly bot: ChatBotInfo;
  readonly mode: "polling" | "webhook" | "gateway";
  /** Start receiving updates; resolves once the first connection succeeded, throws ChatTokenError if it cannot. */
  start(): Promise<void>;
  /** Stop receiving and close connections; idempotent. */
  stop(): Promise<void>;
  state(): { state: ChatConnectionState; error: string | null };
  /** Webhook route body (`/api/v1/chat/<platform>/webhook`): verifies the request, then dispatches. */
  handleWebhook(req: Request): Promise<Response>;
}

/** What adapters get from service.ts. */
export interface ChatAdapterOptions {
  token: string;
  bot: ChatBotInfo;
  /** Called for every received message; the adapter must not await it on its receive loop's critical path longer than needed. */
  onMessage: ChatMessageHandler;
  /** Connection state changes (reconnecting, errors) after start(). */
  onStateChange: (state: ChatConnectionState, error: string | null) => void;
}

export interface TelegramAdapterOptions extends ChatAdapterOptions {
  /** Webhook mode: public URL Telegram posts to + secret for X-Telegram-Bot-Api-Secret-Token. Null → long polling. */
  webhook: { url: string; secret: string } | null;
}

/** Server handles commands and the relay use. */
export interface ChatEnv {
  repo: Repository;
  manager: AgentManager;
}
