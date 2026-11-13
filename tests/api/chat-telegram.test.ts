// Telegram bot end to end: Settings connect/disconnect routes, the long-polling adapter, the chat
// commands and the run relay, against a fake Telegram Bot API (stubbed fetch; Telegram is never
// contacted) and the fake omp.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ADMIN_PASSWORD, api, freshEnv, setupAdmin, teardown, tempDir, useToken, waitFor } from "./helpers";

import * as loginRoute from "@/app/api/v1/auth/login/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import * as statusRoute from "@/app/api/v1/chat/status/route";
import * as connectRoute from "@/app/api/v1/chat/telegram/connect/route";
import * as disconnectRoute from "@/app/api/v1/chat/telegram/disconnect/route";
import * as settingsRoute from "@/app/api/v1/settings/route";
import { getAgentManager } from "@/lib/agent/manager";
import { setPassword } from "@/lib/auth";
import { getRepo } from "@/lib/db";
import { disconnectChat } from "@/lib/server/chat/service";
import { getChatToken } from "@/lib/server/chat/store";
import {
  REDACTED_SECRET,
  type AppSettings,
  type Board,
  type BoardWithCounts,
  type ChatPlatformStatus,
  type ChatStatusResponse,
  type Task,
} from "@/lib/types";

const VALID_TOKEN = "123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-xx";
const TOKEN_SECRET_PART = VALID_TOKEN.split(":")[1];
const BOT_USERNAME = "agentman_test_bot";
const NEW_PASSWORD = "a-brand-new-admin-password";
/** Text the fake omp "stream" scenario streams (tests/fixtures/fake-omp.mjs STREAM_WORDS). */
const STREAMED_TEXT =
  "Streamed summary: I updated the login form, added validation, wrote tests, and verified everything passes.";
const STREAM_THINKING = "Planning the change.";
const REPLY_TIMEOUT = 10_000;
const RUN_TIMEOUT = 15_000;

// ---------------------------------------------------------------------------------------------
// Fake Telegram Bot API

interface SentMessage {
  chat_id: string;
  message_id: number;
  text: string;
}

interface TelegramUpdate {
  update_id: number;
  message: {
    message_id: number;
    from: { id: number; is_bot: boolean; first_name: string; username: string };
    chat: { id: number; type: string };
    text: string;
  };
}

const tg = {
  /** Updates not yet confirmed by a getUpdates `offset` (as Telegram keeps them). */
  updates: [] as TelegramUpdate[],
  nextUpdateId: 1,
  nextIncomingMessageId: 1,
  nextSentMessageId: 1000,
  sent: [] as SentMessage[],
  edits: [] as SentMessage[],
  deletes: [] as { chat_id: string; message_id: number }[],
  /** Every method called with the valid token, in order. */
  calls: [] as { method: string; body: Record<string, unknown> }[],
  /** getUpdates requests currently held open. */
  activePolls: 0,
  /** Wakes held getUpdates requests when an update is pushed. */
  wakers: new Set<() => void>(),
};

const realFetch = globalThis.fetch;

function tgResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/**
 * Hold an empty long poll ≤ 50 ms, waking early on a pushed update or abort. Real Telegram holds it
 * up to `timeout` s; the short cap keeps the adapter's loop from busy-looping without slowing tests.
 */
function holdPoll(signal: AbortSignal | undefined): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const done = () => {
    clearTimeout(timer);
    tg.wakers.delete(done);
    signal?.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, 50);
  tg.wakers.add(done);
  signal?.addEventListener("abort", done, { once: true });
  return promise;
}

async function fakeTelegram(token: string, method: string, body: Record<string, unknown>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (token !== VALID_TOKEN) return tgResponse({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
  tg.calls.push({ method, body });
  const ok = (result: unknown) => tgResponse({ ok: true, result });
  switch (method) {
    case "getMe":
      return ok({ id: 123456789, is_bot: true, first_name: "AgentMan Test", username: BOT_USERNAME });
    case "deleteWebhook":
    case "setWebhook":
    case "setMyCommands":
      return ok(true);
    case "getUpdates": {
      const offset = typeof body.offset === "number" ? body.offset : 0;
      // Telegram forgets updates below the requested offset (they are confirmed).
      tg.updates = tg.updates.filter((u) => u.update_id >= offset);
      tg.activePolls++;
      try {
        if (tg.updates.length === 0 && Number(body.timeout) > 0) await holdPoll(signal);
        signal?.throwIfAborted();
      } finally {
        tg.activePolls--;
      }
      return ok(tg.updates.filter((u) => u.update_id >= offset));
    }
    case "sendMessage": {
      const message = { chat_id: String(body.chat_id), message_id: tg.nextSentMessageId++, text: String(body.text) };
      tg.sent.push(message);
      return ok({ message_id: message.message_id, chat: { id: Number(body.chat_id), type: "private" }, text: message.text });
    }
    case "editMessageText":
      tg.edits.push({ chat_id: String(body.chat_id), message_id: Number(body.message_id), text: String(body.text) });
      return ok(true);
    case "deleteMessage":
      tg.deletes.push({ chat_id: String(body.chat_id), message_id: Number(body.message_id) });
      return ok(true);
    default:
      return tgResponse({ ok: false, error_code: 404, description: "Not Found: method not found" }, 404);
  }
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const match = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
  if (!match) return realFetch(input, init);
  const body = typeof init?.body === "string" && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  return fakeTelegram(decodeURIComponent(match[1]), match[2], body, init?.signal ?? undefined);
}

/** Queue a user's text message for the bot's next getUpdates; returns its message_id. */
function push(text: string, { userId = 42, chatId = 42, type = "private" } = {}): number {
  const messageId = tg.nextIncomingMessageId++;
  tg.updates.push({
    update_id: tg.nextUpdateId++,
    message: {
      message_id: messageId,
      from: { id: userId, is_bot: false, first_name: `User ${userId}`, username: `user${userId}` },
      chat: { id: chatId, type },
      text,
    },
  });
  for (const wake of [...tg.wakers]) wake();
  return messageId;
}

/** Texts sent to `chatId` since `from` (an index into tg.sent). */
function sentSince(from: number, chatId: number | string = 42): string[] {
  return tg.sent.slice(from).filter((m) => m.chat_id === String(chatId)).map((m) => m.text);
}

/** Send `text` as a user and return the bot's first answer in that chat. */
async function say(text: string, opts: { userId?: number; chatId?: number; type?: string } = {}): Promise<string> {
  const from = tg.sent.length;
  push(text, opts);
  return waitFor(() => sentSince(from, opts.chatId ?? 42)[0], REPLY_TIMEOUT);
}

/** What each message of the chat shows now (sends with their edits applied, deletes removed), in order. */
function displayed(chatId: number | string = 42): SentMessage[] {
  const shown = new Map<number, SentMessage>();
  for (const m of tg.sent) if (m.chat_id === String(chatId)) shown.set(m.message_id, { ...m });
  for (const e of tg.edits) {
    const target = shown.get(e.message_id);
    if (target && e.chat_id === String(chatId)) target.text = e.text;
  }
  for (const d of tg.deletes) if (d.chat_id === String(chatId)) shown.delete(d.message_id);
  return [...shown.values()].sort((a, b) => a.message_id - b.message_id);
}

// ---------------------------------------------------------------------------------------------
// App helpers

async function connect(token: string) {
  return api<ChatPlatformStatus & { error?: string }>(connectRoute, "POST", "/chat/telegram/connect", {
    body: { token },
  });
}

async function chatStatus(): Promise<ChatStatusResponse> {
  const res = await api<ChatStatusResponse>(statusRoute, "GET", "/chat/status");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function createBoard(name: string): Promise<Board> {
  const res = await api<Board>(boardsRoute, "POST", "/boards", { body: { name, workdir: tempDir(name) } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function getTask(id: string): Promise<Task> {
  const task = await (await getRepo()).getTask(id);
  if (!task) throw new Error(`card ${id} is gone`);
  return task;
}

function isActive(task: Task): boolean {
  return task.agentState === "running" || task.agentState === "queued";
}

// ---------------------------------------------------------------------------------------------

describe("Telegram bot", () => {
  let boards: BoardWithCounts[];
  let firstCard: Task;

  beforeAll(async () => {
    vi.stubGlobal("fetch", fakeFetch);
    await freshEnv({ FAKE_OMP_SCENARIO: "stream" });
    await setupAdmin();
    await createBoard("alpha-board");
    await createBoard("beta-board");
    // The order /boards lists them in, and the first one /create defaults to.
    boards = await (await getRepo()).listBoards();
    expect(boards.map((b) => b.name).sort()).toEqual(["alpha-board", "beta-board"]);
  });

  // The bot lives in a process-wide registry (globalThis.__ompUiChat, lib/server/chat/service.ts)
  // that teardown() does not reset: stop it here so no polling loop outlives the suite. Its boot
  // flag needs no reset: boot ran once, on this suite's first request, with no token stored.
  afterAll(async () => {
    await disconnectChat({ repo: await getRepo(), manager: await getAgentManager() }, "telegram").catch(() => undefined);
    await teardown();
    vi.unstubAllGlobals();
  });

  it("rejects a malformed or refused token and stays disconnected", async () => {
    const malformed = await connect("not-a-token");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toContain("BotFather");

    const refused = await connect("987654321:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/^Telegram rejected this token/);

    const { telegram } = await chatStatus();
    expect(telegram).toMatchObject({ configured: false, state: "disconnected", bot: null });
    expect(await getChatToken(await getRepo(), "telegram")).toBeNull();
  });

  it("connects with a valid token in polling mode and stores the token encrypted", async () => {
    const res = await connect(VALID_TOKEN);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ configured: true, state: "connected", mode: "polling" });
    expect(res.body.bot?.username).toBe(BOT_USERNAME);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN_SECRET_PART);

    const { telegram } = await chatStatus();
    expect(telegram).toMatchObject({ configured: true, state: "connected", mode: "polling" });
    expect(telegram.bot?.username).toBe(BOT_USERNAME);
    expect(telegram.botUrl).toBe(`https://t.me/${BOT_USERNAME}`);
    expect(JSON.stringify(telegram)).not.toContain(TOKEN_SECRET_PART);

    // Polling needs the webhook removed first; the command menu is registered.
    expect(tg.calls.some((c) => c.method === "deleteWebhook")).toBe(true);
    await waitFor(() => tg.calls.find((c) => c.method === "setMyCommands"));
    const menu = tg.calls.find((c) => c.method === "setMyCommands")!.body.commands as { command: string }[];
    expect(menu.map((c) => c.command)).toEqual(expect.arrayContaining(["login", "boards", "create", "run", "stop"]));

    const settings = await api<AppSettings>(settingsRoute, "GET", "/settings");
    expect(settings.body.telegramBotToken).toBe(REDACTED_SECRET);

    const repo = await getRepo();
    for (const key of ["app_settings", "chat_integrations"]) {
      const raw = (await repo.getSetting(key)) ?? "";
      expect(raw, key).not.toContain(TOKEN_SECRET_PART);
    }
    expect(await repo.getSetting("app_settings")).toContain("telegramBotToken");
    expect(await getChatToken(repo, "telegram")).toBe(VALID_TOKEN);
  });

  it("only lets users who logged in with the admin password run commands", async () => {
    const locked = await say("/boards");
    expect(locked).toContain("/login");
    for (const board of boards) expect(locked).not.toContain(board.name);

    const wrongId = tg.nextIncomingMessageId;
    expect(await say("/login wrong")).toContain("Wrong password");
    // The password never stays in the chat, right or wrong.
    expect(tg.deletes).toContainEqual({ chat_id: "42", message_id: wrongId });
    expect(await say("/boards")).toContain("/login");

    const loginId = tg.nextIncomingMessageId;
    expect(await say(`/login ${ADMIN_PASSWORD}`)).toContain("AgentMan connected");
    expect(tg.deletes).toContainEqual({ chat_id: "42", message_id: loginId });

    const list = await say("/boards");
    for (const board of boards) expect(list).toContain(board.name);

    // Another user, even in a group the admin may share, is still locked out.
    const stranger = await say(`/boards@${BOT_USERNAME}`, { userId: 77, chatId: -1001, type: "group" });
    expect(stranger).toContain("/login");
    for (const board of boards) expect(stranger).not.toContain(board.name);
    expect((await chatStatus()).telegram.authorizedUsers).toBe(1);
  });

  it("/create adds a To-do card to the default board, then to the board picked with /board", async () => {
    const repo = await getRepo();
    const [first, second] = boards;

    const created = await say("/create Test card");
    const onFirst = await repo.listTasks(first.id);
    expect(onFirst).toHaveLength(1);
    firstCard = onFirst[0];
    expect(firstCard).toMatchObject({ title: "Test card", status: "todo" });
    expect(created).toContain(firstCard.id);

    expect(await say(`/board ${second.name}`)).toContain(second.name);
    const other = await say("/create Other");
    const onSecond = await repo.listTasks(second.id);
    expect(onSecond.map((t) => [t.title, t.status])).toEqual([["Other", "todo"]]);
    expect(other).toContain(onSecond[0].id);
    expect(await repo.listTasks(first.id)).toHaveLength(1);
  });

  it("/status lists the cards of the selected board, or of the board given", async () => {
    const selected = await say("/status");
    expect(selected).toContain("Other");
    expect(selected).not.toContain("Test card");

    const first = await say("/status 1");
    expect(first).toContain("Test card");
    expect(first).toContain(firstCard.id.slice(0, 8));
    expect(first).not.toContain("Other");
  });

  it("/run streams the agent's answer into the chat and reports the end of the run", async () => {
    const from = tg.sent.length;
    const editsFrom = tg.edits.length;
    push(`/run ${firstCard.id.slice(0, 8)}`);
    const reply = await waitFor(() => sentSince(from).find((t) => t.includes(firstCard.id)), REPLY_TIMEOUT);
    // A free agent slot starts the card right away: the user must not be told it waits in a queue.
    expect(reply).toContain("Started");

    const finished = await waitFor(
      () => displayed().find((m) => m.message_id >= tg.sent[from].message_id && /Run finished/.test(m.text)),
      RUN_TIMEOUT,
    );
    expect(finished.text).toContain("Test card");

    // The answer is one live message: sent on the first words, ending with the whole text.
    const runMessages = displayed().filter((m) => m.message_id >= tg.sent[from].message_id);
    const answers = runMessages.filter((m) => m.text.includes("Streamed"));
    expect(answers.map((m) => m.text)).toEqual([STREAMED_TEXT]);
    const live = tg.sent.find((m) => m.message_id === answers[0].message_id)!;
    expect(live.text.startsWith("Streamed")).toBe(true);
    // Edited live at most once per 1.5 s, not once per streamed word.
    expect(tg.edits.slice(editsFrom).filter((e) => e.message_id === live.message_id).length).toBeLessThanOrEqual(3);
    // The outcome comes last; thinking is never relayed.
    expect(runMessages.at(-1)!.message_id).toBe(finished.message_id);
    expect(finished.message_id).toBeGreaterThan(live.message_id);
    for (const m of [...tg.sent, ...tg.edits]) expect(m.text).not.toContain(STREAM_THINKING);

    await waitFor(async () => !isActive(await getTask(firstCard.id)), RUN_TIMEOUT);
  });

  it("/stop stops a running card", async () => {
    const created = await say("/create Stop me [fake:slow]");
    const id = /Created card (\S+)/.exec(created)?.[1];
    expect(id, created).toBeTruthy();

    const from = tg.sent.length;
    push(`/run ${id}`);
    const reply = await waitFor(() => sentSince(from).find((t) => t.includes(id!)), REPLY_TIMEOUT);
    expect(reply).toContain("Started");
    await waitFor(async () => (await getTask(id!)).agentState === "running", RUN_TIMEOUT);

    expect(await say(`/stop ${id}`)).toContain("Stopped");
    await waitFor(async () => !isActive(await getTask(id!)), RUN_TIMEOUT);
  });

  it("changing the admin password logs chat users out", async () => {
    await setPassword(NEW_PASSWORD);
    expect(await say("/boards")).toContain("/login");
    expect(await say(`/login ${ADMIN_PASSWORD}`)).toContain("Wrong password");
    expect((await chatStatus().catch(() => null))?.telegram.authorizedUsers ?? 0).toBe(0);

    // The password change also revoked the API session: log in again for the next requests.
    const session = await api<{ token: string }>(loginRoute, "POST", "/auth/login", {
      body: { password: NEW_PASSWORD },
      token: null,
    });
    expect(session.status).toBe(200);
    useToken(session.body.token);
    expect((await chatStatus()).telegram.authorizedUsers).toBe(0);
  });

  it("disconnect stops the bot and forgets the token; a reconnect greets logged-in users", async () => {
    expect(await say(`/login ${NEW_PASSWORD}`)).toContain("AgentMan connected");

    const off = await api<ChatPlatformStatus>(disconnectRoute, "POST", "/chat/telegram/disconnect");
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ configured: false, state: "disconnected", bot: null });
    expect((await chatStatus()).telegram).toMatchObject({ configured: false, state: "disconnected" });
    expect(await getChatToken(await getRepo(), "telegram")).toBeNull();
    // No long poll is left running.
    expect(tg.activePolls).toBe(0);

    const from = tg.sent.length;
    const updatesBefore = tg.nextUpdateId;
    const on = await connect(VALID_TOKEN);
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.state).toBe("connected");
    const greeting = await waitFor(() => sentSince(from).find((t) => t.includes("AgentMan connected")), REPLY_TIMEOUT);
    expect(greeting).toContain("/help");
    // Nobody wrote to the bot meanwhile.
    expect(tg.nextUpdateId).toBe(updatesBefore);
    expect((await chatStatus()).telegram.authorizedUsers).toBe(1);
  });
});
