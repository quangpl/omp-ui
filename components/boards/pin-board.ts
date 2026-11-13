"use client";

import { toast } from "sonner";
import { api } from "@/lib/api-client";
import type { Board } from "@/lib/types";

/** Fired on `window` after a project was pinned or unpinned, so other project lists refetch. */
export const BOARD_PIN_EVENT = "omp:board-pin";

/**
 * Pins or unpins a project on the home dashboard and toasts the outcome. Resolves false when
 * saving failed (callers undo their optimistic update).
 */
export async function setBoardPinned(board: Pick<Board, "id" | "name">, pinned: boolean): Promise<boolean> {
  try {
    await api.boards.update(board.id, { pinned });
  } catch (err) {
    toast.error(pinned ? "Couldn't pin the project" : "Couldn't unpin the project", {
      description: err instanceof Error && err.message ? err.message : board.name,
    });
    return false;
  }
  window.dispatchEvent(new Event(BOARD_PIN_EVENT));
  toast.success(pinned ? "Pinned to the dashboard" : "Unpinned from the dashboard", { description: board.name });
  return true;
}
