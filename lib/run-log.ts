// Turns a run's raw event stream into a readable timeline: the agent's own words (thinking or
// message) lead each step, and the tool calls it made next hang under it as actions.
import { parseSubagent } from "@/lib/subagents";
import type { RunEvent, SubagentSnapshot, SubagentStatus } from "@/lib/types";

export interface ToolCall {
  /** "bash", "read", … */
  name: string;
  /** Command, path, intent or JSON arguments, as recorded. */
  detail?: string;
  /** Why the agent made the call ("Reading the config"), when recorded apart from `detail`. */
  intent?: string;
}

/**
 * Decode a persisted tool line: `▸ name: detail`, optionally followed by the call's intent on a
 * second line (older events have only the first line).
 */
export function parseToolCall(text: string): ToolCall {
  const [first = "", ...rest] = text.split("\n");
  const line = first.replace(/^\s*▸\s*/, "");
  const colon = line.indexOf(":");
  const name = (colon === -1 ? line : line.slice(0, colon)).trim() || "tool";
  const detail = colon === -1 ? undefined : line.slice(colon + 1).trim() || undefined;
  const intent = rest.join(" ").trim() || undefined;
  return { name, detail, intent };
}

/** `✗ bash failed: boom` → { name: "bash", message: "boom" }. */
export function parseToolFailure(text: string): { name: string; message?: string } {
  const match = /^✗\s*(\S+) failed(?::\s*([\s\S]*))?$/.exec(text);
  if (!match) return { name: "tool", message: text.replace(/^✗\s*/, "") || undefined };
  return { name: match[1], message: match[2]?.trim() || undefined };
}

export interface ToolAction {
  type: "tool";
  key: string;
  event: RunEvent;
  call: ToolCall;
  /** Error text when the call failed ("" when it failed without a message). */
  error?: string;
}

export interface SubagentChange {
  agent: SubagentSnapshot;
  change: "spawned" | "ended";
}

export interface AgentsAction {
  type: "agents";
  key: string;
  changes: SubagentChange[];
}

export type StepAction = ToolAction | AgentsAction;

export type TimelineItem =
  /** What the agent said or thought (`lead`), then what it did about it. */
  | { type: "step"; key: string; lead?: RunEvent; actions: StepAction[] }
  | { type: "status"; key: string; event: RunEvent }
  | { type: "error"; key: string; event: RunEvent };

const TERMINAL_SUBAGENT: Record<SubagentStatus, boolean> = {
  pending: false,
  running: false,
  completed: true,
  failed: true,
  aborted: true,
};

/**
 * Arrange events for reading. Each thinking/text event opens a step; tool calls and subagent
 * "delegated"/"finished" markers join the open step (one without a lead when none is open);
 * tool failures attach to the call they ended; status lines and other errors stand alone.
 */
export function buildTimeline(events: RunEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const seen = new Map<string, SubagentStatus>();
  const openStep = (key: string): Extract<TimelineItem, { type: "step" }> => {
    const last = items.at(-1);
    if (last?.type === "step") return last;
    const step = { type: "step" as const, key, actions: [] };
    items.push(step);
    return step;
  };

  for (const event of events) {
    switch (event.kind) {
      case "thinking":
      case "text":
        items.push({ type: "step", key: `step-${event.seq}`, lead: event, actions: [] });
        break;
      case "tool":
        openStep(`step-${event.seq}`).actions.push({
          type: "tool",
          key: String(event.seq),
          event,
          call: parseToolCall(event.text),
        });
        break;
      case "error": {
        // A failed tool call (`✗ bash failed: …`) belongs with the call it ended.
        if (!event.text.startsWith("✗ ")) {
          items.push({ type: "error", key: String(event.seq), event });
          break;
        }
        const failure = parseToolFailure(event.text);
        const step = openStep(`step-${event.seq}`);
        const call = step.actions.findLast(
          (action): action is ToolAction =>
            action.type === "tool" && action.error === undefined && action.call.name === failure.name,
        );
        if (call) call.error = failure.message ?? "";
        else {
          step.actions.push({
            type: "tool",
            key: String(event.seq),
            event,
            call: { name: failure.name },
            error: failure.message ?? "",
          });
        }
        break;
      }
      case "agent": {
        const agent = parseSubagent(event.text);
        if (!agent) break;
        const previous = seen.get(agent.id);
        seen.set(agent.id, agent.status);
        const ended = TERMINAL_SUBAGENT[agent.status] === true;
        const change: SubagentChange["change"] | null =
          previous === undefined ? (ended ? "ended" : "spawned") : ended && previous !== agent.status ? "ended" : null;
        if (!change) break;
        const step = openStep(`step-${event.seq}`);
        const last = step.actions.at(-1);
        if (last?.type === "agents" && last.changes.at(-1)?.change === change) last.changes.push({ agent, change });
        else step.actions.push({ type: "agents", key: `agents-${event.seq}`, changes: [{ agent, change }] });
        break;
      }
      default:
        items.push({ type: "status", key: String(event.seq), event });
    }
  }
  return items;
}
