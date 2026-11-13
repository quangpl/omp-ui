// Discord bot integration end to end through the API routes, against a fake Discord: global
// fetch is stubbed for https://discord.com/api/v10 and the global WebSocket is replaced by a fake
// gateway, so no test ever reaches Discord.
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ADMIN_PASSWORD, api, call, freshEnv, setupAdmin, teardown, tempDir, waitFor } from "./helpers";

import * as boardsRoute from "@/app/api/v1/boards/route";
import * as connectRoute from "@/app/api/v1/chat/discord/connect/route";
import * as disconnectRoute from "@/app/api/v1/chat/discord/disconnect/route";
import * as webhookRoute from "@/app/api/v1/chat/discord/webhook/route";
import * as statusRoute from "@/app/api/v1/chat/status/route";
import * as settingsRoute from "@/app/api/v1/settings/route";
import { getRepo } from "@/lib/db";
import { REDACTED_SECRET, type AppSettings, type Board, type ChatPlatformStatus, type ChatStatusResponse } from "@/lib/types";

const API = "https://discord.com/api/v10";
const VALID_TOKEN = "MTIzNDU2Nzg5.fake-discord-bot-token.abcdef";
const BOT_ID = "bot1";
const APP_ID = "app1";
const OWNER_ID = "owner1";
const USER = { id: "user1", username: "alice" };
const DM_CHANNEL = "dm-user1";
const GUILD_CHANNEL = "guild-chan";
const WAIT_MS = 5000;

// ---------------------------------------------------------------------------------------------
// Fake Discord REST

interface RecordedRequest {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

const keys = generateKeyPairSync("ed25519");
const PUBLIC_KEY_HEX = Buffer.from(keys.publicKey.export({ format: "jwk" }).x as string, "base64url").toString("hex");
const requests: RecordedRequest[] = [];
let nextMessageId = 1;
const realFetch = globalThis.fetch;

function discordResponse(method: string, path: string, auth: string | null, body: unknown): Response {
  const authed = auth === `Bot ${VALID_TOKEN}`;
  const unauthorized = () => Response.json({ message: "401: Unauthorized", code: 0 }, { status: 401 });
  const noContent = () => new Response(null, { status: 204 });
  let m: RegExpExecArray | null;

  if (method === "GET" && path === "/users/@me") {
    return authed ? Response.json({ id: BOT_ID, username: "agentman_bot", global_name: null, bot: true }) : unauthorized();
  }
  if (method === "GET" && path === "/oauth2/applications/@me") {
    return authed
      ? Response.json({ id: APP_ID, verify_key: PUBLIC_KEY_HEX, owner: { id: OWNER_ID } })
      : unauthorized();
  }
  if (method === "PUT" && path === `/applications/${APP_ID}/commands`) {
    return authed ? Response.json(body) : unauthorized();
  }
  if (method === "GET" && path === "/gateway/bot") {
    return authed ? Response.json({ url: "wss://fake.gateway", shards: 1 }) : unauthorized();
  }
  if (method === "POST" && path === "/users/@me/channels") {
    if (!authed) return unauthorized();
    const recipient = String(bodyField(body, "recipient_id"));
    return Response.json({ id: recipient === OWNER_ID ? "dm-owner" : `dm-${recipient}`, type: 1 });
  }
  if ((m = /^\/channels\/([^/]+)\/messages$/.exec(path)) && method === "POST") {
    return authed ? Response.json({ id: `m${nextMessageId++}`, channel_id: m[1] }) : unauthorized();
  }
  if ((m = /^\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(path))) {
    if (!authed) return unauthorized();
    if (method === "PATCH") return Response.json({ id: m[2], channel_id: m[1] });
    if (method === "DELETE") return noContent();
  }
  if (method === "POST" && /^\/interactions\/[^/]+\/[^/]+\/callback$/.test(path)) return noContent();
  if ((m = new RegExp(`^/webhooks/${APP_ID}/([^/]+)(/messages/@original)?$`).exec(path))) {
    if (m[2] && method === "PATCH") return Response.json({ id: `orig-${m[1]}` });
    if (m[2] && method === "DELETE") return noContent();
    if (!m[2] && method === "POST") return Response.json({ id: `m${nextMessageId++}` });
  }
  return Response.json({ message: "404: Not Found", code: 0 }, { status: 404 });
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(`${API}/`)) return realFetch(input, init);
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.slice(API.length);
  const auth = new Headers(init?.headers).get("authorization");
  const body: unknown = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
  requests.push({ method, path, auth, body });
  return discordResponse(method, path, auth, body);
}

function find(method: string, path: string): RecordedRequest[] {
  return requests.filter((r) => r.method === method && r.path === path);
}

/** Field `key` of a recorded JSON body; undefined when the body is not an object or lacks it. */
function bodyField(body: unknown, key: string): unknown {
  return body && typeof body === "object" && key in body ? (body as Record<string, unknown>)[key] : undefined;
}

/** Contents of the messages the bot posted to `channelId`, in order. */
function messagesTo(channelId: string): string[] {
  return find("POST", `/channels/${channelId}/messages`).map((r) => String(bodyField(r.body, "content")));
}

/** Wait for the bot's message number `index` (0-based) in `channelId`. */
function messageAt(channelId: string, index: number): Promise<string> {
  return waitFor(() => messagesTo(channelId)[index], WAIT_MS);
}

// ---------------------------------------------------------------------------------------------
// Fake gateway WebSocket (discord.ts only uses addEventListener, send, close, readyState, binaryType)

type Listener = (event: unknown) => void;

class FakeGatewaySocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeGatewaySocket.CONNECTING;
  binaryType = "blob";
  closeCode: number | null = null;
  readonly sent: { op: number; d: unknown }[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();
  private seq = 0;

  constructor(readonly url: string) {
    sockets.push(this);
    setTimeout(() => {
      if (this.readyState !== FakeGatewaySocket.CONNECTING) return;
      this.readyState = FakeGatewaySocket.OPEN;
      this.emit("open", {});
      this.push({ op: 10, d: { heartbeat_interval: 45_000 } });
    }, 0);
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.readyState !== FakeGatewaySocket.OPEN) throw new Error("socket not open");
    const payload = JSON.parse(data) as { op: number; d: unknown };
    this.sent.push(payload);
    if (payload.op === 2) {
      if (bodyField(payload.d, "token") !== VALID_TOKEN) {
        this.close(4004, "Authentication failed.");
        return;
      }
      this.dispatch("READY", {
        session_id: "session-1",
        resume_gateway_url: "wss://fake.resume",
        user: { id: BOT_ID, username: "agentman_bot", bot: true },
      });
    } else if (payload.op === 1) {
      this.push({ op: 11, d: null });
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= FakeGatewaySocket.CLOSING) return;
    this.readyState = FakeGatewaySocket.CLOSED;
    this.closeCode = code;
    setTimeout(() => this.emit("close", { code, reason }), 0);
  }

  /** Push a gateway dispatch (op 0) to the bot. */
  dispatch(type: string, d: unknown): void {
    this.push({ op: 0, t: type, s: ++this.seq, d });
  }

  private push(payload: unknown): void {
    setTimeout(() => {
      if (this.readyState === FakeGatewaySocket.OPEN) this.emit("message", { data: JSON.stringify(payload) });
    }, 0);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const sockets: FakeGatewaySocket[] = [];

/** The open gateway connection of the running bot. */
function gateway(): FakeGatewaySocket {
  const open = sockets.filter((s) => s.readyState === FakeGatewaySocket.OPEN);
  expect(open).toHaveLength(1);
  return open[0];
}

// ---------------------------------------------------------------------------------------------
// Helpers

async function chatStatus(): Promise<ChatPlatformStatus> {
  const res = await api<ChatStatusResponse>(statusRoute, "GET", "/chat/status");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.discord;
}

async function settings(): Promise<AppSettings> {
  const res = await api<AppSettings>(settingsRoute, "GET", "/settings");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

let dmMessageSeq = 0;

/** A user's direct message (no guild_id) arriving over the gateway; returns its message id. */
function sendDm(content: string): string {
  const id = `in-dm-${++dmMessageSeq}`;
  gateway().dispatch("MESSAGE_CREATE", { id, channel_id: DM_CHANNEL, content, author: USER });
  return id;
}

function signedWebhook(body: string, key: KeyObject = keys.privateKey): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), key).toString("hex");
  return call(webhookRoute, "POST", "/chat/discord/webhook", {
    rawBody: body,
    token: null,
    headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
  });
}

// ---------------------------------------------------------------------------------------------

describe("Discord chat integration", () => {
  let board: Board;

  beforeAll(async () => {
    vi.stubGlobal("fetch", fakeFetch);
    vi.stubGlobal("WebSocket", FakeGatewaySocket);
    await freshEnv();
    await setupAdmin();
    const res = await api<Board>(boardsRoute, "POST", "/boards", {
      body: { name: "Discord Board", workdir: tempDir("project"), autoRun: false },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    board = res.body;
  });

  afterAll(async () => {
    // Stop the bot (gateway socket, heartbeat timer) before the stubs and the database go away.
    // The chat registry (globalThis.__ompUiChat) needs no reset: this file uses one environment,
    // the disconnect leaves no adapter behind, and vitest gives every test file a fresh module graph.
    await call(disconnectRoute, "POST", "/chat/discord/disconnect").catch(() => undefined);
    vi.unstubAllGlobals();
    await teardown();
  });

  it("rejects an invalid token with a reason pointing to the developer portal", async () => {
    const res = await api<{ error: string }>(connectRoute, "POST", "/chat/discord/connect", {
      body: { token: "Bot not-a-valid-token" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/developer portal/);
    expect(res.body.error).not.toContain("not-a-valid-token");

    const status = await chatStatus();
    expect(status.state).toBe("disconnected");
    expect(status.configured).toBe(false);
    expect((await settings()).discordBotToken).toBe("");
    expect(sockets).toHaveLength(0);
  });

  it("connects over the gateway, registers slash commands, DMs the owner and stores the token sealed", async () => {
    const res = await api<ChatPlatformStatus>(connectRoute, "POST", "/chat/discord/connect", {
      body: { token: VALID_TOKEN },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ platform: "discord", state: "connected", mode: "gateway", configured: true });
    const botUrl = new URL(res.body.botUrl!);
    expect(botUrl.origin + botUrl.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(botUrl.searchParams.get("client_id")).toBe(APP_ID);
    expect(botUrl.searchParams.get("scope")).toContain("bot");

    const registered = find("PUT", `/applications/${APP_ID}/commands`);
    expect(registered).toHaveLength(1);
    // The registration body is the array of slash command definitions.
    const names = (registered[0].body as { name: string }[]).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["create", "boards", "status", "run", "stop", "login"]));

    // The owner gets a DM telling them how to take control.
    await waitFor(
      () => find("POST", "/users/@me/channels").some((r) => bodyField(r.body, "recipient_id") === OWNER_ID),
      WAIT_MS,
    );
    expect(await messageAt("dm-owner", 0)).toContain("AgentMan connected");

    expect((await chatStatus()).state).toBe("connected");
    expect((await settings()).discordBotToken).toBe(REDACTED_SECRET);
    const raw = await (await getRepo()).getSetting("app_settings");
    expect(raw).toBeTruthy();
    expect(raw).not.toContain(VALID_TOKEN);
  });

  it("answers DMs: locked until /login, then /boards and /create work", async () => {
    sendDm("/boards");
    expect(await messageAt(DM_CHANNEL, 0)).toMatch(/\/login/);
    expect(messagesTo(DM_CHANNEL)[0]).not.toContain(board.name);

    const loginId = sendDm(`/login ${ADMIN_PASSWORD}`);
    expect(await messageAt(DM_CHANNEL, 1)).toContain("AgentMan connected");
    // The message carrying the password is deleted.
    expect(find("DELETE", `/channels/${DM_CHANNEL}/messages/${loginId}`)).toHaveLength(1);
    expect((await chatStatus()).authorizedUsers).toBe(1);

    sendDm("/boards");
    const list = await messageAt(DM_CHANNEL, 2);
    expect(list).toContain(board.name);
    expect(list).toContain(board.id);

    sendDm("/create Discord card");
    const created = await messageAt(DM_CHANNEL, 3);
    const tasks = await (await getRepo()).listTasks(board.id);
    expect(tasks.map((t) => t.title)).toEqual(["Discord card"]);
    expect(tasks[0].status).toBe("todo");
    expect(created).toContain(tasks[0].id);
  });

  it("ignores guild chatter but answers a mention in the same channel", async () => {
    const socket = gateway();
    socket.dispatch("MESSAGE_CREATE", {
      id: "in-guild-1",
      guild_id: "g1",
      channel_id: GUILD_CHANNEL,
      content: "boards are nice today",
      author: USER,
    });
    socket.dispatch("MESSAGE_CREATE", {
      id: "in-guild-2",
      guild_id: "g1",
      channel_id: GUILD_CHANNEL,
      content: `<@${BOT_ID}> /boards`,
      author: USER,
    });
    expect(await messageAt(GUILD_CHANNEL, 0)).toContain(board.name);
    // Messages of one channel are handled in order, so a reply to the first would already be here.
    expect(messagesTo(GUILD_CHANNEL)).toHaveLength(1);
  });

  it("runs a slash command from the gateway: deferred callback, then the original response is filled", async () => {
    gateway().dispatch("INTERACTION_CREATE", {
      id: "int1",
      application_id: APP_ID,
      type: 2,
      token: "itok1",
      channel_id: DM_CHANNEL,
      user: USER,
      data: { name: "boards" },
    });
    const patchPath = `/webhooks/${APP_ID}/itok1/messages/@original`;
    const patch = await waitFor(() => requests.find((r) => r.method === "PATCH" && r.path === patchPath), WAIT_MS);
    expect(bodyField(patch.body, "content")).toContain(board.name);

    const callbackPath = "/interactions/int1/itok1/callback";
    const callback = find("POST", callbackPath);
    expect(callback).toHaveLength(1);
    expect(bodyField(callback[0].body, "type")).toBe(5);
    expect(requests.indexOf(callback[0])).toBeLessThan(requests.indexOf(patch));
  });

  it("serves the Interactions Endpoint URL with Ed25519 signature checks", async () => {
    const ping = JSON.stringify({ id: "ping1", application_id: APP_ID, type: 1, token: "ptok" });

    const unsigned = await call(webhookRoute, "POST", "/chat/discord/webhook", {
      rawBody: ping,
      token: null,
      headers: { "content-type": "application/json" },
    });
    expect(unsigned.status).toBe(401);

    const otherKey = generateKeyPairSync("ed25519").privateKey;
    expect((await signedWebhook(ping, otherKey)).status).toBe(401);

    const pong = await signedWebhook(ping);
    expect(pong.status).toBe(200);
    expect(await pong.json()).toEqual({ type: 1 });

    const interaction = JSON.stringify({
      id: "int2",
      application_id: APP_ID,
      type: 2,
      token: "itok2",
      guild_id: "g1",
      channel_id: GUILD_CHANNEL,
      member: { user: USER },
      data: { name: "boards" },
    });
    const deferred = await signedWebhook(interaction);
    expect(deferred.status).toBe(200);
    expect(await deferred.json()).toMatchObject({ type: 5 });

    const patchPath = `/webhooks/${APP_ID}/itok2/messages/@original`;
    const patch = await waitFor(() => requests.find((r) => r.method === "PATCH" && r.path === patchPath), WAIT_MS);
    expect(bodyField(patch.body, "content")).toContain(board.name);
    // Already acknowledged in the HTTP response: no separate callback.
    expect(find("POST", "/interactions/int2/itok2/callback")).toHaveLength(0);
  });

  it("disconnects: closes the gateway and forgets the token", async () => {
    const socket = gateway();
    const res = await api<ChatPlatformStatus>(disconnectRoute, "POST", "/chat/discord/disconnect");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.state).toBe("disconnected");
    expect(res.body.configured).toBe(false);
    expect(socket.readyState).toBe(FakeGatewaySocket.CLOSED);
    expect(socket.closeCode).toBe(1000);

    expect((await chatStatus()).state).toBe("disconnected");
    expect((await settings()).discordBotToken).toBe("");
    const webhook = await signedWebhook(JSON.stringify({ id: "ping2", application_id: APP_ID, type: 1, token: "p" }));
    expect(webhook.status).toBe(404);
  });
});
