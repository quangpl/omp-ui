import { TASK_STATUSES, type TaskStatus } from "@/lib/types";

/** localStorage: the project the last "New card" went to, preselected next time off a board. */
export const LAST_BOARD_KEY = "omp-ui:last-board";

/** sessionStorage: the column a phone board should show when it next mounts (where a new card landed). */
const MOBILE_COLUMN_KEY = "omp-ui:mobile-column";

/**
 * The phone "New card" page for `boardId`. `fromBoard` marks that the board itself sits right
 * behind it in history, so leaving the page can go back instead of stacking another board entry.
 */
export function newCardHref(boardId: string, options: { fromBoard?: boolean } = {}): string {
  const path = `/b/${encodeURIComponent(boardId)}/new`;
  return options.fromBoard ? `${path}?from=board` : path;
}

/** Ask the phone board for `boardId` to open on `status` the next time it mounts. */
export function setMobileColumnHint(boardId: string, status: TaskStatus): void {
  try {
    sessionStorage.setItem(MOBILE_COLUMN_KEY, JSON.stringify({ boardId, status }));
  } catch {
    // Storage unavailable (private mode quota): the board just opens on its default column.
  }
}

/** Read and clear the column hint for `boardId`; `null` when there is none for this board. */
export function takeMobileColumnHint(boardId: string): TaskStatus | null {
  try {
    const raw = sessionStorage.getItem(MOBILE_COLUMN_KEY);
    if (raw === null) return null;
    sessionStorage.removeItem(MOBILE_COLUMN_KEY);
    const hint = JSON.parse(raw) as { boardId?: unknown; status?: unknown };
    if (hint.boardId !== boardId) return null;
    return TASK_STATUSES.find((status) => status === hint.status) ?? null;
  } catch {
    return null;
  }
}
