import { describe, expect, it } from "vitest";

import { extractQuestion, questionPreview } from "@/lib/question";

describe("extractQuestion", () => {
  it("returns null when the summary asks nothing", () => {
    expect(extractQuestion("")).toBeNull();
    expect(extractQuestion("Implemented the task and ran the tests.")).toBeNull();
  });

  it("keeps the question paragraph", () => {
    const summary =
      "Added the endpoint and wired the UI.\n\nShould pagination default to 20 or 50 items per page?";
    expect(extractQuestion(summary)).toBe("Should pagination default to 20 or 50 items per page?");
  });

  it("keeps a multi-sentence question paragraph whole for context", () => {
    const question = "I kept the old colors for now.\nDo you want the new palette instead?";
    expect(extractQuestion(`Done.\n\n${question}`)).toBe(question);
  });

  it("keeps only the question items of a pure list paragraph", () => {
    const summary = [
      "Done. Left for you to decide:",
      "",
      "- Should the banner auto-dismiss?",
      "- I kept the old colors.",
      "- **Delete the legacy page?**",
    ].join("\n");
    expect(extractQuestion(summary)).toBe(
      "- Should the banner auto-dismiss?\n- **Delete the legacy page?**",
    );
  });

  it("allows trailing markdown decoration after the question mark", () => {
    expect(extractQuestion('All set. *Is "beta" the right label?*')).toBe(
      'All set. *Is "beta" the right label?*',
    );
  });

  it("ignores questions inside code fences", () => {
    expect(extractQuestion("```\nis this ok?\n```\n\nAll done.")).toBeNull();
  });

  it("caps very long questions", () => {
    const long = `${"x".repeat(2000)}?`;
    expect(extractQuestion(long)!.length).toBeLessThanOrEqual(1200);
  });
});

describe("questionPreview", () => {
  it("returns the first line", () => {
    expect(questionPreview("- Keep it?\n- Drop it?")).toBe("- Keep it?");
    expect(questionPreview("One line?")).toBe("One line?");
  });
});
