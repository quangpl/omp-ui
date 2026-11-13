// Office Open XML (.docx, .xlsx, .pptx) and EPUB readers for the in-app file viewer. Each takes an
// opened zip (lib/viewer/zip.ts) and extracts a preview-friendly model: documents, slides and
// e-book chapters become `DocBlock`s (lib/viewer/document.ts), workbooks become grids of formatted
// cell text. Pure and isomorphic: XML goes through the forgiving parser in lib/viewer/xml.ts, never
// the DOM. Unsupported features (styles beyond basic emphasis, charts, image data, formulas) are
// dropped; the goal is readable content, not fidelity.

import type { DocBlock, Run } from "./document";
import { attr, childElements, findAll, findFirst, localName, parseXml, textContent, type XmlElement } from "./xml";
import type { ZipArchive } from "./zip";

// ─── Shared helpers ──────────────────────────────────────────────────────────

type Format = Omit<Run, "text">;
type HeadingLevel = Extract<DocBlock, { kind: "heading" }>["level"];
type ListItem = Extract<DocBlock, { kind: "list-item" }>;
/** What a run of collected inline text becomes once flushed. */
type Pending = { kind: "paragraph" } | { kind: "heading"; level: HeadingLevel } | Omit<ListItem, "runs">;

const FLAGS = ["bold", "italic", "underline", "strike", "code"] as const;
const MONOSPACE_FONT = /consolas|courier|menlo|monaco|monospace|lucida console|source code|fira code|\bmono\b/i;

/** Only http(s) and mailto targets survive; everything else (javascript:, relative, file:) is dropped. */
function safeHref(url: string | undefined): string | undefined {
  const value = url?.trim();
  return value && /^(https?:|mailto:)/i.test(value) ? value : undefined;
}

/** A run carrying only the flags that are on (keeps the model free of `bold: false` noise). */
function makeRun(text: string, format: Format): Run {
  const run: Run = { text };
  for (const flag of FLAGS) if (format[flag]) run[flag] = true;
  if (format.href) run.href = format.href;
  return run;
}

function sameFormat(a: Run, b: Run): boolean {
  return FLAGS.every((flag) => !!a[flag] === !!b[flag]) && a.href === b.href;
}

/** Drops empty runs and merges neighbours with identical formatting. */
function mergeRuns(runs: Run[]): Run[] {
  const merged: Run[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = merged[merged.length - 1];
    if (last && sameFormat(last, run)) merged[merged.length - 1] = { ...last, text: last.text + run.text };
    else merged.push(run);
  }
  return merged;
}

function runsText(runs: Run[]): string {
  return runs.map((run) => run.text).join("");
}

function hasText(runs: Run[]): boolean {
  return runsText(runs).trim() !== "";
}

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Block for collected runs, or null when they hold no visible text. */
function blockFor(pending: Pending, runs: Run[]): DocBlock | null {
  if (!hasText(runs)) return null;
  if (pending.kind === "heading") return { kind: "heading", level: pending.level, runs };
  if (pending.kind === "list-item") return { kind: "list-item", ordered: pending.ordered, level: pending.level, runs };
  return { kind: "paragraph", runs };
}

/** Flattens blocks into one run list (table cells): text blocks joined by newlines, images dropped. */
function flattenBlocks(blocks: DocBlock[]): Run[] {
  const lines: Run[][] = [];
  for (const block of blocks) {
    if (block.kind === "code") lines.push([{ text: block.text, code: true }]);
    else if (block.kind === "table") {
      for (const row of block.rows) {
        const cells = row.filter(hasText);
        lines.push(cells.flatMap((cell, i) => (i === 0 ? cell : [{ text: " " }, ...cell])));
      }
    } else if (block.kind === "heading" || block.kind === "paragraph" || block.kind === "list-item") lines.push(block.runs);
  }
  return mergeRuns(lines.filter(hasText).flatMap((line, i) => (i === 0 ? line : [{ text: "\n" }, ...line])));
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Resolves `target` against directory `base` ("a/b" + "../c" -> "a/c"); a leading "/" means the archive root. */
function resolvePath(base: string, target: string): string {
  const parts = target.startsWith("/") ? [] : base.split("/");
  const out: string[] = [];
  for (const part of [...parts, ...target.split("/")]) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** Percent-decodes an href path (zip entry names are stored decoded); malformed escapes are left as-is. */
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Strips a "#fragment" or "?query" from an href. */
function stripFragment(href: string): string {
  return href.replace(/[?#].*$/, "");
}

/** The relationship id attribute ("r:id"), distinct from a plain `id` on the same element (p:sldId). */
function relId(el: XmlElement): string | undefined {
  for (const [name, value] of Object.entries(el.attrs)) {
    if (name.includes(":") && localName(name) === "id") return value;
  }
  return undefined;
}

/** First direct child with that local name. */
function child(el: XmlElement | null | undefined, local: string): XmlElement | null {
  return el ? (childElements(el, local)[0] ?? null) : null;
}

async function readXml(zip: ZipArchive, path: string): Promise<XmlElement | null> {
  return zip.has(path) ? parseXml(await zip.readText(path)) : null;
}

interface Relationship {
  type: string;
  /** Archive path for internal targets; the raw URL for external ones. */
  target: string;
  external: boolean;
}

/** "word/document.xml" -> "word/_rels/document.xml.rels". */
function relsPathFor(part: string): string {
  const dir = dirname(part);
  const file = part.slice(dir ? dir.length + 1 : 0);
  return `${dir ? `${dir}/` : ""}_rels/${file}.rels`;
}

/** Relationships of a package part, keyed by id; internal targets resolved against the part's directory. */
async function readRels(zip: ZipArchive, part: string): Promise<Map<string, Relationship>> {
  const rels = new Map<string, Relationship>();
  const root = await readXml(zip, relsPathFor(part));
  if (!root) return rels;
  for (const rel of findAll(root, "Relationship")) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (!id || target === undefined) continue;
    const external = attr(rel, "TargetMode") === "External";
    rels.set(id, { type: attr(rel, "Type") ?? "", target: external ? target : resolvePath(dirname(part), target), external });
  }
  return rels;
}

function relOfType(rels: Map<string, Relationship>, suffix: string): Relationship | undefined {
  for (const rel of rels.values()) if (rel.type.endsWith(suffix)) return rel;
  return undefined;
}

/** A safe link target for an `r:id` relationship (external http(s)/mailto only). */
function relHref(rels: Map<string, Relationship>, id: string | undefined): string | undefined {
  const rel = id ? rels.get(id) : undefined;
  return rel?.external ? safeHref(rel.target) : undefined;
}

/** OOXML on/off property (`<w:b/>`, `<w:b w:val="0"/>`). */
function toggle(el: XmlElement | null): boolean {
  if (!el) return false;
  const value = attr(el, "val")?.toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

function intAttr(el: XmlElement | null, local: string): number | undefined {
  const value = el ? attr(el, local) : undefined;
  const n = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

// ─── Word (.docx) ────────────────────────────────────────────────────────────

interface DocxStyle {
  heading?: HeadingLevel;
  numId?: string;
  ilvl?: number;
}

interface DocxContext {
  rels: Map<string, Relationship>;
  styles: Map<string, DocxStyle>;
  /** numId -> level -> ordered. */
  numbering: Map<string, Map<number, boolean>>;
}

/** "Heading2"/"heading 2" -> 2, "Title" -> 1. */
function headingFromName(name: string | undefined): HeadingLevel | undefined {
  if (!name) return undefined;
  if (/^title$/i.test(name.trim())) return 1;
  const match = /^heading\s*([1-6])$/i.exec(name.trim());
  return match ? (Number(match[1]) as HeadingLevel) : undefined;
}

async function readDocxStyles(zip: ZipArchive, path: string): Promise<Map<string, DocxStyle>> {
  const styles = new Map<string, DocxStyle>();
  const root = await readXml(zip, path);
  if (!root) return styles;
  for (const style of findAll(root, "style")) {
    const id = attr(style, "styleId");
    if (!id) continue;
    const nameEl = child(style, "name");
    const info: DocxStyle = { heading: headingFromName(nameEl ? attr(nameEl, "val") : undefined) ?? headingFromName(id) };
    const numPr = child(child(style, "pPr"), "numPr");
    const numIdEl = child(numPr, "numId");
    if (numIdEl) {
      info.numId = attr(numIdEl, "val");
      info.ilvl = intAttr(child(numPr, "ilvl"), "val");
    }
    styles.set(id, info);
  }
  return styles;
}

async function readDocxNumbering(zip: ZipArchive, path: string): Promise<Map<string, Map<number, boolean>>> {
  const numbering = new Map<string, Map<number, boolean>>();
  const root = await readXml(zip, path);
  if (!root) return numbering;
  const abstracts = new Map<string, Map<number, boolean>>();
  for (const abstract of findAll(root, "abstractNum")) {
    const id = attr(abstract, "abstractNumId");
    if (id === undefined) continue;
    const levels = new Map<number, boolean>();
    for (const lvl of childElements(abstract, "lvl")) {
      const fmtEl = child(lvl, "numFmt");
      const fmt = (fmtEl ? attr(fmtEl, "val") : undefined) ?? "bullet";
      levels.set(intAttr(lvl, "ilvl") ?? 0, fmt !== "bullet" && fmt !== "none");
    }
    abstracts.set(id, levels);
  }
  for (const num of findAll(root, "num")) {
    const id = attr(num, "numId");
    const abstractEl = child(num, "abstractNumId");
    const levels = abstractEl ? abstracts.get(attr(abstractEl, "val") ?? "") : undefined;
    if (id !== undefined && levels) numbering.set(id, levels);
  }
  return numbering;
}

function docxRunFormat(rPr: XmlElement | null, href: string | undefined): Format {
  const format: Format = { href };
  if (!rPr) return format;
  format.bold = toggle(child(rPr, "b"));
  format.italic = toggle(child(rPr, "i"));
  const u = child(rPr, "u");
  format.underline = !!u && (attr(u, "val") ?? "single") !== "none" && toggle(u);
  format.strike = toggle(child(rPr, "strike")) || toggle(child(rPr, "dstrike"));
  const fonts = child(rPr, "rFonts");
  format.code = !!fonts && Object.values(fonts.attrs).some((font) => MONOSPACE_FONT.test(font));
  return format;
}

function docxImageAlt(el: XmlElement): string {
  const docPr = findFirst(el, "docPr");
  if (docPr) return attr(docPr, "descr") || attr(docPr, "title") || attr(docPr, "name") || "";
  const shape = findFirst(el, "shape");
  const data = findFirst(el, "imagedata");
  return (shape && attr(shape, "alt")) || (data && attr(data, "title")) || "";
}

type Inline = Run | { image: string };

function docxRun(r: XmlElement, href: string | undefined, out: Inline[]): void {
  const format = docxRunFormat(child(r, "rPr"), href);
  for (const node of childElements(r)) {
    switch (localName(node.name)) {
      case "t":
        out.push(makeRun(textContent(node), format));
        break;
      case "tab":
        out.push(makeRun("\t", format));
        break;
      case "br":
      case "cr":
        out.push(makeRun("\n", format));
        break;
      case "noBreakHyphen":
        out.push(makeRun("-", format));
        break;
      case "drawing":
      case "pict":
      case "object":
      case "AlternateContent":
        out.push({ image: docxImageAlt(node) });
        break;
    }
  }
}

/** Inline content of a paragraph (runs, links, tracked insertions, content controls) in order. */
function docxInline(el: XmlElement, ctx: DocxContext, href: string | undefined, out: Inline[]): void {
  for (const node of childElements(el)) {
    switch (localName(node.name)) {
      case "r":
        docxRun(node, href, out);
        break;
      case "hyperlink":
        docxInline(node, ctx, relHref(ctx.rels, relId(node)) ?? href, out);
        break;
      case "ins":
      case "moveTo":
      case "smartTag":
      case "customXml":
      case "sdt":
      case "sdtContent":
      case "fldSimple":
      case "dir":
      case "bdo":
        docxInline(node, ctx, href, out);
        break;
      case "oMath":
      case "oMathPara":
        out.push(makeRun(findAll(node, "t").map(textContent).join(""), { href }));
        break;
    }
  }
}

function docxParagraph(p: XmlElement, ctx: DocxContext, blocks: DocBlock[]): void {
  const pPr = child(p, "pPr");
  const styleEl = child(pPr, "pStyle");
  const styleId = styleEl ? attr(styleEl, "val") : undefined;
  const style = styleId ? ctx.styles.get(styleId) : undefined;
  const heading = style?.heading ?? headingFromName(styleId);
  const numPr = child(pPr, "numPr");
  const numIdEl = child(numPr, "numId");
  const numId = (numIdEl ? attr(numIdEl, "val") : undefined) ?? style?.numId;
  const ilvl = intAttr(child(numPr, "ilvl"), "val") ?? style?.ilvl ?? 0;

  let pending: Pending = { kind: "paragraph" };
  if (heading) pending = { kind: "heading", level: heading };
  else if (numId && numId !== "0") pending = { kind: "list-item", ordered: ctx.numbering.get(numId)?.get(ilvl) ?? false, level: ilvl };

  const inline: Inline[] = [];
  docxInline(p, ctx, undefined, inline);
  let runs: Run[] = [];
  const flush = () => {
    const block = blockFor(pending, mergeRuns(runs));
    if (block) blocks.push(block);
    runs = [];
  };
  for (const item of inline) {
    if ("image" in item) {
      flush();
      blocks.push({ kind: "image", alt: item.image });
    } else runs.push(item);
  }
  flush();
}

function docxTable(tbl: XmlElement, ctx: DocxContext): DocBlock | null {
  const rows: Run[][][] = [];
  for (const tr of docxUnwrap(tbl, "tr")) {
    rows.push(docxUnwrap(tr, "tc").map((tc) => {
      const blocks: DocBlock[] = [];
      docxBlocks(tc, ctx, blocks);
      return flattenBlocks(blocks);
    }));
  }
  return rows.length ? { kind: "table", rows } : null;
}

/** Direct children with that local name, looking through content controls (`w:sdt`) and custom XML. */
function docxUnwrap(el: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const node of childElements(el)) {
    const name = localName(node.name);
    if (name === local) out.push(node);
    else if (name === "sdt") out.push(...docxUnwrap(child(node, "sdtContent") ?? node, local));
    else if (name === "customXml") out.push(...docxUnwrap(node, local));
  }
  return out;
}

/** Block-level content (body, table cell, content control) in document order. */
function docxBlocks(container: XmlElement, ctx: DocxContext, blocks: DocBlock[]): void {
  for (const node of childElements(container)) {
    switch (localName(node.name)) {
      case "p":
        docxParagraph(node, ctx, blocks);
        break;
      case "tbl": {
        const table = docxTable(node, ctx);
        if (table) blocks.push(table);
        break;
      }
      case "sdt":
        docxBlocks(child(node, "sdtContent") ?? node, ctx, blocks);
        break;
      case "sdtContent":
      case "customXml":
        docxBlocks(node, ctx, blocks);
        break;
    }
  }
}

/** Reads the body of a Word document: headings, paragraphs, lists, tables and image placeholders. */
export async function readDocx(zip: ZipArchive): Promise<DocBlock[]> {
  const path = "word/document.xml";
  const doc = await readXml(zip, path);
  if (!doc) throw new Error("Not a Word document (word/document.xml is missing)");
  const rels = await readRels(zip, path);
  const stylesPath = relOfType(rels, "/styles")?.target ?? "word/styles.xml";
  const numberingPath = relOfType(rels, "/numbering")?.target ?? "word/numbering.xml";
  const [styles, numbering] = await Promise.all([readDocxStyles(zip, stylesPath), readDocxNumbering(zip, numberingPath)]);
  const body = findFirst(doc, "body");
  const blocks: DocBlock[] = [];
  if (body) docxBlocks(body, { rels, styles, numbering }, blocks);
  return blocks;
}

// ─── Excel (.xlsx) ───────────────────────────────────────────────────────────

/** One worksheet as formatted cell text. */
export interface Sheet {
  name: string;
  /** Row-major cell text; gaps filled with "", trailing empty rows/columns trimmed, rows padded to equal width. */
  rows: string[][];
  /** More than `MAX_SHEET_ROWS` rows or `MAX_SHEET_COLS` columns had content. */
  truncated: boolean;
}

const MAX_SHEET_ROWS = 1000;
const MAX_SHEET_COLS = 100;
/** Excel's last representable date (9999-12-31). */
const MAX_DATE_SERIAL = 2958465;
const DAY_MS = 86_400_000;
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Expands Excel's `_xHHHH_` escapes (e.g. `_x000D_`). */
function unescapeExcel(text: string): string {
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Text of a string item (`si`, `is`): plain `t` or rich-text runs, excluding phonetic hints (`rPh`). */
function stringItemText(item: XmlElement): string {
  let text = "";
  for (const node of childElements(item)) {
    const name = localName(node.name);
    if (name === "t") text += textContent(node);
    else if (name === "r") text += childElements(node, "t").map(textContent).join("");
  }
  return unescapeExcel(text);
}

/** A custom number format renders as a date/time when it uses y/m/d/h/s outside literals and [colour] tags. */
function isDateFormatCode(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "")
    .replace(/[_*]./g, "");
  if (/^\s*general\s*$/i.test(stripped)) return false;
  return /[ymdhs]/i.test(stripped);
}

/** Style index (`c@s`) -> renders as a date. */
async function readDateStyles(zip: ZipArchive, path: string): Promise<boolean[]> {
  const root = await readXml(zip, path);
  if (!root) return [];
  const custom = new Map<number, string>();
  const numFmts = findFirst(root, "numFmts");
  if (numFmts) {
    for (const fmt of childElements(numFmts, "numFmt")) {
      const id = intAttr(fmt, "numFmtId");
      if (id !== undefined) custom.set(id, attr(fmt, "formatCode") ?? "");
    }
  }
  const cellXfs = findFirst(root, "cellXfs");
  if (!cellXfs) return [];
  return childElements(cellXfs, "xf").map((xf) => {
    const id = intAttr(xf, "numFmtId") ?? 0;
    const code = custom.get(id);
    return code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(id);
  });
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Serial date -> "YYYY-MM-DD", "YYYY-MM-DD HH:MM[:SS]", or "HH:MM[:SS]" for pure times. */
function formatSerialDate(serial: number, date1904: boolean): string {
  let days = Math.floor(serial);
  let seconds = Math.round((serial - days) * 86400);
  if (seconds >= 86400) {
    days += 1;
    seconds -= 86400;
  }
  const time = seconds ? `${pad2(Math.floor(seconds / 3600))}:${pad2(Math.floor(seconds / 60) % 60)}${seconds % 60 ? `:${pad2(seconds % 60)}` : ""}` : "";
  if (days === 0 && time) return time;
  // The 1900 system counts the non-existent 1900-02-29 (serial 60), so serials before it are a day off.
  const ms = date1904 ? Date.UTC(1904, 0, 1) + days * DAY_MS : Date.UTC(1899, 11, 30) + (days < 61 ? days + 1 : days) * DAY_MS;
  const date = new Date(ms);
  const iso = `${String(date.getUTCFullYear()).padStart(4, "0")}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  return time ? `${iso} ${time}` : iso;
}

/** Number without binary float noise (0.30000000000000004 -> "0.3"). */
function formatNumber(value: number): string {
  return Number(value.toPrecision(15)).toString();
}

interface XlsxContext {
  shared: string[];
  dateStyles: boolean[];
  date1904: boolean;
}

function cellText(c: XmlElement, ctx: XlsxContext): string {
  const type = attr(c, "t") ?? "n";
  if (type === "inlineStr") {
    const is = child(c, "is");
    return is ? stringItemText(is) : "";
  }
  const vEl = child(c, "v");
  const v = vEl ? textContent(vEl) : "";
  if (v === "") return "";
  switch (type) {
    case "s":
      return ctx.shared[Number.parseInt(v, 10)] ?? "";
    case "b":
      return v.trim() === "1" || v.trim().toLowerCase() === "true" ? "TRUE" : "FALSE";
    case "str":
    case "e":
    case "d":
      return unescapeExcel(v);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  const style = intAttr(c, "s") ?? 0;
  if (ctx.dateStyles[style] && n >= 0 && n <= MAX_DATE_SERIAL) return formatSerialDate(n, ctx.date1904);
  return formatNumber(n);
}

/** "AB12" -> { col: 27, row: 11 } (0-based). */
function parseCellRef(ref: string | undefined): { col: number; row: number } | null {
  const match = ref ? /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref) : null;
  if (!match) return null;
  let col = 0;
  for (const ch of match[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(match[2]) - 1 };
}

function readSheetRows(sheet: XmlElement, ctx: XlsxContext): { rows: string[][]; truncated: boolean } {
  const grid: string[][] = [];
  let truncated = false;
  let maxRow = -1;
  let maxCol = -1;
  const data = findFirst(sheet, "sheetData");
  let rowIndex = -1;
  for (const row of data ? childElements(data, "row") : []) {
    const r = intAttr(row, "r");
    rowIndex = r !== undefined ? r - 1 : rowIndex + 1;
    let colIndex = -1;
    for (const c of childElements(row, "c")) {
      const ref = parseCellRef(attr(c, "r"));
      colIndex = ref ? ref.col : colIndex + 1;
      const text = cellText(c, ctx);
      if (text === "") continue;
      if (rowIndex >= MAX_SHEET_ROWS || colIndex >= MAX_SHEET_COLS) {
        truncated = true;
        continue;
      }
      (grid[rowIndex] ??= [])[colIndex] = text;
      maxRow = Math.max(maxRow, rowIndex);
      maxCol = Math.max(maxCol, colIndex);
    }
  }
  const rows: string[][] = [];
  for (let r = 0; r <= maxRow; r++) {
    const source = grid[r];
    const cells: string[] = [];
    for (let c = 0; c <= maxCol; c++) cells.push(source?.[c] ?? "");
    rows.push(cells);
  }
  return { rows, truncated };
}

/** Reads every worksheet of a workbook in tab order. */
export async function readXlsx(zip: ZipArchive): Promise<Sheet[]> {
  const path = "xl/workbook.xml";
  const workbook = await readXml(zip, path);
  if (!workbook) throw new Error("Not an Excel workbook (xl/workbook.xml is missing)");
  const rels = await readRels(zip, path);
  const workbookPr = findFirst(workbook, "workbookPr");
  const date1904Attr = workbookPr ? attr(workbookPr, "date1904")?.toLowerCase() : undefined;
  const sharedPath = relOfType(rels, "/sharedStrings")?.target ?? "xl/sharedStrings.xml";
  const stylesPath = relOfType(rels, "/styles")?.target ?? "xl/styles.xml";
  const [sharedRoot, dateStyles] = await Promise.all([readXml(zip, sharedPath), readDateStyles(zip, stylesPath)]);
  const sst = sharedRoot ? findFirst(sharedRoot, "sst") : null;
  const ctx: XlsxContext = {
    shared: sst ? childElements(sst, "si").map(stringItemText) : [],
    dateStyles,
    date1904: date1904Attr === "1" || date1904Attr === "true",
  };

  const sheets: Sheet[] = [];
  const sheetEls = findAll(workbook, "sheet");
  for (const [i, sheetEl] of sheetEls.entries()) {
    const rel = rels.get(relId(sheetEl) ?? "");
    const sheetPath = rel && !rel.external ? rel.target : `xl/worksheets/sheet${i + 1}.xml`;
    const sheet = await readXml(zip, sheetPath);
    const { rows, truncated } = sheet ? readSheetRows(sheet, ctx) : { rows: [], truncated: false };
    sheets.push({ name: attr(sheetEl, "name") ?? `Sheet${i + 1}`, rows, truncated });
  }
  return sheets;
}

// ─── PowerPoint (.pptx) ──────────────────────────────────────────────────────

/** One slide in presentation order (`index` is 1-based). */
export interface Slide {
  index: number;
  title: string | null;
  blocks: DocBlock[];
  notes: DocBlock[];
}

/** Placeholders that carry chrome rather than content. */
const PPTX_SKIPPED_PLACEHOLDERS: Record<string, true> = { sldNum: true, dt: true, ftr: true, hdr: true, sldImg: true };

interface PptxContext {
  rels: Map<string, Relationship>;
  /** Paragraphs default to bullets (content/body placeholders on slides). */
  bulletDefault: boolean;
}

function pptxRuns(p: XmlElement, rels: Map<string, Relationship>): Run[] {
  const runs: Run[] = [];
  for (const node of childElements(p)) {
    const name = localName(node.name);
    if (name === "br") {
      runs.push({ text: "\n" });
      continue;
    }
    if (name !== "r" && name !== "fld") continue;
    const rPr = child(node, "rPr");
    const format: Format = {};
    if (rPr) {
      const flag = (local: string) => {
        const value = attr(rPr, local);
        return value === "1" || value === "true";
      };
      format.bold = flag("b");
      format.italic = flag("i");
      const u = attr(rPr, "u");
      format.underline = !!u && u !== "none";
      const strike = attr(rPr, "strike");
      format.strike = !!strike && strike !== "noStrike";
      const latin = child(rPr, "latin");
      format.code = MONOSPACE_FONT.test((latin && attr(latin, "typeface")) ?? "");
      const link = child(rPr, "hlinkClick");
      format.href = link ? relHref(rels, relId(link)) : undefined;
    }
    runs.push(makeRun(childElements(node, "t").map(textContent).join(""), format));
  }
  return mergeRuns(runs);
}

function pptxParagraphs(txBody: XmlElement, ctx: PptxContext): DocBlock[] {
  const blocks: DocBlock[] = [];
  for (const p of childElements(txBody, "p")) {
    const pPr = child(p, "pPr");
    const level = intAttr(pPr, "lvl");
    const autoNum = !!child(pPr, "buAutoNum");
    const bulleted = !child(pPr, "buNone") && (autoNum || !!child(pPr, "buChar") || level !== undefined || ctx.bulletDefault);
    const pending: Pending = bulleted ? { kind: "list-item", ordered: autoNum, level: level ?? 0 } : { kind: "paragraph" };
    const block = blockFor(pending, pptxRuns(p, ctx.rels));
    if (block) blocks.push(block);
  }
  return blocks;
}

function pptxTable(tbl: XmlElement, ctx: PptxContext): DocBlock | null {
  const cellCtx = { ...ctx, bulletDefault: false };
  const rows = childElements(tbl, "tr").map((tr) =>
    childElements(tr, "tc").map((tc) => {
      const txBody = child(tc, "txBody");
      return txBody ? flattenBlocks(pptxParagraphs(txBody, cellCtx)) : [];
    }),
  );
  return rows.length ? { kind: "table", rows } : null;
}

interface ShapeSink {
  blocks: DocBlock[];
  /** Title placeholder text, if any (slides only). */
  title: string | null;
}

/** Walks a shape tree (`p:spTree`/`p:grpSp`) in z-order, which is also reading order for most slides. */
function pptxShapes(tree: XmlElement, ctx: PptxContext, sink: ShapeSink, collectTitle: boolean): void {
  for (const node of childElements(tree)) {
    switch (localName(node.name)) {
      case "sp": {
        const ph = findFirst(child(node, "nvSpPr") ?? node, "ph");
        const type = ph ? attr(ph, "type") : undefined;
        if (type && PPTX_SKIPPED_PLACEHOLDERS[type] === true) break;
        const txBody = child(node, "txBody");
        if (!txBody) break;
        if (collectTitle && (type === "title" || type === "ctrTitle") && sink.title === null) {
          const title = childElements(txBody, "p").map((p) => normalizeSpace(runsText(pptxRuns(p, ctx.rels)))).filter(Boolean).join(" ");
          if (title) {
            sink.title = title;
            break;
          }
        }
        const bulletDefault = ctx.bulletDefault && !!ph && (type === undefined || type === "body" || type === "obj");
        sink.blocks.push(...pptxParagraphs(txBody, { ...ctx, bulletDefault }));
        break;
      }
      case "grpSp":
        pptxShapes(node, ctx, sink, collectTitle);
        break;
      case "graphicFrame": {
        const tbl = findFirst(node, "tbl");
        const table = tbl ? pptxTable(tbl, ctx) : null;
        if (table) sink.blocks.push(table);
        break;
      }
      case "pic": {
        const cNvPr = findFirst(node, "cNvPr");
        sink.blocks.push({ kind: "image", alt: (cNvPr && (attr(cNvPr, "descr") || attr(cNvPr, "name"))) || "" });
        break;
      }
      case "AlternateContent": {
        const choice = child(node, "Choice") ?? child(node, "Fallback");
        if (choice) pptxShapes(choice, ctx, sink, collectTitle);
        break;
      }
    }
  }
}

/** Reads slides in presentation order with their titles, content and speaker notes. */
export async function readPptx(zip: ZipArchive): Promise<Slide[]> {
  const path = "ppt/presentation.xml";
  const presentation = await readXml(zip, path);
  if (!presentation) throw new Error("Not a PowerPoint presentation (ppt/presentation.xml is missing)");
  const rels = await readRels(zip, path);
  const list = findFirst(presentation, "sldIdLst");
  const slidePaths = (list ? childElements(list, "sldId") : [])
    .map((sldId) => rels.get(relId(sldId) ?? ""))
    .filter((rel): rel is Relationship => !!rel && !rel.external)
    .map((rel) => rel.target);

  const slides: Slide[] = [];
  for (const slidePath of slidePaths) {
    const slide = await readXml(zip, slidePath);
    if (!slide) continue;
    const slideRels = await readRels(zip, slidePath);
    const sink: ShapeSink = { blocks: [], title: null };
    const tree = findFirst(slide, "spTree");
    if (tree) pptxShapes(tree, { rels: slideRels, bulletDefault: true }, sink, true);

    const notesRel = relOfType(slideRels, "/notesSlide");
    const notesSink: ShapeSink = { blocks: [], title: null };
    const notes = notesRel && !notesRel.external ? await readXml(zip, notesRel.target) : null;
    const notesTree = notes ? findFirst(notes, "spTree") : null;
    if (notesRel && notesTree) {
      pptxShapes(notesTree, { rels: await readRels(zip, notesRel.target), bulletDefault: false }, notesSink, false);
    }
    slides.push({ index: slides.length + 1, title: sink.title, blocks: sink.blocks, notes: notesSink.blocks });
  }
  return slides;
}

// ─── EPUB ────────────────────────────────────────────────────────────────────

/** An e-book's metadata and its spine as chapters of blocks. */
export interface Ebook {
  title: string | null;
  author: string | null;
  chapters: { title: string; blocks: DocBlock[] }[];
}

const HTML_SKIP: Record<string, true> = {
  head: true, script: true, style: true, title: true, noscript: true, template: true, svg: true,
  button: true, select: true, textarea: true,
};
const HTML_BLOCK: Record<string, true> = {
  html: true, body: true, p: true, div: true, section: true, article: true, aside: true, header: true,
  footer: true, main: true, nav: true, blockquote: true, figure: true, figcaption: true, address: true,
  center: true, dl: true, dt: true, dd: true, details: true, summary: true, fieldset: true, form: true,
  hgroup: true, caption: true,
};
const HTML_INLINE_FORMAT: Record<string, (typeof FLAGS)[number]> = {
  b: "bold", strong: "bold",
  i: "italic", em: "italic", cite: "italic", dfn: "italic", var: "italic",
  u: "underline", ins: "underline",
  s: "strike", strike: "strike", del: "strike",
  code: "code", kbd: "code", samp: "code", tt: "code",
};

/** Text of a `<pre>`, keeping `<br>` line breaks. */
function preText(el: XmlElement): string {
  let text = "";
  for (const node of el.children) {
    if (node.type === "text") text += node.text;
    else if (localName(node.name).toLowerCase() === "br") text += "\n";
    else text += preText(node);
  }
  return text;
}

/**
 * Applies HTML whitespace rules to collected inline runs: whitespace collapsed to one space,
 * no space at block edges or around `<br>` line breaks (runs whose text is exactly "\n").
 */
function collapseRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  let atBreak = true;
  for (const run of runs) {
    if (run.text === "\n") {
      // A break at the start of a block renders nothing.
      if (!out.length) continue;
      const last = out[out.length - 1];
      last.text = last.text.replace(/ +$/, "");
      out.push(run);
      atBreak = true;
      continue;
    }
    let text = run.text;
    if (atBreak) text = text.replace(/^ +/, "");
    if (!text) continue;
    out.push({ ...run, text });
    atBreak = text.endsWith(" ");
  }
  while (out.length) {
    const last = out[out.length - 1];
    last.text = last.text.replace(/[ \n]+$/, "");
    if (last.text) break;
    out.pop();
  }
  return mergeRuns(out);
}

/** Converts (X)HTML element trees into blocks. */
class HtmlBlocks {
  private readonly blocks: DocBlock[] = [];
  private runs: Run[] = [];
  private pending: Pending = { kind: "paragraph" };
  /** Open lists, innermost last: ordered? */
  private readonly lists: boolean[] = [];

  /** Converts the children of `el`. */
  walk(el: XmlElement, format: Format): void {
    for (const node of el.children) {
      if (node.type === "text") {
        const text = node.text.replace(/[ \t\r\n\f]+/g, " ");
        if (text) this.runs.push(makeRun(text, format));
      } else this.element(node, format);
    }
  }

  finish(): DocBlock[] {
    this.flush();
    return this.blocks;
  }

  private flush(): void {
    const block = blockFor(this.pending, collapseRuns(this.runs));
    this.runs = [];
    if (block) this.blocks.push(block);
  }

  /** Converts `el` with its inline text collected into `pending` blocks. */
  private within(pending: Pending, el: XmlElement, format: Format): void {
    this.flush();
    const saved = this.pending;
    this.pending = pending;
    this.walk(el, format);
    this.flush();
    this.pending = saved;
  }

  private element(el: XmlElement, format: Format): void {
    const name = localName(el.name).toLowerCase();
    if (HTML_SKIP[name] === true) return;
    const heading = /^h([1-6])$/.exec(name);
    if (heading) return this.within({ kind: "heading", level: Number(heading[1]) as HeadingLevel }, el, format);
    switch (name) {
      case "ul":
      case "ol":
        this.flush();
        this.lists.push(name === "ol");
        this.walk(el, format);
        this.flush();
        this.lists.pop();
        return;
      case "li":
        return this.within(
          { kind: "list-item", ordered: this.lists[this.lists.length - 1] ?? false, level: Math.max(0, this.lists.length - 1) },
          el,
          format,
        );
      case "pre": {
        this.flush();
        const text = preText(el).replace(/^\r?\n/, "").replace(/\s+$/, "");
        if (text.trim()) this.blocks.push({ kind: "code", text });
        return;
      }
      case "table": {
        this.flush();
        const rows = htmlTableRows(el);
        if (rows.length) this.blocks.push({ kind: "table", rows });
        return;
      }
      case "img":
        this.flush();
        this.blocks.push({ kind: "image", alt: normalizeSpace(attr(el, "alt") || attr(el, "title") || "") });
        return;
      case "hr":
        this.flush();
        this.blocks.push({ kind: "rule" });
        return;
      case "br":
        this.runs.push(makeRun("\n", format));
        return;
      case "a": {
        const href = safeHref(attr(el, "href"));
        return this.walk(el, href ? { ...format, href } : format);
      }
    }
    const flag = Object.hasOwn(HTML_INLINE_FORMAT, name) ? HTML_INLINE_FORMAT[name] : undefined;
    if (flag) return this.walk(el, { ...format, [flag]: true });
    if (HTML_BLOCK[name] === true) {
      this.flush();
      this.walk(el, format);
      this.flush();
      return;
    }
    this.walk(el, format);
  }
}

function htmlTableRows(table: XmlElement): Run[][][] {
  const trs: XmlElement[] = [];
  for (const node of childElements(table)) {
    const name = localName(node.name).toLowerCase();
    if (name === "tr") trs.push(node);
    else if (name === "thead" || name === "tbody" || name === "tfoot") trs.push(...childElements(node, "tr"));
  }
  return trs.map((tr) =>
    childElements(tr)
      .filter((cell) => /^t[dh]$/i.test(localName(cell.name)))
      .map((cell) => {
        const converter = new HtmlBlocks();
        converter.walk(cell, {});
        return flattenBlocks(converter.finish());
      }),
  );
}

function htmlToBlocks(root: XmlElement): DocBlock[] {
  const converter = new HtmlBlocks();
  converter.walk(findFirst(root, "body") ?? root, {});
  return converter.finish();
}

interface ManifestItem {
  path: string;
  mediaType: string;
  properties: string[];
}

/** Chapter path -> title from a navigation document's links (first link per file wins). */
function addTocEntry(titles: Map<string, string>, baseDir: string, href: string | undefined, label: string): void {
  if (!href || !label) return;
  const path = decodePath(resolvePath(baseDir, stripFragment(href)));
  if (path && !titles.has(path)) titles.set(path, label);
}

async function readEpubToc(zip: ZipArchive, manifest: Map<string, ManifestItem>, tocId: string | undefined): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const navItem = [...manifest.values()].find((item) => item.properties.includes("nav"));
  const nav = navItem ? await readXml(zip, navItem.path) : null;
  if (navItem && nav) {
    const navs = findAll(nav, "nav");
    const toc = navs.find((el) => (attr(el, "type") ?? "").split(/\s+/).includes("toc")) ?? navs[0];
    for (const a of toc ? findAll(toc, "a") : []) addTocEntry(titles, dirname(navItem.path), attr(a, "href"), normalizeSpace(textContent(a)));
    if (titles.size) return titles;
  }
  const ncxItem =
    (tocId ? manifest.get(tocId) : undefined) ?? [...manifest.values()].find((item) => item.mediaType === "application/x-dtbncx+xml");
  const ncx = ncxItem ? await readXml(zip, ncxItem.path) : null;
  if (ncxItem && ncx) {
    for (const point of findAll(ncx, "navPoint")) {
      const label = child(point, "navLabel");
      const content = child(point, "content");
      addTocEntry(titles, dirname(ncxItem.path), content ? attr(content, "src") : undefined, label ? normalizeSpace(textContent(label)) : "");
    }
  }
  return titles;
}

function metadataText(metadata: XmlElement | null, local: string): string | null {
  const el = metadata ? findFirst(metadata, local) : null;
  const text = el ? normalizeSpace(textContent(el)) : "";
  return text || null;
}

/** Reads an EPUB (2 or 3): title, author and spine chapters converted to blocks. */
export async function readEpub(zip: ZipArchive): Promise<Ebook> {
  const container = await readXml(zip, "META-INF/container.xml");
  if (!container) throw new Error("Not an EPUB (META-INF/container.xml is missing)");
  const rootfile = findFirst(container, "rootfile");
  const opfPath = rootfile ? decodePath(attr(rootfile, "full-path") ?? "") : "";
  const opf = opfPath ? await readXml(zip, opfPath) : null;
  if (!opf) throw new Error("Not an EPUB (the package document is missing)");

  const opfDir = dirname(opfPath);
  const metadata = findFirst(opf, "metadata");
  const manifest = new Map<string, ManifestItem>();
  const manifestEl = findFirst(opf, "manifest");
  for (const item of manifestEl ? childElements(manifestEl, "item") : []) {
    const id = attr(item, "id");
    const href = attr(item, "href");
    if (!id || !href) continue;
    manifest.set(id, {
      path: decodePath(resolvePath(opfDir, stripFragment(href))),
      mediaType: attr(item, "media-type") ?? "",
      properties: (attr(item, "properties") ?? "").split(/\s+/).filter(Boolean),
    });
  }
  const spine = findFirst(opf, "spine");
  const titles = await readEpubToc(zip, manifest, spine ? attr(spine, "toc") : undefined);

  const chapters: Ebook["chapters"] = [];
  for (const itemref of spine ? childElements(spine, "itemref") : []) {
    const item = manifest.get(attr(itemref, "idref") ?? "");
    if (!item || !(/html|xml/i.test(item.mediaType) || /\.x?html?$/i.test(item.path))) continue;
    const doc = await readXml(zip, item.path);
    if (!doc) continue;
    const blocks = htmlToBlocks(doc);
    if (!blocks.length) continue;
    const heading = blocks.find((block) => block.kind === "heading");
    const title =
      titles.get(item.path) ??
      ((heading?.kind === "heading" ? normalizeSpace(runsText(heading.runs)) : "") || `Chapter ${chapters.length + 1}`);
    chapters.push({ title, blocks });
  }
  return { title: metadataText(metadata, "title"), author: metadataText(metadata, "creator"), chapters };
}
