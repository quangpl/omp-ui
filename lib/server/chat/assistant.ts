// The chat assistant: every message an authorized chat user writes (other than /login, /logout,
// /stop) goes to a short omp helper agent that controls AgentMan through the `agentman_*` host
// tools below and answers in the chat. One request at a time per chat; later messages wait in order.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runOmpHelper } from "@/lib/agent/omp-helper";
import { childEnv } from "@/lib/child-env";
import { publish } from "@/lib/events";
import { dataDir } from "@/lib/files";
import { mcpAgentEnv } from "@/lib/server/mcp-env";
import { parseTitle } from "@/lib/server/validate";
import { getAppSettings } from "@/lib/settings";
import { STATUS_LABELS, TASK_STATUSES, type BoardWithCounts, type ChatPlatform, type Task, type TaskStatus } from "@/lib/types";
import { splitMessage, unwatchCard, watchCard } from "./relay";
import { getChatAdapter } from "./service";
import { loadChatState, updateChatState } from "./store";
import type { ChatEnv, IncomingChatMessage } from "./types";

/** The assistant is cancelled after this long. */
const TIMEOUT_SECONDS = 240;
/** Placeholder edits with the assistant's progress are at least this far apart. */
const ACTIVITY_EDIT_MS = 1500;
/** Exchanges remembered per chat, chats remembered, characters kept per remembered message. */
const MEMORY_EXCHANGES = 10;
const MEMORY_CHATS = 200;
const MEMORY_CLIP = 2000;
/** Shortest id prefix accepted in place of a full card/board id. */
const MIN_ID_PREFIX = 4;
const MAX_CANDIDATES = 10;
const MAX_DESCRIPTION = 20_000;
const MAX_MESSAGE = 4000;
/** Cards `agentman_list_cards` returns before summarizing the rest. */
const MAX_LISTED_CARDS = 60;
const RECENT_COMMENTS = 10;
const MAX_SUMMARY = 3000;

const PLACEHOLDER = "🤔 Working on it…";

type Json = Record<string, unknown>;

export interface ChatToolContext {
  platform: ChatPlatform;
  chatId: string;
}

interface Exchange {
  user: string;
  assistant: string;
}

interface ChatQueue {
  /** Messages waiting for the current request to finish. */
  pending: IncomingChatMessage[];
  /** The request in flight; null when idle. */
  current: AbortController | null;
}

// Survives dev HMR module reloads: one queue and one memory per chat and process.
const g = globalThis as unknown as {
  __ompUiChatAssistant?: { queues: Map<string, ChatQueue>; memory: Map<string, Exchange[]> };
};
const state = (g.__ompUiChatAssistant ??= { queues: new Map(), memory: new Map() });

function chatKey(platform: ChatPlatform, chatId: string): string {
  return `${platform}:${chatId}`;
}

/** Hand a message to the assistant; returns at once. Messages of one chat run one after another. */
export function runChatAssistant(env: ChatEnv, msg: IncomingChatMessage): void {
  const key = chatKey(msg.platform, msg.chatId);
  let queue = state.queues.get(key);
  if (!queue) state.queues.set(key, (queue = { pending: [], current: null }));
  queue.pending.push(msg);
  if (!queue.current) void drain(env, key, queue);
}

/** Abort the chat's request in flight and drop its waiting messages; true when there was any. */
export function cancelChatAssistant(platform: ChatPlatform, chatId: string): boolean {
  const queue = state.queues.get(chatKey(platform, chatId));
  if (!queue || (!queue.current && queue.pending.length === 0)) return false;
  queue.pending.length = 0;
  queue.current?.abort();
  return true;
}

/** Forget the chat's conversation (logout). */
export function forgetChatConversation(platform: ChatPlatform, chatId: string): void {
  state.memory.delete(chatKey(platform, chatId));
}

async function drain(env: ChatEnv, key: string, queue: ChatQueue): Promise<void> {
  for (let msg = queue.pending.shift(); msg; msg = queue.pending.shift()) {
    const controller = new AbortController();
    queue.current = controller;
    try {
      await answer(env, msg, controller.signal);
    } catch (err) {
      console.error("[chat] assistant failed:", err);
    } finally {
      queue.current = null;
    }
  }
  if (state.queues.get(key) === queue && queue.pending.length === 0) state.queues.delete(key);
}

/** One request: placeholder message, live progress, then the answer in its place. */
async function answer(env: ChatEnv, msg: IncomingChatMessage, signal: AbortSignal): Promise<void> {
  const adapter = getChatAdapter(msg.platform);
  let placeholderId: string | null = null;
  try {
    placeholderId = adapter ? await adapter.send(msg.chatId, PLACEHOLDER) : null;
  } catch (err) {
    console.error("[chat] assistant placeholder failed:", err);
  }
  // Progress edits are serialized and never overtake the final edit.
  let chain: Promise<void> = Promise.resolve();
  let lastEdit = 0;
  let finished = false;
  const onActivity = (text: string) => {
    if (!adapter || !placeholderId || finished || Date.now() - lastEdit < ACTIVITY_EDIT_MS) return;
    lastEdit = Date.now();
    const id = placeholderId;
    chain = chain.then(() => (finished ? undefined : adapter.edit(msg.chatId, id, `🤔 ${text}`).catch(() => undefined)));
  };
  let text: string;
  try {
    text = await ask(env, msg, signal, onActivity);
    remember(msg, text);
  } catch (err) {
    text = signal.aborted ? "⏹ Cancelled." : `⚠️ ${err instanceof Error ? err.message : String(err)}`;
  }
  finished = true;
  await chain;
  if (!adapter || !placeholderId) {
    await msg.reply(text);
    return;
  }
  const [first, ...rest] = splitMessage(text, adapter.maxMessageLength);
  try {
    await adapter.edit(msg.chatId, placeholderId, first ?? text);
    for (const chunk of rest) await adapter.send(msg.chatId, chunk);
  } catch (err) {
    console.error("[chat] assistant answer edit failed:", err);
    await msg.reply(text);
  }
}

async function ask(
  env: ChatEnv,
  msg: IncomingChatMessage,
  signal: AbortSignal,
  onActivity: (text: string) => void,
): Promise<string> {
  const settings = await getAppSettings(env.repo);
  const cwd = path.join(dataDir(), "chat-assistant");
  await mkdir(cwd, { recursive: true });
  const ctx: ChatToolContext = { platform: msg.platform, chatId: msg.chatId };
  return runOmpHelper({
    command: settings.ompPath,
    cwd,
    addDirs: [],
    model: settings.defaultModel.trim() || null,
    thinking: null,
    timeoutSeconds: TIMEOUT_SECONDS,
    env: childEnv(await mcpAgentEnv()),
    prompt: await buildPrompt(env, msg),
    signal,
    label: "chat assistant",
    onActivity,
    writing: "Writing the answer…",
    // Only the agentman_* tools: chat text and card content never get to read server files.
    tools: "",
    hostTools: {
      tools: CHAT_ASSISTANT_TOOLS,
      run: (name, args, toolSignal) => runChatTool(env, ctx, name, args, toolSignal),
    },
  });
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function remember(msg: IncomingChatMessage, reply: string): void {
  const key = chatKey(msg.platform, msg.chatId);
  const exchanges = state.memory.get(key) ?? [];
  exchanges.push({ user: clip(msg.text, MEMORY_CLIP), assistant: clip(reply, MEMORY_CLIP) });
  if (exchanges.length > MEMORY_EXCHANGES) exchanges.splice(0, exchanges.length - MEMORY_EXCHANGES);
  // Re-inserted so the Map's order is least recently used first.
  state.memory.delete(key);
  state.memory.set(key, exchanges);
  for (const oldest of state.memory.keys()) {
    if (state.memory.size <= MEMORY_CHATS) break;
    state.memory.delete(oldest);
  }
}

async function buildPrompt(env: ChatEnv, msg: IncomingChatMessage): Promise<string> {
  const boards = await env.repo.listBoards();
  const selectedId = (await loadChatState(env.repo)).selectedBoards[chatKey(msg.platform, msg.chatId)];
  const selected = boards.find((board) => board.id === selectedId) ?? boards[0];
  const platform = msg.platform === "telegram" ? "Telegram" : "Discord";
  const history = state.memory.get(chatKey(msg.platform, msg.chatId)) ?? [];
  return [
    "You are AgentMan's chat assistant. AgentMan runs omp coding agents on projects. Each project is a board of cards in three columns: To do, In progress, Done. Each card is a piece of work with its own omp agent; starting a card's agent moves it to In progress.",
    `The user is AgentMan's authenticated admin, writing to you from ${platform}${msg.isPrivate ? " (direct message)" : " (group or server channel)"}. They control AgentMan by talking to you in plain language.`,
    "",
    "How to work:",
    "- Do what the user asks with the agentman_* tools instead of describing how to do it. Look things up (agentman_list_boards, agentman_list_cards, agentman_read_card) before acting when you need ids or context.",
    "- Cards and boards can be named by id, by a unique id prefix (at least 4 characters), and boards also by name or number.",
    "- When the user asks for work to be done, create a card with a clear title and a self-contained description, and start it unless they only want it noted. A card's agent does not see this conversation.",
    "- Cards you start (or message) stream their agent's output into this chat automatically; do not wait for them.",
    "- Never delete anything; there is no tool for it.",
    "- Ask a short question only when the request is truly ambiguous (e.g. several boards fit and none is selected).",
    "- Reply in the user's language, in plain text for a chat app (no tables, no headings), at most about 1200 characters. Confirm what you did and give card ids as their first 8 characters.",
    "",
    `Now: ${new Date().toISOString()}`,
    `Boards: ${boards.length === 0 ? "none yet" : boards.map((board, index) => `${index + 1}. ${board.name} (${board.id.slice(0, 8)})`).join("; ")}`,
    `Default board of this chat: ${selected ? `${selected.name} (${selected.id.slice(0, 8)})` : "none"}`,
    ...(history.length > 0
      ? ["", "Recent conversation (oldest first):", ...history.flatMap((e: Exchange) => [`User: ${e.user}`, `You: ${e.assistant}`])]
      : []),
    "",
    "The user's new message:",
    "<new-message>",
    msg.text,
    "</new-message>",
  ].join("\n");
}

// ---- Tools ----

/** `set_host_tools` definitions of the AgentMan tools (JSON Schema parameters). */
export const CHAT_ASSISTANT_TOOLS = [
  {
    name: "agentman_list_boards",
    label: "List boards",
    description: "List AgentMan's boards (projects): number, id, name, folder, card counts per column. Marks this chat's default board.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agentman_select_board",
    label: "Select board",
    description: "Make a board this chat's default (used when a request names no board).",
    parameters: {
      type: "object",
      properties: { board: { type: "string", description: "Board number, id, id prefix or name." } },
      required: ["board"],
      additionalProperties: false,
    },
  },
  {
    name: "agentman_list_cards",
    label: "List cards",
    description: "List a board's cards (id, title, column, agent state, waits-for) and the agent queue. Defaults to this chat's board.",
    parameters: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board number, id, id prefix or name." },
        status: { type: "string", enum: [...TASK_STATUSES], description: "Only cards in this column." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentman_read_card",
    label: "Read card",
    description: "Read one card: description, column, agent state, latest run (status, summary or error) and recent comments.",
    parameters: {
      type: "object",
      properties: { cardId: { type: "string", description: "Card id or unique id prefix." } },
      required: ["cardId"],
      additionalProperties: false,
    },
  },
  {
    name: "agentman_create_card",
    label: "Create card",
    description:
      "Create a card. With start=true its agent starts working on it (In progress) and its output streams into this chat; otherwise it waits in To do.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short card title." },
        description: { type: "string", description: "Full, self-contained brief for the card's agent (markdown)." },
        board: { type: "string", description: "Board number, id, id prefix or name; default: this chat's board." },
        start: { type: "boolean", description: "Start the card's agent now (default false)." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "agentman_run_card",
    label: "Run card",
    description: "Start (or queue) a card's agent; its output streams into this chat.",
    parameters: {
      type: "object",
      properties: { cardId: { type: "string" } },
      required: ["cardId"],
      additionalProperties: false,
    },
  },
  {
    name: "agentman_stop_card",
    label: "Stop card",
    description: "Stop a card's running or queued agent; the card stays in its column.",
    parameters: {
      type: "object",
      properties: { cardId: { type: "string" } },
      required: ["cardId"],
      additionalProperties: false,
    },
  },
  {
    name: "agentman_message_card",
    label: "Message card",
    description:
      "Send feedback to a card's agent as the user: steered into its live run, or it resumes the card's agent (its output then streams into this chat).",
    parameters: {
      type: "object",
      properties: { cardId: { type: "string" }, message: { type: "string" } },
      required: ["cardId", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "agentman_move_card",
    label: "Move card",
    description: "Move a card to another column. Moving to In progress may start its agent; moving to To do or Done stops a running agent.",
    parameters: {
      type: "object",
      properties: { cardId: { type: "string" }, status: { type: "string", enum: [...TASK_STATUSES] } },
      required: ["cardId", "status"],
      additionalProperties: false,
    },
  },
] as const;

/** Run one AgentMan tool for the chat; the returned text is the tool result. Throws for a tool error. */
export async function runChatTool(
  env: ChatEnv,
  ctx: ChatToolContext,
  name: string,
  args: Json,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const { repo, manager } = env;
  switch (name) {
    case "agentman_list_boards": {
      const boards = await repo.listBoards();
      const current = (await chatBoard(env, ctx, ""))?.id;
      return JSON.stringify({
        boards: boards.map((board, index) => ({
          number: index + 1,
          id: board.id,
          name: board.name,
          folder: board.workdir,
          cards: board.counts,
          ...(board.id === current ? { chatDefault: true } : {}),
        })),
      });
    }
    case "agentman_select_board": {
      const board = await chatBoard(env, ctx, requiredString(args, "board"));
      if (!board) throw new Error(NO_BOARDS);
      await updateChatState(repo, (s) => {
        s.selectedBoards[chatKey(ctx.platform, ctx.chatId)] = board.id;
      });
      return `This chat now uses board "${board.name}" (${board.id}).`;
    }
    case "agentman_list_cards": {
      const board = await chatBoard(env, ctx, optionalString(args, "board"));
      if (!board) throw new Error(NO_BOARDS);
      const status = optionalStatus(args);
      const tasks = (await repo.listTasks(board.id)).filter((task) => !status || task.status === status);
      const { running, queued } = manager.stats();
      return JSON.stringify({
        board: { id: board.id, name: board.name },
        cards: tasks.slice(0, MAX_LISTED_CARDS).map(cardSummary),
        ...(tasks.length > MAX_LISTED_CARDS ? { more: tasks.length - MAX_LISTED_CARDS } : {}),
        queue: { running: running.length, queued: queued.length },
      });
    }
    case "agentman_read_card": {
      const task = await resolveCard(env, requiredString(args, "cardId"));
      const [runs, comments] = await Promise.all([repo.listRuns(task.id), repo.listComments(task.id)]);
      const latest = runs.reduce<(typeof runs)[number] | null>((a, b) => (!a || b.startedAt > a.startedAt ? b : a), null);
      return JSON.stringify({
        ...cardSummary(task),
        description: clip(task.description, MAX_SUMMARY),
        latestRun: latest
          ? {
              status: latest.status,
              startedAt: latest.startedAt,
              endedAt: latest.endedAt,
              summary: latest.summary ? clip(latest.summary, MAX_SUMMARY) : null,
              error: latest.error,
            }
          : null,
        comments: comments.slice(-RECENT_COMMENTS).map((c) => ({ author: c.author, body: clip(c.body, 500), at: c.createdAt })),
      });
    }
    case "agentman_create_card": {
      const title = parseTitle(requiredString(args, "title"));
      const description = optionalString(args, "description");
      if (description.length > MAX_DESCRIPTION) throw new Error(`description is longer than ${MAX_DESCRIPTION} characters`);
      const board = await chatBoard(env, ctx, optionalString(args, "board"));
      if (!board) throw new Error(NO_BOARDS);
      const start = args.start === true;
      let task = await repo.createTask({ boardId: board.id, title, description, status: "todo" });
      publish({ type: "task.updated", task });
      if (start) task = await startCard(env, ctx, task);
      return JSON.stringify({
        card: { id: task.id, title: task.title, board: board.name, status: STATUS_LABELS[task.status], agentState: task.agentState },
      });
    }
    case "agentman_run_card": {
      const task = await startCard(env, ctx, await resolveCard(env, requiredString(args, "cardId")));
      return JSON.stringify({ card: cardSummary(task), streaming: true });
    }
    case "agentman_stop_card": {
      const task = await resolveCard(env, requiredString(args, "cardId"));
      unwatchCard(ctx.platform, ctx.chatId, task.id);
      if (task.agentState !== "running" && task.agentState !== "queued") return `"${task.title}" is not running.`;
      const stopped = (await manager.stop(task.id)) ?? task;
      return JSON.stringify({ card: cardSummary(stopped), stopped: true });
    }
    case "agentman_message_card": {
      const task = await resolveCard(env, requiredString(args, "cardId"));
      const body = requiredString(args, "message");
      if (body.length > MAX_MESSAGE) throw new Error(`message is longer than ${MAX_MESSAGE} characters`);
      watchCard(ctx.platform, ctx.chatId, task.id);
      const comment = await repo.addComment({ taskId: task.id, author: "user", body });
      publish({ type: "comment.added", comment, boardId: task.boardId });
      const counted = (await repo.getTask(task.id)) ?? task;
      publish({ type: "task.updated", task: counted });
      await manager.onComment(counted, comment);
      return JSON.stringify({ card: cardSummary((await repo.getTask(task.id)) ?? counted), messageSent: true });
    }
    case "agentman_move_card": {
      const previous = await resolveCard(env, requiredString(args, "cardId"));
      const status = optionalStatus(args);
      if (!status) throw new Error(`status must be one of: ${TASK_STATUSES.join(", ")}`);
      if (status === previous.status) return JSON.stringify({ card: cardSummary(previous), moved: false });
      const task = await repo.updateTask(previous.id, { status });
      if (!task) throw new Error("Card not found");
      publish({ type: "task.updated", task });
      if (status === "in_progress") watchCard(ctx.platform, ctx.chatId, task.id);
      await manager.onTaskMoved(task, previous.status);
      return JSON.stringify({ card: cardSummary((await repo.getTask(task.id)) ?? task), moved: true });
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

const NO_BOARDS = "There are no boards yet: create a project in AgentMan first.";

/** Start a card's agent and stream it to the chat (watch first so no output is missed). */
async function startCard(env: ChatEnv, ctx: ChatToolContext, task: Task): Promise<Task> {
  watchCard(ctx.platform, ctx.chatId, task.id);
  try {
    return await env.manager.start(task.id);
  } catch (err) {
    unwatchCard(ctx.platform, ctx.chatId, task.id);
    throw err;
  }
}

function cardSummary(task: Task): Json {
  return {
    id: task.id,
    title: task.title,
    column: STATUS_LABELS[task.status],
    agentState: task.agentState,
    ...(task.blockedBy.length > 0 ? { waitsFor: task.blockedBy } : {}),
  };
}

function requiredString(args: Json, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function optionalString(args: Json, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function optionalStatus(args: Json): TaskStatus | null {
  const value = args.status;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value)) return value as TaskStatus;
  throw new Error(`status must be one of: ${TASK_STATUSES.join(", ")}`);
}

/** The board `query` names, else the chat's default board, else the first board; null when none exist. */
async function chatBoard(env: ChatEnv, ctx: ChatToolContext, query: string): Promise<BoardWithCounts | null> {
  const boards = await env.repo.listBoards();
  if (boards.length === 0) return null;
  if (query) return resolveBoard(boards, query);
  const selected = (await loadChatState(env.repo)).selectedBoards[chatKey(ctx.platform, ctx.chatId)];
  return boards.find((board) => board.id === selected) ?? boards[0];
}

/**
 * Board named by `query`: its 1-based number, exact id, unique id prefix, exact name
 * (case-insensitive), then unique name substring. Errors list the candidates.
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
  const list = (items: BoardWithCounts[]) =>
    items.map((board) => `${boards.indexOf(board) + 1}. ${board.name} (${board.id})`).join("; ");
  if (candidates.length > 1) throw new Error(`"${query}" matches several boards: ${list(candidates)}`);
  throw new Error(`No board matches "${query}". Boards: ${list(boards)}`);
}

/** Card by exact id, else by unique id prefix (≥ 4 characters) across every board. */
export async function resolveCard(env: ChatEnv, query: string): Promise<Task> {
  const exact = await env.repo.getTask(query);
  if (exact) return exact;
  if (query.length < MIN_ID_PREFIX) throw new Error(`Give at least ${MIN_ID_PREFIX} characters of the card id.`);
  const lower = query.toLowerCase();
  const matches: Task[] = [];
  for (const board of await env.repo.listBoards()) {
    for (const task of await env.repo.listTasks(board.id)) {
      if (task.id.toLowerCase().startsWith(lower)) matches.push(task);
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`No card matches "${query}".`);
  const lines = matches.slice(0, MAX_CANDIDATES).map((task) => `${task.id} ${clip(task.title, 60)}`);
  if (matches.length > MAX_CANDIDATES) lines.push(`…and ${matches.length - MAX_CANDIDATES} more`);
  throw new Error(`"${query}" matches several cards:\n${lines.join("\n")}`);
}
