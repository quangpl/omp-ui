// Default branch of a project repo: Board.defaultBranches (folder → branch) with the app-wide
// "main" fallback. Client-safe: the project form and the server both read it.
import type { Board } from "@/lib/types";

/** Last resort when Board.defaultBranches has no entry and the repo names no main/master. */
export const DEFAULT_BRANCH = "main";

/** `Board.defaultBranches` as stored: folder (absolute) → branch. */
export type DefaultBranches = Record<string, string>;

/**
 * The branch the project chose for `folder`, or null when the repo's own default branch applies
 * (origin/HEAD, then a local/remote main or master, then DEFAULT_BRANCH — see
 * `resolveDefaultBranch` in lib/git.ts).
 */
export function boardDefaultBranch(board: Pick<Board, "defaultBranches">, folder: string): string | null {
  return board.defaultBranches?.[folder] || null;
}

/** Drop entries for folders that are no longer part of the project; null when nothing changes. */
export function pruneDefaultBranches(
  branches: DefaultBranches,
  folders: readonly string[],
): DefaultBranches | null {
  const keep = new Set(folders);
  const entries = Object.entries(branches).filter(([folder]) => keep.has(folder));
  return entries.length === Object.keys(branches).length ? null : Object.fromEntries(entries);
}
