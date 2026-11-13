import { describe, expect, it } from "vitest";

import { inlineSources, parseBlocks } from "@/lib/markdown/blocks";

const p = (text: string) => ({ kind: "paragraph", text });
const item = (text: string, checked: boolean | null = null) => ({ checked, blocks: [p(text)] });

describe("parseBlocks", () => {
  it("returns no blocks for empty or blank input", () => {
    expect(parseBlocks("")).toEqual([]);
    expect(parseBlocks("  \n\n\t\n")).toEqual([]);
  });

  it("parses ATX headings level 1 to 6", () => {
    expect(parseBlocks("# h1\n## h2\n### h3\n#### h4\n##### h5\n###### h6\n####### not")).toEqual([
      { kind: "heading", level: 1, text: "h1" },
      { kind: "heading", level: 2, text: "h2" },
      { kind: "heading", level: 3, text: "h3" },
      { kind: "heading", level: 4, text: "h4" },
      { kind: "heading", level: 5, text: "h5" },
      { kind: "heading", level: 6, text: "h6" },
      p("####### not"),
    ]);
  });

  it("strips closing hashes and requires a space after the marker", () => {
    expect(parseBlocks("# Title ##\n#hashtag")).toEqual([{ kind: "heading", level: 1, text: "Title" }, p("#hashtag")]);
  });

  it("keeps internal newlines in a paragraph and splits on blank lines", () => {
    expect(parseBlocks("first line  \n   second line\n\nnext")).toEqual([p("first line\nsecond line"), p("next")]);
  });

  it("parses backtick and tilde fences verbatim", () => {
    const src = "```ts title\nconst a = 1;\n\n  indented\n```\n~~~\nplain ``` inside\n~~~\n````\n```\nx\n````";
    expect(parseBlocks(src)).toEqual([
      { kind: "code", lang: "ts", text: "const a = 1;\n\n  indented" },
      { kind: "code", lang: "", text: "plain ``` inside" },
      { kind: "code", lang: "", text: "```\nx" },
    ]);
  });

  it("runs an unclosed fence to the end of the input", () => {
    expect(parseBlocks("text\n```py\nprint(1)\n\n# not heading")).toEqual([
      p("text"),
      { kind: "code", lang: "py", text: "print(1)\n\n# not heading" },
    ]);
  });

  it("distinguishes thematic breaks from setext headings", () => {
    expect(parseBlocks("intro\n---\n\n***\n\n- - -\n\n___\n\nTitle\n===")).toEqual([
      { kind: "heading", level: 2, text: "intro" },
      { kind: "rule" },
      { kind: "rule" },
      { kind: "rule" },
      { kind: "heading", level: 1, text: "Title" },
    ]);
  });

  it("parses a multi-line blockquote with lazy continuation and a nested list", () => {
    const src = "> quoted line\n> second\nlazy line\n>\n> - item a\n> - item b\n\nafter";
    expect(parseBlocks(src)).toEqual([
      {
        kind: "quote",
        blocks: [
          p("quoted line\nsecond\nlazy line"),
          { kind: "list", ordered: false, start: 1, tight: true, items: [item("item a"), item("item b")] },
        ],
      },
      p("after"),
    ]);
  });

  it("continues a list item paragraph lazily inside a quote", () => {
    expect(parseBlocks("> - a\ncontinued")).toEqual([
      {
        kind: "quote",
        blocks: [{ kind: "list", ordered: false, start: 1, tight: true, items: [item("a\ncontinued")] }],
      },
    ]);
  });

  it("marks lists tight or loose", () => {
    expect(parseBlocks("- a\n- b\n")).toEqual([
      { kind: "list", ordered: false, start: 1, tight: true, items: [item("a"), item("b")] },
    ]);
    expect(parseBlocks("* a\n\n* b")).toEqual([
      { kind: "list", ordered: false, start: 1, tight: false, items: [item("a"), item("b")] },
    ]);
    expect(parseBlocks("- a\n\n  para\n- b")).toEqual([
      {
        kind: "list",
        ordered: false,
        start: 1,
        tight: false,
        items: [{ checked: null, blocks: [p("a"), p("para")] }, item("b")],
      },
    ]);
  });

  it("ends a list at a blank line followed by unindented text", () => {
    expect(parseBlocks("- a\n\nafter")).toEqual([
      { kind: "list", ordered: false, start: 1, tight: true, items: [item("a")] },
      p("after"),
    ]);
  });

  it("lets a bullet interrupt a paragraph but not a mid-paragraph number", () => {
    expect(parseBlocks("Steps:\n- one\n- two")).toEqual([
      p("Steps:"),
      { kind: "list", ordered: false, start: 1, tight: true, items: [item("one"), item("two")] },
    ]);
    expect(parseBlocks("The year\n1986. was good")).toEqual([p("The year\n1986. was good")]);
  });

  it("parses an ordered list with its start number and splits on a delimiter change", () => {
    expect(parseBlocks("3. three\n4. four\n5) other\n- bullet")).toEqual([
      { kind: "list", ordered: true, start: 3, tight: true, items: [item("three"), item("four")] },
      { kind: "list", ordered: true, start: 5, tight: true, items: [item("other")] },
      { kind: "list", ordered: false, start: 1, tight: true, items: [item("bullet")] },
    ]);
  });

  it("parses an empty item", () => {
    expect(parseBlocks("-\n- b")).toEqual([
      { kind: "list", ordered: false, start: 1, tight: true, items: [{ checked: null, blocks: [] }, item("b")] },
    ]);
  });

  it("nests lists with 2-space indentation", () => {
    expect(parseBlocks("- a\n  - b\n    - c\n- d")).toEqual([
      {
        kind: "list",
        ordered: false,
        start: 1,
        tight: true,
        items: [
          {
            checked: null,
            blocks: [
              p("a"),
              {
                kind: "list",
                ordered: false,
                start: 1,
                tight: true,
                items: [
                  {
                    checked: null,
                    blocks: [p("b"), { kind: "list", ordered: false, start: 1, tight: true, items: [item("c")] }],
                  },
                ],
              },
            ],
          },
          item("d"),
        ],
      },
    ]);
  });

  it("nests lists with 4-space indentation", () => {
    expect(parseBlocks("1. one\n    - sub\n    - sub2\n2. two")).toEqual([
      {
        kind: "list",
        ordered: true,
        start: 1,
        tight: true,
        items: [
          {
            checked: null,
            blocks: [
              p("one"),
              { kind: "list", ordered: false, start: 1, tight: true, items: [item("sub"), item("sub2")] },
            ],
          },
          item("two"),
        ],
      },
    ]);
    expect(parseBlocks("- a\n    - b")).toEqual([
      {
        kind: "list",
        ordered: false,
        start: 1,
        tight: true,
        items: [
          {
            checked: null,
            blocks: [p("a"), { kind: "list", ordered: false, start: 1, tight: true, items: [item("b")] }],
          },
        ],
      },
    ]);
  });

  it("parses task list items", () => {
    expect(parseBlocks("- [ ] todo\n- [x] done\n- [X] Done too\n- [x]no space\n- plain")).toEqual([
      {
        kind: "list",
        ordered: false,
        start: 1,
        tight: true,
        items: [item("todo", false), item("done", true), item("Done too", true), item("[x]no space"), item("plain")],
      },
    ]);
  });

  it("parses a fence inside a list item", () => {
    expect(parseBlocks("- step:\n  ```sh\n  npm test\n\n  echo ok\n  ```\n- next")).toEqual([
      {
        kind: "list",
        ordered: false,
        start: 1,
        tight: true,
        items: [
          { checked: null, blocks: [p("step:"), { kind: "code", lang: "sh", text: "npm test\n\necho ok" }] },
          item("next"),
        ],
      },
    ]);
  });

  it("runs an unclosed fence to the end of its list item", () => {
    expect(parseBlocks("- ```\n  code\nafter")).toEqual([
      {
        kind: "list",
        ordered: false,
        start: 1,
        tight: true,
        items: [{ checked: null, blocks: [{ kind: "code", lang: "", text: "code" }] }],
      },
      p("after"),
    ]);
  });

  it("parses a GFM table with alignment, escaped pipes, code spans and ragged rows", () => {
    const src = [
      "| Name | Left | Center | Right |",
      "| ---- | :--- | :----: | ----: |",
      "| a \\| b | `x | y` | `p\\|q` |",
      "| short |",
      "| 1 | 2 | 3 | 4 | 5 |",
      "after",
    ].join("\n");
    expect(parseBlocks(src)).toEqual([
      {
        kind: "table",
        align: [null, "left", "center", "right"],
        header: ["Name", "Left", "Center", "Right"],
        rows: [
          ["a | b", "`x | y`", "`p|q`", ""],
          ["short", "", "", ""],
          ["1", "2", "3", "4"],
        ],
      },
      p("after"),
    ]);
  });

  it("parses a table without edge pipes after a paragraph", () => {
    expect(parseBlocks("intro\na | b\n--- | ---\n1 | 2")).toEqual([
      p("intro"),
      { kind: "table", align: [null, null], header: ["a", "b"], rows: [["1", "2"]] },
    ]);
  });

  it("keeps pipe text without a matching delimiter row as a paragraph", () => {
    expect(parseBlocks("a | b\nc | d")).toEqual([p("a | b\nc | d")]);
    expect(parseBlocks("| a | b |\n| --- |")).toEqual([p("| a | b |\n| --- |")]);
  });

  it("normalises CRLF line endings", () => {
    expect(parseBlocks("# T\r\n\r\nline1\r\nline2\r\n```\r\ncode\r\n```\r\n")).toEqual([
      { kind: "heading", level: 1, text: "T" },
      p("line1\nline2"),
      { kind: "code", lang: "", text: "code" },
    ]);
  });
});

describe("inlineSources", () => {
  it("lists inline sources depth-first in document order, skipping code", () => {
    const src = "# H\n\npara\n\n> quoted\n\n- item\n  - nested\n\n```\ncode\n```\n\n| a | b |\n|---|---|\n| c | d |";
    expect(inlineSources(parseBlocks(src))).toEqual(["H", "para", "quoted", "item", "nested", "a", "b", "c", "d"]);
  });
});
