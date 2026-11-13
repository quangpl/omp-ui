// Data model of the Visualize page: the shared systems agents use, which system each
// tool call touches, and the agent-to-agent links (delegation, dependencies, board contacts)
// drawn as wires between cards. Pure: no React.
import type { QueueSnapshot } from "@/lib/types";
import type { Activity } from "./activity";
import type { LiveAgent } from "./use-live-agents";

/** Shared systems agents use. Order = display order. */
export type SystemId = "model" | "files" | "shell" | "web" | "memory" | "board" | "advisor" | "helpers";

export interface SystemComponent {
  id: SystemId;
  /** Short label: "Model", "Files", … */
  label: string;
  /** One line: what it is. */
  description: string;
}

/** Every system, in display order. */
export const SYSTEMS: readonly SystemComponent[] = [
  { id: "model", label: "Model", description: "The language model that thinks, plans and writes." },
  { id: "files", label: "Files", description: "The card's workspace files: read, searched and edited." },
  { id: "shell", label: "Shell", description: "Runs commands and code in the card's workspace." },
  { id: "web", label: "Web", description: "Web search, page fetches and the browser." },
  { id: "memory", label: "Memory", description: "Long-term agent memory: recalled and saved across runs." },
  { id: "board", label: "Board", description: "Board tools: list, read, create, message and wait for cards." },
  { id: "advisor", label: "Advisor", description: "A second model consulted on hard decisions." },
  { id: "helpers", label: "Subagents", description: "Agents a run delegates work to." },
];

const TOOL_SYSTEMS: Record<string, SystemId> = {
  bash: "shell",
  eval: "shell",
  read: "files",
  edit: "files",
  write: "files",
  ast_edit: "files",
  grep: "files",
  glob: "files",
  find: "files",
  ast_grep: "files",
  lsp: "files",
  web_search: "web",
  fetch: "web",
  browser: "web",
  ask_advisor: "advisor",
  task: "helpers",
  wait: "helpers",
  todo: "model",
};

/** Tool name → the system it touches; null when unknown/none. */
export function toolSystem(toolName: string): SystemId | null {
  if (Object.hasOwn(TOOL_SYSTEMS, toolName)) return TOOL_SYSTEMS[toolName];
  if (toolName.startsWith("memory_") || toolName.startsWith("mcp__agentmemory_")) return "memory";
  if (toolName.startsWith("board_")) return "board";
  return null;
}

/** Activity → system: its tool's system, or the model while thinking/writing; else null. */
export function activitySystem(activity: Activity | undefined): SystemId | null {
  if (!activity) return null;
  if (activity.tool) return toolSystem(activity.tool);
  return activity.icon === "think" || activity.icon === "write" ? "model" : null;
}

/** Agent-to-agent link kinds. */
export type LinkKind =
  | "message" // A sent board_message_card to B (recent)
  | "wait" // A is/was waiting on B via board_wait_for_cards (recent)
  | "inspect" // A read B via board_read_card (recent)
  | "delegate" // B was created by A (QueueEntry.createdByTaskId)
  | "depends"; // queued B waits for A to be Done (QueueEntry.waitingFor)

export interface CardLink {
  kind: LinkKind;
  /** Source card id (sender / creator / blocker). */
  from: string;
  /** Target card id. */
  to: string;
}

/** Recent board interactions stay on the schematic this long. */
export const CONTACT_TTL_MS = 5 * 60_000;

/**
 * Every agent-to-agent link visible right now, deduped by kind+from+to, self-links dropped:
 * dependencies of queued cards, delegations (creator → created card) and board contacts of the
 * last CONTACT_TTL_MS.
 */
export function buildLinks(queue: QueueSnapshot, live: Record<string, LiveAgent>, now: number): CardLink[] {
  const links = new Map<string, CardLink>();
  const add = (kind: LinkKind, from: string, to: string) => {
    const key = `${kind}:${from}:${to}`;
    if (from !== to && !links.has(key)) links.set(key, { kind, from, to });
  };
  for (const entry of queue.queued) {
    for (const blocker of entry.waitingFor) add("depends", blocker, entry.taskId);
  }
  for (const entry of [...queue.running, ...queue.queued]) {
    if (entry.createdByTaskId) add("delegate", entry.createdByTaskId, entry.taskId);
  }
  const since = now - CONTACT_TTL_MS;
  for (const [taskId, agent] of Object.entries(live)) {
    for (const contact of agent.contacts) {
      if (!(Date.parse(contact.at) >= since)) continue;
      for (const cardId of contact.cardIds) add(contact.kind, taskId, cardId);
    }
  }
  return [...links.values()];
}

/** Which running cards (and how many of their busy subagents) use one system right now. */
export interface SystemLoad {
  /** Running card ids whose agent or helpers use the system now. */
  taskIds: string[];
  /** Busy subagents using it now. */
  helpers: number;
}

/**
 * Load of every system: a running card counts for its agent's current activity, and each of its
 * running/pending helpers with a current tool counts for that tool's system.
 */
export function systemLoad(queue: QueueSnapshot, live: Record<string, LiveAgent>): Record<SystemId, SystemLoad> {
  const load = Object.fromEntries(
    SYSTEMS.map((system): [SystemId, SystemLoad] => [system.id, { taskIds: [], helpers: 0 }]),
  ) as Record<SystemId, SystemLoad>;
  for (const entry of queue.running) {
    const agent = live[entry.taskId];
    if (!agent) continue;
    const used = new Set<SystemId>();
    const own = activitySystem(agent.activity);
    if (own) used.add(own);
    for (const helper of Object.values(agent.helpers)) {
      if ((helper.status !== "running" && helper.status !== "pending") || !helper.currentTool) continue;
      const system = toolSystem(helper.currentTool);
      if (!system) continue;
      load[system].helpers++;
      used.add(system);
    }
    for (const system of used) load[system].taskIds.push(entry.taskId);
  }
  return load;
}

const CONTACT_TOOLS: Record<string, "message" | "wait" | "inspect"> = {
  board_message_card: "message",
  board_wait_for_cards: "wait",
  board_read_card: "inspect",
};

const CARD_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Card ids named by a board tool's recorded arguments: `{cardId}` / `{cardIds}` JSON, else UUIDs. */
function contactCardIds(detail: string): string[] {
  try {
    const args: unknown = JSON.parse(detail);
    if (args && typeof args === "object") {
      const { cardId, cardIds } = args as { cardId?: unknown; cardIds?: unknown };
      const ids = [cardId, ...(Array.isArray(cardIds) ? cardIds : [])].filter(
        (id): id is string => typeof id === "string" && id !== "",
      );
      if (ids.length > 0) return [...new Set(ids)];
    }
  } catch {
    // Truncated or not JSON: fall back to the ids it mentions.
  }
  return [...new Set(detail.match(CARD_ID) ?? [])];
}

/**
 * board_* tool call → contact kind + target card ids, else null. board_message_card → "message",
 * board_wait_for_cards → "wait", board_read_card → "inspect"; other tools, or no card ids in the
 * tool line's detail, → null.
 */
export function boardContact(
  toolName: string,
  detail: string | undefined,
): { kind: "message" | "wait" | "inspect"; cardIds: string[] } | null {
  const kind = Object.hasOwn(CONTACT_TOOLS, toolName) ? CONTACT_TOOLS[toolName] : undefined;
  if (!kind || !detail) return null;
  const cardIds = contactCardIds(detail);
  return cardIds.length > 0 ? { kind, cardIds } : null;
}
