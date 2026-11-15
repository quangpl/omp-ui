import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { createProjectViaApi, login, uniqueName } from "./helpers";

// The composer's inline word suggestion: while it shows, the overlay paints the whole text with the
// suggested suffix spliced in at the caret (the textarea's own glyphs are hidden), so the suffix never
// lands on top of the text after the caret or on the next line. The suggestion comes from words in the
// draft (and the word model learned from other specs' cards), so the suffix is always read from the DOM.

const WORD_LINE = "We should reconcile the supercalifragilistic parser.";
const PREFIX = "supercal";
const WORD = "supercalifragilistic";
const GHOST = "[data-composer-ghost]";
const SUFFIX = `${GHOST} [data-ghost-suffix]`;
const TRANSPARENT = "rgba(0, 0, 0, 0)";
/** Rects sharing less than this along an axis only touch (subpixel glyph edges). */
const TOLERANCE = 0.5;
/** Allowed misalignment between the suffix and the caret. */
const ALIGN = 1;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface PaintedText {
  text: string;
  suffix: boolean;
  rects: Box[];
  /** Rects reaching outside a clipping ancestor inside the overlay, so (part of) them never shows. */
  clippedRects: Box[];
}

interface GhostSnapshot {
  value: string;
  caret: number;
  scrollTop: number;
  textFill: string;
  /** Overlay text nodes with a visible color, in document order. */
  painted: PaintedText[];
  /** Last rect of the typed prefix in the painted text before the suffix. */
  prefixRect: Box | null;
  /** Rects of the last occurrence of the needle in the painted text after the suffix. */
  needleRects: Box[];
}

interface SuggestionCheck {
  /** Text after the suffix whose last occurrence's rects the snapshot reports (`needleRects`). */
  needle?: string;
  /** The textarea is scrolled down, so text above the caret's line may lie above its visible area. */
  scrolled?: boolean;
}

async function openComposer(page: Page, request: APIRequestContext): Promise<Locator> {
  const board = await createProjectViaApi(request, uniqueName("ghost"));
  await page.goto(`/b/${board.id}/new`);
  const textarea = page.getByLabel("What should the agent do?", { exact: true });
  await expect(textarea).toBeVisible();
  // The overlay does not re-measure after a font swap.
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  return textarea;
}

/** Puts `before + after` in the textarea, moves the caret between them with keys, then types `PREFIX`. */
async function typePrefixBetween(textarea: Locator, before: string, after: string): Promise<void> {
  await textarea.fill(before + after);
  await textarea.press("ControlOrMeta+End");
  // ArrowLeft only: ArrowRight would accept a suggestion showing on the way.
  for (let i = 0; i < after.length; i++) await textarea.press("ArrowLeft");
  await textarea.pressSequentially(PREFIX);
}

async function ghostSnapshot(textarea: Locator, prefixLength: number, needle: string | null): Promise<GhostSnapshot> {
  return textarea.evaluate(
    (el: HTMLTextAreaElement, args: { prefixLength: number; needle: string | null; tolerance: number }) => {
      const rangeRects = (node: Text, start: number, end: number): Box[] => {
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        return [...range.getClientRects()]
          .filter((r) => r.width > 0 && r.height > 0)
          .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
      };
      const alpha = (color: string): number => {
        const value = color.trim();
        if (value === "transparent") return 0;
        let raw: string | undefined;
        const slash = value.lastIndexOf("/");
        if (slash >= 0) raw = value.slice(slash + 1).replace(")", "").trim();
        else if (/^(rgba|hsla)\(/.test(value)) raw = value.slice(value.indexOf("(") + 1, -1).split(",")[3]?.trim();
        if (raw === undefined) return 1;
        return raw.endsWith("%") ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
      };
      // Intersection of the padding boxes of every clipping ancestor up to the overlay root.
      const clipBox = (from: Element, root: Element): Box => {
        const clip: Box = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
        for (let e: Element | null = from; e; e = e === root ? null : e.parentElement) {
          const style = getComputedStyle(e);
          const r = e.getBoundingClientRect();
          const left = r.left + e.clientLeft;
          const top = r.top + e.clientTop;
          if (style.overflowX !== "visible") {
            clip.left = Math.max(clip.left, left);
            clip.right = Math.min(clip.right, left + e.clientWidth);
          }
          if (style.overflowY !== "visible") {
            clip.top = Math.max(clip.top, top);
            clip.bottom = Math.min(clip.bottom, top + e.clientHeight);
          }
        }
        return clip;
      };

      const painted: PaintedText[] = [];
      let prefixRect: Box | null = null;
      let needleRects: Box[] = [];
      const ghost = document.querySelector("[data-composer-ghost]");
      if (ghost) {
        let lastBefore: Text | null = null;
        let afterSuffix = false;
        const walker = document.createTreeWalker(ghost, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node as Text;
          const parent = text.parentElement;
          if (!parent || !text.data || alpha(getComputedStyle(parent).color) === 0) continue;
          const suffix = parent.closest("[data-ghost-suffix]") !== null;
          const rects = rangeRects(text, 0, text.data.length);
          const clip = clipBox(parent, ghost);
          const clippedRects = rects.filter(
            (r) =>
              r.left < clip.left - args.tolerance ||
              r.right > clip.right + args.tolerance ||
              r.top < clip.top - args.tolerance ||
              r.bottom > clip.bottom + args.tolerance,
          );
          painted.push({ text: text.data, suffix, rects, clippedRects });
          if (suffix) {
            if (!afterSuffix && lastBefore && lastBefore.data.length >= args.prefixLength) {
              const end = lastBefore.data.length;
              prefixRect = rangeRects(lastBefore, end - args.prefixLength, end).at(-1) ?? null;
            }
            afterSuffix = true;
          } else if (!afterSuffix) {
            lastBefore = text;
          } else if (args.needle !== null) {
            const index = text.data.lastIndexOf(args.needle);
            if (index >= 0) needleRects = rangeRects(text, index, index + args.needle.length);
          }
        }
      }
      return {
        value: el.value,
        caret: el.selectionStart,
        scrollTop: el.scrollTop,
        textFill: getComputedStyle(el).webkitTextFillColor,
        painted,
        prefixRect,
        needleRects,
      };
    },
    { prefixLength, needle, tolerance: TOLERANCE },
  );
}

function overlaps(a: Box, b: Box): boolean {
  return (
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > TOLERANCE &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > TOLERANCE
  );
}

/**
 * Waits for the suggestion after `PREFIX` at `caret` in `value`, then checks the overlay paints the text
 * with the suffix spliced in at the caret, the textarea's glyphs are hidden, nothing painted is clipped
 * away (from the caret's line down when `scrolled`), the suffix overlaps no other painted text and starts
 * right after the prefix on the caret's line.
 */
async function expectSplicedSuggestion(
  textarea: Locator,
  value: string,
  caret: number,
  { needle, scrolled = false }: SuggestionCheck = {},
): Promise<{ snapshot: GhostSnapshot; suffix: PaintedText; prefix: Box }> {
  await expect(textarea.page().locator(SUFFIX)).toBeVisible();
  await expect
    .poll(async () => {
      const s = await ghostSnapshot(textarea, PREFIX.length, needle ?? null);
      return { value: s.value, caret: s.caret, suffixes: s.painted.filter((p) => p.suffix).length };
    })
    .toEqual({ value, caret, suffixes: 1 });

  const snapshot = await ghostSnapshot(textarea, PREFIX.length, needle ?? null);
  if (scrolled) expect(snapshot.scrollTop).toBeGreaterThan(0);
  const suffix = snapshot.painted.find((p) => p.suffix);
  if (!suffix) throw new Error("the suggestion's suffix is not painted");
  const [first] = suffix.rects;
  const prefix = snapshot.prefixRect;
  if (!first || !prefix) throw new Error("the suffix or the typed prefix has no rects");
  expect(suffix.text.length).toBeGreaterThan(0);
  expect(snapshot.painted.map((p) => p.text).join("")).toBe(value.slice(0, caret) + suffix.text + value.slice(caret));
  expect(snapshot.textFill).toBe(TRANSPARENT);
  // Scrolled out of view above the caret's line is the textarea's own clipping, not the overlay's.
  const checked = (r: Box) => !scrolled || r.bottom > prefix.top + TOLERANCE;
  expect(snapshot.painted.filter((p) => p.clippedRects.some(checked)).map((p) => p.text)).toEqual([]);

  const others = snapshot.painted.filter((p) => !p.suffix).flatMap((p) => p.rects);
  const collisions = suffix.rects.flatMap((r) => others.filter((o) => overlaps(r, o)).map((o) => ({ suffix: r, other: o })));
  expect(collisions).toEqual([]);

  expect(Math.abs(first.left - prefix.right)).toBeLessThanOrEqual(ALIGN);
  expect(Math.abs(first.top - prefix.top)).toBeLessThanOrEqual(ALIGN);
  return { snapshot, suffix, prefix };
}

/**
 * Screenshots the textarea's content from its top padding edge down to just above the caret's line
 * (where the native caret blinks) with the suggestion showing, then again after Escape hides it: the
 * overlay must paint the lines above the caret pixel for pixel like the textarea itself.
 */
async function expectLinesAboveCaretUnchangedByEscape(textarea: Locator, caretLine: Box): Promise<void> {
  const page = textarea.page();
  const clip = await textarea.evaluate((el: HTMLTextAreaElement, line: Box) => {
    const rect = el.getBoundingClientRect();
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
    // A text rect spans the font's ascent and descent; the line box adds half the leading above it.
    const halfLeading = Number.isNaN(lineHeight) ? 0 : Math.max(0, (lineHeight - (line.bottom - line.top)) / 2);
    const x = Math.ceil(rect.left + el.clientLeft);
    const y = Math.ceil(rect.top + el.clientTop);
    const right = Math.floor(rect.left + el.clientLeft + el.clientWidth);
    const bottom = Math.floor(line.top - halfLeading) - 1;
    return { x, y, width: right - x, height: bottom - y };
  }, caretLine);
  expect(clip.width).toBeGreaterThan(0);
  expect(clip.height).toBeGreaterThan(0);

  const withSuggestion = await page.screenshot({ clip, caret: "hide", animations: "disabled" });
  await textarea.press("Escape");
  await expect(page.locator(GHOST)).toHaveCount(0);
  await expect.poll(() => textarea.evaluate((el) => getComputedStyle(el).webkitTextFillColor)).not.toBe(TRANSPARENT);
  const withoutSuggestion = await page.screenshot({ clip, caret: "hide", animations: "disabled" });
  expect(withSuggestion.equals(withoutSuggestion)).toBe(true);
}

/**
 * Viewport rect of `word[offset]` in the overlay's painted text: the text before the caret, or the
 * text after the suffix (pushed by it).
 */
async function paintedCharRect(page: Page, part: "before" | "after", word: string, offset: number): Promise<Box> {
  return page.evaluate(
    (args: { part: "before" | "after"; word: string; offset: number }) => {
      const ghost = document.querySelector("[data-composer-ghost]");
      const suffix = ghost?.querySelector("[data-ghost-suffix]");
      if (!ghost || !suffix) throw new Error("no suggestion is showing");
      const walker = document.createTreeWalker(ghost, NodeFilter.SHOW_TEXT);
      let node: Text | null = null;
      for (let n = walker.nextNode(); n && !node; n = walker.nextNode()) {
        const text = n as Text;
        if (!text.data) continue;
        const afterSuffix =
          (suffix.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && !suffix.contains(text);
        if (args.part === "before" || afterSuffix) node = text;
      }
      const index = node ? node.data.indexOf(args.word) : -1;
      if (!node || index < 0) throw new Error(`"${args.word}" is not painted ${args.part} the caret`);
      const range = document.createRange();
      range.setStart(node, index + args.offset);
      range.setEnd(node, index + args.offset + 1);
      const rect = [...range.getClientRects()].find((r) => r.width > 0 && r.height > 0);
      if (!rect) throw new Error(`"${args.word}"[${args.offset}] has no rect`);
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    },
    { part, word, offset },
  );
}

test.describe("composer word suggestion", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("the suggestion is spliced in before the text after the caret on its line", async ({ page, request }) => {
    const textarea = await openComposer(page, request);
    const before = `${WORD_LINE}\nThen `;
    const after = " the docs before the release.";
    await typePrefixBetween(textarea, before, after);

    const { suffix, prefix } = await expectSplicedSuggestion(
      textarea,
      before + PREFIX + after,
      before.length + PREFIX.length,
    );
    // Short line: the whole suffix stays on the caret's line, pushing " the docs" right.
    expect(suffix.rects).toHaveLength(1);
    await expectLinesAboveCaretUnchangedByEscape(textarea, prefix);
  });

  test("a suggestion reaching the right edge fills the caret's line, then wraps above the next line", async ({
    page,
    request,
  }) => {
    const textarea = await openComposer(page, request);
    // A line where " supercal" fits with room for a few more letters, but the whole word does not.
    const line = await textarea.evaluate(
      async (el: HTMLTextAreaElement, { prefix, word }: { prefix: string; word: string }) => {
        await document.fonts.ready;
        const style = getComputedStyle(el);
        const context = document.createElement("canvas").getContext("2d");
        if (!context) throw new Error("no canvas 2d context");
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        if (style.letterSpacing !== "normal") context.letterSpacing = style.letterSpacing;
        const width = (text: string) => context.measureText(text).width;
        const content =
          el.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
        const filler = "Make the import screen remember the last folder and keep the column order ".repeat(40);
        let result = "";
        for (let n = 1; n <= filler.length; n++) {
          const next = filler.slice(0, n).trimEnd();
          if (width(`${next} ${prefix}`) > content - 12) break;
          result = next;
        }
        if (width(`${result} ${word}`) <= content) throw new Error(`"${result} ${word}" fits in ${content}px`);
        return result;
      },
      { prefix: PREFIX, word: WORD },
    );
    const nextLine = "Next line here stays put.";
    const before = `${WORD_LINE}\n${line} `;
    const after = `\n${nextLine}`;
    await typePrefixBetween(textarea, before, after);

    const { snapshot, suffix } = await expectSplicedSuggestion(
      textarea,
      before + PREFIX + after,
      before.length + PREFIX.length,
      { needle: nextLine },
    );
    // Letters fill the caret's line (checked by the alignment above), the rest continues below.
    expect(suffix.rects.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.needleRects.length).toBeGreaterThan(0);
    const collisions = suffix.rects.flatMap((r) => snapshot.needleRects.filter((o) => overlaps(r, o)));
    expect(collisions).toEqual([]);
  });

  test("a suggestion at the end of a line between blank lines stays on the caret's line", async ({
    page,
    request,
  }) => {
    const textarea = await openComposer(page, request);
    const before = "First paragraph about the supercalifragilistic parser.\n\n\nThen ";
    const after = "\n\nLast line after a gap.";
    await typePrefixBetween(textarea, before, after);

    const { suffix } = await expectSplicedSuggestion(textarea, before + PREFIX + after, before.length + PREFIX.length);
    expect(suffix.rects).toHaveLength(1);
  });

  test("the suggestion stays aligned in a scrolled textarea", async ({ page, request }) => {
    const textarea = await openComposer(page, request);
    const filler = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of filler text.\n`).join("");
    const before = `${filler}${WORD_LINE}\nThen `;
    const after = " the docs before the release.\nOne more line.\nAnd another one.\nThe end.";
    await typePrefixBetween(textarea, before, after);

    const { suffix, prefix } = await expectSplicedSuggestion(
      textarea,
      before + PREFIX + after,
      before.length + PREFIX.length,
      { scrolled: true },
    );
    expect(suffix.rects).toHaveLength(1);
    await expectLinesAboveCaretUnchangedByEscape(textarea, prefix);
  });

  test("Escape hides the suggestion and shows the textarea's own text again", async ({ page, request }) => {
    const textarea = await openComposer(page, request);
    const before = `${WORD_LINE}\nThen `;
    const after = " the docs before the release.";
    await typePrefixBetween(textarea, before, after);
    await expectSplicedSuggestion(textarea, before + PREFIX + after, before.length + PREFIX.length);

    await textarea.press("Escape");
    await expect(page.locator(GHOST)).toHaveCount(0);
    await expect.poll(() => textarea.evaluate((el) => getComputedStyle(el).webkitTextFillColor)).not.toBe(TRANSPARENT);
    await expect(textarea).toHaveValue(before + PREFIX + after);
  });

  test("blur hides the suggestion and shows the textarea's own text again", async ({ page, request }) => {
    const textarea = await openComposer(page, request);
    const before = `${WORD_LINE}\nThen `;
    const after = " the docs before the release.";
    await typePrefixBetween(textarea, before, after);
    await expectSplicedSuggestion(textarea, before + PREFIX + after, before.length + PREFIX.length);

    await textarea.blur();
    await expect(page.locator(GHOST)).toHaveCount(0);
    await expect.poll(() => textarea.evaluate((el) => getComputedStyle(el).webkitTextFillColor)).not.toBe(TRANSPARENT);
    await expect(textarea).toHaveValue(before + PREFIX + after);
  });

  test("a click on the pushed text lands where it was aimed", async ({ page, request }) => {
    const textarea = await openComposer(page, request);
    const before = `${WORD_LINE}\nThen `;
    const after = " the docs before the release.";
    const value = before + PREFIX + after;
    const caret = before.length + PREFIX.length;
    await typePrefixBetween(textarea, before, after);
    await expectSplicedSuggestion(textarea, value, caret);

    // The left edge of the "c" in "docs", where the suffix pushed it: right before that "c" in the value.
    const c = await paintedCharRect(page, "after", "docs", 2);
    await page.mouse.click(c.left + 1, (c.top + c.bottom) / 2);
    await expect(page.locator(GHOST)).toHaveCount(0);
    await expect(textarea).toHaveValue(value);
    const aimed = value.indexOf("docs", caret) + 2;
    await expect
      .poll(() => textarea.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]))
      .toEqual([aimed, aimed]);
  });

  test("a click on the line above the caret dismisses the suggestion and places the caret natively", async ({
    page,
    request,
  }) => {
    const textarea = await openComposer(page, request);
    const before = `${WORD_LINE}\nThen `;
    const after = " the docs before the release.";
    const value = before + PREFIX + after;
    await typePrefixBetween(textarea, before, after);
    await expectSplicedSuggestion(textarea, value, before.length + PREFIX.length);

    const r = await paintedCharRect(page, "before", "reconcile", 0);
    await page.mouse.click(r.left + 1, (r.top + r.bottom) / 2);
    await expect(page.locator(GHOST)).toHaveCount(0);
    await expect(textarea).toHaveValue(value);
    const aimed = value.indexOf("reconcile");
    await expect
      .poll(() => textarea.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]))
      .toEqual([aimed, aimed]);
  });

  test("Tab inserts the suggested word at the caret", async ({ page, request }) => {
    const textarea = await openComposer(page, request);
    const before = `${WORD_LINE}\nThen `;
    const after = " the docs before the release.";
    await typePrefixBetween(textarea, before, after);
    const { suffix } = await expectSplicedSuggestion(textarea, before + PREFIX + after, before.length + PREFIX.length);

    await textarea.press("Tab");
    await expect(textarea).toHaveValue(before + PREFIX + suffix.text + after);
    await expect.poll(() => textarea.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(
      before.length + PREFIX.length + suffix.text.length,
    );
    await expect(page.locator(GHOST)).toHaveCount(0);
    await expect.poll(() => textarea.evaluate((el) => getComputedStyle(el).webkitTextFillColor)).not.toBe(TRANSPARENT);
  });
});
