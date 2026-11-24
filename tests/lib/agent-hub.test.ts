import { describe, expect, it } from "vitest";
import { foldAgentEvent, newRunFold, parentOf } from "@/lib/agent-hub";
import type { SubagentSnapshot } from "@/lib/types";

const event = (snapshot: Partial<SubagentSnapshot> & Pick<SubagentSnapshot, "id" | "status">, createdAt: string) => ({
  text: JSON.stringify({ agent: "task", ...snapshot }),
  createdAt,
});

describe("foldAgentEvent", () => {
  it("keeps the latest snapshot per subagent and logs lifecycle, response and error lines", () => {
    const fold = newRunFold();
    foldAgentEvent(fold, "r1", event({ id: "Scout", agent: "scout", status: "running", description: "Map the repo" }, "2026-01-01T00:00:00Z"));
    foldAgentEvent(fold, "r1", event({ id: "Scout", agent: "scout", status: "running", tokens: 10 }, "2026-01-01T00:00:05Z"));
    foldAgentEvent(
      fold,
      "r1",
      event({ id: "Scout", agent: "scout", status: "completed", output: "Found\n3 modules" }, "2026-01-01T00:01:00Z"),
    );
    foldAgentEvent(fold, "r1", event({ id: "Scout.Deep", status: "failed", error: "boom" }, "2026-01-01T00:02:00Z"));

    expect(fold.agents.get("Scout")).toMatchObject({
      snapshot: { status: "completed" },
      startedAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:01:00Z",
    });
    expect(fold.activity.map((a) => [a.agentId, a.kind, a.text])).toEqual([
      ["Scout", "lifecycle", "Started: Map the repo"],
      ["Scout", "lifecycle", "Completed"],
      ["Scout", "response", "Found 3 modules"],
      ["Scout.Deep", "lifecycle", "Failed"],
      ["Scout.Deep", "error", "boom"],
    ]);
    expect(new Set(fold.activity.map((a) => a.id)).size).toBe(fold.activity.length);
  });

  it("ignores events that are not subagent snapshots", () => {
    const fold = newRunFold();
    foldAgentEvent(fold, "r1", { text: "not json", createdAt: "2026-01-01T00:00:00Z" });
    foldAgentEvent(fold, "r1", { text: '{"status":"running"}', createdAt: "2026-01-01T00:00:00Z" });
    expect(fold.agents.size).toBe(0);
    expect(fold.activity).toEqual([]);
  });
});

describe("parentOf", () => {
  it("names the spawner of a dot-qualified id", () => {
    expect(parentOf("Lead.Worker.Helper")).toBe("Lead.Worker");
    expect(parentOf("Lead")).toBeNull();
  });
});
