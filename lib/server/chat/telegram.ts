// Telegram Bot API adapter: long polling (default) or webhook, plain-text messages.
// The bot token is part of every request URL; it never appears in thrown messages or logs.
import { timingSafeEqual } from "node:crypto";
import type { ChatConnectionState } from "@/lib/types";
import { CHAT_COMMANDS } from "./commands";
import {
  type ChatAdapter,
  type ChatBotInfo,
  ChatTokenError,
  type IncomingChatMessage,
  type TelegramAdapterOptions,
} from "./types";

const API_BASE = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 4096;
/** Per-request deadline for ordinary calls. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Long-poll wait Telegram holds getUpdates open for (seconds), plus a margin for the request deadline. */
const POLL_TIMEOUT_S = 50;
const POLL_REQUEST_TIMEOUT_MS = (POLL_TIMEOUT_S + 15) * 1000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const TOKEN_FORMAT = /^\d+:[A-Za-z0-9_-]{30,}$/;
const ALLOWED_UPDATES = ["message"];

const BAD_FORMAT_MESSAGE =
  "That doesn't look like a Telegram bot token (expected 123456789:ABC…). Copy it from @BotFather.";
const REJECTED_MESSAGE = "Telegram rejected this token — check it with @BotFather (/token).";

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/** Telegram answered `ok: false`; `message` is its description (token scrubbed). */
class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

/** The request never got an answer (DNS, TLS, timeout…); `message` is the reason. */
class TelegramNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramNetworkError";
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function scrub(text: string, token: string): string {
  return token ? text.split(token).join("***") : text;
}

/** Resolves after `ms`, or early when `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    resolve();
    return promise;
  }
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
  return promise;
}

function networkReason(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") return "request timed out";
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  if (cause instanceof Error && cause.message) return cause.message;
  return describe(err);
}

/**
 * POST a Bot API method. Throws TelegramApiError on `ok: false` (after waiting out one 429
 * `retry_after`), TelegramNetworkError when Telegram is unreachable, and rethrows the abort
 * error when `signal` aborts.
 */
async function callTelegram<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
  retried = false,
): Promise<T> {
  const { signal, timeoutMs = REQUEST_TIMEOUT_MS } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new TelegramNetworkError(scrub(networkReason(err), token));
  }
  let data: TelegramResponse<T> | null = null;
  try {
    data = (await res.json()) as TelegramResponse<T>;
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  if (data?.ok) return data.result as T;
  const status = data?.error_code ?? res.status;
  const retryAfter = data?.parameters?.retry_after;
  if (status === 429 && typeof retryAfter === "number" && !retried) {
    await sleep(retryAfter * 1000, signal);
    signal?.throwIfAborted();
    return callTelegram<T>(token, method, body, options, true);
  }
  throw new TelegramApiError(scrub(data?.description ?? `HTTP ${res.status}`, token), status);
}

/** Map a failed call while checking a token / starting into the message shown in Settings. */
function toTokenError(err: unknown): ChatTokenError {
  if (err instanceof ChatTokenError) return err;
  if (err instanceof TelegramApiError && (err.status === 401 || err.status === 404)) {
    return new ChatTokenError(REJECTED_MESSAGE);
  }
  if (err instanceof TelegramNetworkError) return new ChatTokenError(`Could not reach Telegram: ${err.message}`);
  return new ChatTokenError(`Telegram error: ${describe(err)}`);
}

/** Check a bot token with `getMe`; throws ChatTokenError with a user-facing message. */
export async function validateTelegramToken(token: string): Promise<ChatBotInfo> {
  if (!TOKEN_FORMAT.test(token)) throw new ChatTokenError(BAD_FORMAT_MESSAGE);
  let me: TelegramUser;
  try {
    me = await callTelegram<TelegramUser>(token, "getMe", {});
  } catch (err) {
    throw toTokenError(err);
  }
  const username = me.username ?? null;
  return {
    id: String(me.id),
    name: me.first_name,
    username,
    url: username ? `https://t.me/${username}` : null,
  };
}

/** Split into chunks of at most `max` UTF-16 units, preferring line, then word boundaries. */
function splitText(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    // Never split a surrogate pair.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/, "");
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max - 1;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

function safeEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Bot connection for a validated token: long polling, or a webhook when `options.webhook` is set. */
export function createTelegramAdapter(options: TelegramAdapterOptions): ChatAdapter {
  const { token, bot, onMessage, onStateChange, webhook } = options;
  const botUsername = bot.username?.toLowerCase() ?? null;

  let state: ChatConnectionState = "disconnected";
  let lastError: string | null = null;
  let running = false;
  let controller: AbortController | null = null;
  let loop: Promise<void> | null = null;
  /** Next update id to ask for (polling) / lowest id not yet seen (webhook duplicate guard). */
  let offset = 0;
  /** Per-chat tail of the handler chain, so one chat's updates run in order. */
  const chains = new Map<string, Promise<void>>();

  const api = <T>(method: string, body: Record<string, unknown>, opts?: { signal?: AbortSignal; timeoutMs?: number }) =>
    callTelegram<T>(token, method, body, opts);

  /** State change after start(): reported to service.ts (errors logged once per change). */
  function setState(next: ChatConnectionState, error: string | null): void {
    if (state === next && lastError === error) return;
    state = next;
    lastError = error;
    if (next === "error") console.error(`[chat] telegram polling failed: ${error}`);
    onStateChange(next, error);
  }

  async function send(chatId: string, text: string): Promise<string | null> {
    let last: string | null = null;
    for (const part of splitText(text, MAX_MESSAGE_LENGTH)) {
      const sent = await api<TelegramMessage>("sendMessage", {
        chat_id: chatId,
        text: part,
        link_preview_options: { is_disabled: true },
      });
      last = String(sent.message_id);
    }
    return last;
  }

  /** Update → message for the handler; null for anything the bot ignores. */
  function toIncoming(update: TelegramUpdate): IncomingChatMessage | null {
    const message = update.message;
    if (!message || typeof message.text !== "string" || !message.from || message.from.is_bot) return null;
    const chatId = String(message.chat.id);
    const isPrivate = message.chat.type === "private";
    let text = message.text;
    const addressed = /^\/([A-Za-z0-9_]+)@([A-Za-z0-9_]+)(?=\s|$)/.exec(text);
    if (addressed) {
      if (!isPrivate && addressed[2].toLowerCase() !== botUsername) return null;
      text = `/${addressed[1]}${text.slice(addressed[0].length)}`;
    }
    return {
      platform: "telegram",
      chatId,
      userId: String(message.from.id),
      userName: message.from.username ?? message.from.first_name,
      text,
      messageId: String(message.message_id),
      isPrivate,
      reply: async (replyText) => {
        try {
          await send(chatId, replyText);
        } catch (err) {
          console.error(`[chat] telegram reply failed: ${describe(err)}`);
        }
      },
    };
  }

  /** Run the handler without blocking the receive path, in order per chat. */
  function dispatch(message: IncomingChatMessage): void {
    const previous = chains.get(message.chatId) ?? Promise.resolve();
    const next = previous
      .then(() => onMessage(message))
      .catch((err) => console.error(`[chat] telegram command failed: ${describe(err)}`));
    chains.set(message.chatId, next);
    void next.then(() => {
      if (chains.get(message.chatId) === next) chains.delete(message.chatId);
    });
  }

  function ingest(updates: TelegramUpdate[]): void {
    for (const update of updates) {
      if (typeof update?.update_id !== "number" || update.update_id < offset) continue;
      offset = update.update_id + 1;
      const message = toIncoming(update);
      if (message) dispatch(message);
    }
  }

  async function pollLoop(signal: AbortSignal): Promise<void> {
    let backoff = BACKOFF_MIN_MS;
    while (!signal.aborted) {
      try {
        const updates = await api<TelegramUpdate[]>(
          "getUpdates",
          { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ALLOWED_UPDATES },
          { signal, timeoutMs: POLL_REQUEST_TIMEOUT_MS },
        );
        backoff = BACKOFF_MIN_MS;
        setState("connected", null);
        ingest(updates);
      } catch (err) {
        if (signal.aborted) return;
        const reason =
          err instanceof TelegramApiError && (err.status === 401 || err.status === 404)
            ? REJECTED_MESSAGE
            : err instanceof TelegramNetworkError
              ? `Could not reach Telegram: ${err.message}`
              : describe(err);
        setState("error", reason);
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
  }

  function registerCommands(): void {
    const commands = CHAT_COMMANDS.map((c) => ({ command: c.name, description: truncate(c.description, 256) }));
    api("setMyCommands", { commands }).catch((err) =>
      console.error(`[chat] telegram setMyCommands failed: ${describe(err)}`),
    );
  }

  return {
    platform: "telegram",
    maxMessageLength: MAX_MESSAGE_LENGTH,
    bot,
    mode: webhook ? "webhook" : "polling",

    send,

    async edit(chatId, messageId, text) {
      try {
        await api("editMessageText", {
          chat_id: chatId,
          message_id: Number(messageId),
          text: truncate(text, MAX_MESSAGE_LENGTH),
          link_preview_options: { is_disabled: true },
        });
      } catch (err) {
        if (err instanceof TelegramApiError && err.message.includes("message is not modified")) return;
        throw err;
      }
    },

    async deleteMessage(chatId, messageId) {
      try {
        await api("deleteMessage", { chat_id: chatId, message_id: Number(messageId) });
      } catch {
        // Best effort: no rights to delete, or the message is already gone.
      }
    },

    async start() {
      if (running) return;
      running = true;
      const ctrl = new AbortController();
      controller = ctrl;
      state = "connecting";
      lastError = null;
      try {
        if (webhook) {
          try {
            await api("setWebhook", {
              url: webhook.url,
              secret_token: webhook.secret,
              allowed_updates: ALLOWED_UPDATES,
            });
          } catch (err) {
            if (err instanceof TelegramApiError && err.status !== 401 && err.status !== 404) {
              throw new ChatTokenError(`Telegram rejected the webhook URL: ${err.message}`);
            }
            throw err;
          }
        } else {
          await api("deleteWebhook", { drop_pending_updates: false }, { signal: ctrl.signal });
          const pending = await api<TelegramUpdate[]>(
            "getUpdates",
            { offset, timeout: 0, allowed_updates: ALLOWED_UPDATES },
            { signal: ctrl.signal },
          );
          ingest(pending);
        }
      } catch (err) {
        const tokenError = toTokenError(err);
        if (controller === ctrl) {
          running = false;
          controller = null;
          state = "error";
          lastError = tokenError.message;
        }
        throw tokenError;
      }
      // stop() ran while starting.
      if (controller !== ctrl) return;
      state = "connected";
      registerCommands();
      if (!webhook) loop = pollLoop(ctrl.signal);
    },

    async stop() {
      if (!running) return;
      running = false;
      controller?.abort();
      controller = null;
      const current = loop;
      loop = null;
      await current?.catch(() => {});
      if (webhook) {
        await api("deleteWebhook", { drop_pending_updates: false }).catch((err) =>
          console.error(`[chat] telegram deleteWebhook failed: ${describe(err)}`),
        );
      }
      state = "disconnected";
      lastError = null;
    },

    state() {
      return { state, error: lastError };
    },

    async handleWebhook(req) {
      if (!webhook) return jsonResponse({ error: "Telegram bot uses long polling" }, 409);
      if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
      const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (!safeEqual(secret, webhook.secret)) return jsonResponse({ error: "Unauthorized" }, 401);
      if (!running) return jsonResponse({ error: "Telegram bot is not running" }, 503);
      let update: unknown;
      try {
        update = await req.json();
      } catch {
        return jsonResponse({ error: "Invalid JSON" }, 400);
      }
      if (update && typeof update === "object") ingest([update as TelegramUpdate]);
      return jsonResponse({});
    },
  };
}
