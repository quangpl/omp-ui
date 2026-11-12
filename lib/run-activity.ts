// One-line "what the agent is doing now" from a persisted run event. Shared by the dashboard
// payload (server) and the home page's live updates (client, `run.event`), so both read the same.
import type { RunEventKind } from "@/lib/types";

const MAX_LENGTH = 160;

/** The event as a short single line, or null for events that say nothing about progress. */
export function activityLine(kind: RunEventKind, text: string): string | null {
  if (kind === "thinking" || kind === "agent") return null;
  const firstLine = text.split("\n").find((line) => line.trim()) ?? "";
  // Tool calls are persisted as "▸ tool: detail"; assistant text may start with markdown markers.
  const line = (kind === "tool" ? firstLine.replace(/^\s*▸\s*/, "") : firstLine.replace(/^\s*(?:#+|[-*>])\s+/, ""))
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return null;
  return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH - 1)}…` : line;
}
