import { describe, expect, it } from "vitest";

import { formatDecision, parseAdvisorArgs, parseDecision, parseTriage } from "@/lib/agent/advisor";

describe("advisor replies", () => {
  it("reads a decision from a fenced or prose-wrapped reply", () => {
    expect(parseDecision('```json\n{"needsUser": false, "decision": "Use zod", "reason": "Already a dependency."}\n```')).toEqual({
      needsUser: false,
      decision: "Use zod",
      reason: "Already a dependency.",
    });
    expect(parseDecision('Here you go: {"needsUser": true, "decision": "Blue"} done').needsUser).toBe(true);
    expect(() => parseDecision('{"needsUser": false}')).toThrow(/did not answer/);
  });

  it("reads a triage, treating empty strings as nothing left for the user", () => {
    expect(
      parseTriage(
        JSON.stringify({
          answers: [{ question: "Tests?", answer: "Yes, add one." }, { question: "Blank", answer: "" }, "junk"],
          userQuestion: "  ",
          followUp: "Add the test.",
        }),
      ),
    ).toEqual({ answers: [{ question: "Tests?", answer: "Yes, add one." }], userQuestion: null, followUp: "Add the test." });
    expect(() => parseTriage("no json here")).toThrow(/did not answer/);
  });

  it("tells the agent to keep going on questions only the user can answer", () => {
    const text = formatDecision({ needsUser: true, decision: "Use the existing blue", reason: "Brand call." });
    expect(text).toMatch(/Only the user can answer/);
    expect(text).toMatch(/Do not stop/);
    expect(text).toContain("Use the existing blue");
    expect(formatDecision({ needsUser: false, decision: "Use zod", reason: "" })).toBe(
      "Advisor's decision: Use zod\nProceed with it; do not ask the user about this.",
    );
  });

  it("rejects a call without a question and drops blank options", () => {
    expect(() => parseAdvisorArgs({ question: "  " })).toThrow(/question is required/);
    expect(parseAdvisorArgs({ question: "Which?", options: ["a", " ", 3, "b"], context: 7 })).toEqual({
      question: "Which?",
      options: ["a", "b"],
      context: "",
    });
  });
});
