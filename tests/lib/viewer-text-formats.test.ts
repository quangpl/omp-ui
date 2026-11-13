import { describe, expect, it } from "vitest";

import { parseDelimited } from "@/lib/viewer/csv";
import { parseNotebook } from "@/lib/viewer/notebook";

describe("parseDelimited", () => {
  it("splits plain rows and fields", () => {
    expect(parseDelimited("a,b,c\n1,2,3")).toEqual({
      rows: [
        ["a", "b", "c"],
        ["1", "2", "3"],
      ],
      truncated: false,
    });
  });

  it("keeps empty fields", () => {
    expect(parseDelimited(",a,,\n").rows).toEqual([["", "a", "", ""]]);
  });

  it("handles quoted fields with delimiters and escaped quotes", () => {
    expect(parseDelimited('"a,b","say ""hi""",""\n').rows).toEqual([["a,b", 'say "hi"', ""]]);
  });

  it("keeps newlines inside quoted fields", () => {
    expect(parseDelimited('id,note\n1,"line one\nline two"\n2,"x\r\ny"').rows).toEqual([
      ["id", "note"],
      ["1", "line one\nline two"],
      ["2", "x\r\ny"],
    ]);
  });

  it("accepts CRLF, LF and CR line ends", () => {
    expect(parseDelimited("a,b\r\nc,d\re,f\ng,h\r\n").rows).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
      ["g", "h"],
    ]);
  });

  it("strips a UTF-8 BOM", () => {
    expect(parseDelimited("\uFEFFname,age\nAda,36").rows[0]).toEqual(["name", "age"]);
  });

  it("drops only one trailing empty line", () => {
    expect(parseDelimited("a\n").rows).toEqual([["a"]]);
    expect(parseDelimited("a\n\n").rows).toEqual([["a"], [""]]);
    expect(parseDelimited("").rows).toEqual([]);
  });

  it("parses TSV with a tab delimiter", () => {
    expect(parseDelimited("a\tb,c\n1\t2", { delimiter: "\t" }).rows).toEqual([
      ["a", "b,c"],
      ["1", "2"],
    ]);
  });

  it("truncates after maxRows", () => {
    expect(parseDelimited("1\n2\n3\n4", { maxRows: 2 })).toEqual({ rows: [["1"], ["2"]], truncated: true });
    expect(parseDelimited("1\n2\n", { maxRows: 2 })).toEqual({ rows: [["1"], ["2"]], truncated: false });
  });

  it("defaults to at most 5000 rows", () => {
    const result = parseDelimited(Array.from({ length: 5001 }, (_, i) => String(i)).join("\n"));
    expect(result.rows).toHaveLength(5000);
    expect(result.truncated).toBe(true);
  });
});

const ESC = String.fromCharCode(27);

function notebook(cells: unknown[], metadata: unknown = {}): string {
  return JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata, cells });
}

describe("parseNotebook", () => {
  it("joins string and string[] sources", () => {
    const { cells } = parseNotebook(
      notebook([
        { cell_type: "markdown", metadata: {}, source: ["# Title\n", "Body"] },
        { cell_type: "code", metadata: {}, source: "print(1)", execution_count: 3, outputs: [] },
        { cell_type: "raw", metadata: {}, source: ["raw ", "text"] },
      ]),
    );
    expect(cells).toEqual([
      { type: "markdown", source: "# Title\nBody", executionCount: null, outputs: [] },
      { type: "code", source: "print(1)", executionCount: 3, outputs: [] },
      { type: "raw", source: "raw text", executionCount: null, outputs: [] },
    ]);
  });

  it("reads stream, execute_result, display_data and error outputs", () => {
    const { cells } = parseNotebook(
      notebook([
        {
          cell_type: "code",
          source: "x",
          execution_count: null,
          outputs: [
            { output_type: "stream", name: "stdout", text: ["hello\n", "world\n"] },
            { output_type: "execute_result", execution_count: 1, data: { "text/plain": ["42"] }, metadata: {} },
            {
              output_type: "display_data",
              data: { "image/png": "iVBORw0KGgo=\nAAAA\n", "text/plain": "<Figure>" },
              metadata: {},
            },
            { output_type: "display_data", data: { "image/jpeg": ["/9j/4AAQ\n", "SkZJRg==\n"] }, metadata: {} },
            { output_type: "display_data", data: { "text/markdown": "**bold**", "text/plain": "bold" }, metadata: {} },
            {
              output_type: "error",
              ename: "ValueError",
              evalue: "bad",
              traceback: [`${ESC}[0;31mValueError${ESC}[0m Traceback`, `${ESC}[1;32m----> 1${ESC}[0m raise`],
            },
          ],
        },
      ]),
    );
    expect(cells[0].executionCount).toBeNull();
    expect(cells[0].outputs).toEqual([
      { kind: "text", text: "hello\nworld\n" },
      { kind: "text", text: "42" },
      { kind: "image", mime: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=AAAA" },
      { kind: "image", mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" },
      { kind: "markdown", text: "**bold**" },
      { kind: "text", text: "ValueError: bad\nValueError Traceback\n----> 1 raise", error: true },
    ]);
  });

  it("shows the error summary once when the traceback already ends with it", () => {
    const { cells } = parseNotebook(
      notebook([
        {
          cell_type: "code",
          source: "1/0",
          execution_count: 1,
          outputs: [
            {
              output_type: "error",
              ename: "ZeroDivisionError",
              evalue: "division by zero",
              traceback: [
                `${ESC}[0;31m---------------------------------------------------------------------------${ESC}[0m`,
                `${ESC}[0;31mZeroDivisionError${ESC}[0m                         Traceback (most recent call last)\nCell In[1], line 1\n----> 1 1/0`,
                `${ESC}[0;31mZeroDivisionError${ESC}[0m: division by zero`,
              ],
            },
            { output_type: "error", ename: "KeyError", evalue: "'x'", traceback: [] },
          ],
        },
      ]),
    );
    const [withTraceback, withoutTraceback] = cells[0].outputs;
    expect(withTraceback).toEqual({
      kind: "text",
      text: [
        "---------------------------------------------------------------------------",
        "ZeroDivisionError                         Traceback (most recent call last)",
        "Cell In[1], line 1",
        "----> 1 1/0",
        "ZeroDivisionError: division by zero",
      ].join("\n"),
      error: true,
    });
    expect(withoutTraceback).toEqual({ kind: "text", text: "KeyError: 'x'", error: true });
  });

  it("strips ANSI escapes from streams", () => {
    const { cells } = parseNotebook(
      notebook([
        {
          cell_type: "code",
          source: "",
          execution_count: 1,
          outputs: [{ output_type: "stream", name: "stderr", text: `${ESC}[33mwarning${ESC}[0m: careful` }],
        },
      ]),
    );
    expect(cells[0].outputs).toEqual([{ kind: "text", text: "warning: careful" }]);
  });

  it("never emits svg, html or javascript outputs", () => {
    const { cells } = parseNotebook(
      notebook([
        {
          cell_type: "code",
          source: "",
          execution_count: 1,
          outputs: [
            { output_type: "display_data", data: { "image/svg+xml": "<svg onload='x()'/>" }, metadata: {} },
            { output_type: "display_data", data: { "text/html": "<script>x()</script>" }, metadata: {} },
            { output_type: "display_data", data: { "application/javascript": "x()" }, metadata: {} },
            {
              output_type: "execute_result",
              data: { "text/html": "<b>x</b>", "image/svg+xml": "<svg/>", "text/plain": "x" },
              metadata: {},
            },
          ],
        },
      ]),
    );
    expect(cells[0].outputs).toEqual([{ kind: "text", text: "x" }]);
  });

  it("detects the language from language_info, then kernelspec", () => {
    expect(parseNotebook(notebook([], { language_info: { name: "python" }, kernelspec: { language: "r" } })).language).toBe(
      "python",
    );
    expect(parseNotebook(notebook([], { kernelspec: { name: "ir", language: "R" } })).language).toBe("R");
    expect(parseNotebook(notebook([])).language).toBeNull();
  });

  it("throws on invalid JSON or a missing cells array", () => {
    expect(() => parseNotebook("{not json")).toThrow(/^Invalid notebook/);
    expect(() => parseNotebook(JSON.stringify({ nbformat: 3, worksheets: [] }))).toThrow(/^Invalid notebook/);
    expect(() => parseNotebook("null")).toThrow(/^Invalid notebook/);
  });
});
