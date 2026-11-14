// Discord bot: REST (https://discord.com/api/v10) + gateway WebSocket, built on global fetch and
// WebSocket. Slash commands arrive over the gateway (or the Interactions Endpoint URL webhook when
// one is set in the developer portal); DMs and server messages that mention the bot or start with
// "/" are forwarded as plain text commands. The bot token never appears in errors or logs.
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { CHAT_COMMANDS } from "./commands";
import {
  ChatTokenError,
  type ChatAdapter,
  type ChatAdapterOptions,
  type ChatBotInfo,
  type IncomingChatMessage,
} from "./types";
import type { ChatConnectionState } from "@/lib/types";

const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com, 1.0) AgentMan";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_MESSAGE_LENGTH = 2000;
/** VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY. */
const INVITE_PERMISSIONS = 68608;
const EPHEMERAL = 64;

const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_DIRECT_MESSAGES = 1 << 12;
const INTENT_MESSAGE_CONTENT = 1 << 15;

const READY_TIMEOUT_MS = 15_000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

const TOKEN_REJECTED =
  "Discord rejected this token — reset it under Bot → Token in the Discord developer portal and paste the new one.";
const GATEWAY_TOKEN_REJECTED = "Discord rejected the token";
const MESSAGE_CONTENT_WARNING =
  "Message Content intent is off: in servers the bot only sees messages that mention it. Enable it under Bot → Privileged Gateway Intents, or use slash commands.";

/** A failed Discord REST call; `status` 0 = network failure. Never carries the token. */
class DiscordRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    readonly reason: string,
    label: string,
  ) {
    super(status ? `Discord ${label} failed (${status}): ${reason}` : `Discord ${label} failed: ${reason}`);
    this.name = "DiscordRequestError";
  }
}

interface RequestOptions {
  body?: unknown;
  /** Send `Authorization: Bot <token>` (interaction callbacks and webhooks need none). */
  auth?: boolean;
  /** Names the call in errors instead of the path (which may hold an interaction token). */
  label?: string;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Trimmed token without a pasted "Bot " prefix. */
function normalizeToken(token: string): string {
  return token.trim().replace(/^Bot\s+/i, "").trim();
}

/** REST call; on 429 waits `retry_after` and retries once. Resolves to the JSON body (undefined for 204). */
async function discordRequest<T>(
  token: string,
  method: string,
  path: string,
  options: RequestOptions = {},
  retried = false,
): Promise<T> {
  const label = options.label ?? `${method} ${path}`;
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (options.auth !== false) headers.Authorization = `Bot ${token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined;
    throw new DiscordRequestError(0, null, cause instanceof Error ? cause.message : describe(err), label);
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (res.status === 429 && !retried) {
    const retryAfter = data && typeof data === "object" && "retry_after" in data ? data.retry_after : null;
    const after = Number(retryAfter ?? res.headers.get("retry-after"));
    await sleep(Number.isFinite(after) && after > 0 ? Math.ceil(after * 1000) : 1000);
    return discordRequest<T>(token, method, path, options, true);
  }
  if (!res.ok) {
    const body = (data ?? {}) as { message?: unknown; code?: unknown };
    throw new DiscordRequestError(
      res.status,
      typeof body.code === "number" ? body.code : null,
      typeof body.message === "string" ? body.message : res.statusText || "request failed",
      label,
    );
  }
  return data as T;
}

/** Split text into chunks ≤ `max`, preferring line breaks. Discord rejects empty content. */
function splitText(text: string, max: number): string[] {
  if (!text.trim()) return ["\u200b"];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

interface DiscordApplication {
  id: string;
  verify_key: string;
  owner?: { id: string } | null;
  team?: { owner_user_id: string } | null;
}

/** Check a bot token and look up the bot user + its application (ids, public key, owner). */
export async function validateDiscordToken(token: string): Promise<ChatBotInfo> {
  const botToken = normalizeToken(token);
  if (!botToken) throw new ChatTokenError("Paste the bot token from Bot → Token in the Discord developer portal.");
  let me: DiscordUser;
  let app: DiscordApplication;
  try {
    me = await discordRequest<DiscordUser>(botToken, "GET", "/users/@me");
    if (!me.bot) throw new ChatTokenError("This is not a bot token — copy it from Bot → Token in the Discord developer portal.");
    app = await discordRequest<DiscordApplication>(botToken, "GET", "/oauth2/applications/@me");
  } catch (err) {
    if (err instanceof ChatTokenError) throw err;
    if (err instanceof DiscordRequestError) {
      if (err.status === 401) throw new ChatTokenError(TOKEN_REJECTED);
      if (err.status === 0) throw new ChatTokenError(`Could not reach Discord: ${err.reason}`);
      throw new ChatTokenError(`Discord answered ${err.status}: ${err.reason}`);
    }
    throw new ChatTokenError(`Could not reach Discord: ${describe(err)}`);
  }
  const ownerId = app.team?.owner_user_id ?? app.owner?.id;
  return {
    id: me.id,
    name: me.global_name ?? me.username,
    username: me.username,
    url: `https://discord.com/oauth2/authorize?client_id=${app.id}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}`,
    applicationId: app.id,
    publicKey: app.verify_key,
    ...(ownerId ? { ownerId } : {}),
  };
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content?: string;
  author?: DiscordUser;
}

interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  channel?: { id: string };
  member?: { user?: DiscordUser };
  user?: DiscordUser;
  data?: { name?: string; options?: { name: string; value?: unknown }[] };
}

interface GatewayPayload {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
}

/** Global slash commands mirroring CHAT_COMMANDS (one STRING option `value` when the command takes an argument). */
function slashCommands() {
  const clip = (text: string, fallback: string) => (text.trim() || fallback).slice(0, 100);
  return CHAT_COMMANDS.map((command) => {
    const args = command.args.trim();
    return {
      name: command.name,
      type: 1,
      description: clip(command.description, command.name),
      dm_permission: true,
      ...(args
        ? {
            options: [
              {
                type: 3,
                name: "value",
                description: clip(args.replace(/[<>[\]]/g, ""), "value"),
                // Required when any part is mandatory, e.g. `[username] <password>`.
                required: args.includes("<"),
              },
            ],
          }
        : {}),
    };
  });
}

/** Discord bot connection: gateway receive loop, REST sends, interaction replies. */
export function createDiscordAdapter(
  options: ChatAdapterOptions,
): ChatAdapter & { sendDirect(userId: string, text: string): Promise<void> } {
  const token = normalizeToken(options.token);
  const bot = options.bot;
  let botId = bot.id;

  let current: ChatConnectionState = "disconnected";
  let failure: string | null = null;
  let warning: string | null = null;

  let stopped = true;
  let ws: WebSocket | null = null;
  let gatewayUrl: string | null = null;
  let resumeUrl: string | null = null;
  let sessionId: string | null = null;
  let seq: number | null = null;
  let intents = INTENT_GUILDS | INTENT_GUILD_MESSAGES | INTENT_DIRECT_MESSAGES | INTENT_MESSAGE_CONTENT;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let heartbeatAcked = true;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let backoff = BACKOFF_MIN_MS;
  let ready: { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout } | null = null;
  let publicKey: KeyObject | null = null;

  /** Per-channel promise chains: messages of one channel are handled in order. */
  const chains = new Map<string, Promise<void>>();

  const request = <T>(method: string, path: string, opts?: RequestOptions) =>
    discordRequest<T>(token, method, path, opts);

  function snapshot(): { state: ChatConnectionState; error: string | null } {
    return { state: current, error: failure ?? warning };
  }

  function report(next: ChatConnectionState, error: string | null = null): void {
    const before = snapshot();
    current = next;
    failure = error;
    const after = snapshot();
    if (before.state !== after.state || before.error !== after.error) options.onStateChange(after.state, after.error);
  }

  function enqueue(chatId: string, job: () => Promise<void>): void {
    const next = (chains.get(chatId) ?? Promise.resolve())
      .then(job)
      .catch((err) => console.error("[chat] discord message handler failed:", describe(err)));
    chains.set(chatId, next);
    void next.then(() => {
      if (chains.get(chatId) === next) chains.delete(chatId);
    });
  }

  // ---- REST sends ----

  async function send(channelId: string, text: string): Promise<string | null> {
    let lastId: string | null = null;
    for (const content of splitText(text, MAX_MESSAGE_LENGTH)) {
      const message = await request<{ id: string }>("POST", `/channels/${channelId}/messages`, {
        body: { content, allowed_mentions: { parse: [] } },
        label: "send message",
      });
      lastId = message?.id ?? null;
    }
    return lastId;
  }

  async function edit(channelId: string, messageId: string, text: string): Promise<void> {
    await request("PATCH", `/channels/${channelId}/messages/${messageId}`, {
      body: { content: splitText(text, MAX_MESSAGE_LENGTH)[0], allowed_mentions: { parse: [] } },
      label: "edit message",
    });
  }

  async function deleteMessage(channelId: string, messageId: string): Promise<void> {
    try {
      await request("DELETE", `/channels/${channelId}/messages/${messageId}`, { label: "delete message" });
    } catch (err) {
      console.warn("[chat] discord delete message failed:", describe(err));
    }
  }

  async function sendDirect(userId: string, text: string): Promise<void> {
    const channel = await request<{ id: string }>("POST", "/users/@me/channels", {
      body: { recipient_id: userId },
      label: "open DM",
    });
    await send(channel.id, text);
  }

  // ---- incoming ----

  function handleMessageCreate(message: DiscordMessage): void {
    const author = message.author;
    if (!author || author.bot || !message.content) return;
    const isPrivate = !message.guild_id;
    const mention = new RegExp(`<@!?${botId}>`, "g");
    const mentioned = mention.test(message.content);
    const text = message.content.replace(mention, "").trim();
    if (!text) return;
    if (!isPrivate && !mentioned && !text.startsWith("/")) return;
    const incoming: IncomingChatMessage = {
      platform: "discord",
      chatId: message.channel_id,
      userId: author.id,
      userName: author.global_name ?? author.username,
      text,
      messageId: message.id,
      isPrivate,
      reply: async (replyText) => {
        try {
          await send(message.channel_id, replyText);
        } catch (err) {
          console.error("[chat] discord reply failed:", describe(err));
        }
      },
    };
    enqueue(incoming.chatId, () => options.onMessage(incoming));
  }

  /**
   * Run a slash command. `acknowledged`: the deferred response was already given (webhook mode
   * answers it in the HTTP response); otherwise it is sent to the callback endpoint first.
   */
  async function handleInteraction(interaction: DiscordInteraction, acknowledged: boolean): Promise<void> {
    const name = interaction.data?.name;
    const user = interaction.member?.user ?? interaction.user;
    const chatId = interaction.channel_id ?? interaction.channel?.id;
    if (interaction.type !== 2 || !name || !user || !chatId) return;
    const commandEphemeral = name === "login";
    if (!acknowledged) {
      try {
        await request("POST", `/interactions/${interaction.id}/${interaction.token}/callback`, {
          body: { type: 5, data: { flags: commandEphemeral ? EPHEMERAL : 0 } },
          auth: false,
          label: "interaction callback",
        });
      } catch (err) {
        console.error("[chat] discord interaction acknowledge failed:", describe(err));
        return;
      }
    }
    const webhookPath = `/webhooks/${interaction.application_id}/${interaction.token}`;
    let answered = false;
    let replies: Promise<void> = Promise.resolve();

    /** First reply fills the deferred response; in webhook mode it may not be registered yet (404 → retry). */
    async function patchOriginal(content: string): Promise<void> {
      for (let attempt = 0; ; attempt++) {
        try {
          await request("PATCH", `${webhookPath}/messages/@original`, {
            body: { content, allowed_mentions: { parse: [] } },
            auth: false,
            label: "interaction reply",
          });
          return;
        } catch (err) {
          if (!acknowledged || attempt >= 5 || !(err instanceof DiscordRequestError) || err.status !== 404) throw err;
          await sleep(300);
        }
      }
    }

    const reply = (text: string, replyOptions?: { ephemeral?: boolean }): Promise<void> => {
      const ephemeral = commandEphemeral || replyOptions?.ephemeral === true;
      const run = replies
        .then(async () => {
          for (const content of splitText(text, MAX_MESSAGE_LENGTH)) {
            if (!answered) {
              await patchOriginal(content);
              answered = true;
            } else {
              await request("POST", webhookPath, {
                body: { content, allowed_mentions: { parse: [] }, flags: ephemeral ? EPHEMERAL : 0 },
                auth: false,
                label: "interaction follow-up",
              });
            }
          }
        })
        .catch((err) => console.error("[chat] discord interaction reply failed:", describe(err)));
      replies = run;
      return run;
    };

    const value = interaction.data?.options?.find((option) => option.name === "value")?.value;
    const incoming: IncomingChatMessage = {
      platform: "discord",
      chatId,
      userId: user.id,
      userName: user.global_name ?? user.username,
      text: `/${name} ${value == null ? "" : String(value)}`.trim(),
      messageId: null,
      isPrivate: !interaction.guild_id,
      reply,
    };
    enqueue(chatId, async () => {
      try {
        await options.onMessage(incoming);
      } finally {
        await replies;
        // Never leave the "thinking…" placeholder behind when the command answered nothing.
        if (!answered) {
          await request("DELETE", `${webhookPath}/messages/@original`, {
            auth: false,
            label: "interaction cleanup",
          }).catch((err) => console.warn("[chat] discord interaction cleanup failed:", describe(err)));
        }
      }
    });
  }

  // ---- gateway ----

  function sendPayload(socket: WebSocket, op: number, d: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op, d }));
  }

  function identify(socket: WebSocket): void {
    sendPayload(socket, 2, {
      token,
      intents,
      properties: { os: process.platform, browser: "agentman", device: "agentman" },
    });
  }

  function resume(socket: WebSocket): void {
    sendPayload(socket, 6, { token, session_id: sessionId, seq });
  }

  function stopHeartbeat(): void {
    clearTimeout(heartbeatTimer ?? undefined);
    heartbeatTimer = null;
  }

  function startHeartbeat(socket: WebSocket, interval: number): void {
    stopHeartbeat();
    heartbeatAcked = true;
    const beat = () => {
      if (ws !== socket) return;
      if (!heartbeatAcked) {
        console.warn("[chat] discord gateway heartbeat not acknowledged; reconnecting");
        markConnecting();
        reconnect(true, 0);
        return;
      }
      heartbeatAcked = false;
      sendPayload(socket, 1, seq);
    };
    heartbeatTimer = setTimeout(() => {
      beat();
      if (ws === socket) heartbeatTimer = setInterval(beat, interval);
    }, Math.floor(interval * Math.random()));
  }

  function nextBackoff(): number {
    const delay = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    return delay;
  }

  function markConnecting(): void {
    if (current === "connected") report("connecting");
  }

  /** Drop the current socket (non-1000 close keeps the session resumable) and connect again after `delay`. */
  function reconnect(resumeSession: boolean, delay: number): void {
    stopHeartbeat();
    const socket = ws;
    ws = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(4000, "reconnect");
    clearTimeout(reconnectTimer ?? undefined);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!stopped) connect(resumeSession);
    }, delay);
  }

  function settleReady(error: Error | null): void {
    if (!ready) return;
    const { resolve, reject, timer } = ready;
    ready = null;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve();
  }

  /** Close for good after a fatal gateway error (bad token, invalid intents, …). */
  function fail(message: string): void {
    halt();
    report("error", message);
    settleReady(new ChatTokenError(message));
  }

  function halt(): void {
    stopped = true;
    stopHeartbeat();
    clearTimeout(reconnectTimer ?? undefined);
    reconnectTimer = null;
    const socket = ws;
    ws = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "stop");
  }

  function onDispatch(type: string | null | undefined, data: unknown): void {
    switch (type) {
      case "READY": {
        const readyData = data as { session_id: string; resume_gateway_url?: string; user?: { id: string } };
        sessionId = readyData.session_id;
        resumeUrl = readyData.resume_gateway_url ?? null;
        if (readyData.user?.id) botId = readyData.user.id;
        backoff = BACKOFF_MIN_MS;
        report("connected");
        settleReady(null);
        break;
      }
      case "RESUMED":
        backoff = BACKOFF_MIN_MS;
        report("connected");
        break;
      case "MESSAGE_CREATE":
        handleMessageCreate(data as DiscordMessage);
        break;
      case "INTERACTION_CREATE":
        void handleInteraction(data as DiscordInteraction, false).catch((err) =>
          console.error("[chat] discord interaction failed:", describe(err)),
        );
        break;
    }
  }

  function onPayload(socket: WebSocket, payload: GatewayPayload, resuming: boolean): void {
    if (typeof payload.s === "number") seq = payload.s;
    switch (payload.op) {
      case 0:
        onDispatch(payload.t, payload.d);
        break;
      case 1:
        sendPayload(socket, 1, seq);
        break;
      case 7:
        markConnecting();
        reconnect(true, 0);
        break;
      case 9: {
        const resumable = payload.d === true;
        if (!resumable) {
          sessionId = null;
          seq = null;
        }
        setTimeout(() => {
          if (ws !== socket) return;
          if (resumable && sessionId) resume(socket);
          else identify(socket);
        }, 1000 + Math.random() * 4000);
        break;
      }
      case 10: {
        const hello = payload.d;
        const interval =
          hello && typeof hello === "object" && "heartbeat_interval" in hello ? Number(hello.heartbeat_interval) : NaN;
        startHeartbeat(socket, Number.isFinite(interval) && interval > 0 ? interval : 41_250);
        if (resuming && sessionId) resume(socket);
        else identify(socket);
        break;
      }
      case 11:
        heartbeatAcked = true;
        break;
    }
  }

  function onClose(code: number, reason: string): void {
    stopHeartbeat();
    if (stopped) return;
    switch (code) {
      case 4004:
        fail(GATEWAY_TOKEN_REJECTED);
        return;
      case 4010:
      case 4011:
      case 4012:
      case 4013:
        fail(`Discord closed the gateway (${code}${reason ? `: ${reason}` : ""})`);
        return;
      case 4014:
        if (intents & INTENT_MESSAGE_CONTENT) {
          intents &= ~INTENT_MESSAGE_CONTENT;
          warning = MESSAGE_CONTENT_WARNING;
          sessionId = null;
          seq = null;
          report(current, failure);
          reconnect(false, 0);
        } else {
          fail(`Discord closed the gateway (${code}${reason ? `: ${reason}` : ""})`);
        }
        return;
      case 4007:
      case 4009:
        sessionId = null;
        seq = null;
        markConnecting();
        reconnect(false, nextBackoff());
        return;
      default:
        markConnecting();
        reconnect(true, nextBackoff());
    }
  }

  function connect(resumeSession: boolean): void {
    const base = ((resumeSession && sessionId && resumeUrl) || gatewayUrl || "wss://gateway.discord.gg").replace(/\/+$/, "");
    const resuming = resumeSession && !!sessionId;
    let socket: WebSocket;
    try {
      socket = new WebSocket(`${base}/?v=10&encoding=json`);
    } catch (err) {
      console.error("[chat] discord gateway connect failed:", describe(err));
      reconnect(resumeSession, nextBackoff());
      return;
    }
    ws = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      if (ws !== socket) return;
      let payload: GatewayPayload;
      try {
        const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
        payload = JSON.parse(raw) as GatewayPayload;
      } catch {
        return;
      }
      onPayload(socket, payload, resuming);
    });
    socket.addEventListener("close", (event) => {
      if (ws !== socket) return;
      ws = null;
      onClose(event.code, event.reason);
    });
    // An "error" event is always followed by "close", which handles reconnecting.
    socket.addEventListener("error", () => {});
  }

  async function registerCommands(): Promise<void> {
    if (!bot.applicationId) {
      console.warn("[chat] discord slash commands not registered: application id unknown");
      return;
    }
    try {
      await request("PUT", `/applications/${bot.applicationId}/commands`, {
        body: slashCommands(),
        label: "register slash commands",
      });
    } catch (err) {
      console.error("[chat] discord slash command registration failed:", describe(err));
    }
  }

  function publicKeyObject(): KeyObject | null {
    if (publicKey) return publicKey;
    if (!bot.publicKey || !/^[0-9a-f]{64}$/i.test(bot.publicKey)) return null;
    publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(bot.publicKey, "hex").toString("base64url") },
      format: "jwk",
    });
    return publicKey;
  }

  function verifySignature(req: Request, body: string): boolean {
    const signature = req.headers.get("x-signature-ed25519");
    const timestamp = req.headers.get("x-signature-timestamp");
    if (!signature || !timestamp || !/^[0-9a-f]{128}$/i.test(signature)) return false;
    try {
      const key = publicKeyObject();
      return !!key && verify(null, Buffer.from(timestamp + body), key, Buffer.from(signature, "hex"));
    } catch {
      return false;
    }
  }

  return {
    platform: "discord",
    maxMessageLength: MAX_MESSAGE_LENGTH,
    mode: "gateway",
    bot,
    send,
    edit,
    deleteMessage,
    sendDirect,

    async start() {
      if (!stopped) return;
      stopped = false;
      failure = null;
      report("connecting");
      await registerCommands();
      try {
        const gateway = await request<{ url: string }>("GET", "/gateway/bot", { label: "get gateway" });
        gatewayUrl = gateway.url;
      } catch (err) {
        const message =
          err instanceof DiscordRequestError && err.status === 401
            ? TOKEN_REJECTED
            : `Could not reach Discord gateway: ${err instanceof DiscordRequestError ? err.reason : describe(err)}`;
        halt();
        report("error", message);
        throw new ChatTokenError(message);
      }
      if (stopped) throw new ChatTokenError("Discord connection was stopped");
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const timer = setTimeout(() => {
        const message = "Timed out connecting to Discord gateway";
        halt();
        report("error", message);
        settleReady(new ChatTokenError(message));
      }, READY_TIMEOUT_MS);
      ready = { resolve, reject, timer };
      connect(false);
      await promise;
    },

    async stop() {
      halt();
      sessionId = null;
      seq = null;
      settleReady(new ChatTokenError("Discord connection was stopped"));
      report("disconnected");
    },

    state: snapshot,

    async handleWebhook(req: Request): Promise<Response> {
      const body = await req.text();
      if (!verifySignature(req, body)) return new Response("invalid request signature", { status: 401 });
      let interaction: DiscordInteraction;
      try {
        interaction = JSON.parse(body) as DiscordInteraction;
      } catch {
        return new Response("invalid JSON", { status: 400 });
      }
      if (interaction.type === 1) return Response.json({ type: 1 });
      if (interaction.type !== 2) return new Response("unsupported interaction type", { status: 400 });
      const flags = interaction.data?.name === "login" ? EPHEMERAL : 0;
      void handleInteraction(interaction, true).catch((err) =>
        console.error("[chat] discord interaction failed:", describe(err)),
      );
      return Response.json({ type: 5, data: { flags } });
    },
  };
}
