import { describe, expect, it } from "vitest";

import {
  buildWordModelData,
  suggestWord,
  wordCompletionQuery,
  wordModelFromData,
  type WordModel,
} from "@/lib/word-completion";

// Suggestion for the word ending at the end of `text`, as the composer would ask for it.
function suggestAtEnd(model: WordModel, text: string): string | null {
  const query = wordCompletionQuery(text, text.length);
  if (!query) throw new Error(`no word query for ${JSON.stringify(text)}`);
  return suggestWord(model, text, query);
}

describe("wordCompletionQuery", () => {
  it("returns the word being typed with the previous word", () => {
    expect(wordCompletionQuery("Please imp", 10)).toEqual({ start: 7, end: 10, prefix: "imp", previous: "please" });
  });

  it("matches at the start of the text with no previous word", () => {
    expect(wordCompletionQuery("Imp", 3)).toEqual({ start: 0, end: 3, prefix: "Imp", previous: null });
  });

  it("matches mid-text when the caret ends a word", () => {
    expect(wordCompletionQuery("Please imp now", 10)).toEqual({ start: 7, end: 10, prefix: "imp", previous: "please" });
  });

  it("allows punctuation right after the caret", () => {
    expect(wordCompletionQuery("imp.", 3)).toEqual({ start: 0, end: 3, prefix: "imp", previous: null });
  });

  it("skips an opening quote and still links the previous word", () => {
    expect(wordCompletionQuery("say 'imp", 8)).toEqual({ start: 5, end: 8, prefix: "imp", previous: "say" });
  });

  it("rejects a caret in the middle of a word", () => {
    expect(wordCompletionQuery("Please implement", 10)).toBeNull();
  });

  it("rejects prefixes shorter than two letters", () => {
    expect(wordCompletionQuery("Please i", 8)).toBeNull();
  });

  it("rejects paths, URLs, emails and identifiers", () => {
    for (const text of [
      "open src/comp",
      "see https://example.com/doc",
      "mail me@exam",
      "call foo_ba",
      "use fooBa",
      "release v2beta",
    ]) {
      expect(wordCompletionQuery(text, text.length), text).toBeNull();
    }
  });

  it("rejects words inside an inline code span", () => {
    expect(wordCompletionQuery("use `imp", 8)).toBeNull();
    expect(wordCompletionQuery("use `imp` now", 8)).toBeNull();
  });

  it("matches after a closed code span without linking across it", () => {
    expect(wordCompletionQuery("use `foo` imp", 13)).toEqual({ start: 10, end: 13, prefix: "imp", previous: null });
  });

  it("rejects words inside fenced code blocks", () => {
    expect(wordCompletionQuery("```ts\nconst imp", 15)).toBeNull();
    expect(wordCompletionQuery("~~~\nlet imp", 11)).toBeNull();
  });

  it("matches after a closed fence", () => {
    expect(wordCompletionQuery("```\ncode\n```\nthen imp", 21)).toEqual({
      start: 18,
      end: 21,
      prefix: "imp",
      previous: "then",
    });
  });

  it("rejects slash commands", () => {
    expect(wordCompletionQuery("/skill imp", 10)).toBeNull();
    expect(wordCompletionQuery("  /foo imp", 10)).toBeNull();
  });

  it("resets the previous word after sentence punctuation and newlines", () => {
    expect(wordCompletionQuery("Done. imp", 9)).toEqual({ start: 6, end: 9, prefix: "imp", previous: null });
    expect(wordCompletionQuery("Done\nimp", 8)).toEqual({ start: 5, end: 8, prefix: "imp", previous: null });
  });

  it("ignores very long texts", () => {
    const text = "a ".repeat(10_001) + "imp";
    expect(wordCompletionQuery(text, text.length)).toBeNull();
  });
});

describe("buildWordModelData", () => {
  const corpus = ["the quick fox", "the quick dog", "The lazy dog"];

  it("counts unigrams and bigrams, most frequent first", () => {
    expect(buildWordModelData(corpus)).toEqual({
      words: [
        ["the", 3],
        ["dog", 2],
        ["quick", 2],
        ["fox", 1],
        ["lazy", 1],
      ],
      bigrams: [
        ["the", [["quick", 2], ["lazy", 1]]],
        ["quick", [["dog", 1], ["fox", 1]]],
        ["lazy", [["dog", 1]]],
      ],
    });
  });

  it("is deterministic regardless of input order", () => {
    expect(buildWordModelData([...corpus].reverse())).toEqual(buildWordModelData(corpus));
  });

  it("applies the limits", () => {
    expect(buildWordModelData(corpus, { maxWords: 2, maxBigramHeads: 1, maxBigramTails: 1 })).toEqual({
      words: [
        ["the", 3],
        ["dog", 2],
      ],
      bigrams: [["the", [["quick", 2]]]],
    });
  });

  it("keeps short words as bigram heads but never as candidates", () => {
    expect(buildWordModelData(["go to the shop"])).toEqual({
      words: [
        ["shop", 1],
        ["the", 1],
      ],
      bigrams: [
        ["the", [["shop", 1]]],
        ["to", [["the", 1]]],
      ],
    });
  });

  it("does not link words across sentence punctuation or newlines", () => {
    expect(buildWordModelData(["one two. three\nfour"]).bigrams).toEqual([["one", [["two", 1]]]]);
  });

  it("skips paths, code spans and fenced blocks", () => {
    expect(buildWordModelData(["see src/app.ts and `codeword` here", "```\nhidden words\n```"])).toEqual({
      words: [
        ["and", 1],
        ["here", 1],
        ["see", 1],
      ],
      bigrams: [],
    });
  });

  it("drops one-off words and pairs once the corpus is large", () => {
    const letters = (i: number) => String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26));
    const rare = Array.from({ length: 205 }, (_, i) => `zz${letters(i)}`).join(". ");
    expect(buildWordModelData([rare, "common common"])).toEqual({ words: [["common", 2]], bigrams: [] });
  });
});

describe("suggestWord", () => {
  const model = wordModelFromData({
    words: [
      ["implement", 5],
      ["important", 2],
      ["image", 1],
    ],
    bigrams: [["very", [["important", 3]]]],
  });

  it("completes the most frequent word", () => {
    expect(suggestAtEnd(model, "Please imp")).toBe("lement");
    expect(suggestAtEnd(model, "Use ima")).toBe("ge");
  });

  it("prefers a bigram over a more frequent unigram", () => {
    expect(suggestAtEnd(model, "very imp")).toBe("ortant");
  });

  it("completes words typed earlier in the draft with an empty model", () => {
    expect(suggestAtEnd(wordModelFromData(null), "Refactor the parser, then test the par")).toBe("ser");
  });

  it("does not complete the word at the caret from itself", () => {
    expect(suggestAtEnd(wordModelFromData(null), "imp")).toBeNull();
  });

  it("lets repeated draft words outrank the corpus", () => {
    const text = "The importer reads files and the importer validates them. Fix imp";
    expect(suggestAtEnd(model, text)).toBe("orter");
  });

  it("follows the prefix casing", () => {
    expect(suggestAtEnd(model, "Imp")).toBe("lement");
    expect(suggestAtEnd(model, "IMP")).toBe("LEMENT");
  });

  it("returns null when only the exact word matches", () => {
    expect(suggestAtEnd(model, "image")).toBeNull();
  });

  it("returns null with an empty model and nothing in the draft", () => {
    expect(suggestAtEnd(wordModelFromData(null), "Please imp")).toBeNull();
  });

  it("breaks score ties by the shorter word", () => {
    const tied = wordModelFromData({
      words: [
        ["planet", 1],
        ["plan", 1],
      ],
      bigrams: [],
    });
    expect(suggestAtEnd(tied, "pla")).toBe("n");
  });
});
