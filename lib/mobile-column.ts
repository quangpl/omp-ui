import { TASK_STATUSES, type TaskStatus } from "@/lib/types";

/** localStorage: the column last picked on a board's phone column switcher, one key per board. */
const keyFor = (boardId: string) => `omp-ui:mobile-column:${boardId}`;

/** The column last picked on `boardId`'s phone board; `null` when none was saved or it is stale. */
export function loadMobileColumn(boardId: string): TaskStatus | null {
  try {
    const stored = localStorage.getItem(keyFor(boardId));
    return TASK_STATUSES.find((status) => status === stored) ?? null;
  } catch {
    return null;
  }
}

/** Remember `status` as the column to reopen `boardId`'s phone board on. */
export function saveMobileColumn(boardId: string, status: TaskStatus): void {
  try {
    localStorage.setItem(keyFor(boardId), status);
  } catch {
    // Storage unavailable (private mode / quota): the board just opens on its default column.
  }
}
