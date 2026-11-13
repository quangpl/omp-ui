// Chat commands (`/create`, `/boards`, `/status`, `/run`, `/stop`, …), identical on every platform.
// Adapters hand every received message to `handleChatMessage`; replies go back through `msg.reply`.
import { setTimeout as sleep } from "node:timers/promises";
import { verifyPassword } from "@/lib/auth";
import { publish } from "@/lib/events";
import { parseTitle } from "@/lib/server/validate";
import { STATUS_LABELS, type Board, type BoardWithCounts, type Task, type TaskStatus } from "@/lib/types";
import { unwatchCard, watchCard } from "./relay";
import { getChatAdapter } from "./service";
import { authorizeUser, isAuthorized, loadChatState, revokeUser, updateChatState } from "./store";
import type { ChatEnv, IncomingChatMessage } from "./types";

/** Every command the bots understand; Discord registers its slash commands from this list. */
export const CHAT_COMMANDS: readonly { name: string; args: string; description: string }[] = [
  { name: "login", args: "<password>", description: "Connect this chat with the AgentMan admin password" },
  { name: "logout", args: "", description: "Disconnect this chat from AgentMan" },
  { name: "boards", args: "", description: "List boards" },
  { name: "board", args: "<board>", description: "Pick the board /create and /status use in this chat" },
  { name: "create", args: "<title>", description: "Create a card in To do on the selected board" },
  { name: "status", args: "[board]", description: "Show the cards of a board and the agent queue" },
  { name: "run", args: "<cardId>", description: "Start a card's agent and stream its output here" },
  { name: "stop", args: "<cardId>", description: "Stop a card's agent" },
  { name: "help", args: "", description: "Show this help" },
];

const LOGIN_HINT = "🔒 Send /login <admin password> first (only the AgentMan admin can control it).";
const NO_BOARDS = "No boards yet — create one in AgentMan.";
const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_MAX_GLOBAL_FAILURES = 20;
const LOGIN_GLOBAL_KEY = "*";
/** Card lines `/status` lists before summarizing the rest. */
const STATUS_MAX_CARDS = 40;
/** Columns in `/status` order: active work first, so the cap cuts Done cards. */
const STATUS_ORDER: readonly TaskStatus[] = ["in_progress", "todo", "done"];
/** Shortest id prefix accepted in place of a full card/board id. */
const MIN_ID_PREFIX = 4;
/** Ambiguous card matches listed before "…". */
const MAX_CANDIDATES = 10;
/** How long `/run` waits for a queued run to start before reporting it as queued. */
const START_WAIT_MS = 2000;
const START_POLL_MS = 100;

// Failed `/login` timestamps, survives dev HMR. Two buckets, both checked before verifyPassword:
// per `${platform}:${userId}` (LOGIN_MAX_FAILURES) and LOGIN_GLOBAL_KEY shared by every chat user
// on every platform (LOGIN_MAX_GLOBAL_FAILURES), so many accounts cannot multiply the guesses.
// A success clears only the user's own bucket.
const g = globalThis as unknown as { __ompUiChatLoginFailures?: Map<string, number[]> };
const loginFailures: Map<string, number[]> = (g.__ompUiChatLoginFailures ??= new Map());

/** A problem with the user's input (bad argument, no match); replied as `⚠️ <message>`, not logged. */
class CommandError extends Error {}

/** Run one received message. Never rejects: failures are replied as `⚠️ <message>`. */
export async function handleChatMessage(env: ChatEnv, msg: IncomingChatMessage): Promise<void> {
  try {
    await dispatch(env, msg);
  } catch (err) {
    if (!(err instanceof CommandError)) console.error("[chat] command failed:", err);
    const message = err instanceof Error ? err.message : String(err);
    try {
      await msg.reply(`⚠️ ${message}`);
    } catch (replyErr) {
      console.error("[chat] reply failed:", replyErr);
    }
  }
}

async function dispatch(env: ChatEnv, msg: IncomingChatMessage): Promise<void> {
  const { repo } = env;
  const parsed = parseCommand(msg.text);
  if (!parsed) {
    const authorized = await isAuthorized(repo, msg.platform, msg.userId);
    await msg.reply(authorized ? "Send /help to see what I can do." : LOGIN_HINT);
    return;
  }
  const { name, arg } = parsed;
  if (name === "start" || name === "help") {
    await msg.reply(helpText(await isAuthorized(repo, msg.platform, msg.userId)));
    return;
  }
  if (name === "login") {
    await login(env, msg, arg);
    return;
  }
  if (!CHAT_COMMANDS.some((command) => command.name === name)) {
    await msg.reply("Unknown command. Send /help");
    return;
  }
  if (!(await isAuthorized(repo, msg.platform, msg.userId))) {
    await msg.reply(LOGIN_HINT);
    return;
  }
  switch (name) {
    case "logout":
      await revokeUser(repo, msg.platform, msg.userId);
      await msg.reply("Logged out. Send /login <admin password> to connect again.", { ephemeral: true });
      return;
    case "boards":
      await msg.reply(await boardsText(env, msg));
      return;
    case "board":
      await selectBoard(env, msg, arg);
      return;
    case "create":
      await createCard(env, msg, arg);
      return;
    case "status":
      await msg.reply(await statusText(env, msg, arg));
      return;
    case "run":
      await runCard(env, msg, arg);
      return;
    case "stop":
      await stopCard(env, msg, arg);
      return;
  }
}

/** `/name@bot rest` → `{ name, arg }` (name lowercased, arg trimmed); null for non-command text. */
function parseCommand(text: string): { name: string; arg: string } | null {
  const match = /^\/([a-z0-9_]+)(?:@\S*)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  return { name: match[1].toLowerCase(), arg: (match[2] ?? "").trim() };
}

function helpText(authorized: boolean): string {
  const lines = ["AgentMan commands:"];
  for (const command of CHAT_COMMANDS) {
    const usage = command.args ? `/${command.name} ${command.args}` : `/${command.name}`;
    lines.push(`${usage} — ${command.description}`);
  }
  lines.push("", "Card and board ids may be shortened to their first characters (at least 4).");
  if (!authorized) lines.push("", "Send /login <admin password> first.");
  return lines.join("\n");
}

async function login(env: ChatEnv, msg: IncomingChatMessage, password: string): Promise<void> {
  // The password must not linger in the chat, whatever the outcome.
  if (msg.messageId) await getChatAdapter(msg.platform)?.deleteMessage(msg.chatId, msg.messageId);
  if (!password) {
    await msg.reply("Usage: /login <admin password>", { ephemeral: true });
    return;
  }
  const key = `${msg.platform}:${msg.userId}`;
  const now = Date.now();
  const buckets = [
    { key, max: LOGIN_MAX_FAILURES },
    { key: LOGIN_GLOBAL_KEY, max: LOGIN_MAX_GLOBAL_FAILURES },
  ].map((bucket) => {
    // Pruned in place (never replaced) so concurrent logins share the same arrays.
    let failures = loginFailures.get(bucket.key);
    if (!failures) loginFailures.set(bucket.key, (failures = []));
    while (failures.length > 0 && now - failures[0] >= LOGIN_WINDOW_MS) failures.shift();
    return { ...bucket, failures };
  });
  const blockedUntil = Math.max(
    0,
    ...buckets
      .filter((bucket) => bucket.failures.length >= bucket.max)
      .map((bucket) => bucket.failures[bucket.failures.length - bucket.max] + LOGIN_WINDOW_MS),
  );
  if (blockedUntil > now) {
    const minutes = Math.max(1, Math.ceil((blockedUntil - now) / 60_000));
    await msg.reply(`Too many attempts, try again in ${minutes} min.`, { ephemeral: true });
    return;
  }
  const warning = msg.isPrivate
    ? ""
    : "\n⚠️ This is not a private chat: send /login in a direct message to the bot so nobody sees your password.";
  // Counted as a failure before checking, so concurrent guesses cannot all slip under the limit.
  for (const bucket of buckets) bucket.failures.push(now);
  if (!(await verifyPassword(password))) {
    await msg.reply(`Wrong password.${warning}`, { ephemeral: true });
    return;
  }
  loginFailures.delete(key);
  const shared = buckets[1].failures;
  const reserved = shared.lastIndexOf(now);
  if (reserved >= 0) shared.splice(reserved, 1);
  await authorizeUser(env.repo, {
    platform: msg.platform,
    userId: msg.userId,
    userName: msg.userName,
    chatId: msg.chatId,
  });
  await msg.reply(
    `AgentMan connected ✅ — you can now control AgentMan from this chat. Send /help.${warning}`,
    { ephemeral: true },
  );
}

// ---- Boards ----

/** `ChatState.selectedBoards` key of the message's chat. */
function selectionKey(msg: IncomingChatMessage): string {
  return `${msg.platform}:${msg.chatId}`;
}

async function selectedBoardId(env: ChatEnv, msg: IncomingChatMessage): Promise<string | null> {
  return (await loadChatState(env.repo)).selectedBoards[selectionKey(msg)] ?? null;
}

/** The board `arg` names, else the chat's selected board, else the first board. */
async function targetBoard(env: ChatEnv, msg: IncomingChatMessage, arg: string): Promise<Board> {
  const boards = await env.repo.listBoards();
  if (boards.length === 0) throw new CommandError(NO_BOARDS);
  if (arg) return resolveBoard(boards, arg);
  const selected = await selectedBoardId(env, msg);
  return boards.find((board) => board.id === selected) ?? boards[0];
}

function boardLine(board: BoardWithCounts, index: number): string {
  const cards = Object.values(board.counts).reduce((sum, count) => sum + count, 0);
  return `${index + 1}. ${board.name} — ${board.id} (${cards} ${cards === 1 ? "card" : "cards"})`;
}

/**
 * Board named by `query`: its number in `/boards` (1-based), exact id, unique id prefix, exact
 * name (case-insensitive), then unique name substring. Errors list the candidates.
 */
function resolveBoard(boards: BoardWithCounts[], query: string): BoardWithCounts {
  if (/^\d+$/.test(query)) {
    const index = Number(query);
    if (index >= 1 && index <= boards.length) return boards[index - 1];
  }
  const exact = boards.find((board) => board.id === query);
  if (exact) return exact;
  const lower = query.toLowerCase();
  const byPrefix =
    query.length >= MIN_ID_PREFIX ? boards.filter((board) => board.id.toLowerCase().startsWith(lower)) : [];
  if (byPrefix.length === 1) return byPrefix[0];
  const byName = boards.filter((board) => board.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  let candidates = byName.length > 1 ? byName : boards.filter((board) => board.name.toLowerCase().includes(lower));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) candidates = byPrefix;
  if (candidates.length > 1) {
    const lines = candidates.map((board) => boardLine(board, boards.indexOf(board)));
    throw new CommandError(`"${query}" matches several boards:\n${lines.join("\n")}\nUse its number or id.`);
  }
  const lines = boards.map((board, index) => `${index + 1}. ${board.name}`);
  throw new CommandError(`No board matches "${query}". Boards:\n${lines.join("\n")}`);
}

async function boardsText(env: ChatEnv, msg: IncomingChatMessage): Promise<string> {
  const boards = await env.repo.listBoards();
  if (boards.length === 0) return NO_BOARDS;
  const selected = await selectedBoardId(env, msg);
  const explicit = boards.some((board) => board.id === selected);
  const current = explicit ? selected : boards[0].id;
  const lines = boards.map((board, index) => {
    const mark = board.id === current ? (explicit ? "  ← selected" : "  ← default") : "";
    return `${boardLine(board, index)}${mark}`;
  });
  lines.push("", "Pick the board for /create and /status with /board <number|name|id>.");
  return lines.join("\n");
}

async function selectBoard(env: ChatEnv, msg: IncomingChatMessage, arg: string): Promise<void> {
  if (!arg) {
    const board = await targetBoard(env, msg, "");
    await msg.reply(`This chat uses "${board.name}" (${board.id}). Change it with /board <number|name|id>.`);
    return;
  }
  const board = await targetBoard(env, msg, arg);
  const key = selectionKey(msg);
  await updateChatState(env.repo, (state) => {
    state.selectedBoards[key] = board.id;
  });
  await msg.reply(`✅ /create and /status now use "${board.name}" (${board.id}).`);
}

// ---- Cards ----

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

async function createCard(env: ChatEnv, msg: IncomingChatMessage, arg: string): Promise<void> {
  if (!arg) throw new CommandError("Usage: /create <title>");
  let title: string;
  try {
    title = parseTitle(arg);
  } catch (err) {
    await msg.reply(err instanceof Error ? err.message : String(err));
    return;
  }
  const board = await targetBoard(env, msg, "");
  const task = await env.repo.createTask({ boardId: board.id, title, status: "todo" });
  publish({ type: "task.updated", task });
  await msg.reply(
    `Created card ${task.id} "${task.title}" on ${board.name} (${STATUS_LABELS.todo}). Start it with /run ${task.id}`,
  );
}

async function statusText(env: ChatEnv, msg: IncomingChatMessage, arg: string): Promise<string> {
  const board = await targetBoard(env, msg, arg);
  const tasks = await env.repo.listTasks(board.id);
  const { running, queued } = env.manager.stats();
  const lines = [
    `📋 ${board.name} — ${tasks.length} ${tasks.length === 1 ? "card" : "cards"}`,
    `Agents (all boards): ${running.length} running, ${queued.length} queued`,
  ];
  let shown = 0;
  for (const status of STATUS_ORDER) {
    const column = tasks.filter((task) => task.status === status);
    if (column.length === 0) continue;
    lines.push("", `${STATUS_LABELS[status]} (${column.length})`);
    for (const task of column) {
      if (shown >= STATUS_MAX_CARDS) break;
      const state = task.agentState === "idle" ? "" : `[${task.agentState}] `;
      lines.push(`• ${state}${task.id.slice(0, 8)} ${clip(task.title, 80)}`);
      shown++;
    }
  }
  if (tasks.length === 0) lines.push("", "No cards yet — add one with /create <title>.");
  if (tasks.length > shown) lines.push("", `…and ${tasks.length - shown} more`);
  return lines.join("\n");
}

/** Card by exact id, else by unique id prefix (≥ 4 chars) across every board. */
async function resolveCard(env: ChatEnv, query: string, usage: string): Promise<Task> {
  if (!query) throw new CommandError(`Usage: ${usage}`);
  const exact = await env.repo.getTask(query);
  if (exact) return exact;
  if (query.length < MIN_ID_PREFIX) {
    throw new CommandError(`Give at least ${MIN_ID_PREFIX} characters of the card id (see /status).`);
  }
  const lower = query.toLowerCase();
  const matches: Task[] = [];
  for (const board of await env.repo.listBoards()) {
    for (const task of await env.repo.listTasks(board.id)) {
      if (task.id.toLowerCase().startsWith(lower)) matches.push(task);
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new CommandError(`No card matches "${query}". Send /status to see card ids.`);
  const lines = matches.slice(0, MAX_CANDIDATES).map((task) => `${task.id} ${clip(task.title, 60)}`);
  if (matches.length > MAX_CANDIDATES) lines.push(`…and ${matches.length - MAX_CANDIDATES} more`);
  throw new CommandError(`"${query}" matches several cards:\n${lines.join("\n")}\nGive more of the id.`);
}

async function runCard(env: ChatEnv, msg: IncomingChatMessage, arg: string): Promise<void> {
  const task = await resolveCard(env, arg, "/run <cardId>");
  const wasActive = task.agentState === "running" || task.agentState === "queued";
  // Watch first so the run's first output is not missed.
  watchCard(msg.platform, msg.chatId, task.id);
  let started: Task;
  try {
    started = await env.manager.start(task.id);
  } catch (err) {
    unwatchCard(msg.platform, msg.chatId, task.id);
    throw err;
  }
  // start() only queues the run (the queue starts it right after): wait briefly so a card that gets
  // a free slot is reported as started, not queued.
  const deadline = Date.now() + START_WAIT_MS;
  while (started.agentState === "queued" && Date.now() < deadline) {
    await sleep(START_POLL_MS);
    started = (await env.repo.getTask(task.id)) ?? started;
  }
  const label = `"${started.title}" (${started.id})`;
  if (started.agentState === "queued") {
    const { queued } = env.manager.stats();
    const index = queued.indexOf(started.id);
    const position = index >= 0 ? ` (position ${index + 1} of ${queued.length})` : "";
    await msg.reply(
      `⏳ ${wasActive ? "Already queued" : "Queued"} ${label}${position}. Its output will stream here once it starts…`,
    );
  } else if (wasActive) {
    await msg.reply(`▶️ ${label} is already running. Streaming its output here…`);
  } else {
    await msg.reply(`▶️ Started ${label}. Streaming its output here…`);
  }
}

async function stopCard(env: ChatEnv, msg: IncomingChatMessage, arg: string): Promise<void> {
  const task = await resolveCard(env, arg, "/stop <cardId>");
  // Unwatch first: the reply below replaces the relay's "Run stopped" message.
  unwatchCard(msg.platform, msg.chatId, task.id);
  if (task.agentState !== "running" && task.agentState !== "queued") {
    await msg.reply(`"${task.title}" is not running.`);
    return;
  }
  await env.manager.stop(task.id);
  await msg.reply(`⏹ Stopped "${task.title}"`);
}
