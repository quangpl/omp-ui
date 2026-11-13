import { describe, expect, it } from "vitest";
import { foldText, matchToken, tokenScore } from "@/lib/fuzzy-match";

describe("foldText", () => {
  it("lowercases and strips accents without shifting indexes", () => {
    expect(foldText("Crème Brûlée")).toBe("creme brulee");
    expect(foldText("Crème Brûlée")).toHaveLength("Crème Brûlée".length);
  });
});

describe("tokenScore", () => {
  it("ranks prefix > word start > substring > subsequence", () => {
    expect(tokenScore("login page", "log", false)).toBe(4);
    expect(tokenScore("fix login", "log", false)).toBeCloseTo(2.8);
    expect(tokenScore("catalog", "log", false)).toBeCloseTo(1.75);
    const subsequence = tokenScore("fix login", "fxlgn", true);
    expect(subsequence).toBeGreaterThan(0);
    expect(subsequence).toBeLessThan(1);
    expect(tokenScore("fix login", "fxlgn", false)).toBe(0);
  });
});

describe("matchToken", () => {
  it("prefers an exact word-start occurrence", () => {
    expect(matchToken("fix login", "log")).toEqual({ tier: "exact", score: tokenScore("fix login", "log", false), indices: [4, 5, 6] });
  });

  it("accepts one swapped letter in a word", () => {
    expect(matchToken("fix login", "lgoin")).toEqual({ tier: "typo", score: 1, indices: [4, 5, 6, 7, 8] });
  });

  it("falls back to a subsequence", () => {
    const match = matchToken("fix login", "fxlgn");
    expect(match).toMatchObject({ tier: "loose", indices: [0, 2, 4, 6, 8] });
  });

  it("returns null when nothing fits", () => {
    expect(matchToken("fix login", "zzz")).toBeNull();
  });

  it("does not treat short tokens as typos", () => {
    expect(matchToken("fix login", "lgo")?.tier).not.toBe("typo");
  });
});
