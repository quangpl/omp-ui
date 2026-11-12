"use client";

import { useState } from "react";
import { Loader2Icon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api } from "@/lib/api-client";
import type { BoardWithCounts } from "@/lib/types";

/** Confirm-and-delete for a board. Open while `board` is set. */
export function DeleteBoardDialog({
  board,
  onOpenChange,
  onDeleted,
}: {
  board: BoardWithCounts | null;
  onOpenChange: (open: boolean) => void;
  onDeleted?: (boardId: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const cardCount = board ? board.counts.todo + board.counts.in_progress + board.counts.done : 0;

  async function onConfirm(e: React.MouseEvent) {
    // Keep the dialog open until the request settles.
    e.preventDefault();
    if (!board || deleting) return;
    setDeleting(true);
    try {
      await api.boards.remove(board.id);
      toast.success(`Deleted “${board.name}”`);
      onDeleted?.(board.id);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : "Couldn't delete the project.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AlertDialog open={board !== null} onOpenChange={(open) => !deleting && onOpenChange(open)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2Icon />
          </AlertDialogMedia>
          <AlertDialogTitle className="[overflow-wrap:anywhere]">Delete “{board?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {cardCount > 0
              ? `Its ${cardCount} card${cardCount === 1 ? "" : "s"}, comments and run history will be removed. `
              : ""}
            {board && board.runningCount > 0 ? "Running agents will be stopped. " : ""}
            Files in the project folder are not touched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting} className="max-md:h-11">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting}
            onClick={onConfirm}
            className="max-md:h-11"
          >
            {deleting && <Loader2Icon className="animate-spin" />}
            Delete project
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
