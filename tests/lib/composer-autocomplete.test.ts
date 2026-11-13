import { describe, expect, it } from "vitest";

import { applyCompletion, autocompleteTokenAt, mentionText } from "@/lib/composer-autocomplete";

describe("autocompleteTokenAt", () => {
  it("matches / at the start of the text", () => {
    expect(autocompleteTokenAt("/min", 4)).toEqual({ trigger: "slash", start: 0, end: 4, query: "min" });
  });

  it("matches / after whitespace, mid-text, at the caret", () => {
    const text = "Redesign the page /bran and keep the logo";
    expect(autocompleteTokenAt(text, 23)).toEqual({ trigger: "slash", start: 18, end: 23, query: "bran" });
  });

  it("matches a bare / with an empty query", () => {
    expect(autocompleteTokenAt("do it\n/", 7)).toEqual({ trigger: "slash", start: 6, end: 7, query: "" });
  });

  it("matches skill:// mid-text and prefers it over the slash trigger", () => {
    const text = "use skill://min now";
    expect(autocompleteTokenAt(text, 15)).toEqual({ trigger: "skill-url", start: 4, end: 15, query: "min" });
    expect(autocompleteTokenAt("skill://", 8)).toEqual({ trigger: "skill-url", start: 0, end: 8, query: "" });
  });

  it("matches @ mentions mid-text, including path separators", () => {
    const text = "fix @src/ap then test";
    expect(autocompleteTokenAt(text, 11)).toEqual({ trigger: "mention", start: 4, end: 11, query: "src/ap" });
    expect(autocompleteTokenAt("@", 1)).toEqual({ trigger: "mention", start: 0, end: 1, query: "" });
  });

  it("keeps completing after a directory mention", () => {
    expect(autocompleteTokenAt("see @src/", 9)).toEqual({ trigger: "mention", start: 4, end: 9, query: "src/" });
  });

  it("matches an opened quoted mention whose query may contain spaces", () => {
    const text = 'open @"My Docs/no';
    expect(autocompleteTokenAt(text, text.length)).toEqual({
      trigger: "mention",
      start: 5,
      end: 17,
      query: "My Docs/no",
    });
  });

  it("closes a quoted mention once the quote is closed", () => {
    const text = 'open @"My Docs" next';
    expect(autocompleteTokenAt(text, text.length)).toBeNull();
  });

  it("ignores URLs, paths and emails", () => {
    for (const text of ["see https://x/y", "fix a/b", "mail me@x.com", "mail me@"]) {
      expect(autocompleteTokenAt(text, text.length)).toBeNull();
    }
  });

  it("closes once the token is left behind", () => {
    expect(autocompleteTokenAt("/min done", 9)).toBeNull();
    expect(autocompleteTokenAt("@src done", 9)).toBeNull();
  });

  it("only looks at the text before the caret", () => {
    expect(autocompleteTokenAt("/orchestrate", 3)).toEqual({ trigger: "slash", start: 0, end: 3, query: "or" });
  });
});

describe("applyCompletion", () => {
  it("reuses an existing following space and puts the caret after it", () => {
    const text = "Build the page /min please";
    const token = autocompleteTokenAt(text, 19)!;
    const next = applyCompletion(text, token, "skill://minimalist-ui");
    expect(next.text).toBe("Build the page skill://minimalist-ui please");
    expect(next.text.slice(0, next.caret)).toBe("Build the page skill://minimalist-ui ");
  });

  it("appends a trailing space at the end of the text", () => {
    const next = applyCompletion("/orch", autocompleteTokenAt("/orch", 5)!, "orchestrate");
    expect(next).toEqual({ text: "orchestrate ", caret: 12 });
  });

  it("inserts a space before non-whitespace that follows the token", () => {
    const next = applyCompletion("x @ap,y", autocompleteTokenAt("x @ap,y", 5)!, "@src/app.ts");
    expect(next).toEqual({ text: "x @src/app.ts ,y", caret: 14 });
  });

  it("treats a following newline as existing whitespace", () => {
    const next = applyCompletion("/orch\nnext", autocompleteTokenAt("/orch\nnext", 5)!, "orchestrate");
    expect(next).toEqual({ text: "orchestrate\nnext", caret: 12 });
  });

  it("omits the trailing space when disabled, leaving the caret right after the replacement", () => {
    const end = applyCompletion("fix @sr", autocompleteTokenAt("fix @sr", 7)!, "@src/", { trailingSpace: false });
    expect(end).toEqual({ text: "fix @src/", caret: 9 });
    const mid = applyCompletion("fix @sr more", autocompleteTokenAt("fix @sr more", 7)!, "@src/", {
      trailingSpace: false,
    });
    expect(mid).toEqual({ text: "fix @src/ more", caret: 9 });
  });

  it("replaces a quoted mention token as a whole", () => {
    const text = 'open @"My Do';
    const next = applyCompletion(text, autocompleteTokenAt(text, text.length)!, mentionText("My Docs/a.md"));
    expect(next).toEqual({ text: 'open @"My Docs/a.md" ', caret: 21 });
  });

  it("completes skill:// names", () => {
    const text = "use skill://br";
    const next = applyCompletion(text, autocompleteTokenAt(text, text.length)!, "skill://brandkit");
    expect(next).toEqual({ text: "use skill://brandkit ", caret: 21 });
  });
});

describe("mentionText", () => {
  it("prefixes plain paths with @", () => {
    expect(mentionText("src/app.ts")).toBe("@src/app.ts");
    expect(mentionText("src/")).toBe("@src/");
    expect(mentionText("/abs/extra/lib.ts")).toBe("@/abs/extra/lib.ts");
  });

  it("quotes paths containing whitespace", () => {
    expect(mentionText("My Docs/a.md")).toBe('@"My Docs/a.md"');
  });
});
