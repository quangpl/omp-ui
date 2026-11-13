// Word-level completion for the composers, mirroring the OMP CLI prompt editor: while a prose word
// is being typed, the rest of the most likely word shows as dim ghost text after the caret and
// Tab / ArrowRight accepts it. Suggestions come from an n-gram model (unigrams + bigrams on the
// previous word) learned from the user's past prompts, plus words already typed in the draft.
// The prose gate keeps it out of paths, URLs, identifiers, slash commands and code. Pure string
// logic, isomorphic: the server builds the model data, the client looks it up per keystroke.

/** Serialized corpus model sent by the server. Keys lowercase. */
export interface WordModelData {
  /** Unigram counts, most frequent first. */
  words: [word: string, count: number][];
  /** Previous word → following words, most frequent first. */
  bigrams: [previous: string, next: [word: string, count: number][]][];
}

/** The word being typed at the caret: `text.slice(start, end) === prefix`, `end === caret`. `previous` is the lowercase previous word in the same sentence/line, or null. */
export interface WordQuery {
  start: number;
  end: number;
  prefix: string;
  previous: string | null;
}

/** Lookup-optimized model; build with `wordModelFromData`. */
export interface WordModel {
  /** Candidate words sorted by code unit, for binary-search prefix ranges. */
  readonly sorted: readonly string[];
  readonly counts: ReadonlyMap<string, number>;
  readonly bigrams: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

/** No suggestion for shorter prefixes. */
export const MIN_WORD_PREFIX = 2;
// Shorter words are never worth completing; they still count as bigram heads ("a", "to").
const MIN_CANDIDATE_LENGTH = 3;
// Same cap as OMP: huge pastes are not prose being typed, and scanning them per keystroke is wasted work.
const MAX_TEXT_LENGTH = 20_000;
// Below this many distinct words the corpus is too young for count pruning to mean anything.
const SMALL_CORPUS_WORDS = 200;

const PREFIX_AT_CARET = /[\p{L}\p{M}']+$/u;
const LETTER_AT_CARET = /^[\p{L}\p{M}']/u;
// Path / URL / email / identifier / markup characters, digits, or a camelCase hump mark a chunk as non-prose.
const NON_PROSE = /[\\/@_=:{}[\]<>]|\p{N}|\p{Ll}\p{Lu}/u;
// Two words form a bigram only when the gap between them holds no other word, code, sentence
// punctuation or line break ("well-known", "this, that" link; "done. next" does not).
const LINKING_GAP = /^[^\p{L}\p{M}\p{N}.!?;:\r\n`]*$/u;
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;

type Range = [start: number, end: number];

interface Token {
  word: string;
  start: number;
  end: number;
}

/** The completable word ending at `caret`, or null when the OMP prose gate rejects the position. */
export function wordCompletionQuery(text: string, caret: number): WordQuery | null {
  if (text.length > MAX_TEXT_LENGTH || caret < 0 || caret > text.length) return null;
  if (text.trimStart().startsWith("/")) return null;

  const before = text.slice(0, caret);
  const match = PREFIX_AT_CARET.exec(before);
  if (!match) return null;
  // Mid-word: completing would splice letters into an existing word.
  if (LETTER_AT_CARET.test(text.slice(caret, caret + 2))) return null;

  // Opening quotes ('like this) are not part of the word.
  const prefix = match[0].replace(/^'+/, "");
  if (prefix.length < MIN_WORD_PREFIX) return null;
  const start = caret - prefix.length;

  const tokenStart = before.search(/\S*$/);
  const tokenEnd = caret + (/^\S*/.exec(text.slice(caret))?.[0].length ?? 0);
  if (!isProseChunk(text.slice(tokenStart, tokenEnd))) return null;

  // Only text up to the caret matters: an unclosed span or fence there means we are typing code.
  if (codeRanges(before).some(([from, to]) => from < caret && to > start)) return null;

  // Fences can't open mid-line and inline spans never cross lines, so the line alone is enough.
  const lineStart = before.lastIndexOf("\n", start - 1) + 1;
  const line = before.slice(lineStart, start);
  const tokens = tokenize(line);
  const last = tokens[tokens.length - 1];
  const previous = last && LINKING_GAP.test(line.slice(last.end)) ? last.word : null;

  return { start, end: caret, prefix, previous };
}

/** Counts prose unigrams and bigrams across `texts` and keeps the most frequent. */
export function buildWordModelData(
  texts: Iterable<string>,
  limits: { maxWords?: number; maxBigramHeads?: number; maxBigramTails?: number } = {},
): WordModelData {
  const { maxWords = 6000, maxBigramHeads = 3000, maxBigramTails = 8 } = limits;
  const unigrams = new Map<string, number>();
  const bigrams = new Map<string, Map<string, number>>();

  for (const raw of texts) {
    const text = raw.length > MAX_TEXT_LENGTH ? raw.slice(0, MAX_TEXT_LENGTH) : raw;
    let previous: Token | undefined;
    for (const token of tokenize(text)) {
      if (token.word.length >= MIN_CANDIDATE_LENGTH) {
        unigrams.set(token.word, (unigrams.get(token.word) ?? 0) + 1);
        if (previous && LINKING_GAP.test(text.slice(previous.end, token.start))) {
          let tails = bigrams.get(previous.word);
          if (!tails) bigrams.set(previous.word, (tails = new Map()));
          tails.set(token.word, (tails.get(token.word) ?? 0) + 1);
        }
      }
      previous = token;
    }
  }

  // One-off words and pairs in a large corpus are mostly typos and noise.
  const minCount = unigrams.size > SMALL_CORPUS_WORDS ? 2 : 1;
  const words = [...unigrams].filter(([, count]) => count >= minCount).sort(byCount).slice(0, maxWords);

  // Heads rank by how often anything follows them, so the most-used contexts survive the cap.
  const tailsByHead = new Map<string, [string, number][]>();
  const totals: [string, number][] = [];
  for (const [head, tails] of bigrams) {
    const kept = [...tails].filter(([, count]) => count >= minCount).sort(byCount);
    if (kept.length === 0) continue;
    tailsByHead.set(head, kept.slice(0, maxBigramTails));
    totals.push([head, kept.reduce((sum, [, count]) => sum + count, 0)]);
  }
  const heads = totals.sort(byCount).slice(0, maxBigramHeads);

  return {
    words,
    bigrams: heads.map(([head]): [string, [string, number][]] => [head, tailsByHead.get(head) ?? []]),
  };
}

/** Builds the lookup structures for `suggestWord`; null gives an empty model (draft words still complete). */
export function wordModelFromData(data: WordModelData | null): WordModel {
  const counts = new Map<string, number>();
  const bigrams = new Map<string, Map<string, number>>();
  for (const [word, count] of data?.words ?? []) counts.set(word, count);
  for (const [head, tails] of data?.bigrams ?? []) bigrams.set(head, new Map(tails));
  const sorted = [...counts.keys()].sort(compareText);
  return { sorted, counts, bigrams };
}

/** Suffix to append after `query.prefix`, or null when no known word extends it. */
export function suggestWord(model: WordModel, text: string, query: WordQuery): string | null {
  const prefix = query.prefix.toLowerCase();
  const isCandidate = (word: string) =>
    word.length > prefix.length && word.length >= MIN_CANDIDATE_LENGTH && word.startsWith(prefix);

  // Words typed elsewhere in the draft complete too, so a term introduced once can be reused at once.
  const local = new Map<string, number>();
  const draft = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
  for (const token of tokenize(draft)) {
    if (token.start < query.end && token.end > query.start) continue;
    if (isCandidate(token.word)) local.set(token.word, (local.get(token.word) ?? 0) + 1);
  }

  const following = query.previous === null ? undefined : model.bigrams.get(query.previous);
  const candidates = new Set<string>(local.keys());
  for (let i = lowerBound(model.sorted, prefix); i < model.sorted.length; i++) {
    const word = model.sorted[i];
    if (!word.startsWith(prefix)) break;
    if (isCandidate(word)) candidates.add(word);
  }
  if (following) for (const word of following.keys()) if (isCandidate(word)) candidates.add(word);

  let best: string | null = null;
  let bestScore = 0;
  let bestUnigram = 0;
  for (const word of candidates) {
    const unigram = model.counts.get(word) ?? 0;
    const score = (following?.get(word) ?? 0) * 10 + unigram + (local.get(word) ?? 0) * 3;
    const better =
      best === null ||
      score > bestScore ||
      (score === bestScore &&
        (unigram > bestUnigram ||
          (unigram === bestUnigram &&
            (word.length < best.length || (word.length === best.length && word < best)))));
    if (better) {
      best = word;
      bestScore = score;
      bestUnigram = unigram;
    }
  }
  if (best === null) return null;

  const suffix = best.slice(prefix.length);
  const shouting = query.prefix.length >= 2 && query.prefix === query.prefix.toUpperCase() && query.prefix !== prefix;
  return shouting ? suffix.toUpperCase() : suffix;
}

/** Prose words in `text`, lowercase, skipping code and non-prose chunks (paths, URLs, identifiers). */
function tokenize(text: string): Token[] {
  const ranges = codeRanges(text);
  const tokens: Token[] = [];
  let range = 0;
  const chunks = /\S+/g;
  let chunk: RegExpExecArray | null;
  while ((chunk = chunks.exec(text))) {
    if (!isProseChunk(chunk[0])) continue;
    const words = /[\p{L}\p{M}']+/gu;
    let match: RegExpExecArray | null;
    while ((match = words.exec(chunk[0]))) {
      const word = match[0].replace(/^'+/, "");
      const lead = match[0].length - word.length;
      const trimmed = word.replace(/'+$/, "");
      if (!trimmed) continue;
      const start = chunk.index + match.index + lead;
      const end = start + trimmed.length;
      while (range < ranges.length && ranges[range][1] <= start) range++;
      if (range < ranges.length && ranges[range][0] < end) continue;
      tokens.push({ word: trimmed.toLowerCase(), start, end });
    }
  }
  return tokens;
}

function isProseChunk(chunk: string): boolean {
  // A trailing colon ends a label ("Note:"), it doesn't make the word a URL scheme or key.
  return !NON_PROSE.test(chunk.replace(/:+$/, ""));
}

/**
 * Sorted code regions: ``` / ~~~ fenced blocks (an unclosed fence runs to the end of the text) and
 * inline spans between matching backtick runs. An unmatched run masks the rest of its line, since
 * that is a span still being typed.
 */
function codeRanges(text: string): Range[] {
  const ranges: Range[] = [];
  let fence: { char: string; length: number; start: number } | null = null;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    const open = FENCE_OPEN.exec(line);
    if (fence) {
      const closes =
        open !== null &&
        open[1][0] === fence.char &&
        open[1].length >= fence.length &&
        line.slice(open[0].length).trim() === "";
      if (closes) {
        ranges.push([fence.start, lineEnd]);
        fence = null;
      }
    } else if (open) {
      fence = { char: open[1][0], length: open[1].length, start: lineStart };
    } else {
      inlineSpans(line, lineStart, ranges);
    }
    lineStart = lineEnd + 1;
  }
  if (fence) ranges.push([fence.start, text.length]);
  return ranges;
}

function inlineSpans(line: string, offset: number, ranges: Range[]): void {
  const runs = /`+/g;
  let open: RegExpExecArray | null;
  while ((open = runs.exec(line))) {
    const length = open[0].length;
    let close = runs.exec(line);
    while (close && close[0].length !== length) close = runs.exec(line);
    if (!close) {
      ranges.push([offset + open.index, offset + line.length]);
      return;
    }
    ranges.push([offset + open.index, offset + close.index + length]);
  }
}

function lowerBound(sorted: readonly string[], target: string): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Most frequent first, ties alphabetical, so the serialized model is deterministic.
function byCount(a: [string, number], b: [string, number]): number {
  return b[1] - a[1] || compareText(a[0], b[0]);
}
