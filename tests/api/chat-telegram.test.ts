// Telegram bot end to end: Settings connect/disconnect routes, the long-polling adapter, the chat
// commands (/login, /logout, /stop), the natural-language chat assistant (driven through the fake
// omp's `<calls>` markers) and the run relay, against a fake Telegram Bot API (stubbed fetch;
// Telegram is never contacted) and the fake omp.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ADMIN_PASSWORD,
  api,
  createUser,
  freshEnv,
  loginAs,
  readOmpLog,
  setupAdmin,
  sleep,
  teardown,
  tempDir,
  useToken,
  waitFor,
} from "./helpers";

import * as loginRoute from "@/app/api/v1/auth/login/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import * as statusRoute from "@/app/api/v1/chat/status/route";
import * as connectRoute from "@/app/api/v1/chat/telegram/connect/route";
import * as disconnectRoute from "@/app/api/v1/chat/telegram/disconnect/route";
import * as settingsRoute from "@/app/api/v1/settings/route";
import { getAgentManager } from "@/lib/agent/manager";
import { setUserPassword } from "@/lib/auth";
import { getRepo } from "@/lib/db";
import { disconnectChat } from "@/lib/server/chat/service";
import { getChatToken, updateChatState } from "@/lib/server/chat/store";
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
/** Password of "bob", a regular (non-admin) account. */
const BOB_PASSWORD = "bobs-own-password";
/** Text the fake omp "stream" scenario streams (tests/fixtures/fake-omp.mjs STREAM_WORDS). */
const STREAMED_TEXT =
  "Streamed summary: I updated the login form, added validation, wrote tests, and verified everything passes.";
const STREAM_THINKING = "Planning the change.";
const REPLY_TIMEOUT = 10_000;
const RUN_TIMEOUT = 15_000;
/** Start of every chat assistant prompt (lib/server/chat/assistant.ts buildPrompt). */
const CHAT_PROMPT = "You are AgentMan's chat assistant";
/** The assistant's placeholder, edited with its progress and then replaced by its answer. */
const PLACEHOLDER = "🤔 Working on it…";
const CANCELLED = "⏹ Cancelled.";

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
// Chat assistant helpers

/** A message asking the fake omp's chat assistant to call these AgentMan tools. */
function calls(...list: { toolName: string; arguments: Record<string, unknown> }[]): string {
  return `<calls>${JSON.stringify(list)}</calls>`;
}

interface ToolResult {
  toolName: string;
  isError: boolean;
  text: string;
}

/** The tool results of a fake assistant answer (`Chat reply: <JSON list>`). */
function toolResults(answer: string): ToolResult[] {
  const match = /^Chat reply: (\[[\s\S]*\])$/.exec(answer);
  if (!match) throw new Error(`not a tool-results answer: ${answer}`);
  return JSON.parse(match[1]) as ToolResult[];
}

/** Id of the card an agentman_create_card result describes. */
function createdId(result: ToolResult): string {
  expect(result, JSON.stringify(result)).toMatchObject({ toolName: "agentman_create_card", isError: false });
  return (JSON.parse(result.text) as { card: { id: string } }).card.id;
}

/** Prompts of the fake omp's helper workers (advisor, chat assistant…), in order. */
function helperPrompts(): string[] {
  return readOmpLog().flatMap((e) => (e.kind === "helper" && e.prompt ? [e.prompt] : []));
}

/** The helper prompt whose new chat message is `text`. */
function promptFor(text: string): string | undefined {
  return helperPrompts().find((p) => p.includes(`<new-message>\n${text}\n</new-message>`));
}

/** What the message shows now, edits applied. */
function shown(messageId: number, chatId = 42): string | undefined {
  return displayed(chatId).find((m) => m.message_id === messageId)?.text;
}

/** A chat user and the chat they write in; the admin's own private chat 42 by default. */
interface Sender {
  userId?: number;
  chatId?: number;
}

/** Send `text` as a logged-in user; returns the assistant's placeholder message id once it is sent. */
async function ask(text: string, { userId = 42, chatId = 42 }: Sender = {}): Promise<number> {
  const from = tg.sent.length;
  push(text, { userId, chatId });
  const placeholder = await waitFor(
    () => tg.sent.slice(from).find((m) => m.chat_id === String(chatId) && m.text === PLACEHOLDER),
    REPLY_TIMEOUT,
  );
  return placeholder.message_id;
}

/** The placeholder's final text: the assistant's answer (or cancellation/error) instead of `🤔 …`. */
async function answerOf(placeholder: number, chatId = 42): Promise<string> {
  return waitFor(() => {
    const text = shown(placeholder, chatId);
    return text && !text.startsWith("🤔") ? text : undefined;
  }, REPLY_TIMEOUT);
}

/** Send `text` to the assistant and return its answer. */
async function chat(text: string, sender: Sender = {}): Promise<string> {
  return answerOf(await ask(text, sender), sender.chatId ?? 42);
}

// Test-only peek at assistant.ts's process-wide state; the suite runs the app in this process.
const assistantGlobal = globalThis as unknown as { __ompUiChatAssistant?: { queues: Map<string, unknown> } };

/** No request of chat 42 is in flight or waiting (its per-chat queue in assistant.ts is gone). */
function assistantIdle(): boolean {
  return !assistantGlobal.__ompUiChatAssistant?.queues.has("telegram:42");
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
    // The order agentman_list_boards numbers them in; the first is a chat's default board.
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
    expect(menu.map((c) => c.command)).toEqual(["login", "logout", "stop"]);

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

  it("only answers users who logged in (`/login <password>` signs in as admin)", async () => {
    const from = tg.sent.length;
    const locked = await say("show my boards");
    expect(locked).toContain("/login");
    for (const board of boards) expect(locked).not.toContain(board.name);
    // Locked out means no assistant either: no placeholder, no prompt.
    expect(sentSince(from)).toEqual([locked]);
    expect(promptFor("show my boards")).toBeUndefined();

    const wrongId = tg.nextIncomingMessageId;
    expect(await say("/login wrong")).toContain("Wrong username or password");
    // The password never stays in the chat, right or wrong.
    expect(tg.deletes).toContainEqual({ chat_id: "42", message_id: wrongId });
    expect(await say("show my boards")).toContain("/login");

    const loginId = tg.nextIncomingMessageId;
    const welcome = await say(`/login ${ADMIN_PASSWORD}`);
    expect(welcome).toContain("AgentMan connected");
    expect(welcome).toContain("just tell me");
    expect(tg.deletes).toContainEqual({ chat_id: "42", message_id: loginId });

    // Another user, even in a group the admin may share, is still locked out.
    const strangerFrom = tg.sent.length;
    const stranger = await say("show my boards", { userId: 77, chatId: -1001, type: "group" });
    expect(stranger).toContain("/login");
    for (const board of boards) expect(stranger).not.toContain(board.name);
    expect(sentSince(strangerFrom, -1001)).toEqual([stranger]);
    expect((await chatStatus()).telegram.authorizedUsers).toBe(1);
  });

  it("answers plain language in place of its placeholder, telling the assistant the boards", async () => {
    const from = tg.sent.length;
    const placeholder = await ask("hello there");
    expect(await answerOf(placeholder)).toBe("Chat reply: hello there");
    // The answer replaces the placeholder: nothing else is sent.
    expect(sentSince(from)).toEqual([PLACEHOLDER]);

    const prompt = promptFor("hello there");
    expect(prompt?.startsWith(CHAT_PROMPT), prompt).toBe(true);
    for (const board of boards) expect(prompt).toContain(board.name);
    // The locked-out messages above never reached the assistant (it runs a chat's messages in order).
    expect(promptFor("show my boards")).toBeUndefined();
    expect(helperPrompts().filter((p) => p.startsWith(CHAT_PROMPT))).toEqual([prompt]);
  });

  it("lists the boards through its tools, showing its progress meanwhile", async () => {
    const placeholder = await ask(`show my boards ${calls({ toolName: "agentman_list_boards", arguments: {} })}`);
    const answer = await answerOf(placeholder);
    expect(toolResults(answer)).toMatchObject([{ toolName: "agentman_list_boards", isError: false }]);
    for (const board of boards) expect(answer).toContain(board.name);
    expect(tg.edits).toContainEqual({ chat_id: "42", message_id: placeholder, text: "🤔 Using AgentMan's tools" });
  });

  it("creates and starts a card on the default board, streaming its run into the chat", async () => {
    const repo = await getRepo();
    const editsFrom = tg.edits.length;
    const placeholder = await ask(
      `add a test card and start it ${calls({ toolName: "agentman_create_card", arguments: { title: "Test card", start: true } })}`,
    );
    const answer = await answerOf(placeholder);
    const id = createdId(toolResults(answer)[0]);
    const onFirst = await repo.listTasks(boards[0].id);
    expect(onFirst.map((t) => [t.id, t.title])).toEqual([[id, "Test card"]]);
    firstCard = onFirst[0];
    expect(answer).toContain(id);
    expect(await repo.listTasks(boards[1].id)).toEqual([]);

    const finished = await waitFor(
      () => displayed().find((m) => m.message_id > placeholder && /Run finished/.test(m.text)),
      RUN_TIMEOUT,
    );
    expect(finished.text).toContain("Test card");

    // The run's answer is one live message: sent on the first words, ending with the whole text.
    const runMessages = displayed().filter((m) => m.message_id > placeholder);
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

    await waitFor(async () => !isActive(await getTask(id)), RUN_TIMEOUT);
    expect(await repo.listRuns(id)).toHaveLength(1);
  });

  it("creates cards on the board the chat selected", async () => {
    const repo = await getRepo();
    const [first, second] = boards;
    const selected = toolResults(
      await chat(`switch to ${second.name} ${calls({ toolName: "agentman_select_board", arguments: { board: second.name } })}`),
    );
    expect(selected).toMatchObject([{ toolName: "agentman_select_board", isError: false }]);
    expect(selected[0].text).toContain(second.name);

    const note = `note this down ${calls({ toolName: "agentman_create_card", arguments: { title: "Other" } })}`;
    const id = createdId(toolResults(await chat(note))[0]);
    const onSecond = await repo.listTasks(second.id);
    expect(onSecond.map((t) => [t.id, t.title, t.status])).toEqual([[id, "Other", "todo"]]);
    expect(await repo.listTasks(first.id)).toHaveLength(1);
    // The assistant is told which board the chat uses.
    expect(promptFor(note)).toContain(`Default board of this chat: ${second.name}`);
  });

  it("lists the cards of the selected board, or of the board asked for", async () => {
    const selected = await chat(`what is on my board? ${calls({ toolName: "agentman_list_cards", arguments: {} })}`);
    expect(selected).toContain("Other");
    expect(selected).not.toContain("Test card");

    const named = await chat(
      `and on the first one? ${calls({ toolName: "agentman_list_cards", arguments: { board: boards[0].name } })}`,
    );
    expect(named).toContain("Test card");
    expect(named).toContain(firstCard.id);
    expect(named).not.toContain("Other");
  });

  it("/stop <cardId> stops a running card", async () => {
    const answer = await chat(
      `start a slow one ${calls({ toolName: "agentman_create_card", arguments: { title: "Stop me [fake:slow]", start: true } })}`,
    );
    const id = createdId(toolResults(answer)[0]);
    await waitFor(async () => (await getTask(id)).agentState === "running", RUN_TIMEOUT);

    expect(await say(`/stop ${id.slice(0, 8)}`)).toContain("Stopped");
    await waitFor(async () => !isActive(await getTask(id)), RUN_TIMEOUT);
  });

  it("/stop alone cancels the request in flight and drops the waiting ones", async () => {
    const slow = "think hard [fake-chat:slow]";
    const placeholder = await ask(slow);
    await waitFor(() => promptFor(slow), REPLY_TIMEOUT);
    push("this waits in line");
    expect(await say("/stop")).toBe("⏹ Cancelled the current request.");
    expect(await answerOf(placeholder)).toBe(CANCELLED);
    await waitFor(assistantIdle, REPLY_TIMEOUT);
    expect(await say("/stop")).toBe("Nothing to stop.");

    // The assistant still answers, and the dropped message never ran before it (one queue per chat).
    const next = "are you still there?";
    expect(await chat(next)).toBe(`Chat reply: ${next}`);
    expect(promptFor("this waits in line")).toBeUndefined();
    // A cancelled request is not remembered as part of the conversation.
    expect(promptFor(next)).not.toContain("think hard");
  });

  it("answers a chat's messages one at a time, in order, remembering the conversation", async () => {
    const from = tg.sent.length;
    const callsFrom = tg.calls.length;
    push("first question");
    push("second question");
    const placeholders = await waitFor(() => {
      const sent = tg.sent.slice(from).filter((m) => m.chat_id === "42" && m.text === PLACEHOLDER);
      return sent.length === 2 ? sent : undefined;
    }, REPLY_TIMEOUT);
    expect(await answerOf(placeholders[0].message_id)).toBe("Chat reply: first question");
    expect(await answerOf(placeholders[1].message_id)).toBe("Chat reply: second question");

    // The second request starts only once the first is answered.
    const log = tg.calls.slice(callsFrom);
    const answered = log.findIndex((c) => c.method === "editMessageText" && c.body.text === "Chat reply: first question");
    const started = log.findLastIndex((c) => c.method === "sendMessage" && c.body.text === PLACEHOLDER);
    expect(answered).toBeGreaterThan(-1);
    expect(started).toBeGreaterThan(answered);
    expect(promptFor("second question")).toContain("User: first question\nYou: Chat reply: first question");
  });

  it("/logout works while a request runs, cancels it and locks the chat", async () => {
    const slow = "long job [fake-chat:slow]";
    const placeholder = await ask(slow);
    await waitFor(() => promptFor(slow), REPLY_TIMEOUT);
    expect(await say("/logout")).toContain("Logged out");
    expect(await answerOf(placeholder)).toBe(CANCELLED);
    expect((await chatStatus()).telegram.authorizedUsers).toBe(0);
    expect(await say("show my boards")).toContain("/login");

    // Logging in again starts a fresh conversation.
    expect(await say(`/login ${ADMIN_PASSWORD}`)).toContain("AgentMan connected");
    const fresh = "hello again";
    expect(await chat(fresh)).toBe(`Chat reply: ${fresh}`);
    expect(promptFor(fresh)).not.toContain("Recent conversation");
    // What was written while logged out never reached the assistant.
    expect(promptFor("show my boards")).toBeUndefined();
  });

  it("logs in by username: a regular account only sees, creates and stops its own cards", async () => {
    const bobChat = { userId: 77, chatId: 77 };
    const bob = await createUser({ username: "bob", password: BOB_PASSWORD });
    const created = await api<Board>(boardsRoute, "POST", "/boards", {
      body: { name: "bob-board", workdir: tempDir("bob-board") },
      token: await loginAs("bob", BOB_PASSWORD),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bobBoard = created.body;
    expect(bobBoard.userId).toBe(bob.id);

    // `/login <password>` signs in as "admin": bob's password alone is not enough.
    expect(await say(`/login ${BOB_PASSWORD}`, bobChat)).toContain("Wrong username or password");
    expect(await say("/login bob not-his-password", bobChat)).toContain("Wrong username or password");
    const loginId = tg.nextIncomingMessageId;
    expect(await say(`/login bob ${BOB_PASSWORD}`, bobChat)).toContain("AgentMan connected ✅ as bob");
    expect(tg.deletes).toContainEqual({ chat_id: "77", message_id: loginId });
    expect((await chatStatus()).telegram.authorizedUsers).toBe(2);

    // A default board bob cannot see (e.g. selected by another account) counts as unselected.
    await updateChatState(await getRepo(), (state) => {
      state.selectedBoards["telegram:77"] = boards[0].id;
    });
    const listMine = `list my boards ${calls({ toolName: "agentman_list_boards", arguments: {} })}`;
    const mine = await chat(listMine, bobChat);
    expect(mine).toContain("bob-board");
    for (const board of boards) expect(mine).not.toContain(board.name);
    const prompt = promptFor(listMine);
    expect(prompt).toContain("Default board of this chat: bob-board");
    for (const board of boards) expect(prompt).not.toContain(board.name);

    // Another account's cards and boards are out of reach.
    const foreign = toolResults(
      await chat(
        `peek ${calls(
          { toolName: "agentman_read_card", arguments: { cardId: firstCard.id } },
          { toolName: "agentman_list_cards", arguments: { board: boards[0].id } },
          { toolName: "agentman_select_board", arguments: { board: boards[1].id } },
        )}`,
        bobChat,
      ),
    );
    expect(foreign.map((r) => [r.toolName, r.isError])).toEqual([
      ["agentman_read_card", true],
      ["agentman_list_cards", true],
      ["agentman_select_board", true],
    ]);
    expect(JSON.stringify(foreign)).not.toContain(firstCard.title);
    expect(await say(`/stop ${firstCard.id}`, bobChat)).toContain("No card matches");

    // His cards land on his board, and he can stop them.
    const answer = await chat(
      `start a slow one ${calls({ toolName: "agentman_create_card", arguments: { title: "Bob slow [fake:slow]", start: true } })}`,
      bobChat,
    );
    const id = createdId(toolResults(answer)[0]);
    const card = await getTask(id);
    expect([card.boardId, card.userId]).toEqual([bobBoard.id, bob.id]);
    await waitFor(async () => (await getTask(id)).agentState === "running", RUN_TIMEOUT);

    // The admin sees every account's boards.
    const all = await chat(`every board ${calls({ toolName: "agentman_list_boards", arguments: {} })}`);
    for (const name of ["bob-board", ...boards.map((b) => b.name)]) expect(all).toContain(name);

    // Once bob logged out, his card's outcome is no longer relayed to his chat.
    expect(await say("/logout", bobChat)).toContain("Logged out");
    const from = tg.sent.length;
    await (await getAgentManager()).stop(id);
    await waitFor(async () => !isActive(await getTask(id)), RUN_TIMEOUT);
    await sleep(500);
    expect(sentSince(from, 77).filter((text) => text.includes("Run stopped"))).toEqual([]);
    expect((await chatStatus()).telegram.authorizedUsers).toBe(1);
  });

  it("changing the admin password logs chat users out", async () => {
    expect((await chatStatus()).telegram.authorizedUsers).toBe(1);
    const admin = await (await getRepo()).findUserAuthByLogin("admin");
    await setUserPassword(admin!.id, NEW_PASSWORD);
    expect(await say("show my boards")).toContain("/login");
    expect(await say(`/login ${ADMIN_PASSWORD}`)).toContain("Wrong username or password");
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
    expect(greeting).toContain("just tell me");
    // Nobody wrote to the bot meanwhile.
    expect(tg.nextUpdateId).toBe(updatesBefore);
    expect((await chatStatus()).telegram.authorizedUsers).toBe(1);
  });
});
