// Live agent output turned into "what is this agent doing" lines (Visualize page, agent log).
import { parseToolCall } from "@/lib/run-log";
import type { RunEventKind } from "@/lib/types";

export type ActivityIcon =
  | "terminal"
  | "read"
  | "edit"
  | "search"
  | "delegate"
  | "team"
  | "web"
  | "advisor"
  | "plan"
  | "inspect"
  | "think"
  | "write"
  | "status"
  | "error"
  | "tool";

export interface Activity {
  icon: ActivityIcon;
  /** Short verb phrase: "Running a command". */
  label: string;
  /** The command, path or intent, when there is one. */
  detail?: string;
  /** Tool name ("bash", "board_message_card", …) for tool activities. */
  tool?: string;
}

const TOOL_ACTIVITY: Record<string, Pick<Activity, "icon" | "label">> = {
  bash: { icon: "terminal", label: "Running a command" },
  eval: { icon: "terminal", label: "Running code" },
  read: { icon: "read", label: "Reading" },
  edit: { icon: "edit", label: "Editing code" },
  write: { icon: "edit", label: "Writing a file" },
  ast_edit: { icon: "edit", label: "Refactoring" },
  grep: { icon: "search", label: "Searching the code" },
  glob: { icon: "search", label: "Looking for files" },
  find: { icon: "search", label: "Looking for files" },
  ast_grep: { icon: "search", label: "Searching the code" },
  task: { icon: "delegate", label: "Starting subagents" },
  web_search: { icon: "web", label: "Searching the web" },
  fetch: { icon: "web", label: "Fetching a page" },
  browser: { icon: "web", label: "Using the browser" },
  ask_advisor: { icon: "advisor", label: "Asking the advisor" },
  todo: { icon: "plan", label: "Planning steps" },
  wait: { icon: "delegate", label: "Waiting on subagents" },
  memory_search: { icon: "search", label: "Recalling memory" },
  memory_save: { icon: "write", label: "Saving a memory" },
  lsp: { icon: "inspect", label: "Inspecting code" },
};

/** What a tool call looks like as an activity: icon and verb phrase. */
export function toolActivityKind(name: string): Pick<Activity, "icon" | "label"> {
  const known = TOOL_ACTIVITY[name];
  if (known) return known;
  if (name.startsWith("board_")) return { icon: "team", label: "Using board tools" };
  return { icon: "tool", label: `Using ${name}` };
}

/** The agent log's tool line ("▸ bash: pnpm test") → what the agent is doing. */
function toolActivity(text: string): Activity {
  const { name, detail, intent } = parseToolCall(text);
  return { ...toolActivityKind(name), detail: intent ?? detail, tool: name };
}

/**
 * A run event or live delta → the agent's current activity; null for events that say nothing
 * about it (subagent snapshots are tracked separately).
 */
export function describeActivity(kind: RunEventKind, text: string): Activity | null {
  switch (kind) {
    case "tool":
      return toolActivity(text);
    case "thinking":
      return { icon: "think", label: "Thinking" };
    case "text":
      return { icon: "write", label: "Writing a reply" };
    case "error":
      return { icon: "error", label: "Error", detail: text.replace(/^✗\s*/, "") || undefined };
    case "status":
      return text ? { icon: "status", label: text } : null;
    case "agent":
      return null;
  }
}
