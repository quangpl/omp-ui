import type { TasksByStatus } from "@/hooks/use-board";
import { foldText, matchToken, type MatchTier } from "@/lib/fuzzy-match";
import { TASK_STATUSES } from "@/lib/types";

/** Folded (lowercase, accent-free) whitespace-separated terms of `query`; `[]` when it is blank. */
export function normalizeSearchQuery(query: string): string[] {
  const trimmed = query.trim();
  return trimmed ? foldText(trimmed).split(/\s+/) : [];
}

export interface TitleMatch {
  /** Worst tier over all terms. */
  tier: MatchTier;
  /** Sum of the term scores. */
  score: number;
  /** Matched title char positions, ascending and unique. */
  indices: number[];
}

const TIER_RANK: Record<MatchTier, number> = { exact: 0, typo: 1, loose: 2 };

/** Matches every term against `title` (AND); null when any term misses. */
export function matchTitle(title: string, terms: readonly string[]): TitleMatch | null {
  const text = foldText(title);
  let tier: MatchTier = "exact";
  let score = 0;
  const indices = new Set<number>();
  for (const term of terms) {
    const match = matchToken(text, term);
    if (!match) return null;
    if (TIER_RANK[match.tier] > TIER_RANK[tier]) tier = match.tier;
    score += match.score;
    for (const index of match.indices) indices.add(index);
  }
  return { tier, score, indices: [...indices].sort((a, b) => a - b) };
}

export interface BoardSearchResult {
  /** Cards per column that match, in board order. */
  columns: TasksByStatus;
  matches: number;
  total: number;
  /** False for a blank query: `columns` is then the input reference itself. */
  active: boolean;
  /** True when some shown card is only a close match (typo or skipped letters). */
  fuzzy: boolean;
  /** Task id → matched title char indices, for every shown card. */
  highlights: ReadonlyMap<string, readonly number[]>;
}

/**
 * Filters every column by card title. Exact and one-typo matches win board-wide; subsequence
 * matches only show when nothing closer exists. Cards keep board order (drag reorder relies on it).
 * A blank query hands back `columns` untouched.
 */
export function filterColumns(columns: TasksByStatus, query: string): BoardSearchResult {
  const terms = normalizeSearchQuery(query);
  let total = 0;
  for (const status of TASK_STATUSES) total += columns[status].length;
  if (terms.length === 0) {
    return { columns, matches: total, total, active: false, fuzzy: false, highlights: new Map() };
  }

  const found = new Map<string, TitleMatch>();
  let close = false;
  for (const status of TASK_STATUSES) {
    for (const task of columns[status]) {
      const match = matchTitle(task.title, terms);
      if (!match) continue;
      found.set(task.id, match);
      if (match.tier !== "loose") close = true;
    }
  }

  const filtered = {} as TasksByStatus;
  const highlights = new Map<string, readonly number[]>();
  let matches = 0;
  let fuzzy = false;
  for (const status of TASK_STATUSES) {
    filtered[status] = columns[status].filter((task) => {
      const match = found.get(task.id);
      if (!match || (close && match.tier === "loose")) return false;
      highlights.set(task.id, match.indices);
      if (match.tier !== "exact") fuzzy = true;
      return true;
    });
    matches += filtered[status].length;
  }
  return { columns: filtered, matches, total, active: true, fuzzy, highlights };
}
