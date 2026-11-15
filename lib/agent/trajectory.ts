/**
 * Trajectory export of card runs, in the ShareGPT JSONL format Hermes (NousResearch) writes for
 * debugging and training datasets: `{ conversations: [{ from, value }], timestamp, model, completed }`
 * with `from` one of system / human / gpt / tool. Tool calls are embedded in the gpt turn as
 * `<tool_call>{json}</tool_call>` and their results become tool turns `<tool_response>{json}</tool_response>`.
 *
 * `sessionToConversations` turns an omp session file (one JSON object per line; `message` lines
 * carry the conversation) into turns, optionally limited to one run's time window of a resumed
 * session. `compressTrajectory` mirrors Hermes' trajectory compressor: below the token target the
 * trajectory is left alone; above it, large old tool outputs are pruned to short stubs first
 * (deterministic, cheap), then whole middle turns are replaced by one summary turn while the head
 * (the leading run of distinct roles, completed to a whole call group) and the last few turns stay
 * verbatim and no tool call is ever separated from its responses. `redactTrajectory` replaces known
 * secret values and common token shapes so a trajectory can be shared.
 *
 * Pure: no I/O; the API routes read the session file.
 */

type Json = Record<string, unknown>;

export type TrajectoryRole = "system" | "human" | "gpt" | "tool";

export interface TrajectoryTurn {
  from: TrajectoryRole;
  value: string;
}

export interface TrajectoryMetrics {
  originalTokens: number;
  compressedTokens: number;
  tokensSaved: number;
  /** compressedTokens / originalTokens (1 when nothing was compressed). */
  compressionRatio: number;
  /** Whole turns replaced by the summary turn. */
  turnsRemoved: number;
  /** Tool turns whose output was cut down to a stub. */
  toolResultsPruned: number;
}

export interface Trajectory {
  conversations: TrajectoryTurn[];
  /** ISO time the trajectory was taken (the run's end for a run export). */
  timestamp: string;
  /** `provider/model` the run used, when the session names one. */
  model: string | null;
  /** Whether the run finished successfully. */
  completed: boolean;
  taskId: string;
  /** Run the trajectory covers; null for the card's whole session. */
  runId: string | null;
  /** Set by compressTrajectory. */
  metrics?: TrajectoryMetrics;
}

/** Hermes' trajectory compressor target. */
export const TRAJECTORY_TARGET_TOKENS = 15_250;
/** Turns at the end of a trajectory that compression never touches. */
export const PROTECT_LAST_TURNS = 4;
/** Tool outputs longer than this (characters) are pruned to a stub when compressing. */
const PRUNE_MIN_CHARS = 2_000;
/** Characters kept from each end of a pruned tool output. */
const PRUNE_KEEP_CHARS = 200;

// `s` flag: tool output may contain U+2028/U+2029, which JSON.stringify leaves unescaped and `.`
// would not match otherwise. Calls are lazy: JSON never holds a raw newline, so the first
// `\n</tool_call>` closes the call.
const TOOL_CALL_RE = /<tool_call>\n([\s\S]*?)\n<\/tool_call>/g;
const TOOL_RESPONSE_RE = /^<tool_response>\n([\s\S]*)\n<\/tool_response>$/;

/** Rough token count (4 characters per token), as used for the compression target. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Epoch ms of an ISO string or ms epoch (number or numeric string); null when unparseable. */
function toMs(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Text of a message's content: text blocks joined by newlines, images as `[image]`, thinking dropped. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

function toolResponseTag(name: string, content: string, isError: boolean): string {
  return `<tool_response>\n${JSON.stringify({ name, content, is_error: isError })}\n</tool_response>`;
}

function assistantValue(content: unknown): string {
  const text = contentText(content);
  const calls: string[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isObject(block) && block.type === "toolCall" && typeof block.name === "string") {
        calls.push(`<tool_call>\n${JSON.stringify({ name: block.name, arguments: block.arguments ?? {} })}\n</tool_call>`);
      }
    }
  }
  return [text, ...calls].filter(Boolean).join("\n");
}

/** One omp session message as a trajectory turn; null for roles without one or empty messages. */
function messageTurn(message: Json): TrajectoryTurn | null {
  switch (message.role) {
    case "developer": {
      const value = contentText(message.content);
      return value ? { from: "system", value } : null;
    }
    case "user": {
      const value = contentText(message.content);
      return value ? { from: "human", value } : null;
    }
    case "assistant": {
      const value = assistantValue(message.content);
      return value ? { from: "gpt", value } : null;
    }
    case "toolResult": {
      const name = typeof message.toolName === "string" && message.toolName ? message.toolName : "unknown";
      return { from: "tool", value: toolResponseTag(name, contentText(message.content), message.isError === true) };
    }
    default:
      return null;
  }
}

/**
 * Conversation turns of an omp session file (JSONL). developer → system, user → human, assistant →
 * gpt (text, then each tool call as a `<tool_call>` block; thinking dropped), toolResult → tool
 * (`<tool_response>` with name, content and is_error). Other line types and malformed lines are
 * skipped. `window` (ISO or ms epoch, inclusive) keeps only messages timestamped inside it, so one
 * run of a resumed session can be exported. `model` is the last model an assistant message in the
 * window used (`provider/model`), else the session's model as of the window's end.
 */
export function sessionToConversations(
  jsonl: string,
  window: { from?: string; to?: string } = {},
): { conversations: TrajectoryTurn[]; model: string | null } {
  const from = toMs(window.from);
  const to = toMs(window.to);
  const windowed = from !== null || to !== null;
  const conversations: TrajectoryTurn[] = [];
  let sessionModel: string | null = null;
  let runModel: string | null = null;

  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isObject(entry)) continue;
    const lineTime = toMs(entry.timestamp);

    if (entry.type === "model_change") {
      if (typeof entry.model === "string" && entry.model && (to === null || lineTime === null || lineTime <= to)) {
        sessionModel = entry.model;
      }
      continue;
    }
    if (entry.type !== "message" || !isObject(entry.message)) continue;
    const message = entry.message;

    if (windowed) {
      const time = toMs(message.timestamp) ?? lineTime;
      if (time === null || (from !== null && time < from) || (to !== null && time > to)) continue;
    }

    const turn = messageTurn(message);
    if (turn) conversations.push(turn);
    if (message.role === "assistant" && typeof message.model === "string" && message.model) {
      const provider = typeof message.provider === "string" ? message.provider : "";
      runModel = provider && !message.model.includes("/") ? `${provider}/${message.model}` : message.model;
    }
  }

  return { conversations, model: runModel ?? sessionModel };
}

function countTokens(turns: readonly TrajectoryTurn[]): number {
  let total = 0;
  for (const turn of turns) total += estimateTokens(turn.value);
  return total;
}

/** `head … [N chars pruned] … tail` of a long text. */
function stub(text: string): string {
  const pruned = text.length - 2 * PRUNE_KEEP_CHARS;
  return `${text.slice(0, PRUNE_KEEP_CHARS)} … [${pruned} chars pruned] … ${text.slice(-PRUNE_KEEP_CHARS)}`;
}

/** A tool turn's value with its output cut to a stub; keeps the tool name and error flag. */
function pruneToolValue(value: string): string {
  const response = parseToolResponse(value);
  if (!response) return stub(value);
  const content = response.content.length > 2 * PRUNE_KEEP_CHARS ? stub(response.content) : response.content;
  return toolResponseTag(response.name, content, response.isError);
}

function parseToolResponse(value: string): { name: string; content: string; isError: boolean } | null {
  const match = TOOL_RESPONSE_RE.exec(value);
  if (!match) return null;
  try {
    const data: unknown = JSON.parse(match[1]);
    if (!isObject(data)) return null;
    return {
      name: typeof data.name === "string" ? data.name : "unknown",
      content: typeof data.content === "string" ? data.content : JSON.stringify(data.content ?? ""),
      isError: data.is_error === true,
    };
  } catch {
    return null;
  }
}

function toolCallNames(value: string): string[] {
  const names: string[] = [];
  for (const match of value.matchAll(TOOL_CALL_RE)) {
    try {
      const data: unknown = JSON.parse(match[1]);
      if (isObject(data) && typeof data.name === "string") names.push(data.name);
    } catch {
      // Not a call this module wrote; nothing to count.
    }
  }
  return names;
}

function summaryText(turns: number, tools: ReadonlyMap<string, number>, errors: number): string {
  const used = [...tools]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
  return `[CONTEXT SUMMARY]: ${turns} turns compressed (tools used: ${used || "none"}; ${errors} errors)`;
}

/**
 * Index after the protected head: the leading run of turns with distinct roles, extended over the
 * tool turns that follow so it never ends between a call and its responses. Hermes protects the
 * first system, human, gpt and tool turns wherever they occur; omp sessions have no leading system
 * turn (developer messages show up mid-session), so scanning for all four roles would protect most
 * of the session.
 */
function headEnd(turns: readonly TrajectoryTurn[]): number {
  const seen = new Set<TrajectoryRole>();
  let i = 0;
  while (i < turns.length && !seen.has(turns[i].from)) {
    seen.add(turns[i].from);
    i++;
  }
  while (i < turns.length && turns[i].from === "tool") i++;
  return i;
}

/**
 * Smallest run of whole middle turns `[start, end)` whose replacement by one summary turn brings
 * `tokens` under `maxTokens` (else the largest possible), or null when nothing can be removed.
 * Boundaries snap to whole call/response groups: neither the first removed turn nor the first kept
 * turn after the run is a tool turn, so no tool call loses its responses.
 */
function middleCut(
  turns: readonly TrajectoryTurn[],
  tailStart: number,
  tokens: number,
  maxTokens: number,
): { start: number; end: number; summary: string } | null {
  const start = headEnd(turns);

  const tools = new Map<string, number>();
  let errors = 0;
  let removedTokens = 0;
  let best: { start: number; end: number; summary: string } | null = null;
  for (let i = start; i < tailStart; i++) {
    const turn = turns[i];
    removedTokens += estimateTokens(turn.value);
    if (turn.from === "gpt") {
      for (const name of toolCallNames(turn.value)) tools.set(name, (tools.get(name) ?? 0) + 1);
    } else if (turn.from === "tool" && parseToolResponse(turn.value)?.isError) {
      errors++;
    }
    const end = i + 1;
    if (end < turns.length && turns[end].from === "tool") continue;
    const summary = summaryText(end - start, tools, errors);
    const summaryTokens = estimateTokens(summary);
    if (removedTokens <= summaryTokens) continue;
    best = { start, end, summary };
    if (tokens - removedTokens + summaryTokens <= maxTokens) break;
  }
  return best;
}

/** What a redacted secret is replaced with. */
export const REDACTED = "[REDACTED]";
/** Secret values shorter than this are not redacted (too likely to hit ordinary text). */
export const MIN_SECRET_LENGTH = 8;

/** Common credential shapes redacted even when their value is not known: OpenAI/Anthropic-style keys, GitHub tokens, Slack tokens, AWS access key ids. */
const TOKEN_RE =
  /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g;

/**
 * `t` with every occurrence of a known secret value (at least MIN_SECRET_LENGTH characters, also
 * trimmed and as it appears inside a JSON string) and every common token shape in any turn replaced
 * by REDACTED. Longest values first, so a secret containing another is replaced whole. The input is
 * never mutated.
 */
export function redactTrajectory(t: Trajectory, secrets: readonly string[]): Trajectory {
  const values = new Set<string>();
  for (const secret of secrets) {
    for (const variant of [secret, secret.trim()]) {
      if (variant.length < MIN_SECRET_LENGTH) continue;
      values.add(variant);
      // Tool calls and responses are JSON-encoded: quotes, backslashes and control characters appear escaped.
      values.add(JSON.stringify(variant).slice(1, -1));
    }
  }
  const ordered = [...values].sort((a, b) => b.length - a.length);
  const redact = (text: string): string => {
    let out = text;
    for (const value of ordered) if (out.includes(value)) out = out.split(value).join(REDACTED);
    return out.replace(TOKEN_RE, REDACTED);
  };
  return { ...t, conversations: t.conversations.map((turn) => ({ ...turn, value: redact(turn.value) })) };
}

/**
 * Hermes-style compression to `maxTokens` (default TRAJECTORY_TARGET_TOKENS). Under the target the
 * trajectory comes back unchanged. Over it, tool outputs longer than 2,000 characters outside the
 * last `protectLastTurns` turns are pruned to stubs (tool name plus the first and last 200
 * characters); if still over, whole middle turns between the protected head (the leading run of
 * distinct roles plus the rest of its call group) and tail are replaced by one human
 * `[CONTEXT SUMMARY]` turn, never splitting a tool call from its responses. `metrics` reports the
 * result. The input is never mutated.
 */
export function compressTrajectory(
  t: Trajectory,
  options: { maxTokens?: number; protectLastTurns?: number } = {},
): Trajectory {
  const maxTokens = options.maxTokens ?? TRAJECTORY_TARGET_TOKENS;
  const protectLast = Math.max(0, Math.floor(options.protectLastTurns ?? PROTECT_LAST_TURNS));
  const originalTokens = countTokens(t.conversations);
  const tailStart = Math.max(0, t.conversations.length - protectLast);

  let toolResultsPruned = 0;
  let turnsRemoved = 0;
  let conversations = t.conversations.map((turn) => ({ ...turn }));

  if (originalTokens > maxTokens) {
    conversations = conversations.map((turn, i) => {
      if (i >= tailStart || turn.from !== "tool" || turn.value.length <= PRUNE_MIN_CHARS) return turn;
      toolResultsPruned++;
      return { from: "tool", value: pruneToolValue(turn.value) };
    });
    const tokens = countTokens(conversations);
    const cut = tokens > maxTokens ? middleCut(conversations, tailStart, tokens, maxTokens) : null;
    if (cut) {
      turnsRemoved = cut.end - cut.start;
      conversations = [
        ...conversations.slice(0, cut.start),
        { from: "human", value: cut.summary },
        ...conversations.slice(cut.end),
      ];
    }
  }

  const compressedTokens = countTokens(conversations);
  return {
    ...t,
    conversations,
    metrics: {
      originalTokens,
      compressedTokens,
      tokensSaved: originalTokens - compressedTokens,
      compressionRatio: originalTokens > 0 ? Math.round((compressedTokens / originalTokens) * 10_000) / 10_000 : 1,
      turnsRemoved,
      toolResultsPruned,
    },
  };
}
