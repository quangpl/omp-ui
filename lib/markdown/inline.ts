/**
 * Inline GitHub-flavoured markdown: a pure parser for the safe subset rendered by
 * `components/board/rich-text.tsx` (no raw HTML, no reference links). It runs in
 * roughly linear time and never throws, so partial streaming text is fine.
 */

/** One inline node. Adjacent text nodes are always merged. */
export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: MdInline[] }
  | { kind: "em"; children: MdInline[] }
  | { kind: "strike"; children: MdInline[] }
  | { kind: "image"; alt: string; url: string }
  | { kind: "link"; url: string; children: MdInline[] }
  | { kind: "url"; url: string };

/** Allowed link/image target: http://, https://, mailto: (links only) or a path starting with /api/v1/. Anything else (javascript:, data:, relative) is not a link: the source stays literal text. */
export function isSafeUrl(url: string, kind: "link" | "image"): boolean {
  if (/^https?:\/\//i.test(url) || url.startsWith("/api/v1/")) return true;
  return kind === "link" && /^mailto:/i.test(url);
}

/** Inline nodes of `text` (CRLF normalised; backslash escapes resolved). */
export function parseInline(text: string): MdInline[] {
  return new InlineParser(text.replace(/\r\n?/g, "\n")).parse();
}

/** Characters that may start an inline construct; everything else is plain text. */
const SPECIAL: Record<string, true> = {
  "\\": true,
  "`": true,
  "<": true,
  "!": true,
  "[": true,
  "]": true,
  "*": true,
  _: true,
  "~": true,
  h: true,
  H: true,
  "/": true,
};
const AUTOLINK = /<((?:https?|mailto):[^\s<>]*)>/iy;
const URL_SCHEME = /https?:\/\//iy;
const APP_FILE_PREFIX = /\/api\/v1\/(?:tasks|boards)\/[A-Za-z0-9_-]+\/files\//y;
const ESCAPED = /\\([!-\/:-@\[-`{-~])/g;
/** Trimmed from the end of bare URLs; `)` is trimmed only when unbalanced. */
const URL_TRAILING: Record<string, true> = {
  ".": true,
  ",": true,
  ";": true,
  ":": true,
  "!": true,
  "?": true,
  "'": true,
  '"': true,
  "]": true,
  "*": true,
  _: true,
  "~": true,
};
const WHITESPACE = /\s/;
const PUNCTUATION = new RegExp("[\\p{P}\\p{S}]", "u");
/** Bounds the `(destination "title")` scan after every `]`, keeping `[](`-style input linear. */
const MAX_LINK_TAIL = 4096;
const MAX_PAREN_DEPTH = 32;
const MAX_UNLINK_DEPTH = 256;

/** A node of the token list: literal text (`node` null) or a finished inline node. */
interface Tok {
  text: string;
  node: MdInline | null;
  prev: Tok | null;
  next: Tok | null;
}

/** An emphasis delimiter run (`*`, `_`, `~~`) whose token text is its unused characters. */
interface Delim {
  tok: Tok;
  char: string;
  count: number;
  orig: number;
  canOpen: boolean;
  canClose: boolean;
  prev: Delim | null;
  next: Delim | null;
}

/** An unresolved `[` or `![`. */
interface Bracket {
  tok: Tok;
  image: boolean;
  /** Links closed before this bracket opened: any later link is nested inside it, which deactivates a `[`. */
  linkCount: number;
  /** Delimiter on top of the stack when the bracket opened; emphasis inside the brackets stays above it. */
  bottom: Delim | null;
}

function isAsciiPunct(code: number): boolean {
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

function isAlnum(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function skipSpace(s: string, at: number): number {
  let i = at;
  while (s[i] === " " || s[i] === "\t" || s[i] === "\n") i++;
  return i;
}

/** Parses `(destination "optional title")` starting at the `(`; null when it is not a valid link tail. */
function parseLinkTail(s: string, open: number): { url: string; end: number } | null {
  const limit = Math.min(s.length, open + MAX_LINK_TAIL);
  let at = skipSpace(s, open + 1);
  let url: string;
  if (s[at] === "<") {
    let r = at + 1;
    while (r < limit && s[r] !== ">") {
      if (s[r] === "\n" || s[r] === "<") return null;
      r += s[r] === "\\" ? 2 : 1;
    }
    if (r >= limit) return null;
    url = s.slice(at + 1, r).replace(ESCAPED, "$1");
    at = r + 1;
  } else {
    let r = at;
    let depth = 0;
    while (r < limit) {
      const code = s.charCodeAt(r);
      if (code <= 0x20 || code === 0x7f) break;
      if (code === 0x5c && isAsciiPunct(s.charCodeAt(r + 1))) {
        r += 2;
        continue;
      }
      if (code === 0x28) {
        if (++depth > MAX_PAREN_DEPTH) return null;
      } else if (code === 0x29) {
        if (depth === 0) break;
        depth--;
      }
      r++;
    }
    if (depth !== 0 || r === at || r >= limit) return null;
    url = s.slice(at, r).replace(ESCAPED, "$1");
    at = r;
  }
  const afterUrl = at;
  at = skipSpace(s, at);
  const quote = s[at];
  if (at > afterUrl && (quote === '"' || quote === "'" || quote === "(")) {
    const close = quote === "(" ? ")" : quote;
    let r = at + 1;
    while (r < limit && s[r] !== close) r += s[r] === "\\" ? 2 : 1;
    if (r >= limit) return null;
    at = skipSpace(s, r + 1);
  }
  if (at >= limit || s[at] !== ")") return null;
  return { url, end: at + 1 };
}

/** Appends `node`, merging it into a preceding text node. */
function append(out: MdInline[], node: MdInline) {
  const last = out[out.length - 1];
  if (node.kind === "text" && last?.kind === "text") out[out.length - 1] = { kind: "text", text: last.text + node.text };
  else if (node.kind !== "text" || node.text) out.push(node);
}

/** Inline nodes of the token list from `from` up to (excluding) `until`. */
function collect(from: Tok | null, until: Tok | null): MdInline[] {
  const out: MdInline[] = [];
  for (let tok = from; tok && tok !== until; tok = tok.next) {
    append(out, tok.node ?? { kind: "text", text: tok.text });
  }
  return out;
}

/** Link text cannot hold links: nested links and bare URLs become their text. */
function unlink(nodes: MdInline[], depth: number): MdInline[] {
  if (depth > MAX_UNLINK_DEPTH) return nodes;
  const out: MdInline[] = [];
  for (const node of nodes) {
    switch (node.kind) {
      case "url":
        append(out, { kind: "text", text: node.url });
        break;
      case "link":
        for (const child of unlink(node.children, depth + 1)) append(out, child);
        break;
      case "strong":
      case "em":
      case "strike":
        out.push({ kind: node.kind, children: unlink(node.children, depth + 1) });
        break;
      default:
        append(out, node);
    }
  }
  return out;
}

/** Plain text of inline nodes (image alt text); iterative so deep nesting cannot overflow. */
function plainText(nodes: MdInline[]): string {
  let out = "";
  const stack = nodes.slice().reverse();
  for (let node = stack.pop(); node; node = stack.pop()) {
    switch (node.kind) {
      case "text":
      case "code":
        out += node.text;
        break;
      case "url":
        out += node.url;
        break;
      case "image":
        out += node.alt;
        break;
      default:
        for (let k = node.children.length - 1; k >= 0; k--) stack.push(node.children[k]);
    }
  }
  return out;
}

/** CommonMark's opener/closer compatibility, including the "multiple of 3" rule; `~~` pairs only with `~~`. */
function canPair(opener: Delim, closer: Delim): boolean {
  if (opener.char !== closer.char || !opener.canOpen) return false;
  if (opener.char === "~") return opener.count === closer.count;
  return !((opener.canClose || closer.canOpen) && closer.orig % 3 !== 0 && (opener.orig + closer.orig) % 3 === 0);
}

/**
 * Single left-to-right scan into a token list plus delimiter and bracket stacks,
 * resolved with CommonMark's "process emphasis" / "look for link" procedures.
 */
class InlineParser {
  private readonly s: string;
  private readonly head: Tok = { text: "", node: null, prev: null, next: null };
  private tail: Tok = this.head;
  private delimTop: Delim | null = null;
  private readonly brackets: Bracket[] = [];
  private linkCount = 0;
  private buf = "";
  /** Start offsets of every maximal backtick run, by run length (built on first use). */
  private tickRuns: Map<number, number[]> | null = null;
  private readonly tickCursor = new Map<number, number>();

  constructor(s: string) {
    this.s = s;
  }

  parse(): MdInline[] {
    const s = this.s;
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (!SPECIAL[ch]) {
        let j = i + 1;
        while (j < s.length && !SPECIAL[s[j]]) j++;
        this.buf += s.slice(i, j);
        i = j;
        continue;
      }
      switch (ch) {
        case "\\":
          i = this.escape(i);
          break;
        case "`":
          i = this.codeSpan(i);
          break;
        case "<":
          i = this.autolink(i);
          break;
        case "!":
          if (s[i + 1] === "[") {
            this.openBracket("![", true);
            i += 2;
          } else {
            this.buf += ch;
            i += 1;
          }
          break;
        case "[":
          this.openBracket("[", false);
          i += 1;
          break;
        case "]":
          i = this.closeBracket(i);
          break;
        case "h":
        case "H":
          i = this.bareUrl(i);
          break;
        case "/":
          i = this.appFile(i);
          break;
        default:
          i = this.delimRun(i);
      }
    }
    this.flush();
    this.processEmphasis(null);
    return collect(this.head.next, null);
  }

  private append(text: string, node: MdInline | null): Tok {
    const tok: Tok = { text, node, prev: this.tail, next: null };
    this.tail.next = tok;
    this.tail = tok;
    return tok;
  }

  private flush() {
    if (!this.buf) return;
    this.append(this.buf, null);
    this.buf = "";
  }

  private pushNode(node: MdInline) {
    this.flush();
    this.append("", node);
  }

  private removeTok(tok: Tok) {
    if (tok.prev) tok.prev.next = tok.next;
    if (tok.next) tok.next.prev = tok.prev;
    else this.tail = tok.prev ?? this.head;
  }

  private removeDelim(delim: Delim) {
    if (delim.prev) delim.prev.next = delim.next;
    if (delim.next) delim.next.prev = delim.prev;
    else this.delimTop = delim.prev;
  }

  private escape(i: number): number {
    if (isAsciiPunct(this.s.charCodeAt(i + 1))) {
      this.buf += this.s[i + 1];
      return i + 2;
    }
    this.buf += "\\";
    return i + 1;
  }

  private codeSpan(i: number): number {
    const s = this.s;
    let j = i;
    while (s[j] === "`") j++;
    const close = this.closingTicks(j - i, j);
    if (close < 0) {
      this.buf += s.slice(i, j);
      return j;
    }
    let text = s.slice(j, close).replace(/\n/g, " ");
    if (text.length > 2 && text[0] === " " && text[text.length - 1] === " " && /[^ ]/.test(text)) {
      text = text.slice(1, -1);
    }
    this.pushNode({ kind: "code", text });
    return close + (j - i);
  }

  /** Start of the first backtick run of exactly `length` at or after `from`, or -1. */
  private closingTicks(length: number, from: number): number {
    if (!this.tickRuns) {
      const runs = new Map<number, number[]>();
      const s = this.s;
      for (let k = s.indexOf("`"); k >= 0; k = s.indexOf("`", k)) {
        let e = k;
        while (s[e] === "`") e++;
        const list = runs.get(e - k);
        if (list) list.push(k);
        else runs.set(e - k, [k]);
        k = e;
      }
      this.tickRuns = runs;
    }
    const list = this.tickRuns.get(length);
    if (!list) return -1;
    // Openers arrive in increasing order, so each length's cursor only moves forward.
    let cursor = this.tickCursor.get(length) ?? 0;
    while (cursor < list.length && list[cursor] < from) cursor++;
    this.tickCursor.set(length, cursor);
    return cursor < list.length ? list[cursor] : -1;
  }

  private autolink(i: number): number {
    AUTOLINK.lastIndex = i;
    const match = AUTOLINK.exec(this.s);
    if (match && isSafeUrl(match[1], "link")) {
      this.pushNode({ kind: "link", url: match[1], children: [{ kind: "text", text: match[1] }] });
      return i + match[0].length;
    }
    this.buf += "<";
    return i + 1;
  }

  private openBracket(text: string, image: boolean) {
    this.flush();
    const tok = this.append(text, null);
    this.brackets.push({ tok, image, linkCount: this.linkCount, bottom: this.delimTop });
  }

  private closeBracket(i: number): number {
    const opener = this.brackets.pop();
    const active = opener !== undefined && (opener.image || opener.linkCount === this.linkCount);
    const tail = active && this.s[i + 1] === "(" ? parseLinkTail(this.s, i + 1) : null;
    if (!opener || !tail || !isSafeUrl(tail.url, opener.image ? "image" : "link")) {
      this.buf += "]";
      return i + 1;
    }
    this.flush();
    this.processEmphasis(opener.bottom);
    const children = collect(opener.tok.next, null);
    const tok = opener.tok;
    tok.next = null;
    tok.text = "";
    this.tail = tok;
    if (opener.image) {
      tok.node = { kind: "image", alt: plainText(children), url: tail.url };
    } else {
      tok.node = { kind: "link", url: tail.url, children: unlink(children, 0) };
      this.linkCount++;
    }
    return tail.end;
  }

  /** End of a bare URL whose scheme/prefix ends at `start`, trailing punctuation trimmed; -1 when empty. */
  private urlEnd(start: number): number {
    const s = this.s;
    const stopAtBracket = this.brackets.length > 0;
    let end = start;
    let open = 0;
    let close = 0;
    while (end < s.length) {
      const c = s[end];
      if (c === "<" || c === ">" || (c === "]" && stopAtBracket) || WHITESPACE.test(c)) break;
      if (c === "(") open++;
      else if (c === ")") close++;
      end++;
    }
    while (end > start) {
      const c = s[end - 1];
      if (URL_TRAILING[c]) end--;
      else if (c === ")" && close > open) {
        close--;
        end--;
      } else break;
    }
    return end > start ? end : -1;
  }

  private bareUrl(i: number): number {
    if (!isAlnum(this.s.charCodeAt(i - 1))) {
      URL_SCHEME.lastIndex = i;
      if (URL_SCHEME.test(this.s)) {
        const end = this.urlEnd(URL_SCHEME.lastIndex);
        if (end > 0) {
          this.pushNode({ kind: "url", url: this.s.slice(i, end) });
          return end;
        }
      }
    }
    this.buf += this.s[i];
    return i + 1;
  }

  private appFile(i: number): number {
    const prev = this.s.charCodeAt(i - 1);
    if (!isAlnum(prev) && prev !== 0x5f && prev !== 0x2f && prev !== 0x2e) {
      APP_FILE_PREFIX.lastIndex = i;
      if (APP_FILE_PREFIX.test(this.s)) {
        const end = this.urlEnd(APP_FILE_PREFIX.lastIndex);
        if (end > 0) {
          this.pushNode({ kind: "url", url: this.s.slice(i, end) });
          return end;
        }
      }
    }
    this.buf += "/";
    return i + 1;
  }

  private delimRun(i: number): number {
    const s = this.s;
    const char = s[i];
    let j = i;
    while (s[j] === char) j++;
    const run = s.slice(i, j);
    // Start and end of text count as whitespace for flanking.
    const before = i > 0 ? s[i - 1] : " ";
    const after = j < s.length ? s[j] : " ";
    const spaceBefore = WHITESPACE.test(before);
    const spaceAfter = WHITESPACE.test(after);
    const punctBefore = PUNCTUATION.test(before);
    const punctAfter = PUNCTUATION.test(after);
    const left = !spaceAfter && (!punctAfter || spaceBefore || punctBefore);
    const right = !spaceBefore && (!punctBefore || spaceAfter || punctAfter);
    let canOpen = left;
    let canClose = right;
    if (char === "_") {
      // No intraword underscore emphasis: snake_case_name stays text.
      canOpen = left && (!right || punctBefore);
      canClose = right && (!left || punctAfter);
    } else if (char === "~" && run.length !== 2) {
      canOpen = false;
      canClose = false;
    }
    if (!canOpen && !canClose) {
      this.buf += run;
      return j;
    }
    this.flush();
    const delim: Delim = {
      tok: this.append(run, null),
      char,
      count: run.length,
      orig: run.length,
      canOpen,
      canClose,
      prev: this.delimTop,
      next: null,
    };
    if (this.delimTop) this.delimTop.next = delim;
    this.delimTop = delim;
    return j;
  }

  /** Pairs the delimiters above `bottom` into emphasis nodes, then drops them from the stack. */
  private processEmphasis(bottom: Delim | null) {
    let closer = this.delimTop === bottom ? null : this.delimTop;
    while (closer && closer.prev !== bottom) closer = closer.prev;
    // Per closer kind, the delimiter below which no opener can match (keeps this linear).
    const openersBottom = new Map<string, Delim | null>();
    while (closer) {
      if (!closer.canClose) {
        closer = closer.next;
        continue;
      }
      const key = `${closer.char}${closer.canOpen ? 1 : 0}${closer.orig % 3}`;
      const stored = openersBottom.get(key);
      const floor = stored === undefined ? bottom : stored;
      let opener = closer.prev;
      while (opener && opener !== bottom && opener !== floor && !canPair(opener, closer)) opener = opener.prev;
      if (opener && opener !== bottom && opener !== floor) {
        const use = closer.char === "~" || (opener.count >= 2 && closer.count >= 2) ? 2 : 1;
        opener.count -= use;
        closer.count -= use;
        opener.tok.text = opener.char.repeat(opener.count);
        closer.tok.text = closer.char.repeat(closer.count);
        const kind = closer.char === "~" ? "strike" : use === 2 ? "strong" : "em";
        const tok: Tok = {
          text: "",
          node: { kind, children: collect(opener.tok.next, closer.tok) },
          prev: opener.tok,
          next: closer.tok,
        };
        opener.tok.next = tok;
        closer.tok.prev = tok;
        // Delimiters between the pair can no longer match anything.
        opener.next = closer;
        closer.prev = opener;
        if (opener.count === 0) {
          this.removeTok(opener.tok);
          this.removeDelim(opener);
        }
        if (closer.count === 0) {
          const next = closer.next;
          this.removeTok(closer.tok);
          this.removeDelim(closer);
          closer = next;
        }
      } else {
        openersBottom.set(key, closer.prev);
        const next = closer.next;
        if (!closer.canOpen) this.removeDelim(closer);
        closer = next;
      }
    }
    while (this.delimTop && this.delimTop !== bottom) this.removeDelim(this.delimTop);
  }
}
