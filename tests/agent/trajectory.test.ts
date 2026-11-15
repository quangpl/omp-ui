import { describe, expect, it } from "vitest";

import {
  compressTrajectory,
  estimateTokens,
  MIN_SECRET_LENGTH,
  PROTECT_LAST_TURNS,
  REDACTED,
  redactTrajectory,
  sessionToConversations,
  type Trajectory,
  type TrajectoryTurn,
} from "@/lib/agent/trajectory";

const T0 = Date.parse("2026-01-01T10:00:00.000Z");

function line(entry: unknown): string {
  return JSON.stringify(entry);
}

function message(role: string, content: unknown, at: number, extra: Record<string, unknown> = {}): string {
  return line({
    type: "message",
    id: `m${at}`,
    timestamp: new Date(at + 5).toISOString(),
    message: { role, content, timestamp: at, ...extra },
  });
}

function toolResult(name: string, text: string, at: number, isError = false): string {
  return message("toolResult", [{ type: "text", text }], at, { toolName: name, toolCallId: `call-${at}`, isError });
}

/** A two-run session: run 1 reads a file, run 2 (resumed later on another model) answers a follow-up. */
function sessionFixture(): string {
  return [
    line({ type: "title", title: "Fix the bug" }),
    line({ type: "session", id: "s1", timestamp: new Date(T0).toISOString() }),
    line({ type: "model_change", model: "anthropic/model-a", timestamp: new Date(T0).toISOString() }),
    message("developer", [{ type: "text", text: "You are a coding agent." }], T0 + 1_000),
    message("user", [{ type: "text", text: "Fix the bug" }, { type: "image", data: "xx", mimeType: "image/png" }], T0 + 2_000),
    line({ type: "custom", customType: "note", data: {}, timestamp: new Date(T0 + 2_500).toISOString() }),
    message(
      "assistant",
      [
        { type: "thinking", thinking: "secret plan", thinkingSignature: "sig" },
        { type: "text", text: "Looking." },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
        { type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } },
      ],
      T0 + 3_000,
      { model: "model-a", provider: "anthropic" },
    ),
    toolResult("read", "export const a = 1;", T0 + 4_000),
    toolResult("bash", "ls: cannot access", T0 + 5_000, true),
    message("assistant", [{ type: "text", text: "Fixed." }], T0 + 6_000, { model: "model-a", provider: "anthropic" }),
    line({ type: "model_change", model: "openai/model-b", timestamp: new Date(T0 + 60_000).toISOString() }),
    message("user", [{ type: "text", text: "Also add a test" }], T0 + 61_000),
    message("assistant", [{ type: "text", text: "Test added." }], T0 + 62_000, { model: "model-b", provider: "openai" }),
  ].join("\n");
}

const callTag = (name: string, args: unknown) => `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`;
const responseTag = (name: string, content: string, isError = false) =>
  `<tool_response>\n${JSON.stringify({ name, content, is_error: isError })}\n</tool_response>`;

describe("sessionToConversations", () => {
  it("maps omp roles to ShareGPT turns with tool_call / tool_response tags and drops thinking", () => {
    const { conversations, model } = sessionToConversations(sessionFixture());
    expect(conversations).toEqual([
      { from: "system", value: "You are a coding agent." },
      { from: "human", value: "Fix the bug\n[image]" },
      {
        from: "gpt",
        value: `Looking.\n${callTag("read", { path: "a.ts" })}\n${callTag("bash", { command: "ls" })}`,
      },
      { from: "tool", value: responseTag("read", "export const a = 1;") },
      { from: "tool", value: responseTag("bash", "ls: cannot access", true) },
      { from: "gpt", value: "Fixed." },
      { from: "human", value: "Also add a test" },
      { from: "gpt", value: "Test added." },
    ]);
    expect(conversations.some((turn) => turn.value.includes("secret plan"))).toBe(false);
    expect(model).toBe("openai/model-b");
  });

  it("skips malformed and irrelevant lines instead of throwing", () => {
    const jsonl = [
      "not json",
      "{",
      "[1,2,3]",
      "null",
      line({ type: "message" }),
      line({ type: "message", message: "oops" }),
      message("custom", [{ type: "text", text: "internal" }], T0),
      message("user", [{ type: "text", text: "hello" }], T0 + 1),
      "",
      "   ",
      message("assistant", [], T0 + 2, { model: "m", provider: "p" }),
      message("assistant", [{ type: "text", text: "hi" }], T0 + 3),
    ].join("\r\n");
    expect(() => sessionToConversations(jsonl)).not.toThrow();
    expect(sessionToConversations(jsonl).conversations).toEqual([
      { from: "human", value: "hello" },
      { from: "gpt", value: "hi" },
    ]);
  });

  it("limits the export to one run's time window, inclusive, with that run's model", () => {
    const firstRun = sessionToConversations(sessionFixture(), {
      from: new Date(T0 + 2_000).toISOString(),
      to: new Date(T0 + 6_000).toISOString(),
    });
    expect(firstRun.conversations.map((turn) => turn.from)).toEqual(["human", "gpt", "tool", "tool", "gpt"]);
    expect(firstRun.conversations[0].value).toBe("Fix the bug\n[image]");
    expect(firstRun.conversations.at(-1)?.value).toBe("Fixed.");
    expect(firstRun.model).toBe("anthropic/model-a");

    const secondRun = sessionToConversations(sessionFixture(), { from: String(T0 + 60_000) });
    expect(secondRun.conversations).toEqual([
      { from: "human", value: "Also add a test" },
      { from: "gpt", value: "Test added." },
    ]);
    expect(secondRun.model).toBe("openai/model-b");
  });
});

function trajectory(conversations: TrajectoryTurn[]): Trajectory {
  return {
    conversations,
    timestamp: "2026-01-01T10:00:00.000Z",
    model: "anthropic/model-a",
    completed: true,
    taskId: "task-1",
    runId: null,
  };
}

function tokensOf(turns: readonly TrajectoryTurn[]): number {
  return turns.reduce((sum, turn) => sum + estimateTokens(turn.value), 0);
}

/** Every gpt turn with k tool calls is followed by exactly k tool turns, and every tool turn has a caller. */
function expectWholeCallGroups(turns: readonly TrajectoryTurn[]): void {
  let i = 0;
  while (i < turns.length) {
    expect(turns[i].from, `turn ${i} is a tool response without its call`).not.toBe("tool");
    const calls = turns[i].from === "gpt" ? (turns[i].value.match(/<tool_call>/g) ?? []).length : 0;
    for (let k = 1; k <= calls; k++) {
      expect(turns[i + k]?.from, `call ${k} of turn ${i} lost its response`).toBe("tool");
    }
    i += calls + 1;
  }
}

/** Head (system, human, then a gpt calling two tools) + `steps` gpt/tool groups + a closing group. */
function longConversation(steps: number): TrajectoryTurn[] {
  const turns: TrajectoryTurn[] = [
    { from: "system", value: "You are a coding agent." },
    { from: "human", value: "Refactor the parser." },
    { from: "gpt", value: `Start.\n${callTag("read", { path: "a.ts" })}\n${callTag("grep", { pattern: "x" })}` },
    { from: "tool", value: responseTag("read", "a".repeat(400)) },
    { from: "tool", value: responseTag("grep", "b".repeat(400)) },
  ];
  for (let i = 0; i < steps; i++) {
    const tool = i % 3 === 0 ? "bash" : "edit";
    turns.push({ from: "gpt", value: `Step ${i}. ${"reasoning ".repeat(60)}\n${callTag(tool, { n: i })}` });
    turns.push({ from: "tool", value: responseTag(tool, `${"output ".repeat(150)}${i}`, i % 5 === 0) });
  }
  turns.push({ from: "gpt", value: `Finish.\n${callTag("bash", { c: 1 })}\n${callTag("bash", { c: 2 })}\n${callTag("bash", { c: 3 })}` });
  turns.push({ from: "tool", value: responseTag("bash", "one") });
  turns.push({ from: "tool", value: responseTag("bash", "two") });
  turns.push({ from: "tool", value: responseTag("bash", "three") });
  turns.push({ from: "gpt", value: "All done." });
  return turns;
}

/**
 * Shaped like a real omp session: no leading system turn (human, then a gpt calling two tools),
 * `steps` gpt/tool groups with a developer → system turn mid-session before group `systemAt`, and a
 * closing group.
 */
function ompShapedConversation(steps: number, systemAt: number): TrajectoryTurn[] {
  const turns: TrajectoryTurn[] = [
    { from: "human", value: "Implement the card." },
    { from: "gpt", value: `Looking.\n${callTag("read", { path: "a.ts" })}\n${callTag("grep", { pattern: "x" })}` },
    { from: "tool", value: responseTag("read", "a".repeat(400)) },
    { from: "tool", value: responseTag("grep", "b".repeat(400)) },
  ];
  for (let i = 0; i < steps; i++) {
    if (i === systemAt) turns.push({ from: "system", value: "Mid-session developer note." });
    turns.push({ from: "gpt", value: `Step ${i}. ${"reasoning ".repeat(60)}\n${callTag("edit", { n: i })}` });
    turns.push({ from: "tool", value: responseTag("edit", `${"output ".repeat(150)}${i}`) });
  }
  turns.push({ from: "gpt", value: `Finish.\n${callTag("bash", { c: 1 })}` });
  turns.push({ from: "tool", value: responseTag("bash", "ok") });
  turns.push({ from: "gpt", value: "All done." });
  return turns;
}

describe("compressTrajectory", () => {
  it("leaves a trajectory under the target unchanged and reports a ratio of 1", () => {
    const input = trajectory(sessionToConversations(sessionFixture()).conversations);
    const result = compressTrajectory(input);
    expect(result.conversations).toEqual(input.conversations);
    expect(result).toMatchObject({ taskId: "task-1", model: "anthropic/model-a", completed: true });
    const tokens = tokensOf(input.conversations);
    expect(result.metrics).toEqual({
      originalTokens: tokens,
      compressedTokens: tokens,
      tokensSaved: 0,
      compressionRatio: 1,
      turnsRemoved: 0,
      toolResultsPruned: 0,
    });
  });

  it("prunes large old tool outputs to stubs before removing any turn", () => {
    const big = `HEAD${"x".repeat(9_000)}TAIL`;
    const tailOutput = "y".repeat(5_000);
    const turns: TrajectoryTurn[] = [
      { from: "system", value: "sys" },
      { from: "human", value: "go" },
      { from: "gpt", value: callTag("bash", { command: "cat big.log" }) },
      { from: "tool", value: responseTag("bash", big) },
      { from: "gpt", value: callTag("read", { path: "b.ts" }) },
      { from: "tool", value: responseTag("read", tailOutput) },
      { from: "gpt", value: "done" },
      { from: "human", value: "thanks" },
    ];
    const result = compressTrajectory(trajectory(turns), { maxTokens: 2_000 });

    expect(result.metrics?.toolResultsPruned).toBe(1);
    expect(result.metrics?.turnsRemoved).toBe(0);
    expect(result.conversations).toHaveLength(turns.length);
    const stub = result.conversations[3].value;
    expect(stub.length).toBeLessThan(1_000);
    const inner = JSON.parse(/^<tool_response>\n(.*)\n<\/tool_response>$/.exec(stub)?.[1] ?? "null");
    expect(inner.name).toBe("bash");
    expect(inner.content).toBe(`${big.slice(0, 200)} … [${big.length - 400} chars pruned] … ${big.slice(-200)}`);
    // The protected tail keeps its large output verbatim.
    expect(result.conversations[5]).toEqual(turns[5]);
    expect(result.metrics?.compressedTokens).toBe(tokensOf(result.conversations));
    expect(result.metrics?.tokensSaved).toBe(tokensOf(turns) - tokensOf(result.conversations));
    expect(result.metrics?.compressedTokens).toBeLessThanOrEqual(2_000);
  });

  it("replaces middle turns with one summary, keeping the head and last turns and whole call groups", () => {
    const turns = longConversation(40);
    const maxTokens = 3_000;
    expect(tokensOf(turns)).toBeGreaterThan(maxTokens);
    const result = compressTrajectory(trajectory(turns), { maxTokens });
    const out = result.conversations;
    const removed = result.metrics?.turnsRemoved ?? 0;

    expect(removed).toBeGreaterThan(0);
    expect(out).toHaveLength(turns.length - removed + 1);
    // Head: first system, human, gpt and tool turns plus the rest of the first call group.
    expect(out.slice(0, 5)).toEqual(turns.slice(0, 5));
    // Tail: the last turns verbatim, including the gpt whose calls the tail answers.
    expect(out.slice(-PROTECT_LAST_TURNS - 1)).toEqual(turns.slice(-PROTECT_LAST_TURNS - 1));
    expectWholeCallGroups(out);

    const summaries = out.filter((turn) => turn.value.startsWith("[CONTEXT SUMMARY]"));
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    expect(summary.from).toBe("human");
    expect(out[5]).toBe(summary);

    const gone = turns.slice(5, 5 + removed);
    const tally = new Map<string, number>();
    for (const turn of gone) {
      for (const match of turn.value.matchAll(/<tool_call>\n(.*)\n<\/tool_call>/g)) {
        const name = JSON.parse(match[1]).name as string;
        tally.set(name, (tally.get(name) ?? 0) + 1);
      }
    }
    const errors = gone.filter((turn) => turn.from === "tool" && turn.value.includes('"is_error":true')).length;
    expect(errors).toBeGreaterThan(0);
    const used = [...tally]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => `${name}×${count}`);
    expect(summary.value).toBe(`[CONTEXT SUMMARY]: ${removed} turns compressed (tools used: ${used.join(", ")}; ${errors} errors)`);

    expect(result.metrics?.compressedTokens).toBe(tokensOf(out));
    expect(result.metrics?.compressedTokens).toBeLessThanOrEqual(maxTokens);
    expect(result.metrics?.compressionRatio).toBeLessThan(1);
    // Only as much as needed: one step group is ~450 tokens, so the cut stops within one group of the target.
    expect(tokensOf(out)).toBeGreaterThan(maxTokens - 600);
  });

  it("removes the whole middle when the target cannot be met, still without splitting call groups", () => {
    const turns = longConversation(10);
    const result = compressTrajectory(trajectory(turns), { maxTokens: 200 });
    const out = result.conversations;
    expectWholeCallGroups(out);
    // head (5) + summary + the closing call group (gpt + 3 tool turns + final gpt)
    expect(out).toHaveLength(5 + 1 + 5);
    expect(out.slice(-5)).toEqual(turns.slice(-5));
    expect(result.metrics?.turnsRemoved).toBe(turns.length - 10);
  });

  it("protects only the leading call group of a session without a leading system turn", () => {
    // The system turn sits ~45 groups (~19k tokens) in: protecting up to it would make 3,000 unreachable.
    const turns = ompShapedConversation(60, 45);
    const maxTokens = 3_000;
    expect(tokensOf(turns)).toBeGreaterThan(maxTokens);
    const result = compressTrajectory(trajectory(turns), { maxTokens });
    const out = result.conversations;

    expect(result.metrics?.compressedTokens).toBe(tokensOf(out));
    expect(result.metrics?.compressedTokens).toBeLessThanOrEqual(maxTokens);
    // Head: human + gpt + both tool responses of its call group; the summary follows directly.
    expect(out.slice(0, 4)).toEqual(turns.slice(0, 4));
    expect(out[4].from).toBe("human");
    expect(out[4].value.startsWith("[CONTEXT SUMMARY]")).toBe(true);
    expect(out.slice(-PROTECT_LAST_TURNS)).toEqual(turns.slice(-PROTECT_LAST_TURNS));
    expectWholeCallGroups(out);
  });

  it("parses tool turns containing U+2028/U+2029: stubs stay valid JSON and errors are counted", () => {
    const big = `first\u2028second${"x".repeat(5_000)}third\u2029last`;
    const turns: TrajectoryTurn[] = [
      { from: "human", value: "go" },
      { from: "gpt", value: callTag("read", { path: "a.ts" }) },
      { from: "tool", value: responseTag("read", "a") },
      { from: "gpt", value: callTag("bash", { command: "printf '\u2028'" }) },
      { from: "tool", value: responseTag("bash", big, true) },
      { from: "gpt", value: callTag("edit", { path: "a.ts" }) },
      { from: "tool", value: responseTag("edit", "ok") },
      { from: "gpt", value: "done" },
      { from: "human", value: "thanks" },
    ];

    const pruned = compressTrajectory(trajectory(turns), { maxTokens: 1_000 });
    expect(pruned.metrics).toMatchObject({ toolResultsPruned: 1, turnsRemoved: 0 });
    const stub = pruned.conversations[4].value;
    const inner = JSON.parse(/^<tool_response>\n([\s\S]*)\n<\/tool_response>$/.exec(stub)?.[1] ?? "null");
    expect(inner).toEqual({
      name: "bash",
      content: `${big.slice(0, 200)} … [${big.length - 400} chars pruned] … ${big.slice(-200)}`,
      is_error: true,
    });
    expect(inner.content).toContain("\u2028");

    const cut = compressTrajectory(trajectory(turns), { maxTokens: 50 });
    expect(cut.metrics?.turnsRemoved).toBe(2);
    expect(cut.conversations[3]).toEqual({
      from: "human",
      value: "[CONTEXT SUMMARY]: 2 turns compressed (tools used: bash×1; 1 errors)",
    });
    expectWholeCallGroups(cut.conversations);
  });

  it("never mutates its input", () => {
    const turns = longConversation(40);
    turns[6] = { from: "tool", value: responseTag("edit", "z".repeat(6_000)) };
    turns[5] = { from: "gpt", value: callTag("edit", { n: "big" }) };
    const input = trajectory(turns);
    const snapshot = structuredClone(input);
    const result = compressTrajectory(input, { maxTokens: 3_000 });
    expect(result.metrics?.toolResultsPruned).toBe(1);
    expect(result.metrics?.turnsRemoved).toBeGreaterThan(0);
    expect(input).toEqual(snapshot);
    expect(input.metrics).toBeUndefined();
    expect(result.conversations).not.toBe(input.conversations);
  });
});

describe("redactTrajectory", () => {
  const SECRET = "s3cr3t-value-123";

  it("replaces known secret values in tool and gpt turns, longest first, without mutating the input", () => {
    const input = trajectory([
      { from: "human", value: "Deploy it." },
      { from: "gpt", value: `Using ${SECRET}.\n${callTag("bash", { command: `curl -H 'x: ${SECRET}'` })}` },
      { from: "tool", value: responseTag("bash", `KEY=${SECRET}\nLONG=${SECRET}-suffix`) },
    ]);
    const snapshot = structuredClone(input);
    const out = redactTrajectory(input, [SECRET, `${SECRET}-suffix`]);
    expect(out.conversations[0]).toEqual({ from: "human", value: "Deploy it." });
    expect(out.conversations[1].value).toBe(
      `Using ${REDACTED}.\n${callTag("bash", { command: `curl -H 'x: ${REDACTED}'` })}`,
    );
    expect(out.conversations[2].value).toBe(responseTag("bash", `KEY=${REDACTED}\nLONG=${REDACTED}`));
    expect(input).toEqual(snapshot);
    expect({ ...out, conversations: [] }).toEqual({ ...input, conversations: [] });
  });

  it("matches secrets as they appear JSON-escaped inside tool turns and trimmed", () => {
    const quoted = 'pa"ss\\word-42';
    const out = redactTrajectory(trajectory([{ from: "tool", value: responseTag("cat", `pw=${quoted} tok=${SECRET}`) }]), [
      quoted,
      ` ${SECRET}\n`,
    ]);
    expect(out.conversations[0].value).toBe(responseTag("cat", `pw=${REDACTED} tok=${REDACTED}`));
  });

  it("ignores secret values shorter than MIN_SECRET_LENGTH", () => {
    const short = "x".repeat(MIN_SECRET_LENGTH - 1);
    const out = redactTrajectory(trajectory([{ from: "tool", value: `value ${short}` }]), [short, ""]);
    expect(out.conversations[0].value).toBe(`value ${short}`);
  });

  it("redacts common token shapes even when the value is unknown", () => {
    const tokens = [
      `sk-${"A1b2_".repeat(5)}`,
      `sk-ant-api03-${"x".repeat(24)}`,
      `ghp_${"a".repeat(36)}`,
      `github_pat_${"B".repeat(40)}`,
      `xoxb-${"1234-".repeat(3)}abc`,
      `AKIA${"ABCDEFGH12345678"}`,
    ];
    const out = redactTrajectory(trajectory([{ from: "tool", value: tokens.map((t) => `t=${t}`).join("\n") }]), []);
    expect(out.conversations[0].value).toBe(tokens.map(() => `t=${REDACTED}`).join("\n"));

    // Not token shapes: too short, or `sk-` inside a word.
    const plain = `sk-short task-${"a".repeat(30)} ghp_abc`;
    expect(redactTrajectory(trajectory([{ from: "gpt", value: plain }]), []).conversations[0].value).toBe(plain);
  });
});
