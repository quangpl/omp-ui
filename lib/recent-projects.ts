import type { Board } from "@/lib/types";

/** Projects listed in the sidebar's "Your projects" before the "All projects" overflow link. */
export const MAX_RECENT_PROJECTS = 10;

/**
 * The sidebar's "Your projects": most recently opened first, then never-opened ones in their
 * given order (newest first from the API), at most `limit`. `activeId`, when given and present,
 * is always kept, in place of the last entry if it would fall past the limit.
 */
export function recentProjects<T extends Pick<Board, "id" | "lastAccessedAt">>(
  boards: readonly T[],
  activeId?: string,
  limit = MAX_RECENT_PROJECTS,
): T[] {
  const opened = boards
    .filter((board) => board.lastAccessedAt !== null)
    .sort((a, b) => Date.parse(b.lastAccessedAt ?? "") - Date.parse(a.lastAccessedAt ?? ""));
  const ordered = [...opened, ...boards.filter((board) => board.lastAccessedAt === null)];
  const listed = ordered.slice(0, limit);
  const active = activeId === undefined ? undefined : ordered.find((board) => board.id === activeId);
  if (active && limit > 0 && !listed.includes(active)) listed[listed.length - 1] = active;
  return listed;
}
