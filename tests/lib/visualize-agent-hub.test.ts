import { describe, expect, it } from "vitest";
import {
  filterActivity,
  filterAgents,
  flatRows,
  mergeLive,
  subtreeKeys,
  toolActivity,
  totals,
  treeGroups,
} from "@/components/visualize/agent-hub-model";
import type { LiveAgent } from "@/components/visualize/use-live-agents";
import { EMPTY_STATS } from "@/components/visualize/use-live-agents";
import type { AgentHubActivity, AgentHubAgent, SubagentSnapshot } from "@/lib/types";

function agent(
  id: string,
  patch: Partial<SubagentSnapshot> = {},
  extra: Partial<AgentHubAgent> = {},
): AgentHubAgent {
  const dot = id.lastIndexOf(".");
  return {
    key: `run1:${id}`,
    runId: "run1",
    taskId: "t1",
    boardId: "b1",
    boardName: "Board",
    taskTitle: "Fix login",
    runStatus: "running",
    parentId: dot > 0 ? id.slice(0, dot) : null,
    snapshot: { id, agent: "task", status: "completed", ...patch },
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

describe("flatRows / treeGroups", () => {
  const agents = [
    agent("Done", { status: "completed" }, { lastActivityAt: "2026-01-01T00:09:00.000Z" }),
    agent("Busy", { status: "running" }, { lastActivityAt: "2026-01-01T00:01:00.000Z" }),
    agent("Busy.Child", { status: "failed" }),
    agent("Other", { status: "running" }, { runId: "run2", key: "run2:Other", taskTitle: "Other card", lastActivityAt: "2026-01-01T00:05:00.000Z" }),
  ];

  it("orders the flat roster running first, then by recency", () => {
    expect(flatRows(agents).map((r) => r.agent.snapshot.id)).toEqual(["Other", "Busy", "Busy.Child", "Done"]);
  });

  it("nests subagents under their spawner, per card, and re-roots orphans", () => {
    const groups = treeGroups(agents);
    expect(groups.map((g) => g.title)).toEqual(["Other card", "Fix login"]);
    expect(groups[1].rows.map((r) => [r.agent.snapshot.id, r.depth])).toEqual([
      ["Busy", 0],
      ["Busy.Child", 1],
      ["Done", 0],
    ]);
    const orphan = treeGroups(agents.filter((a) => a.snapshot.id !== "Busy"));
    expect(orphan[1].rows.find((r) => r.agent.snapshot.id === "Busy.Child")?.depth).toBe(0);
  });

  it("finds the subtree of an agent without matching siblings that share a prefix", () => {
    const all = [agent("A"), agent("A.B"), agent("A.B.C"), agent("AB")];
    expect([...subtreeKeys(all, all[0])].sort()).toEqual(["run1:A", "run1:A.B", "run1:A.B.C"]);
  });
});

describe("filterAgents", () => {
  it("matches id, description, model and card title", () => {
    const agents = [
      agent("Alpha", { description: "Write migrations" }),
      agent("Beta", { model: "anthropic/claude-sonnet" }, { taskTitle: "Billing" }),
    ];
    expect(filterAgents(agents, "migr").map((a) => a.snapshot.id)).toEqual(["Alpha"]);
    expect(filterAgents(agents, "SONNET").map((a) => a.snapshot.id)).toEqual(["Beta"]);
    expect(filterAgents(agents, "billing").map((a) => a.snapshot.id)).toEqual(["Beta"]);
    expect(filterAgents(agents, "  ")).toHaveLength(2);
  });
});

describe("totals", () => {
  it("counts statuses and sums only the figures omp reported", () => {
    const sum = totals([
      agent("A", { status: "running", cost: 0.5, tokens: 100, requests: 2, toolCount: 4, durationMs: 1000 }),
      agent("B", { status: "failed", cost: 0.25 }),
      agent("C", { status: "completed" }),
    ]);
    expect(sum.counts).toMatchObject({ running: 1, failed: 1, completed: 1, pending: 0, aborted: 0 });
    expect(sum).toMatchObject({ cost: 0.75, tokens: 100, requests: 2, toolCalls: 4, durationMs: 1000, measured: 2 });
  });
});

describe("mergeLive", () => {
  const liveEntry = (helpers: Record<string, SubagentSnapshot>): Record<string, LiveAgent> => ({
    t1: { runId: "run1", helpers, contacts: [], stats: EMPTY_STATS },
  });
  const cards = new Map([["t1", { boardId: "b1", boardName: "Board", title: "Fix login" }]]);

  it("lays live snapshots over persisted ones and adds subagents the server lacks", () => {
    const seen = new Map();
    const server = [agent("Scout", { status: "running" })];
    const first = mergeLive(
      server,
      liveEntry({
        Scout: { id: "Scout", agent: "task", status: "running", tokens: 5 },
        Fresh: { id: "Fresh", agent: "scout", status: "pending" },
      }),
      cards,
      seen,
      "2026-01-01T00:10:00.000Z",
    );
    expect(first.agents.map((a) => [a.snapshot.id, a.snapshot.tokens, a.taskTitle])).toEqual([
      ["Scout", 5, "Fix login"],
      ["Fresh", undefined, "Fix login"],
    ]);
    // First sight keeps the server's date; a new live-only agent is dated now.
    expect(first.agents.map((a) => a.lastActivityAt)).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-01T00:10:00.000Z"]);

    // An unchanged snapshot keeps its date, a changed one moves to now.
    const second = mergeLive(
      server,
      liveEntry({
        Scout: { id: "Scout", agent: "task", status: "running", tokens: 9 },
        Fresh: { id: "Fresh", agent: "scout", status: "pending" },
      }),
      cards,
      seen,
      "2026-01-01T00:20:00.000Z",
    );
    expect(second.agents.map((a) => a.lastActivityAt)).toEqual(["2026-01-01T00:20:00.000Z", "2026-01-01T00:10:00.000Z"]);
    expect([...second.liveKeys].sort()).toEqual(["run1:Fresh", "run1:Scout"]);
  });

  it("drops live subagents of a card it cannot place", () => {
    const merged = mergeLive([], liveEntry({ X: { id: "X", agent: "task", status: "running" } }), new Map(), new Map(), "2026-01-01T00:00:00.000Z");
    expect(merged.agents).toEqual([]);
  });
});

describe("toolActivity", () => {
  it("logs a live agent's tool call once, when it changes", () => {
    const agents = [agent("A", { status: "running", currentTool: "bash", currentToolDetail: "ls" })];
    const keys = new Set(["run1:A"]);
    const first = toolActivity(new Map(), agents, keys, "2026-01-01T00:00:00.000Z");
    expect(first.lines.map((l) => l.text)).toEqual(["bash: ls"]);
    expect(toolActivity(first.next, agents, keys, "2026-01-01T00:00:01.000Z").lines).toEqual([]);
    expect(toolActivity(first.next, agents, new Set(), "2026-01-01T00:00:01.000Z").lines).toEqual([]);
  });
});

describe("filterActivity", () => {
  const line = (id: string, kind: AgentHubActivity["kind"], text: string, agentKey = "run1:A"): AgentHubActivity => ({
    id,
    at: "2026-01-01T00:00:00.000Z",
    agentKey,
    agentId: agentKey.split(":")[1],
    kind,
    text,
  });
  const lines = [line("1", "error", "boom"), line("2", "tool", "bash: ls"), line("3", "response", "done", "run1:B")];

  it("filters by kind, search and scope", () => {
    expect(filterActivity(lines, "errors", "", null).map((l) => l.id)).toEqual(["1"]);
    expect(filterActivity(lines, "all", "LS", null).map((l) => l.id)).toEqual(["2"]);
    expect(filterActivity(lines, "all", "", new Set(["run1:B"])).map((l) => l.id)).toEqual(["3"]);
    expect(filterActivity(lines, "all", "b", null).map((l) => l.id)).toEqual(["1", "2", "3"]);
  });
});
