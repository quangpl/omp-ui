// Data model of the Visualize page: the shared systems agents use (one factory department each),
// which system each tool call touches, who stands in which room of the floor, and the
// agent-to-agent links (delegation, dependencies, board contacts). Pure: no React.
import type { Dashboard, QueueEntry, QueueSnapshot, SubagentSnapshot } from "@/lib/types";
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
  if (toolName.startsWith("memory_")) return "memory";
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
  | "delegate"; // B was created by A (QueueEntry.createdByTaskId)

export interface CardLink {
  kind: LinkKind;
  /** Source card id (sender / creator / inspector). */
  from: string;
  /** Target card id. */
  to: string;
}

/** Recent board interactions stay on the schematic this long. */
export const CONTACT_TTL_MS = 5 * 60_000;

/**
 * Every agent-to-agent link visible right now, deduped by kind+from+to, self-links dropped:
 * delegations (creator → created card) and board contacts of the last CONTACT_TTL_MS.
 */
export function buildLinks(queue: QueueSnapshot, live: Record<string, LiveAgent>, now: number): CardLink[] {
  const links = new Map<string, CardLink>();
  const add = (kind: LinkKind, from: string, to: string) => {
    const key = `${kind}:${from}:${to}`;
    if (from !== to && !links.has(key)) links.set(key, { kind, from, to });
  };
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

/** Every room of the factory floor: intake, one department per system, rework and shipping. */
export type DepartmentId = "intake" | SystemId | "rework" | "shipping";

/** Someone standing on the floor; `id` is stable across rooms so the worker can walk between them. */
export type FloorWorker =
  | { id: string; kind: "queued"; entry: QueueEntry; position: number }
  | { id: string; kind: "running"; entry: QueueEntry }
  | { id: string; kind: "subagent"; entry: QueueEntry; subagent: SubagentSnapshot }
  | { id: string; kind: "rework"; card: Dashboard["attention"][number] }
  | { id: string; kind: "shipped"; card: Dashboard["finished"][number] };

export interface FloorPlan {
  rooms: Record<DepartmentId, FloorWorker[]>;
  /** System room of every running card and busy subagent, by worker id: feed it back as `previous`. */
  placed: Map<string, SystemId>;
}

/**
 * Who stands where. Queued cards wait in intake, failed/stalled ones in rework, recently finished
 * ones on the shipping dock. A running card stands in the room of the system its current activity
 * uses; activities that use none (status lines, errors) keep it in its `previous` room, and a
 * card that has done nothing yet starts at the model. Busy subagents stand in their tool's room,
 * else the subagent room. A card shows up once: running > queued > rework > shipped.
 */
export function floorPlan(
  dashboard: Pick<Dashboard, "queue" | "attention" | "finished">,
  live: Record<string, LiveAgent>,
  previous: ReadonlyMap<string, SystemId>,
): FloorPlan {
  const rooms = Object.fromEntries(
    (["intake", ...SYSTEMS.map((system) => system.id), "rework", "shipping"] as DepartmentId[]).map((id) => [id, []]),
  ) as unknown as Record<DepartmentId, FloorWorker[]>;
  const placed = new Map<string, SystemId>();
  const seen = new Set<string>();
  const { queue, attention, finished } = dashboard;

  for (const entry of queue.running) {
    seen.add(entry.taskId);
    const id = `card:${entry.taskId}`;
    const agent = live[entry.taskId];
    const room = activitySystem(agent?.activity) ?? previous.get(id) ?? "model";
    placed.set(id, room);
    rooms[room].push({ id, kind: "running", entry });
    for (const subagent of Object.values(agent?.helpers ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
      if (subagent.status !== "running" && subagent.status !== "pending") continue;
      const subId = `sub:${entry.taskId}:${subagent.id}`;
      const subRoom = (subagent.currentTool ? toolSystem(subagent.currentTool) : null) ?? previous.get(subId) ?? "helpers";
      placed.set(subId, subRoom);
      rooms[subRoom].push({ id: subId, kind: "subagent", entry, subagent });
    }
  }
  queue.queued.forEach((entry, i) => {
    if (seen.has(entry.taskId)) return;
    seen.add(entry.taskId);
    rooms.intake.push({ id: `card:${entry.taskId}`, kind: "queued", entry, position: i + 1 });
  });
  for (const card of attention) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    rooms.rework.push({ id: `card:${card.id}`, kind: "rework", card });
  }
  for (const card of finished) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    rooms.shipping.push({ id: `card:${card.id}`, kind: "shipped", card });
  }
  return { rooms, placed };
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
