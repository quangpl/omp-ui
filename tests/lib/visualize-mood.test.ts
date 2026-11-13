import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_WINDOW, agentVitals, subagentVitals } from "@/components/visualize/mood";
import { type AgentStats, EMPTY_STATS, type LiveAgent, applyEvent } from "@/components/visualize/use-live-agents";
import type { RunEventKind, SubagentSnapshot } from "@/lib/types";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;
/** ISO time `ago` ms before NOW. */
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** Stats after `events` ([kind, text, ms before NOW]), oldest first. */
function replay(events: [RunEventKind, string, number][]): AgentStats {
  return events.reduce((stats, [kind, text, ms]) => applyEvent(stats, kind, text, ago(ms)), EMPTY_STATS);
}

function agent(over: Partial<LiveAgent> = {}): LiveAgent {
  return {
    runId: "run-1",
    startedAt: ago(2 * MIN),
    activity: { icon: "terminal", label: "Running a command", tool: "bash" },
    helpers: {},
    contacts: [],
    stats: EMPTY_STATS,
    ...over,
  };
}

function sub(over: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return { id: "Scout", agent: "scout", status: "running", toolCount: 2, durationMs: 2 * MIN, ...over };
}

describe("applyEvent", () => {
  it("marks the failed tool call and clears unresolved errors on a text reply", () => {
    let stats = replay([
      ["tool", "▸ read: a.ts", 50 * SEC],
      ["tool", "▸ bash: pnpm test", 40 * SEC],
      ["error", "✗ bash failed: exit 1", 39 * SEC],
    ]);
    expect(stats).toMatchObject({ toolCount: 2, errorCount: 1, unresolvedErrors: 1, lastErrorAt: ago(39 * SEC) });
    expect(stats.recentTools).toEqual([
      { tool: "read", at: ago(50 * SEC) },
      { tool: "bash", at: ago(40 * SEC), error: true },
    ]);
    stats = applyEvent(stats, "text", "Fixed it", ago(10 * SEC));
    expect(stats).toMatchObject({ unresolvedErrors: 0, lastProgressAt: ago(10 * SEC) });
  });

  it("keeps errors unresolved while the agent goes back to the failing tool", () => {
    const stats = replay([
      ["tool", "▸ bash: build", 60 * SEC],
      ["error", "✗ bash failed: boom", 59 * SEC],
      ["tool", "▸ read: log.txt", 50 * SEC],
      ["tool", "▸ bash: build", 40 * SEC],
      ["error", "✗ bash failed: boom", 39 * SEC],
    ]);
    expect(stats.unresolvedErrors).toBe(2);
    // A good call followed by a different tool is progress.
    const moved = replay([
      ["tool", "▸ bash: build", 60 * SEC],
      ["error", "✗ bash failed: boom", 59 * SEC],
      ["tool", "▸ read: log.txt", 50 * SEC],
      ["tool", "▸ edit: fix.ts", 40 * SEC],
    ]);
    expect(moved).toMatchObject({ unresolvedErrors: 0, lastProgressAt: ago(40 * SEC) });
  });

  it("tracks retries, thinking stretches and keeps the last 12 tools", () => {
    let stats = replay([
      ["error", "Model overloaded", 30 * SEC],
      ["status", "Retrying (attempt 1/3) in 2s", 29 * SEC],
    ]);
    expect(stats).toMatchObject({ retryCount: 1, unresolvedErrors: 1 });
    stats = applyEvent(stats, "status", "Retry succeeded", ago(20 * SEC));
    expect(stats.unresolvedErrors).toBe(0);

    stats = applyEvent(stats, "thinking", "hmm", ago(15 * SEC));
    stats = applyEvent(stats, "thinking", "hmm more", ago(10 * SEC));
    expect(stats.thinkingSince).toBe(ago(15 * SEC));
    stats = applyEvent(stats, "tool", "▸ read: x", ago(5 * SEC));
    expect(stats.thinkingSince).toBeUndefined();

    for (let i = 0; i < 15; i++) stats = applyEvent(stats, "tool", `▸ grep: ${i}`, ago(4 * SEC));
    expect(stats.recentTools).toHaveLength(12);
    expect(stats.toolCount).toBe(16);
  });
});

describe("agentVitals", () => {
  it("is working when fresh and energized when productive", () => {
    const one = agentVitals(agent({ stats: replay([["tool", "▸ read: a", 30 * SEC]]) }), NOW);
    expect(one.mood).toBe("working");
    expect(one.help).toBeNull();

    const busy = agentVitals(
      agent({
        stats: replay([
          ["tool", "▸ read: a", 90 * SEC],
          ["tool", "▸ grep: b", 60 * SEC],
          ["tool", "▸ edit: c", 30 * SEC],
        ]),
      }),
      NOW,
    );
    expect(busy).toMatchObject({ mood: "energized", heat: 0 });
    expect(busy.feeling).toBe("Energized: 3 tool calls in the last 2m");
  });

  it("gets tired after many tool calls over a long run", () => {
    const vitals = agentVitals(
      agent({ startedAt: ago(48 * MIN), stats: { ...EMPTY_STATS, toolCount: 96, lastEventAt: ago(10 * SEC) } }),
      NOW,
    );
    expect(vitals.mood).toBe("tired");
    expect(vitals.fatigue).toBeCloseTo(0.8);
    expect(vitals.feeling).toBe("Getting tired: 96 tool calls in 48m");
  });

  it("gets stuck hammering the same failing tool", () => {
    const stats = replay([
      ["tool", "▸ bash: build", 50 * SEC],
      ["error", "✗ bash failed: boom", 49 * SEC],
      ["tool", "▸ bash: build", 40 * SEC],
      ["tool", "▸ bash: build", 30 * SEC],
      ["error", "✗ bash failed: boom", 29 * SEC],
      ["tool", "▸ bash: build", 20 * SEC],
      ["tool", "▸ bash: build", 10 * SEC],
      ["error", "✗ bash failed: boom", 9 * SEC],
    ]);
    expect(stats.unresolvedErrors).toBe(1);
    const vitals = agentVitals(agent({ stats }), NOW);
    expect(vitals).toMatchObject({ mood: "stuck", thinking: "stuck", heat: 1 });
    expect(vitals.feeling).toBe("Stuck: bash 5 times in a row, still failing");
  });

  it("overheats when calls keep failing across tools", () => {
    const stats = replay([
      ["tool", "▸ read: a", 70 * SEC],
      ["tool", "▸ bash: b", 60 * SEC],
      ["error", "✗ bash failed: x", 59 * SEC],
      ["tool", "▸ read: c", 50 * SEC],
      ["tool", "▸ grep: d", 40 * SEC],
      ["error", "✗ grep failed: x", 39 * SEC],
      ["tool", "▸ read: e", 30 * SEC],
      ["tool", "▸ edit: f", 20 * SEC],
      ["error", "✗ edit failed: x", 19 * SEC],
      ["tool", "▸ read: g", 10 * SEC],
    ]);
    const vitals = agentVitals(agent({ stats }), NOW);
    expect(vitals.mood).toBe("overheated");
    expect(vitals.heat).toBeGreaterThanOrEqual(0.6);
    expect(vitals.feeling).toBe("Running hot: 3 of the last 7 calls failed");
  });

  it("asks for help after three unresolved errors, when retrying and when stalled", () => {
    const failing = replay([
      ["tool", "▸ bash: a", 30 * SEC],
      ["error", "✗ bash failed: x", 29 * SEC],
      ["tool", "▸ bash: a", 20 * SEC],
      ["error", "✗ bash failed: x", 19 * SEC],
      ["tool", "▸ bash: a", 10 * SEC],
      ["error", "✗ bash failed: x", 9 * SEC],
    ]);
    const errors = agentVitals(agent({ stats: failing }), NOW);
    expect(errors.mood).toBe("needs-help");
    expect(errors.help?.reason).toBe("errors");

    const retrying = agentVitals(
      agent({
        activity: { icon: "status", label: "Retrying (attempt 2/3) in 4s" },
        stats: replay([
          ["error", "Overloaded", 20 * SEC],
          ["status", "Retrying (attempt 2/3) in 4s", 19 * SEC],
        ]),
      }),
      NOW,
    );
    expect(retrying).toMatchObject({ mood: "needs-help", help: { reason: "retrying" } });

    const stalled = agentVitals(agent({ startedAt: ago(20 * MIN), stats: { ...EMPTY_STATS, lastEventAt: ago(7 * MIN) } }), NOW);
    expect(stalled.help).toEqual({ reason: "stalled", text: "no sign of life for 7m" });
    // Busy subagents are not a stall.
    const delegating = agentVitals(
      agent({ startedAt: ago(20 * MIN), helpers: { Scout: sub() }, stats: { ...EMPTY_STATS, lastEventAt: ago(7 * MIN) } }),
      NOW,
    );
    expect(delegating.help).toBeNull();
  });

  it("tells deep thinking on a productive run from being stuck", () => {
    const thinking = { icon: "think", label: "Thinking" } as const;
    const focused = agentVitals(
      agent({
        activity: thinking,
        stats: { ...replay([["tool", "▸ read: a", 60 * SEC]]), thinkingSince: ago(30 * SEC), lastEventAt: ago(30 * SEC) },
      }),
      NOW,
    );
    expect(focused).toMatchObject({ mood: "focused", thinking: "solving", feeling: "Deep in thought for 30s" });

    const pause = agentVitals(agent({ activity: thinking, stats: { ...EMPTY_STATS, thinkingSince: ago(3 * SEC) } }), NOW);
    expect(pause).toMatchObject({ mood: "thinking", thinking: "idle" });

    const errored = replay([
      ["tool", "▸ bash: a", 7 * MIN],
      ["error", "✗ bash failed: x", 6 * MIN],
      ["thinking", "", 5 * MIN],
    ]);
    const stuck = agentVitals(agent({ startedAt: ago(10 * MIN), activity: thinking, stats: errored }), NOW);
    expect(stuck).toMatchObject({ mood: "stuck", thinking: "stuck" });
    expect(stuck.feeling).toBe("Stuck: thinking for 5m with 1 unresolved error");

    // The same long stretch without errors is calm pondering, not stuck.
    const pondering = agentVitals(
      agent({ startedAt: ago(10 * MIN), activity: thinking, stats: replay([["thinking", "", 5 * MIN]]) }),
      NOW,
    );
    expect(pondering).toMatchObject({ mood: "thinking", thinking: "idle", feeling: "Pondering for 5m" });
  });

  it("shows a fresh error as an error unless it is part of a bigger trouble", () => {
    const errorActivity = { icon: "error", label: "Error", detail: "bash failed: boom" } as const;
    const bare = agentVitals(agent({ activity: { icon: "error", label: "Error", detail: "boom" } }), NOW);
    expect(bare).toMatchObject({ mood: "error", feeling: "Hit an error: boom" });

    const once = replay([
      ["tool", "▸ bash: build", 20 * SEC],
      ["error", "✗ bash failed: boom", 19 * SEC],
    ]);
    expect(agentVitals(agent({ activity: errorActivity, stats: once }), NOW).mood).toBe("error");

    const piling = replay([
      ["tool", "▸ bash: a", 30 * SEC],
      ["error", "✗ bash failed: x", 29 * SEC],
      ["tool", "▸ read: b", 20 * SEC],
      ["error", "✗ read failed: x", 19 * SEC],
      ["tool", "▸ edit: c", 10 * SEC],
      ["error", "✗ edit failed: x", 9 * SEC],
    ]);
    expect(piling.unresolvedErrors).toBe(3);
    expect(agentVitals(agent({ activity: errorActivity, stats: piling }), NOW)).toMatchObject({
      mood: "needs-help",
      help: { reason: "errors" },
    });

    const hammering = replay([
      ["tool", "▸ bash: build", 50 * SEC],
      ["tool", "▸ bash: build", 40 * SEC],
      ["tool", "▸ bash: build", 30 * SEC],
      ["tool", "▸ bash: build", 20 * SEC],
      ["tool", "▸ bash: build", 10 * SEC],
      ["error", "✗ bash failed: boom", 9 * SEC],
    ]);
    expect(agentVitals(agent({ activity: errorActivity, stats: hammering }), NOW).mood).toBe("stuck");
  });

  it("is overloaded by many busy helpers, not by a first burst of tool calls", () => {
    const helpers = Object.fromEntries(["A", "B", "C", "D"].map((id) => [id, sub({ id })]));
    const crowded = agentVitals(agent({ helpers, stats: { ...EMPTY_STATS, lastEventAt: ago(SEC) } }), NOW);
    expect(crowded.mood).toBe("overloaded");
    expect(crowded.load).toBe(1);

    // 9 calls in its first minute with one helper: averaged over 2 minutes, 4.5/min of 30.
    const burst = replay(Array.from({ length: 9 }, (_, i): [RunEventKind, string, number] => ["tool", `▸ read: ${i}`, (53 - i * 6) * SEC]));
    const eager = agent({ startedAt: ago(MIN), helpers: { A: sub({ id: "A" }) }, stats: burst });
    const vitals = agentVitals(eager, NOW);
    expect(vitals.load).toBeCloseTo(0.25 + 4.5 / 30);
    expect(vitals.mood).toBe("energized");
  });

  it("turns context fill into mana, live context winning over the snapshot", () => {
    expect(agentVitals(agent(), NOW).mana).toBeNull();
    expect(agentVitals(undefined, NOW, { tokens: 50_000, contextWindow: 0 }).mana).toBeCloseTo(1 - 50_000 / DEFAULT_CONTEXT_WINDOW);

    const low = agentVitals(agent({ context: { tokens: 182_000, contextWindow: 200_000 } }), NOW, {
      tokens: 10_000,
      contextWindow: 200_000,
    });
    expect(low.mana).toBeCloseTo(0.09);
    expect(low).toMatchObject({ mood: "tired", feeling: "Low on mana: 9% context left" });
    expect(low.notes).toContain("Mana 9% · 182k / 200k tokens");
  });
});

describe("subagentVitals", () => {
  it("maps finished and queued subagents straight to a mood", () => {
    expect(subagentVitals(sub({ status: "completed" }), NOW).mood).toBe("happy");
    expect(subagentVitals(sub({ status: "pending" }), NOW).mood).toBe("waiting");
    expect(subagentVitals(sub({ status: "aborted" }), NOW).mood).toBe("sleeping");
    const failed = subagentVitals(sub({ status: "failed", error: "Tests failed\nstack" }), NOW);
    expect(failed).toMatchObject({ mood: "error", help: { reason: "failed", text: "failed: Tests failed" } });
  });

  it("measures mana against the parent's window", () => {
    expect(subagentVitals(sub(), NOW).mana).toBeNull();
    expect(subagentVitals(sub({ contextTokens: 50_000 }), NOW, 100_000).mana).toBeCloseTo(0.5);
    expect(subagentVitals(sub({ contextTokens: 50_000 }), NOW).mana).toBeCloseTo(0.75);
  });

  it("is stuck on a repeated failing tool and needs help when the last calls all failed", () => {
    const flaky = subagentVitals(
      sub({
        recentTools: [
          { tool: "bash", isError: true },
          { tool: "bash" },
          { tool: "bash", isError: true },
          { tool: "bash" },
          { tool: "bash", isError: true },
        ],
      }),
      NOW,
    );
    expect(flaky).toMatchObject({ mood: "stuck", thinking: "stuck" });

    const broken = subagentVitals(
      sub({ recentTools: [{ tool: "bash", isError: true }, { tool: "edit", isError: true }, { tool: "read", isError: true }] }),
      NOW,
    );
    expect(broken).toMatchObject({ mood: "needs-help", help: { reason: "errors" } });
  });

  it("gets tired from long, busy runs", () => {
    expect(subagentVitals(sub({ toolCount: 100, durationMs: 30 * MIN }), NOW).mood).toBe("tired");
    expect(subagentVitals(sub({ toolCount: 2, durationMs: MIN }), NOW).mood).toBe("working");
  });
});
