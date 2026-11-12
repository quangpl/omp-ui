import { describe, expect, it } from "vitest";
import { chooseDraftModel, parseDraftReply } from "@/lib/agent/draft";
import { ATTACH_BRIEF_MIN, ORCHESTRATE_LINE, TITLE_MAX, draftToCard, fallbackDraft } from "@/lib/card-draft";

const open = new Map([
  ["c1", "Build the API"],
  ["c2", "Add dark mode"],
]);

describe("parseDraftReply", () => {
  it("reads a card from a fenced or prose-wrapped reply; `parallel` asks for parallel subagents", () => {
    const reply = { title: "Fix the login redirect", description: "## Goal\n\nStop the loop.", parallel: true, waitFor: [] };
    const card = { title: reply.title, description: reply.description, orchestrate: true, waitFor: [] };
    for (const text of [
      JSON.stringify(reply),
      `\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``,
      `Here is the card:\n${JSON.stringify(reply)}\nGood luck!`,
    ]) {
      expect(parseDraftReply(text, open)).toEqual(card);
    }
  });

  it("keeps only open cards in waitFor, once each, with their titles", () => {
    const reply = JSON.stringify({ title: "T", description: "", waitFor: ["c2", "nope", "c2", 7, "c1"] });
    expect(parseDraftReply(reply, open).waitFor).toEqual([
      { id: "c2", title: "Add dark mode" },
      { id: "c1", title: "Build the API" },
    ]);
  });

  it("puts the title on one line within the API limit and treats a non-true parallel as false", () => {
    const draft = parseDraftReply(JSON.stringify({ title: `Fix\n  the ${"x".repeat(300)}`, parallel: "yes" }), open);
    expect(draft.title.startsWith("Fix the ")).toBe(true);
    expect(draft.title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(draft.orchestrate).toBe(false);
    expect(draft.description).toBe("");
  });

  it("rejects replies without a card or a title", () => {
    expect(() => parseDraftReply("I could not do it.", open)).toThrow(/did not answer with a card/);
    expect(() => parseDraftReply('{"title": "  ", "description": "x"}', open)).toThrow(/no title/);
  });
});

describe("chooseDraftModel", () => {
  const board = { model: null };
  const settings = { defaultModel: "sonnet" };
  const roles = { smol: "anthropic/claude-haiku-4-5" };

  it("writes short requests fast: the smol role, else the default model thinking briefly", () => {
    expect(chooseDraftModel({ text: "Fix the typo in the footer", roles, board, settings })).toMatchObject({
      model: "@smol",
      thinking: null,
      tier: "quick",
    });
    expect(chooseDraftModel({ text: "Fix the typo in the footer", roles: {}, board: { model: "opus" }, settings })).toMatchObject({
      model: "opus",
      thinking: "low",
      tier: "quick",
    });
  });

  it("gives long or list-heavy requests the project's model and more time", () => {
    const quick = chooseDraftModel({ text: "short", roles, board, settings });
    for (const text of ["word ".repeat(150), "Revamp:\n- a\n- b\n- c\n1. d\n2) e"]) {
      const choice = chooseDraftModel({ text, roles, board, settings });
      expect(choice).toMatchObject({ model: "sonnet", thinking: null, tier: "thorough" });
      expect(choice.timeoutSeconds).toBeGreaterThan(quick.timeoutSeconds);
    }
  });
});

describe("fallbackDraft", () => {
  it("titles the card with the first line, without its list marker, and keeps the text", () => {
    const text = "- Fix the login redirect\nIt loops forever.";
    expect(fallbackDraft(text)).toEqual({ title: "Fix the login redirect", description: text, orchestrate: false, waitFor: [] });
  });

  it("uses the first sentence of a long first line, and no description for a bare title", () => {
    const long = `The stats page overflows on phones. ${"More detail follows here. ".repeat(10)}`;
    expect(fallbackDraft(long).title).toBe("The stats page overflows on phones.");
    expect(fallbackDraft("  Rename the button  ")).toMatchObject({ title: "Rename the button", description: "" });
  });
});

describe("draftToCard", () => {
  const draft = { title: " Fix it ", description: "## Goal\n\nFix it.", orchestrate: false, waitFor: [{ id: "c1", title: "Build the API" }] };

  it("adds omp's orchestrate keyword only when the card should be orchestrated", () => {
    expect(draftToCard(draft, "fix it").description).toBe("## Goal\n\nFix it.");
    expect(draftToCard({ ...draft, orchestrate: true }, "fix it").description).toBe(`## Goal\n\nFix it.\n\n${ORCHESTRATE_LINE}`);
    expect(ORCHESTRATE_LINE.startsWith("orchestrate")).toBe(true);
  });

  it("attaches long original text the description does not hold, and maps waitFor to blockedBy", () => {
    const long = "word ".repeat(ATTACH_BRIEF_MIN / 5 + 1).trim();
    expect(draftToCard(draft, long)).toEqual({ title: "Fix it", description: "## Goal\n\nFix it.", blockedBy: ["c1"], brief: long });
    expect(draftToCard({ ...draft, description: long }, long).brief).toBeUndefined();
    expect(draftToCard(draft, "short text").brief).toBeUndefined();
  });
});
