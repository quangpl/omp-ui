import type { Board } from "@/lib/types";

/** The project's folders in order: its working directory, then the extra folders. Cards work in these directly. */
export function boardFolders(board: Pick<Board, "workdir" | "extraFolders">): string[] {
  return [board.workdir, ...board.extraFolders];
}
