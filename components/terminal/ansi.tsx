import { memo, type CSSProperties } from "react";

/** 0–15: the theme-aware 16-color palette below; a string: an exact CSS color (256-color or truecolor). */
type AnsiColor = number | string;

interface SgrState {
  fg: AnsiColor | null;
  bg: AnsiColor | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strike: boolean;
}

export interface AnsiSegment {
  text: string;
  className?: string;
  style?: CSSProperties;
}

export interface AnsiParseResult {
  segments: AnsiSegment[];
  /** SGR state at the end of the text, to continue parsing a following chunk. */
  state: SgrState;
}

const DEFAULT_SGR: SgrState = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
};

// Literal class strings (Tailwind scans them). Dark-on-light / light-on-dark variants keep "black" and
// "white" readable on both panel surfaces, like a terminal theme would.
const FG_CLASSES = [
  "text-zinc-800 dark:text-zinc-500",
  "text-red-600 dark:text-red-400",
  "text-green-700 dark:text-green-400",
  "text-amber-600 dark:text-yellow-300",
  "text-blue-600 dark:text-blue-400",
  "text-fuchsia-600 dark:text-fuchsia-400",
  "text-cyan-700 dark:text-cyan-400",
  "text-zinc-500 dark:text-zinc-200",
  "text-zinc-500 dark:text-zinc-400",
  "text-red-500 dark:text-red-300",
  "text-green-600 dark:text-green-300",
  "text-amber-500 dark:text-yellow-200",
  "text-blue-500 dark:text-blue-300",
  "text-fuchsia-500 dark:text-fuchsia-300",
  "text-cyan-600 dark:text-cyan-300",
  "text-zinc-400 dark:text-white",
];

const BG_CLASSES = [
  "bg-zinc-300 dark:bg-zinc-800",
  "bg-red-200 dark:bg-red-900/70",
  "bg-green-200 dark:bg-green-900/70",
  "bg-yellow-200 dark:bg-yellow-900/70",
  "bg-blue-200 dark:bg-blue-900/70",
  "bg-fuchsia-200 dark:bg-fuchsia-900/70",
  "bg-cyan-200 dark:bg-cyan-900/70",
  "bg-zinc-200 dark:bg-zinc-600",
  "bg-zinc-400 dark:bg-zinc-700",
  "bg-red-300 dark:bg-red-800",
  "bg-green-300 dark:bg-green-800",
  "bg-yellow-300 dark:bg-yellow-800",
  "bg-blue-300 dark:bg-blue-800",
  "bg-fuchsia-300 dark:bg-fuchsia-800",
  "bg-cyan-300 dark:bg-cyan-800",
  "bg-zinc-100 dark:bg-zinc-500",
];

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function color256(n: number): AnsiColor | null {
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  if (n < 16) return n;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v} ${v} ${v})`;
  }
  const i = n - 16;
  return `rgb(${CUBE_LEVELS[Math.floor(i / 36)]} ${CUBE_LEVELS[Math.floor(i / 6) % 6]} ${CUBE_LEVELS[i % 6]})`;
}

/**
 * Reads an extended color (`38;5;n`, `38;2;r;g;b`, or the colon forms `38:5:n` / `38:2::r:g:b`) whose
 * selector starts at `params[i]`; returns the color and how many params it consumed after the 38/48.
 */
function extendedColor(params: string[], i: number): { color: AnsiColor | null; used: number } {
  const mode = Number(params[i]);
  if (mode === 5) return { color: color256(Number(params[i + 1])), used: 2 };
  if (mode === 2) {
    const channels = params.slice(i + 1, i + 4).map(Number);
    const valid = channels.length === 3 && channels.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);
    return { color: valid ? `rgb(${channels.join(" ")})` : null, used: 4 };
  }
  return { color: null, used: 1 };
}

function applySgr(state: SgrState, raw: string): SgrState {
  const next = { ...state };
  const params = raw === "" ? ["0"] : raw.split(";");
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    if (param.includes(":")) {
      // Colon sub-params: `38:2::r:g:b` (with an empty color-space id) or `38:2:r:g:b`, `38:5:n`.
      const sub = param.split(":");
      const target = Number(sub[0]);
      if (target === 38 || target === 48) {
        const values = sub[1] === "2" && sub.length >= 6 ? ["2", ...sub.slice(-3)] : sub.slice(1);
        const { color } = extendedColor(values, 0);
        if (target === 38) next.fg = color;
        else next.bg = color;
      } else if (target === 4) {
        next.underline = sub[1] !== "0";
      }
      continue;
    }
    const code = param === "" ? 0 : Number(param);
    if (code === 0) Object.assign(next, DEFAULT_SGR);
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 9) next.strike = true;
    else if (code === 21 || code === 22) next.bold = next.dim = false;
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code === 29) next.strike = false;
    else if (code >= 30 && code <= 37) next.fg = code - 30;
    else if (code === 39) next.fg = null;
    else if (code >= 40 && code <= 47) next.bg = code - 40;
    else if (code === 49) next.bg = null;
    else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
    else if (code >= 100 && code <= 107) next.bg = code - 100 + 8;
    else if (code === 38 || code === 48) {
      const { color, used } = extendedColor(params, i + 1);
      if (code === 38) next.fg = color;
      else next.bg = color;
      i += used;
    }
  }
  return next;
}

function segmentStyle(state: SgrState): Pick<AnsiSegment, "className" | "style"> {
  const { fg: rawFg, bg: rawBg, bold, dim, italic, underline, inverse, strike } = state;
  if (rawFg === null && rawBg === null && !bold && !dim && !italic && !underline && !inverse && !strike) return {};
  let fg = rawFg;
  let bg = rawBg;
  const classes: string[] = [];
  if (inverse) {
    [fg, bg] = [bg, fg];
    // Swapping a default color: approximate it with the theme's own foreground/background.
    if (fg === null) classes.push("text-background");
    if (bg === null) classes.push("bg-foreground");
  }
  const style: CSSProperties = {};
  if (typeof fg === "number") classes.push(FG_CLASSES[fg]);
  else if (fg) style.color = fg;
  if (typeof bg === "number") classes.push(BG_CLASSES[bg]);
  else if (bg) style.backgroundColor = bg;
  if (bold) classes.push("font-bold");
  if (dim) classes.push("opacity-60");
  if (italic) classes.push("italic");
  if (underline) classes.push("underline underline-offset-2");
  if (strike) classes.push("line-through");
  return {
    className: classes.length > 0 ? classes.join(" ") : undefined,
    style: style.color || style.backgroundColor ? style : undefined,
  };
}

/** C0 controls other than \t and \n, DEL, and ESC: everything the plain-text fast path stops at. */
const SPECIAL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * Parses terminal output into styled segments: SGR codes become classes/styles, every other CSI, OSC,
 * DCS/APC/PM/SOS and two-char escape is dropped, `\r\n` is a newline and a bare `\r` returns to the
 * start of the line (later text replaces it), `\b` deletes a character. An escape cut off at the end of
 * `text` (a split chunk) is hidden until the rest arrives, as is a trailing `\r` (maybe half a `\r\n`).
 */
export function parseAnsi(text: string, initial: SgrState = DEFAULT_SGR): AnsiParseResult {
  const segments: AnsiSegment[] = [];
  let state = initial;
  let current = segmentStyle(state);
  let buffer = "";

  const flush = () => {
    if (!buffer) return;
    const last = segments[segments.length - 1];
    if (last && last.className === current.className && last.style === current.style) last.text += buffer;
    else segments.push({ text: buffer, ...current });
    buffer = "";
  };

  /** Bare `\r`: drop what was written since the last newline (in the buffer and in earlier segments). */
  const carriageReturn = () => {
    const nl = buffer.lastIndexOf("\n");
    if (nl >= 0) {
      buffer = buffer.slice(0, nl + 1);
      return;
    }
    buffer = "";
    while (segments.length > 0) {
      const last = segments[segments.length - 1];
      const idx = last.text.lastIndexOf("\n");
      if (idx >= 0) {
        last.text = last.text.slice(0, idx + 1);
        return;
      }
      segments.pop();
    }
  };

  const backspace = () => {
    if (buffer) {
      if (!buffer.endsWith("\n")) buffer = buffer.slice(0, -1);
      return;
    }
    const last = segments[segments.length - 1];
    if (!last || last.text.endsWith("\n")) return;
    last.text = last.text.slice(0, -1);
    if (!last.text) segments.pop();
  };

  let pos = 0;
  const len = text.length;
  while (pos < len) {
    SPECIAL.lastIndex = pos;
    const match = SPECIAL.exec(text);
    const at = match ? match.index : len;
    if (at > pos) buffer += text.slice(pos, at);
    if (!match) break;
    const ch = text[at];
    pos = at + 1;

    if (ch === "\r") {
      // `\r\n` (also `\r\r\n`) is a newline; a trailing `\r` may be half of one split across chunks.
      let next = pos;
      while (text[next] === "\r") next++;
      if (text[next] === "\n") {
        pos = next;
        continue;
      }
      if (next < len) carriageReturn();
      continue;
    }
    if (ch === "\b") {
      backspace();
      continue;
    }
    if (ch !== "\x1b") continue; // Bell and other controls: invisible.

    const kind = text[pos];
    if (kind === undefined) break; // Lone ESC at the end: wait for the rest.
    if (kind === "[") {
      // CSI: parameter bytes 0x30–0x3F, intermediate bytes 0x20–0x2F, one final byte 0x40–0x7E.
      let end = pos + 1;
      while (end < len && text.charCodeAt(end) >= 0x20 && text.charCodeAt(end) <= 0x3f) end++;
      if (end >= len) {
        pos = len;
        break;
      }
      const final = text.charCodeAt(end);
      if (final < 0x40 || final > 0x7e) {
        // Malformed: drop the introducer and show the rest as text.
        pos = end;
        continue;
      }
      if (final === 0x6d) {
        const params = text.slice(pos + 1, end);
        // Private-mode SGR-like sequences (e.g. `ESC[>4;2m`) are not colors.
        if (!/^[<=>?]/.test(params)) {
          flush();
          state = applySgr(state, params);
          current = segmentStyle(state);
        }
      }
      pos = end + 1;
      continue;
    }
    if (kind === "]" || kind === "P" || kind === "_" || kind === "^" || kind === "X") {
      // String sequences end with BEL or ST (ESC \).
      let end = pos + 1;
      while (end < len && text[end] !== "\x07" && !(text[end] === "\x1b" && text[end + 1] === "\\")) end++;
      if (end >= len) {
        pos = len;
        break;
      }
      pos = text[end] === "\x07" ? end + 1 : end + 2;
      continue;
    }
    // Two-char (or charset `ESC ( B`) escapes: intermediates 0x20–0x2F, then one final byte.
    let end = pos;
    while (end < len && text.charCodeAt(end) >= 0x20 && text.charCodeAt(end) <= 0x2f) end++;
    pos = Math.min(end + 1, len);
  }
  flush();
  return { segments, state };
}

/** A stretch of a block's output. Runs are immutable; only a block's last run is ever replaced. */
export interface OutputRun {
  text: string;
}

/**
 * Parse results per run object. A run's parse depends only on the runs before it, which never change
 * once a later run exists, so a streaming block only re-parses its last run on each update.
 */
const parsedRuns = new WeakMap<OutputRun, AnsiParseResult>();

/** Parses a block's runs, carrying the SGR state from each run into the next. */
export function parseRuns(runs: readonly OutputRun[]): AnsiParseResult[] {
  let state = DEFAULT_SGR;
  return runs.map((run) => {
    let parsed = parsedRuns.get(run);
    if (!parsed) {
      parsed = parseAnsi(run.text, state);
      parsedRuns.set(run, parsed);
    }
    state = parsed.state;
    return parsed;
  });
}

/** Visible text of a block's output (escapes and overwritten text removed), for copying. */
export function runsToPlain(runs: readonly OutputRun[]): string {
  return parseRuns(runs)
    .flatMap((parsed) => parsed.segments.map((segment) => segment.text))
    .join("");
}

/** Styled spans for parsed segments; unstyled text renders as bare text nodes. */
export const AnsiSegments = memo(function AnsiSegments({ segments }: { segments: AnsiSegment[] }) {
  return (
    <>
      {segments.map((segment, i) =>
        segment.className || segment.style ? (
          <span key={i} className={segment.className} style={segment.style}>
            {segment.text}
          </span>
        ) : (
          segment.text
        ),
      )}
    </>
  );
});
