/**
 * Block-level parser for the GitHub-flavoured markdown subset rendered in agent replies.
 * Pure (no React): turns source text into a small AST of blocks whose inline content stays raw
 * (see `lib/markdown/inline.ts`). Line based, never throws, tolerant of streaming partial input.
 */

export type MdAlign = "left" | "center" | "right" | null;

export interface MdListItem {
  /** GFM task list state: `- [ ]` → false, `- [x]`/`[X]` → true, plain item → null. */
  checked: boolean | null;
  /** Item content parsed recursively (paragraphs, nested lists, code, quotes...). */
  blocks: MdBlock[];
}

export type MdBlock =
  | { kind: "code"; lang: string; text: string }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; start: number; tight: boolean; items: MdListItem[] }
  | { kind: "quote"; blocks: MdBlock[] }
  | { kind: "rule" }
  | { kind: "table"; align: MdAlign[]; header: string[]; rows: string[][] };

/** Container nesting (quotes/lists) beyond this depth is treated as plain paragraph text. */
const MAX_DEPTH = 32;

interface Step {
  block: MdBlock;
  next: number;
}

interface Parsed {
  blocks: MdBlock[];
  /** A blank line separates two of the top-level blocks (makes an enclosing list item loose). */
  loose: boolean;
}

interface Fence {
  ch: string;
  len: number;
  indent: number;
  info: string;
}

interface ListMarker {
  ordered: boolean;
  /** Bullet character, or the ordered delimiter (`.` / `)`). */
  type: string;
  start: number;
  /** Column of the marker. */
  indent: number;
  /** Column where the item content starts. */
  offset: number;
  content: string;
}

/** Parse markdown source into blocks. `\r\n` line endings are normalised. */
export function parseBlocks(source: string): MdBlock[] {
  if (!source) return [];
  return parseLines(source.replace(/\r\n?/g, "\n").split("\n"), 0).blocks;
}

/** Every inline source string (paragraph, heading, table header/cells), depth-first in document order, skipping code blocks. */
export function inlineSources(blocks: MdBlock[]): string[] {
  const out: string[] = [];
  const walk = (list: MdBlock[]): void => {
    for (const block of list) {
      switch (block.kind) {
        case "paragraph":
        case "heading":
          out.push(block.text);
          break;
        case "table":
          for (const cell of block.header) out.push(cell);
          for (const row of block.rows) for (const cell of row) out.push(cell);
          break;
        case "quote":
          walk(block.blocks);
          break;
        case "list":
          for (const item of block.items) walk(item.blocks);
          break;
        default:
          break;
      }
    }
  };
  walk(blocks);
  return out;
}

function parseLines(lines: string[], depth: number): Parsed {
  const blocks: MdBlock[] = [];
  let loose = false;
  let gap = false;
  let i = 0;
  while (i < lines.length) {
    if (isBlank(lines[i])) {
      gap = true;
      i++;
      continue;
    }
    const step = parseBlock(lines, i, depth);
    if (gap && blocks.length > 0) loose = true;
    gap = false;
    blocks.push(step.block);
    i = step.next;
  }
  return { blocks, loose };
}

function parseBlock(lines: string[], i: number, depth: number): Step {
  const line = lines[i];
  const fence = fenceOpen(line);
  if (fence) return parseFence(lines, i, fence);
  const heading = atxHeading(line);
  if (heading) return { block: { kind: "heading", level: heading.level, text: heading.text }, next: i + 1 };
  if (isRule(line)) return { block: { kind: "rule" }, next: i + 1 };
  if (depth < MAX_DEPTH) {
    if (quoteContent(line) !== null) return parseQuote(lines, i, depth);
    const marker = listMarker(line);
    if (marker) return parseList(lines, i, marker, depth);
  }
  const align = tableAt(lines, i);
  if (align) return parseTable(lines, i, align);
  return parseParagraph(lines, i);
}

function parseFence(lines: string[], i: number, fence: Fence): Step {
  const body: string[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j];
    j++;
    if (isFenceClose(line, fence)) break;
    body.push(stripIndent(line, fence.indent));
  }
  const lang = fence.info.split(/\s+/)[0] ?? "";
  return { block: { kind: "code", lang, text: body.join("\n") }, next: j };
}

function parseParagraph(lines: string[], i: number): Step {
  const parts = [lines[i].trim()];
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j];
    if (isBlank(line)) break;
    const setext = setextLevel(line);
    if (setext !== 0) return { block: { kind: "heading", level: setext, text: parts.join("\n") }, next: j + 1 };
    if (interruptsParagraph(line) || tableAt(lines, j)) break;
    parts.push(line.trim());
    j++;
  }
  return { block: { kind: "paragraph", text: parts.join("\n") }, next: j };
}

function parseQuote(lines: string[], i: number, depth: number): Step {
  const inner: string[] = [];
  const lazy = new LazyTracker();
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    const content = quoteContent(line);
    if (content === null && (isBlank(line) || !lazy.ok() || interruptsParagraph(line) || setextLevel(line) !== 0)) break;
    const text = content ?? line;
    inner.push(text);
    lazy.feed(text);
    j++;
  }
  return { block: { kind: "quote", blocks: parseLines(inner, depth + 1).blocks }, next: j };
}

function parseList(lines: string[], i: number, first: ListMarker, depth: number): Step {
  const items: MdListItem[] = [];
  let tight = true;
  let marker = first;
  let j = i;
  for (;;) {
    const item = parseItem(lines, j, marker, depth);
    items.push(item.item);
    if (item.loose) tight = false;
    j = item.next;
    let k = j;
    while (k < lines.length && isBlank(lines[k])) k++;
    if (k >= lines.length || isRule(lines[k])) break;
    const next = listMarker(lines[k]);
    if (!next || next.ordered !== first.ordered || next.type !== first.type) break;
    if (k > j) tight = false;
    marker = next;
    j = k;
  }
  return { block: { kind: "list", ordered: first.ordered, start: first.start, tight, items }, next: j };
}

function parseItem(
  lines: string[],
  i: number,
  marker: ListMarker,
  depth: number,
): { item: MdListItem; next: number; loose: boolean } {
  let content = marker.content;
  let checked: boolean | null = null;
  const task = /^\[([ xX])\][ \t]+/.exec(content);
  if (task) {
    checked = task[1] !== " ";
    content = content.slice(task[0].length);
  }
  let j = i + 1;
  // An item starting with an empty marker line followed by a blank line is empty.
  if (marker.content === "" && j < lines.length && isBlank(lines[j])) {
    return { item: { checked, blocks: [] }, next: j, loose: false };
  }
  const inner = [content];
  const lazy = new LazyTracker();
  lazy.feed(content);
  let blanks = 0;
  while (j < lines.length) {
    const line = lines[j];
    if (isBlank(line)) {
      blanks++;
      j++;
      continue;
    }
    const indent = indentOf(line);
    if (indent >= marker.offset || (indent >= 2 && indent > marker.indent)) {
      for (; blanks > 0; blanks--) inner.push("");
      const text = stripIndent(line, Math.min(indent, marker.offset));
      inner.push(text);
      lazy.feed(text);
      j++;
      continue;
    }
    if (
      blanks > 0 ||
      !lazy.ok() ||
      interruptsParagraph(line) ||
      listMarker(line) !== null ||
      setextLevel(line) !== 0
    ) {
      break;
    }
    inner.push(line);
    lazy.feed(line);
    j++;
  }
  const parsed = parseLines(inner, depth + 1);
  return { item: { checked, blocks: parsed.blocks }, next: j - blanks, loose: parsed.loose };
}

function parseTable(lines: string[], i: number, align: MdAlign[]): Step {
  const header = splitRow(lines[i]);
  const rows: string[][] = [];
  let j = i + 2;
  while (j < lines.length) {
    const line = lines[j];
    if (isBlank(line) || !hasPipe(line) || interruptsParagraph(line)) break;
    const cells = splitRow(line);
    rows.push(header.map((_, c) => cells[c] ?? ""));
    j++;
  }
  return { block: { kind: "table", align, header, rows }, next: j };
}

/** Tracks fence state across a container's lines to decide whether a lazy continuation line may follow. */
class LazyTracker {
  private fence: Fence | null = null;
  private paragraph = false;

  feed(line: string): void {
    if (this.fence) {
      if (isFenceClose(line, this.fence)) this.fence = null;
      this.paragraph = false;
      return;
    }
    const fence = fenceOpen(line);
    if (fence) {
      this.fence = fence;
      this.paragraph = false;
      return;
    }
    const marker = listMarker(line);
    this.paragraph =
      !isBlank(line) &&
      !atxHeading(line) &&
      !isRule(line) &&
      setextLevel(line) === 0 &&
      !(marker && marker.content === "");
  }

  ok(): boolean {
    return this.fence === null && this.paragraph;
  }
}

function isBlank(line: string): boolean {
  return /^[ \t]*$/.test(line);
}

/** Column width of the leading whitespace (tabs advance to the next multiple of 4). */
function indentOf(line: string): number {
  let col = 0;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c === " ") col++;
    else if (c === "\t") col += 4 - (col % 4);
    else break;
  }
  return col;
}

/** Remove up to `n` columns of leading whitespace; a tab straddling the limit leaves its remainder as spaces. */
function stripIndent(line: string, n: number): string {
  let col = 0;
  let k = 0;
  while (k < line.length && col < n) {
    const c = line[k];
    if (c === " ") {
      col++;
      k++;
    } else if (c === "\t") {
      const next = col + 4 - (col % 4);
      if (next > n) return " ".repeat(next - n) + line.slice(k + 1);
      col = next;
      k++;
    } else {
      break;
    }
  }
  return line.slice(k);
}

function afterIndent(line: string): string {
  return line.replace(/^[ \t]*/, "");
}

function fenceOpen(line: string): Fence | null {
  const indent = indentOf(line);
  if (indent > 3) return null;
  const rest = afterIndent(line);
  const ch = rest[0];
  if (ch !== "`" && ch !== "~") return null;
  let len = 0;
  while (rest[len] === ch) len++;
  if (len < 3) return null;
  const info = rest.slice(len);
  if (ch === "`" && info.includes("`")) return null;
  return { ch, len, indent, info: info.trim() };
}

function isFenceClose(line: string, fence: Fence): boolean {
  if (indentOf(line) > 3) return false;
  const rest = afterIndent(line);
  let len = 0;
  while (rest[len] === fence.ch) len++;
  return len >= fence.len && isBlank(rest.slice(len));
}

function atxHeading(line: string): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | null {
  if (indentOf(line) > 3) return null;
  const rest = afterIndent(line);
  let level = 0;
  while (rest[level] === "#") level++;
  if (level < 1 || level > 6) return null;
  const after = rest.slice(level);
  if (after !== "" && after[0] !== " " && after[0] !== "\t") return null;
  let text = after.trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end--;
  if (end < text.length && (end === 0 || text[end - 1] === " " || text[end - 1] === "\t")) {
    text = text.slice(0, end).trimEnd();
  }
  return { level: level as 1 | 2 | 3 | 4 | 5 | 6, text };
}

function isRule(line: string): boolean {
  if (indentOf(line) > 3) return false;
  const rest = afterIndent(line);
  const ch = rest[0];
  if (ch !== "-" && ch !== "*" && ch !== "_") return false;
  let count = 0;
  for (let k = 0; k < rest.length; k++) {
    const c = rest[k];
    if (c === ch) count++;
    else if (c !== " " && c !== "\t") return false;
  }
  return count >= 3;
}

/** Setext underline level: `===` → 1, `---` → 2, otherwise 0. */
function setextLevel(line: string): 0 | 1 | 2 {
  if (indentOf(line) > 3) return 0;
  const rest = afterIndent(line).trimEnd();
  const ch = rest[0];
  if (ch !== "=" && ch !== "-") return 0;
  for (let k = 1; k < rest.length; k++) if (rest[k] !== ch) return 0;
  return ch === "=" ? 1 : 2;
}

/** Content of a `>` blockquote line (one optional space after `>` removed), or null. */
function quoteContent(line: string): string | null {
  if (indentOf(line) > 3) return null;
  const rest = afterIndent(line);
  if (rest[0] !== ">") return null;
  const after = rest.slice(1);
  return after[0] === " " || after[0] === "\t" ? stripIndent(after, 1) : after;
}

function listMarker(line: string): ListMarker | null {
  const indent = indentOf(line);
  if (indent > 3) return null;
  const rest = afterIndent(line);
  const c = rest[0];
  let width: number;
  let ordered: boolean;
  let type: string;
  let start = 1;
  if (c === "-" || c === "+" || c === "*") {
    width = 1;
    ordered = false;
    type = c;
  } else {
    let digits = 0;
    while (digits < 9 && digits < rest.length) {
      const code = rest.charCodeAt(digits);
      if (code < 48 || code > 57) break;
      digits++;
    }
    const delim = rest[digits];
    if (digits === 0 || (delim !== "." && delim !== ")")) return null;
    width = digits + 1;
    ordered = true;
    type = delim;
    start = parseInt(rest.slice(0, digits), 10);
  }
  const after = rest.slice(width);
  if (after !== "" && after[0] !== " " && after[0] !== "\t") return null;
  const content = afterIndent(after);
  if (content.trim() === "") return { ordered, type, start, indent, offset: indent + width + 1, content: "" };
  const spaces = indentOf(after);
  const offset = indent + width + (spaces > 4 ? 1 : spaces);
  return { ordered, type, start, indent, offset, content };
}

/** Whether `line` starts a block that ends an open paragraph (bullets always; ordered lists only from 1). */
function interruptsParagraph(line: string): boolean {
  if (indentOf(line) > 3) return false;
  if (fenceOpen(line) || atxHeading(line) || isRule(line) || quoteContent(line) !== null) return true;
  const marker = listMarker(line);
  return marker !== null && marker.content !== "" && (!marker.ordered || marker.start === 1);
}

/** Alignments when `lines[i]` is a table header followed by a matching delimiter row, else null. */
function tableAt(lines: string[], i: number): MdAlign[] | null {
  const head = lines[i];
  const delimiter = lines[i + 1];
  if (delimiter === undefined || indentOf(head) > 3 || !hasPipe(head)) return null;
  const align = delimiterAligns(delimiter);
  if (!align || align.length !== splitRow(head).length) return null;
  return align;
}

function delimiterAligns(line: string): MdAlign[] | null {
  if (indentOf(line) > 3 || !line.includes("|")) return null;
  const align: MdAlign[] = [];
  for (const cell of splitRow(line)) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    align.push(left && right ? "center" : left ? "left" : right ? "right" : null);
  }
  return align;
}

/** Whether the line has a `|` that is not backslash-escaped. */
function hasPipe(line: string): boolean {
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c === "\\") k++;
    else if (c === "|") return true;
  }
  return false;
}

/** Split a table row on unescaped pipes outside code spans; cells trimmed, `\|` unescaped. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  const noCloser = new Set<number>();
  let cell = "";
  let k = 0;
  while (k < s.length) {
    const c = s[k];
    if (c === "\\") {
      if (s[k + 1] === "|") cell += "|";
      else cell += s.slice(k, k + 2);
      k += 2;
    } else if (c === "`") {
      let run = 1;
      while (s[k + run] === "`") run++;
      const close = noCloser.has(run) ? -1 : findBacktickRun(s, k + run, run);
      if (close < 0) {
        noCloser.add(run);
        cell += s.slice(k, k + run);
        k += run;
      } else {
        cell += s.slice(k, close + run).replace(/\\\|/g, "|");
        k = close + run;
      }
    } else if (c === "|") {
      cells.push(cell.trim());
      cell = "";
      k++;
    } else {
      cell += c;
      k++;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** Index of the next backtick run of exactly `run` characters at or after `from`, or -1. */
function findBacktickRun(s: string, from: number, run: number): number {
  let k = from;
  while (k < s.length) {
    if (s[k] !== "`") {
      k++;
      continue;
    }
    let len = 1;
    while (s[k + len] === "`") len++;
    if (len === run) return k;
    k += len;
  }
  return -1;
}
