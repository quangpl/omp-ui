"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ellipsis, RotateCcw, Settings2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api-client";
import type { Board } from "@/lib/types";
import { errorMessage } from "@/components/board/format";
import { BoardFormDialog } from "@/components/boards/board-form-dialog";

/** Header overflow menu: project settings, refresh, delete. */
export function BoardMenu({
  board,
  onUpdated,
  onRefresh,
}: {
  board: Board;
  onUpdated: (board: Board) => void;
  onRefresh: () => void;
}) {
  const router = useRouter();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    setDeleting(true);
    try {
      await api.boards.remove(board.id);
      toast.success(`Deleted “${board.name}”`, { id: `board-deleted-${board.id}` });
      router.replace("/");
    } catch (err) {
      toast.error("Couldn't delete project", { description: errorMessage(err) });
      setDeleting(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-11 md:size-9" aria-label="Project menu">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem className="max-md:min-h-11" onSelect={() => setSettingsOpen(true)}>
            <Settings2 />
            Project settings
          </DropdownMenuItem>
          <DropdownMenuItem className="max-md:min-h-11" onSelect={onRefresh}>
            <RotateCcw />
            Refresh
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            className="max-md:min-h-11"
            onSelect={() => setDeleteOpen(true)}
          >
            <Trash2 />
            Delete project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <BoardFormDialog
        board={board}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSaved={(saved) => onUpdated(saved)}
      />

      <AlertDialog open={deleteOpen} onOpenChange={(open) => !deleting && setDeleteOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{board.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              All cards, comments and agent logs of this project are removed and running agents are
              stopped. Files in <span className="font-mono break-all">{board.workdir}</span> are not
              touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="max-md:h-11" disabled={deleting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="max-md:h-11"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void remove();
              }}
            >
              {deleting ? "Deleting…" : "Delete project"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
