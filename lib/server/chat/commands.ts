// Chat messages, identical on every platform. Only three commands: `/login`, `/logout`, `/stop`;
// everything else an authorized user writes goes to the chat assistant (assistant.ts), which
// controls AgentMan in natural language. Adapters hand every received message to `handleChatMessage`.
import { verifyPassword } from "@/lib/auth";
import { cancelChatAssistant, forgetChatConversation, resolveCard, runChatAssistant } from "./assistant";
import { unwatchCard } from "./relay";
import { getChatAdapter } from "./service";
import { authorizeUser, isAuthorized, revokeUser } from "./store";
import type { ChatEnv, IncomingChatMessage } from "./types";

/** The commands the bots understand; Discord registers its slash commands from this list. */
export const CHAT_COMMANDS: readonly { name: string; args: string; description: string }[] = [
  { name: "login", args: "<password>", description: "Connect this chat with the AgentMan admin password" },
  { name: "logout", args: "", description: "Disconnect this chat from AgentMan" },
  { name: "stop", args: "[cardId]", description: "Stop a card's agent, or cancel the current request" },
];

const LOGIN_HINT = "🔒 Send /login <admin password> first (only the AgentMan admin can control it).";
const EXAMPLES = [
  "show my boards",
  "create a card on omp-ui to fix the login page and start it",
  "what is running right now?",
  "tell card 1a2b to also add tests",
];
const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_MAX_GLOBAL_FAILURES = 20;
const LOGIN_GLOBAL_KEY = "*";

// Failed `/login` timestamps, survives dev HMR. Two buckets, both checked before verifyPassword:
// per `${platform}:${userId}` (LOGIN_MAX_FAILURES) and LOGIN_GLOBAL_KEY shared by every chat user
// on every platform (LOGIN_MAX_GLOBAL_FAILURES), so many accounts cannot multiply the guesses.
// A success clears only the user's own bucket.
const g = globalThis as unknown as { __ompUiChatLoginFailures?: Map<string, number[]> };
const loginFailures: Map<string, number[]> = (g.__ompUiChatLoginFailures ??= new Map());

/** Handle one received message. Never rejects: failures are replied as `⚠️ <message>`. */
export async function handleChatMessage(env: ChatEnv, msg: IncomingChatMessage): Promise<void> {
  try {
    await dispatch(env, msg);
  } catch (err) {
    console.error("[chat] message failed:", err);
    try {
      await msg.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
    } catch (replyErr) {
      console.error("[chat] reply failed:", replyErr);
    }
  }
}

async function dispatch(env: ChatEnv, msg: IncomingChatMessage): Promise<void> {
  const parsed = parseCommand(msg.text);
  if (parsed?.name === "login") {
    await login(env, msg, parsed.arg);
    return;
  }
  const authorized = await isAuthorized(env.repo, msg.platform, msg.userId);
  if (parsed && (parsed.name === "start" || parsed.name === "help")) {
    await msg.reply(introText(authorized));
    return;
  }
  if (!authorized) {
    await msg.reply(LOGIN_HINT);
    return;
  }
  if (parsed?.name === "logout") {
    cancelChatAssistant(msg.platform, msg.chatId);
    forgetChatConversation(msg.platform, msg.chatId);
    await revokeUser(env.repo, msg.platform, msg.userId);
    await msg.reply("Logged out. Send /login <admin password> to connect again.", { ephemeral: true });
    return;
  }
  if (parsed?.name === "stop") {
    await stop(env, msg, parsed.arg);
    return;
  }
  // Not awaited: /stop and /logout must never wait behind a running request.
  runChatAssistant(env, msg);
}

/** `/name@bot rest` → `{ name, arg }` (name lowercased, arg trimmed); null for non-command text. */
function parseCommand(text: string): { name: string; arg: string } | null {
  const match = /^\/([a-z0-9_]+)(?:@\S*)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  return { name: match[1].toLowerCase(), arg: (match[2] ?? "").trim() };
}

function introText(authorized: boolean): string {
  const lines = [
    "Tell me in plain words what you want AgentMan to do: look at boards and cards, create cards, start or stop agents, send feedback to a card's agent. Started cards stream their output here.",
    "",
    "For example:",
    ...EXAMPLES.map((example) => `• ${example}`),
    "",
    "Commands:",
    ...CHAT_COMMANDS.map((c) => `${c.args ? `/${c.name} ${c.args}` : `/${c.name}`} — ${c.description}`),
  ];
  if (!authorized) lines.push("", "Send /login <admin password> first.");
  return lines.join("\n");
}

/** `/stop <cardId>` stops a card's agent; `/stop` alone cancels the assistant's current request. */
async function stop(env: ChatEnv, msg: IncomingChatMessage, arg: string): Promise<void> {
  if (!arg) {
    const cancelled = cancelChatAssistant(msg.platform, msg.chatId);
    await msg.reply(cancelled ? "⏹ Cancelled the current request." : "Nothing to stop.");
    return;
  }
  const task = await resolveCard(env, arg);
  // Unwatch first: the reply below replaces the relay's "Run stopped" message.
  unwatchCard(msg.platform, msg.chatId, task.id);
  if (task.agentState !== "running" && task.agentState !== "queued") {
    await msg.reply(`"${task.title}" is not running.`);
    return;
  }
  await env.manager.stop(task.id);
  await msg.reply(`⏹ Stopped "${task.title}"`);
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
  await msg.reply(`AgentMan connected ✅ — just tell me what you want, e.g. "show my boards".${warning}`, {
    ephemeral: true,
  });
}
