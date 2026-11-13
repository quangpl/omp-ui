/** Letters (any script) and digits; anything else (or no char at all) separates words. */
export function isWordChar(char: string | undefined): boolean {
  if (char === undefined) return false;
  return char.toLowerCase() !== char.toUpperCase() || (char >= "0" && char <= "9");
}

/**
 * Lowercases and strips diacritics one character at a time, so every index in the result points
 * at the same character in `text` ("Crème" → "creme"); characters that would change length are
 * only lowercased, or kept as-is.
 */
export function foldText(text: string): string {
  let folded = "";
  for (const char of text) {
    const stripped = char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    if (stripped.length === char.length) folded += stripped;
    else {
      const lower = char.toLowerCase();
      folded += lower.length === char.length ? lower : char;
    }
  }
  return folded;
}

/**
 * Tiered match of one lowercase query token in lowercase `text`: prefix (4) > word start (~3) >
 * contiguous substring (~2) > subsequence (<1, only when `fuzzy`); 0 = no match. The fraction
 * favours earlier matches, and subsequences with fewer gaps and more word-start hits.
 */
export function tokenScore(text: string, token: string, fuzzy: boolean): number {
  if (text.startsWith(token)) return 4;
  const first = text.indexOf(token);
  if (first >= 0) {
    const position = first / (text.length + 1) / 2;
    for (let at = first; at >= 0; at = text.indexOf(token, at + 1)) {
      if (!isWordChar(text[at - 1])) return 3 - at / (text.length + 1) / 2;
    }
    return 2 - position;
  }
  if (!fuzzy) return 0;
  let from = 0;
  let last = -1;
  let gaps = 0;
  let starts = 0;
  for (const char of token) {
    const found = text.indexOf(char, from);
    if (found < 0) return 0;
    if (last >= 0 && found > last + 1) gaps++;
    if (found === 0 || !isWordChar(text[found - 1])) starts++;
    last = found;
    from = found + 1;
  }
  return 0.5 + (starts / token.length) * 0.4 - Math.min(gaps, 10) * 0.01;
}

/** exact = prefix/word start/substring, typo = one edit off a word, loose = subsequence. */
export type MatchTier = "exact" | "typo" | "loose";

export interface TokenMatch {
  tier: MatchTier;
  score: number;
  /** Matched char positions in `text`, ascending. */
  indices: number[];
}

/** Shortest token the typo tier applies to: shorter ones are one edit away from too much. */
const MIN_TYPO_LENGTH = 4;

/** Start of the occurrence `tokenScore` ranks: the prefix, else the first word start, else the first hit. */
function exactStart(text: string, token: string): number {
  if (text.startsWith(token)) return 0;
  const first = text.indexOf(token);
  for (let at = first; at >= 0; at = text.indexOf(token, at + 1)) {
    if (!isWordChar(text[at - 1])) return at;
  }
  return first;
}

/** True when `text[start, start + length)` is within one Damerau edit (incl. adjacent swap) of `token`. */
function withinOneEdit(text: string, start: number, length: number, token: string): boolean {
  const diff = length - token.length;
  if (diff < -1 || diff > 1) return false;
  const shorter = Math.min(length, token.length);
  let i = 0;
  while (i < shorter && text[start + i] === token[i]) i++;
  if (i === shorter) return true;
  // The rest of the candidate from `at` equals the rest of the token from `tokenAt`.
  const restEqual = (at: number, tokenAt: number): boolean => {
    if (length - at !== token.length - tokenAt) return false;
    for (let k = 0; at + k < length; k++) {
      if (text[start + at + k] !== token[tokenAt + k]) return false;
    }
    return true;
  };
  if (diff === 1) return restEqual(i + 1, i);
  if (diff === -1) return restEqual(i, i + 1);
  if (restEqual(i + 1, i + 1)) return true;
  return text[start + i] === token[i + 1] && text[start + i + 1] === token[i] && restEqual(i + 2, i + 2);
}

/** Indices of the first word (or word prefix) within one edit of `token`, or null. */
function typoIndices(text: string, token: string): number[] | null {
  if (token.length < MIN_TYPO_LENGTH) return null;
  // Equal length first, so a whole-word swap wins over a shorter prefix.
  const lengths = [token.length, token.length - 1, token.length + 1];
  for (let start = 0; start < text.length; ) {
    if (!isWordChar(text[start])) {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < text.length && isWordChar(text[end])) end++;
    for (const length of lengths) {
      if (length <= end - start && withinOneEdit(text, start, length, token)) {
        return Array.from({ length }, (_, i) => start + i);
      }
    }
    start = end;
  }
  return null;
}

/** Positions of `token`'s chars found left to right in `text`, or null when it is not a subsequence. */
function subsequenceIndices(text: string, token: string): number[] | null {
  const indices: number[] = [];
  let from = 0;
  for (const char of token) {
    const found = text.indexOf(char, from);
    if (found < 0) return null;
    for (let k = 0; k < char.length; k++) indices.push(found + k);
    from = found + char.length;
  }
  return indices;
}

/** Best tier of folded `token` in folded `text` (see `foldText`); null when nothing fits. */
export function matchToken(text: string, token: string): TokenMatch | null {
  const start = exactStart(text, token);
  if (start >= 0) {
    const indices = Array.from({ length: token.length }, (_, i) => start + i);
    return { tier: "exact", score: tokenScore(text, token, false), indices };
  }
  const typo = typoIndices(text, token);
  if (typo) return { tier: "typo", score: 1, indices: typo };
  const loose = subsequenceIndices(text, token);
  if (loose) return { tier: "loose", score: tokenScore(text, token, true), indices: loose };
  return null;
}
