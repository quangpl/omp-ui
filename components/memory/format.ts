import { ApiRequestError } from "@/lib/api-client";

/** Labels for agentmemory's memory kinds and observation kinds. */
const TYPE_LABELS: Record<string, string> = {
  pattern: "Pattern",
  preference: "Preference",
  architecture: "Architecture",
  bug: "Bug",
  workflow: "Workflow",
  fact: "Fact",
  file_read: "File read",
  file_write: "File write",
  file_edit: "File edit",
  command_run: "Command",
  search: "Search",
  web_fetch: "Web fetch",
  conversation: "Conversation",
  error: "Error",
  decision: "Decision",
  discovery: "Discovery",
  subagent: "Subagent",
  notification: "Notification",
  task: "Task",
  image: "Image",
  other: "Other",
};

export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export const LAYER_LABELS: Record<string, string> = {
  memory: "Memory",
  observation: "Observation",
  lesson: "Lesson",
  insight: "Insight",
};

export const RANGE_OPTIONS = [
  { value: "all", label: "Any time" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
] as const;

/** The memory routes answer 503 when the agentmemory server is down or missing. */
export function isMemoryUnavailable(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 503;
}

/** Board link of a card session: `/b/<boardId>?task=<taskId>`. */
export function cardHref(card: { boardId: string; taskId: string }): string {
  return `/b/${encodeURIComponent(card.boardId)}?task=${encodeURIComponent(card.taskId)}`;
}

/** "1,234" in the browser locale. */
export function formatCount(n: number): string {
  return n.toLocaleString();
}

/** Surface of the memory page's list and detail panels (matches the Stats page panels). */
export const MEMORY_PANEL = "min-w-0 rounded-xl bg-card ring-1 ring-foreground/10";
