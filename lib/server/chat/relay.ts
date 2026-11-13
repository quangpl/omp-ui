// Streams the agent output of watched cards (`/run`) back to the chats that started them:
// - each assistant message is one chat message, sent on its first delta and edited live
//   (at most once per EDIT_INTERVAL_MS), then replaced by the final text (split when too long);
// - tool calls become compact `🔧` lines, batched per TOOL_BATCH_MS; errors become `⚠️` lines;
// - a final status message when the run ends, after which the card is no longer watched.
// Everything a chat receives goes through its own promise chain, so edits never race sends and a
// failing chat never affects other chats or the event bus.
import { subscribe } from "@/lib/events";
import type { ChatPlatform, Run, RunEvent, ServerEvent } from "@/lib/types";
import { getChatAdapter } from "./service";
import type { ChatEnv, ChatTransport } from "./types";

/** Minimum time between two edits of a live message. */
const EDIT_INTERVAL_MS = 1500;
/** Tool lines arriving within this window after the first one share one message. */
const TOOL_BATCH_MS = 3000;
const TOOL_LINE_MAX = 200;
const RUN_ERROR_MAX = 500;
/** Live messages stay this far below the platform limit. */
const LIVE_MARGIN = 20;

/** The chat message showing an assistant message while it is generated. */
interface LiveMessage {
  taskId: string;
  /** Null until sent, or when the platform gave no id / sending failed (then nothing is edited). */
  messageId: string | null;
  /** Latest accumulated text from `run.delta`. */
  latest: string;
  /** `latest` as of the last send/edit. */
  pushed: string;
  /** Text the chat message shows (tail-truncated `pushed`). */
  shown: string;
  lastPushAt: number;
  timer: NodeJS.Timeout | null;
  /** A send or edit of this message is queued or in flight. */
  busy: boolean;
  /** Finalized or dropped: no more edits. */
  done: boolean;
}

interface RelayChat {
  platform: ChatPlatform;
  chatId: string;
  /** Serializes everything sent to this chat. Never rejects. */
  chain: Promise<void>;
  /** runId → live message of the run's current assistant message. */
  live: Map<string, LiveMessage>;
  tools: { lines: string[]; timer: NodeJS.Timeout } | null;
}

interface RelayState {
  env: ChatEnv | null;
  unsubscribe: (() => void) | null;
  /** taskId → watch keys (`${platform}\u0000${chatId}`). */
  watches: Map<string, Set<string>>;
  /** watch key → chat. */
  chats: Map<string, RelayChat>;
}

// Survives dev HMR module reloads: one relay per process.
const g = globalThis as unknown as { __ompUiChatRelay?: RelayState };
const relay: RelayState = (g.__ompUiChatRelay ??= {
  env: null,
  unsubscribe: null,
  watches: new Map(),
  chats: new Map(),
});

/** Start relaying watched cards' output; idempotent (later calls only refresh `env`). */
export function startChatRelay(env: ChatEnv): void {
  relay.env = env;
  relay.unsubscribe ??= subscribe(onEvent);
}

/** Stream the card's runs to the chat until the current run ends. */
export function watchCard(platform: ChatPlatform, chatId: string, taskId: string): void {
  const key = `${platform}\u0000${chatId}`;
  if (!relay.chats.has(key)) {
    relay.chats.set(key, { platform, chatId, chain: Promise.resolve(), live: new Map(), tools: null });
  }
  let keys = relay.watches.get(taskId);
  if (!keys) relay.watches.set(taskId, (keys = new Set()));
  keys.add(key);
}

/** Stop streaming the card to the chat; its live message is left as it is. */
export function unwatchCard(platform: ChatPlatform, chatId: string, taskId: string): void {
  const key = `${platform}\u0000${chatId}`;
  const keys = relay.watches.get(taskId);
  if (keys) {
    keys.delete(key);
    if (keys.size === 0) relay.watches.delete(taskId);
  }
  const chat = relay.chats.get(key);
  if (!chat) return;
  for (const [runId, live] of chat.live) {
    if (live.taskId !== taskId) continue;
    chat.live.delete(runId);
    live.done = true;
    clearTimeout(live.timer ?? undefined);
  }
}

/**
 * Split text into messages of at most `max` characters, on line boundaries; longer lines are
 * hard-split (never inside a surrogate pair). Blank chunks are dropped.
 */
export function splitMessage(text: string, max: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current);
    current = "";
  };
  for (const line of text.split("\n")) {
    if (current && current.length + 1 + line.length <= max) {
      current += `\n${line}`;
      continue;
    }
    flush();
    let rest = line;
    while (rest.length > max) {
      let cut = max;
      if (cut > 1 && isHighSurrogate(rest.charCodeAt(cut - 1))) cut--;
      const piece = rest.slice(0, cut);
      if (piece.trim()) chunks.push(piece);
      rest = rest.slice(cut);
    }
    current = rest;
  }
  flush();
  return chunks;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function onEvent(event: ServerEvent): void {
  try {
    if (event.type === "run.delta") {
      if (event.kind !== "text") return;
      for (const chat of watchers(event.taskId)) onDelta(chat, event.taskId, event.runId, event.text);
    } else if (event.type === "run.event") {
      onRunEvent(event.event);
    } else if (event.type === "run.updated" && event.run.status !== "running") {
      onRunFinished(event.run).catch((err) => console.error("[chat] relay run end failed:", err));
    }
  } catch (err) {
    console.error("[chat] relay event failed:", err);
  }
}

function watchers(taskId: string): RelayChat[] {
  const keys = relay.watches.get(taskId);
  if (!keys) return [];
  const chats: RelayChat[] = [];
  for (const key of keys) {
    const chat = relay.chats.get(key);
    if (chat) chats.push(chat);
  }
  return chats;
}

/** Queue a step on the chat's chain; dropped when the platform is not connected. Errors are logged. */
function enqueue(chat: RelayChat, what: string, step: (transport: ChatTransport) => Promise<void>): void {
  chat.chain = chat.chain.then(async () => {
    const transport = getChatAdapter(chat.platform);
    if (!transport) return;
    try {
      await step(transport);
    } catch (err) {
      console.error(`[chat] relay ${what} failed (${chat.platform} ${chat.chatId}):`, err);
    }
  });
}

/** Tail of `text` that fits a live message, with a leading "…" when cut. */
function liveText(text: string, max: number): string {
  const limit = max - LIVE_MARGIN;
  if (text.length <= limit) return text;
  let start = text.length - (limit - 1);
  if (!isHighSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) start++;
  return `…${text.slice(start)}`;
}

function onDelta(chat: RelayChat, taskId: string, runId: string, text: string): void {
  const live = chat.live.get(runId);
  if (live) {
    live.latest = text;
    scheduleEdit(chat, live);
    return;
  }
  if (!text.trim()) return;
  flushTools(chat);
  const message: LiveMessage = {
    taskId,
    messageId: null,
    latest: text,
    pushed: "",
    shown: "",
    lastPushAt: Date.now(),
    timer: null,
    busy: true,
    done: false,
  };
  chat.live.set(runId, message);
  enqueue(chat, "send", async (transport) => {
    try {
      const body = liveText(message.latest, transport.maxMessageLength);
      message.pushed = message.latest;
      message.messageId = await transport.send(chat.chatId, body);
      message.shown = body;
    } finally {
      settlePush(chat, message);
    }
  });
}

/** After a send/edit: allow the next one, and schedule it when newer text arrived meanwhile. */
function settlePush(chat: RelayChat, live: LiveMessage): void {
  live.lastPushAt = Date.now();
  live.busy = false;
  scheduleEdit(chat, live);
}

/** Edit the live message with its latest text, at most once per EDIT_INTERVAL_MS (trailing). */
function scheduleEdit(chat: RelayChat, live: LiveMessage): void {
  if (live.done || live.busy || live.timer || live.latest === live.pushed) return;
  const delay = Math.max(0, live.lastPushAt + EDIT_INTERVAL_MS - Date.now());
  live.timer = setTimeout(() => {
    live.timer = null;
    if (live.done) return;
    live.busy = true;
    enqueue(chat, "edit", async (transport) => {
      try {
        if (live.done) return;
        live.pushed = live.latest;
        if (live.messageId === null) return;
        const body = liveText(live.latest, transport.maxMessageLength);
        if (body === live.shown) return;
        await transport.edit(chat.chatId, live.messageId, body);
        live.shown = body;
      } finally {
        settlePush(chat, live);
      }
    });
  }, delay);
}

/**
 * End the run's live message with `finalText` (null: its latest streamed text): the live message
 * gets the first chunk, further chunks are sent after it. Without a live message every chunk is sent.
 */
function finalize(chat: RelayChat, runId: string, finalText: string | null): void {
  const live = chat.live.get(runId);
  if (live) {
    chat.live.delete(runId);
    live.done = true;
    clearTimeout(live.timer ?? undefined);
    live.timer = null;
  }
  flushTools(chat);
  const text = (finalText ?? live?.latest ?? "").trim();
  if (!text) return;
  enqueue(chat, "final message", async (transport) => {
    let chunks = splitMessage(text, transport.maxMessageLength);
    if (live?.messageId && chunks.length > 0) {
      if (chunks[0] === live.shown) {
        chunks = chunks.slice(1);
      } else {
        try {
          await transport.edit(chat.chatId, live.messageId, chunks[0]);
          chunks = chunks.slice(1);
        } catch (err) {
          // Fall back to sending the whole text as new messages.
          console.error(`[chat] relay final edit failed (${chat.platform} ${chat.chatId}):`, err);
        }
      }
    }
    for (const chunk of chunks) await transport.send(chat.chatId, chunk);
  });
}

function onRunEvent(event: RunEvent): void {
  if (event.kind !== "text" && event.kind !== "tool" && event.kind !== "error") return;
  for (const chat of watchers(event.taskId)) {
    if (event.kind === "text") {
      finalize(chat, event.runId, event.text);
    } else if (event.kind === "tool") {
      addToolLine(chat, event.text);
    } else {
      flushTools(chat);
      const text = `⚠️ ${event.text.trim()}`;
      enqueue(chat, "error", async (transport) => {
        for (const chunk of splitMessage(text, transport.maxMessageLength)) await transport.send(chat.chatId, chunk);
      });
    }
  }
}

/** `🔧 <first line>` (tool events read `▸ name: detail`), batched with the lines of the next TOOL_BATCH_MS. */
function addToolLine(chat: RelayChat, text: string): void {
  const firstLine = text.trim().split("\n", 1)[0].replace(/^▸\s*/, "");
  const line = `🔧 ${firstLine.length <= TOOL_LINE_MAX ? firstLine : `${firstLine.slice(0, TOOL_LINE_MAX - 1)}…`}`;
  if (chat.tools) {
    chat.tools.lines.push(line);
    return;
  }
  chat.tools = { lines: [line], timer: setTimeout(() => flushTools(chat), TOOL_BATCH_MS) };
}

/** Send the pending tool lines now (before anything else is sent, to keep the chat in order). */
function flushTools(chat: RelayChat): void {
  const batch = chat.tools;
  if (!batch) return;
  chat.tools = null;
  clearTimeout(batch.timer);
  enqueue(chat, "tool lines", async (transport) => {
    for (const chunk of splitMessage(batch.lines.join("\n"), transport.maxMessageLength)) {
      await transport.send(chat.chatId, chunk);
    }
  });
}

/** Run ended: flush its output, send the outcome to every watching chat, then stop watching the card. */
async function onRunFinished(run: Run): Promise<void> {
  const chats = watchers(run.taskId);
  if (chats.length === 0) return;
  relay.watches.delete(run.taskId);
  let title = run.taskId;
  try {
    title = (await relay.env?.repo.getTask(run.taskId))?.title ?? title;
  } catch (err) {
    console.error("[chat] relay card lookup failed:", err);
  }
  let outcome: string;
  if (run.status === "succeeded") {
    outcome = "✅ Run finished";
  } else if (run.status === "failed") {
    const reason = run.error?.trim();
    const clipped = reason && reason.length > RUN_ERROR_MAX ? `${reason.slice(0, RUN_ERROR_MAX - 1)}…` : reason;
    outcome = clipped ? `❌ Run failed: ${clipped}` : "❌ Run failed";
  } else {
    outcome = "⏹ Run stopped";
  }
  const text = `${outcome} — "${title}"`;
  for (const chat of chats) {
    finalize(chat, run.id, null);
    enqueue(chat, "run outcome", async (transport) => {
      for (const chunk of splitMessage(text, transport.maxMessageLength)) await transport.send(chat.chatId, chunk);
    });
  }
}
