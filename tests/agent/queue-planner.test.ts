import { describe, expect, it } from "vitest";

import { PLANNER_MARKER, buildPlanPrompt, parsePlanReply, type PlanCard } from "@/lib/agent/queue-planner";

function card(id: string, blockedBy: string[] = []): PlanCard {
  return { id, title: `Card ${id}`, description: `Do ${id}`, blockedBy };
}

const plan = (data: unknown) => JSON.stringify(data);

describe("queue planner prompt", () => {
  it("starts with the marker and lists every running and queued card", () => {
    const prompt = buildPlanPrompt({
      board: { name: "Shop", workdir: "/work/shop", extraFolders: [] },
      queued: [card("q1", ["r1"]), { ...card("q2"), description: "Line one\n\nline two" }],
      running: [card("r1")],
    });
    expect(prompt.startsWith(PLANNER_MARKER)).toBe(true);
    expect(prompt).toContain('"Shop"');
    for (const id of ["q1", "q2", "r1"]) expect(prompt).toContain(`- ${id} — Card ${id}`);
    expect(prompt).toContain("already runs after: r1");
    expect(prompt).toContain("Line one line two");
  });
});

describe("queue planner replies", () => {
  it("reads a plan from a fenced or prose-wrapped reply", () => {
    const queued = [card("a"), card("b")];
    expect(parsePlanReply('```json\n{"order": ["b", "a"], "cards": []}\n```', queued, []).order).toEqual(["b", "a"]);
    expect(parsePlanReply('Here is the plan: {"order": ["b", "a"]} — done.', queued, []).order).toEqual(["b", "a"]);
  });

  it("throws when the reply holds no JSON object", () => {
    expect(() => parsePlanReply("I could not decide.", [card("a")], [])).toThrow(/did not answer with a plan/);
  });

  it("drops unknown ids and self-dependencies, keeping running prerequisites", () => {
    const result = parsePlanReply(
      plan({
        order: ["zzz", "a", "b"],
        cards: [
          { id: "a", waitFor: ["a", "zzz", "r", "r", 5] },
          { id: "zzz", waitFor: ["a"], reason: "Unknown card" },
          "junk",
        ],
      }),
      [card("a"), card("b")],
      [card("r")],
    );
    expect(result).toEqual({ order: ["a", "b"], dependencies: { a: ["r"] }, reasons: {} });
  });

  it("appends queued cards the planner left out in their input order", () => {
    const queued = [card("a"), card("b"), card("c"), card("d")];
    expect(parsePlanReply(plan({ order: ["c", "x", "c"] }), queued, []).order).toEqual(["c", "a", "b", "d"]);
    expect(parsePlanReply(plan({ cards: [] }), queued, []).order).toEqual(["a", "b", "c", "d"]);
  });

  it("drops an inferred edge that would close a cycle", () => {
    const mutual = parsePlanReply(
      plan({
        order: ["a", "b"],
        cards: [
          { id: "a", waitFor: ["b"] },
          { id: "b", waitFor: ["a"] },
        ],
      }),
      [card("a"), card("b")],
      [],
    );
    expect(mutual.dependencies).toEqual({ a: ["b"] });
    expect(mutual.order).toEqual(["b", "a"]);

    // c already runs after b, which runs after a: a cannot wait for c.
    const existing = parsePlanReply(
      plan({ order: ["a", "b", "c"], cards: [{ id: "a", waitFor: ["c"] }] }),
      [card("a"), card("b", ["a"]), card("c", ["b"])],
      [],
    );
    expect(existing.dependencies).toEqual({});
    expect(existing.order).toEqual(["a", "b", "c"]);
  });

  it("moves dependants after their prerequisites, otherwise keeping the planner's order", () => {
    const inferred = parsePlanReply(
      plan({ order: ["a", "b", "c"], cards: [{ id: "a", waitFor: ["c"] }] }),
      [card("a"), card("b"), card("c")],
      [],
    );
    expect(inferred.order).toEqual(["b", "c", "a"]);

    // Existing "Runs after" among queued cards counts too; a running prerequisite does not.
    const existing = parsePlanReply(plan({ order: ["a", "b", "c"] }), [card("a", ["b"]), card("b"), card("c", ["r"])], [card("r")]);
    expect(existing.order).toEqual(["b", "a", "c"]);
  });

  it("keeps reasons on one line, clipped, and only for queued cards", () => {
    const long = `First line\n${"word ".repeat(80)}`;
    const result = parsePlanReply(
      plan({
        order: ["a", "b"],
        cards: [
          { id: "a", reason: long },
          { id: "b", reason: "   " },
          { id: "r", reason: "Running" },
        ],
      }),
      [card("a"), card("b")],
      [card("r")],
    );
    expect(Object.keys(result.reasons)).toEqual(["a"]);
    expect(result.reasons.a.length).toBeLessThanOrEqual(160);
    expect(result.reasons.a).not.toContain("\n");
    expect(result.reasons.a.startsWith("First line word")).toBe(true);
    expect(result.reasons.a.endsWith("…")).toBe(true);
  });
});
