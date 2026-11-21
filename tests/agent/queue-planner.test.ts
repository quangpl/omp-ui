import { describe, expect, it } from "vitest";

import { PLANNER_MARKER, buildPlanPrompt, parsePlanReply, type PlanCard } from "@/lib/agent/queue-planner";

function card(id: string): PlanCard {
  return { id, title: `Card ${id}`, description: `Do ${id}` };
}

const plan = (data: unknown) => JSON.stringify(data);

describe("queue planner prompt", () => {
  it("starts with the marker and lists every running and queued card", () => {
    const prompt = buildPlanPrompt({
      board: { name: "Shop", workdir: "/work/shop", extraFolders: [] },
      queued: [card("q1"), { ...card("q2"), description: "Line one\n\nline two" }],
      running: [card("r1")],
    });
    expect(prompt.startsWith(PLANNER_MARKER)).toBe(true);
    expect(prompt).toContain('"Shop"');
    for (const id of ["q1", "q2", "r1"]) expect(prompt).toContain(`- ${id} — Card ${id}`);
    expect(prompt).toContain("Line one line two");
    expect(prompt).not.toContain("waitFor");
  });
});

describe("queue planner replies", () => {
  it("reads a plan from a fenced or prose-wrapped reply", () => {
    const queued = [card("a"), card("b")];
    expect(parsePlanReply('```json\n{"order": ["b", "a"], "cards": []}\n```', queued).order).toEqual(["b", "a"]);
    expect(parsePlanReply('Here is the plan: {"order": ["b", "a"]} — done.', queued).order).toEqual(["b", "a"]);
  });

  it("throws when the reply holds no JSON object", () => {
    expect(() => parsePlanReply("I could not decide.", [card("a")])).toThrow(/did not answer with a plan/);
  });

  it("drops unknown ids and appends queued cards the planner left out in their input order", () => {
    const queued = [card("a"), card("b"), card("c"), card("d")];
    expect(parsePlanReply(plan({ order: ["zzz", "c", "x", "c"] }), queued)).toEqual({
      order: ["c", "a", "b", "d"],
      reasons: {},
    });
    expect(parsePlanReply(plan({ cards: [] }), queued).order).toEqual(["a", "b", "c", "d"]);
  });

  it("ignores waitFor fields: the planner can never make a card wait", () => {
    const result = parsePlanReply(
      plan({ order: ["a", "b"], cards: [{ id: "a", waitFor: ["b"], reason: "Waits for b." }] }),
      [card("a"), card("b")],
    );
    expect(result).toEqual({ order: ["a", "b"], reasons: { a: "Waits for b." } });
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
    );
    expect(Object.keys(result.reasons)).toEqual(["a"]);
    expect(result.reasons.a.length).toBeLessThanOrEqual(160);
    expect(result.reasons.a).not.toContain("\n");
    expect(result.reasons.a.startsWith("First line word")).toBe(true);
    expect(result.reasons.a.endsWith("…")).toBe(true);
  });
});
