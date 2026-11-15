"use client";

import { api } from "@/lib/api-client";

/** Fired on `window` after a project's board was opened and recorded, so the sidebar reorders. */
export const BOARD_ACCESS_EVENT = "omp:board-access";

/** Records that the board was opened; best effort, failures only leave the sidebar order stale. */
export async function recordBoardAccess(boardId: string): Promise<void> {
  try {
    await api.boards.access(boardId);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(BOARD_ACCESS_EVENT));
}
