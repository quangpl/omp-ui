import type { Board } from "@/lib/types";

/** Projects listed in the sidebar's "Your projects" before the "All projects" overflow link. */
export const MAX_RECENT_PROJECTS = 10;

/**
 * The sidebar's "Your projects": the `limit` most recently opened projects (never-opened ones only
 * fill spots left over, in their given order), shown in the given (API) order so the list doesn't
 * reshuffle each time a project is opened. `activeId`, when given and present, is always kept, in
 * place of the least recently opened entry if it would fall outside the limit.
 */
export function recentProjects<T extends Pick<Board, "id" | "lastAccessedAt">>(
  boards: readonly T[],
  activeId?: string,
  limit = MAX_RECENT_PROJECTS,
): T[] {
  const opened = boards
    .filter((board) => board.lastAccessedAt !== null)
    .sort((a, b) => Date.parse(b.lastAccessedAt ?? "") - Date.parse(a.lastAccessedAt ?? ""));
  const ranked = [...opened, ...boards.filter((board) => board.lastAccessedAt === null)];
  const picked = ranked.slice(0, limit);
  const active = activeId === undefined ? undefined : ranked.find((board) => board.id === activeId);
  if (active && limit > 0 && !picked.includes(active)) picked[picked.length - 1] = active;
  const keep = new Set(picked);
  return boards.filter((board) => keep.has(board));
}
