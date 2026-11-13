import { describe, expect, it } from "vitest";
import { isSafeUrl, parseInline } from "@/lib/markdown/inline";

const text = (value: string) => ({ kind: "text", text: value });

describe("parseInline", () => {
  it("returns nothing for empty input and one text node for plain text", () => {
    expect(parseInline("")).toEqual([]);
    expect(parseInline("hello world")).toEqual([text("hello world")]);
  });

  it("keeps newlines inside text and normalises CRLF", () => {
    expect(parseInline("line one\nline two")).toEqual([text("line one\nline two")]);
    expect(parseInline("a\r\nb\rc")).toEqual([text("a\nb\nc")]);
  });

  it("parses code spans with matching backtick runs", () => {
    expect(parseInline("a `b` c")).toEqual([text("a "), { kind: "code", text: "b" }, text(" c")]);
    expect(parseInline("``a ` b``")).toEqual([{ kind: "code", text: "a ` b" }]);
    expect(parseInline("`` `x` ``")).toEqual([{ kind: "code", text: "`x`" }]);
    expect(parseInline("`  `")).toEqual([{ kind: "code", text: "  " }]);
    expect(parseInline("`**not bold** \\*`")).toEqual([{ kind: "code", text: "**not bold** \\*" }]);
    expect(parseInline("`a")).toEqual([text("`a")]);
    expect(parseInline("``a`")).toEqual([text("``a`")]);
  });

  it("resolves backslash escapes of ASCII punctuation only", () => {
    expect(parseInline("\\*not em\\* \\[x\\] \\` \\| \\\\ \\a")).toEqual([text("*not em* [x] ` | \\ \\a")]);
    expect(parseInline("\\_x\\_")).toEqual([text("_x_")]);
  });

  it("parses strong and em with both delimiter styles", () => {
    expect(parseInline("**bold** and __bold__")).toEqual([
      { kind: "strong", children: [text("bold")] },
      text(" and "),
      { kind: "strong", children: [text("bold")] },
    ]);
    expect(parseInline("*it* _it_")).toEqual([
      { kind: "em", children: [text("it")] },
      text(" "),
      { kind: "em", children: [text("it")] },
    ]);
    expect(parseInline("un*frigging*believable")).toEqual([
      text("un"),
      { kind: "em", children: [text("frigging")] },
      text("believable"),
    ]);
  });

  it("nests strong and em", () => {
    expect(parseInline("**bold *and italic***")).toEqual([
      { kind: "strong", children: [text("bold "), { kind: "em", children: [text("and italic")] }] },
    ]);
    expect(parseInline("***both***")).toEqual([
      { kind: "em", children: [{ kind: "strong", children: [text("both")] }] },
    ]);
  });

  it("parses strikethrough with double tildes only", () => {
    expect(parseInline("~~gone~~ now")).toEqual([{ kind: "strike", children: [text("gone")] }, text(" now")]);
    expect(parseInline("~one~")).toEqual([text("~one~")]);
  });

  it("leaves intraword underscores and spaced asterisks literal", () => {
    expect(parseInline("my_var_name and snake_case")).toEqual([text("my_var_name and snake_case")]);
    expect(parseInline("2 * 3 * 4")).toEqual([text("2 * 3 * 4")]);
  });

  it("leaves unmatched delimiters literal", () => {
    expect(parseInline("**bold")).toEqual([text("**bold")]);
    expect(parseInline("a ~~b")).toEqual([text("a ~~b")]);
  });

  it("does not let emphasis cross code spans or links", () => {
    expect(parseInline("*a `*` b")).toEqual([text("*a "), { kind: "code", text: "*" }, text(" b")]);
    expect(parseInline("*a `b*` c")).toEqual([text("*a "), { kind: "code", text: "b*" }, text(" c")]);
    expect(parseInline("**a [b** c](https://x.com)")).toEqual([
      text("**a "),
      { kind: "link", url: "https://x.com", children: [text("b** c")] },
    ]);
  });

  it("parses links with titles, angle brackets and balanced parens", () => {
    expect(parseInline('[docs](https://x.com/a "Title")')).toEqual([
      { kind: "link", url: "https://x.com/a", children: [text("docs")] },
    ]);
    expect(parseInline("[wiki](https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual([
      { kind: "link", url: "https://en.wikipedia.org/wiki/Foo_(bar)", children: [text("wiki")] },
    ]);
    expect(parseInline("[a](<https://x.com/a b>)")).toEqual([
      { kind: "link", url: "https://x.com/a b", children: [text("a")] },
    ]);
    expect(parseInline("see [**the** file](/api/v1/tasks/t1/files/a.png).")).toEqual([
      text("see "),
      {
        kind: "link",
        url: "/api/v1/tasks/t1/files/a.png",
        children: [{ kind: "strong", children: [text("the")] }, text(" file")],
      },
      text("."),
    ]);
  });

  it("turns URLs inside link text into plain text", () => {
    expect(parseInline("[https://a.com](https://b.com)")).toEqual([
      { kind: "link", url: "https://b.com", children: [text("https://a.com")] },
    ]);
  });

  it("keeps links with unsafe targets literal", () => {
    expect(parseInline("[click](javascript:alert(1))")).toEqual([text("[click](javascript:alert(1))")]);
    expect(parseInline("[x](data:text/html,hi)")).toEqual([text("[x](data:text/html,hi)")]);
    expect(parseInline("[rel](docs/readme.md)")).toEqual([text("[rel](docs/readme.md)")]);
  });

  it("parses images with plain-text alt", () => {
    expect(parseInline('![a *cat*](https://x.com/c.png "t")')).toEqual([
      { kind: "image", alt: "a cat", url: "https://x.com/c.png" },
    ]);
    expect(parseInline("![shot](/api/v1/boards/b1/files/s.png)")).toEqual([
      { kind: "image", alt: "shot", url: "/api/v1/boards/b1/files/s.png" },
    ]);
    expect(parseInline("![x](javascript:alert(1))")).toEqual([text("![x](javascript:alert(1))")]);
  });

  it("parses angle-bracket autolinks", () => {
    expect(parseInline("<https://x.com>")).toEqual([
      { kind: "link", url: "https://x.com", children: [text("https://x.com")] },
    ]);
    expect(parseInline("<mailto:a@b.co>")).toEqual([
      { kind: "link", url: "mailto:a@b.co", children: [text("mailto:a@b.co")] },
    ]);
    expect(parseInline("<javascript:alert(1)>")).toEqual([text("<javascript:alert(1)>")]);
  });

  it("autolinks bare URLs, trimming trailing punctuation", () => {
    expect(parseInline("See https://example.com/a.")).toEqual([
      text("See "),
      { kind: "url", url: "https://example.com/a" },
      text("."),
    ]);
    expect(parseInline("(https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual([
      text("("),
      { kind: "url", url: "https://en.wikipedia.org/wiki/Foo_(bar)" },
      text(")"),
    ]);
    expect(parseInline("**https://x.com/a_b**")).toEqual([
      { kind: "strong", children: [{ kind: "url", url: "https://x.com/a_b" }] },
    ]);
    expect(parseInline("https://")).toEqual([text("https://")]);
    expect(parseInline("xhttps://x.com")).toEqual([text("xhttps://x.com")]);
  });

  it("autolinks bare app file paths, trimming trailing punctuation", () => {
    expect(parseInline("/api/v1/tasks/abc/files/shot.png, done")).toEqual([
      { kind: "url", url: "/api/v1/tasks/abc/files/shot.png" },
      text(", done"),
    ]);
    expect(parseInline("open /api/v1/boards/b-1/files/dir/a.pdf.")).toEqual([
      text("open "),
      { kind: "url", url: "/api/v1/boards/b-1/files/dir/a.pdf" },
      text("."),
    ]);
    expect(parseInline("x/api/v1/tasks/abc/files/a.png")).toEqual([text("x/api/v1/tasks/abc/files/a.png")]);
    expect(parseInline("/api/v1/tasks/abc/files/")).toEqual([text("/api/v1/tasks/abc/files/")]);
  });

  it("returns on pathological input", () => {
    const stars = "*".repeat(50_000);
    expect(parseInline(stars)).toEqual([text(stars)]);
    const brackets = "[".repeat(50_000);
    expect(parseInline(brackets)).toEqual([text(brackets)]);
    const closers = "]".repeat(50_000);
    expect(parseInline(closers)).toEqual([text(closers)]);
    for (const input of [
      "[](".repeat(20_000),
      "[a](x".repeat(10_000),
      "*a ".repeat(20_000),
      "a* ".repeat(20_000),
      "*a _b ".repeat(10_000),
      "` ``".repeat(15_000),
      "<https:".repeat(10_000),
      "\\".repeat(50_000),
    ]) {
      expect(Array.isArray(parseInline(input))).toBe(true);
    }
  });
});

describe("isSafeUrl", () => {
  it.each([
    ["https://x.com", "link", true],
    ["http://x.com", "image", true],
    ["HTTPS://x.com", "link", true],
    ["/api/v1/tasks/a/files/b.png", "image", true],
    ["mailto:a@b.co", "link", true],
    ["MAILTO:a@b.co", "link", true],
    ["mailto:a@b.co", "image", false],
    ["javascript:alert(1)", "link", false],
    ["JavaScript:alert(1)", "link", false],
    ["data:image/png;base64,AAAA", "image", false],
    ["//evil.com", "link", false],
    ["relative/path.png", "image", false],
    ["/api/v2/x", "link", false],
    [" https://x.com", "link", false],
    ["\u0001https://x.com", "link", false],
    ["", "link", false],
  ] as const)("%j as %s → %s", (url, kind, expected) => {
    expect(isSafeUrl(url, kind)).toBe(expected);
  });
});
