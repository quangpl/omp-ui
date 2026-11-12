import type { SubagentSnapshot, SubagentStatus } from "@/lib/types";

/** Decode an `agent` run event; null for malformed text. */
export function parseSubagent(text: string): SubagentSnapshot | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const snapshot = value as Partial<SubagentSnapshot>;
    if (typeof snapshot.id !== "string" || typeof snapshot.status !== "string") return null;
    return { ...snapshot, id: snapshot.id, agent: snapshot.agent ?? "task", status: snapshot.status };
  } catch {
    return null;
  }
}

export const SUBAGENT_STATUS_LABELS: Record<SubagentStatus, string> = {
  pending: "Waiting",
  running: "Working",
  completed: "Done",
  failed: "Failed",
  aborted: "Stopped",
};
