import { describe, expect, it } from "vitest";
import { buildTimeline, parseToolCall, parseToolFailure } from "@/lib/run-log";
import type { RunEvent, RunEventKind } from "@/lib/types";

let seq = 0;
function ev(kind: RunEventKind, text: string): RunEvent {
  seq++;
  return { seq, runId: "r", taskId: "t", kind, text, createdAt: new Date(seq * 1000).toISOString() };
}

describe("parseToolCall", () => {
  it("splits name, detail and the optional intent line", () => {
    expect(parseToolCall("▸ bash: pnpm test -- --run\nRunning the tests")).toEqual({
      name: "bash",
      detail: "pnpm test -- --run",
      intent: "Running the tests",
    });
    // Older events: one line, colons inside the detail are kept.
    expect(parseToolCall("▸ bash: echo a:b")).toEqual({ name: "bash", detail: "echo a:b", intent: undefined });
    expect(parseToolCall("▸ todo")).toEqual({ name: "todo", detail: undefined, intent: undefined });
  });
});

describe("parseToolFailure", () => {
  it("reads the tool and message of a failed call", () => {
    expect(parseToolFailure("✗ bash failed: exit 1\nstack")).toEqual({ name: "bash", message: "exit 1\nstack" });
    expect(parseToolFailure("✗ edit failed")).toEqual({ name: "edit", message: undefined });
  });
});

describe("buildTimeline", () => {
  it("hangs tool calls under the thinking or message that preceded them", () => {
    const items = buildTimeline([
      ev("status", "Prompt sent to agent"),
      ev("tool", "▸ read: README.md"),
      ev("thinking", "I'll check the tests."),
      ev("tool", "▸ bash: pnpm test\nRunning the tests"),
      ev("tool", "▸ grep: Finding callers"),
      ev("text", "Done: all green."),
    ]);
    expect(items.map((item) => item.type)).toEqual(["status", "step", "step", "step"]);
    const [, early, thought, message] = items;
    // A call before any thinking still gets a (lead-less) step.
    expect(early).toMatchObject({ type: "step", actions: [{ call: { name: "read" } }] });
    expect(early.type === "step" && early.lead).toBeUndefined();
    expect(thought).toMatchObject({ lead: { kind: "thinking" } });
    expect(thought.type === "step" && thought.actions.map((a) => a.type === "tool" && a.call.intent)).toEqual([
      "Running the tests",
      undefined,
    ]);
    expect(message).toMatchObject({ lead: { kind: "text", text: "Done: all green." }, actions: [] });
  });

  it("marks the call a failure ended, and keeps other errors standalone", () => {
    const items = buildTimeline([
      ev("thinking", "Try it."),
      ev("tool", "▸ bash: false"),
      ev("tool", "▸ read: a.ts"),
      ev("error", "✗ bash failed: exit 1"),
      ev("error", "Model overloaded"),
    ]);
    expect(items).toHaveLength(2);
    const [step, error] = items;
    expect(step.type === "step" && step.actions.map((a) => a.type === "tool" && a.error)).toEqual(["exit 1", undefined]);
    expect(error).toMatchObject({ type: "error", event: { text: "Model overloaded" } });
  });

  it("turns subagent snapshots into delegated/finished markers, once per change", () => {
    const agent = (id: string, status: string) => JSON.stringify({ id, agent: "task", status });
    const items = buildTimeline([
      ev("thinking", "Split it."),
      ev("tool", "▸ task: delegating to 2 subagents"),
      ev("agent", agent("A", "running")),
      ev("agent", agent("B", "pending")),
      ev("agent", agent("A", "running")),
      ev("agent", agent("A", "completed")),
      ev("agent", agent("A", "completed")),
    ]);
    expect(items).toHaveLength(1);
    const step = items[0];
    if (step.type !== "step") throw new Error("expected a step");
    expect(
      step.actions.map((a) =>
        a.type === "agents" ? `${a.changes[0].change}:${a.changes.map((c) => c.agent.id).join(",")}` : a.call.name,
      ),
    ).toEqual(["task", "spawned:A,B", "ended:A"]);
  });
});
