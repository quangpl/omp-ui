import { describe, expect, it } from "vitest";

import { joinTranscript, mergeTranscript } from "@/lib/speech-input";

describe("mergeTranscript", () => {
  it("appends to existing text with a separating space", () => {
    expect(mergeTranscript("Fix the", "", "login bug")).toEqual({ value: "Fix the login bug", inserted: " login bug" });
  });

  it("does not add a space after whitespace or into an empty field", () => {
    expect(mergeTranscript("Line one\n", "", "line two").value).toBe("Line one\nline two");
    expect(mergeTranscript("", "", "hello").value).toBe("hello");
  });

  it("replaces the previous interim insertion instead of stacking it", () => {
    const first = mergeTranscript("Fix", "", "the log");
    const second = mergeTranscript(first.value, first.inserted, "the login bug");
    expect(second.value).toBe("Fix the login bug");
  });

  it("removes the insertion when the transcript becomes empty", () => {
    const first = mergeTranscript("Fix", "", "x");
    expect(mergeTranscript(first.value, first.inserted, "")).toEqual({ value: "Fix", inserted: "" });
  });
});

describe("joinTranscript", () => {
  it("joins final and interim parts of a session", () => {
    const results = [[{ transcript: "hello" }], [{ transcript: " world" }]];
    expect(joinTranscript({ results: Object.assign(results, { length: 2 }) })).toBe("hello world");
  });
});
