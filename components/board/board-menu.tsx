"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ellipsis, Paperclip, RotateCcw, Settings2, Trash2 } from "lucide-react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
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
import { FilesPanel } from "@/components/files-panel";
import { useIsMobile } from "@/hooks/use-mobile";

const SHARED_FILES_TITLE = "Shared files";
const SHARED_FILES_DESCRIPTION = "Shared with every card's agent in this project.";

/** Board-wide shared files: dialog on desktop, bottom sheet on mobile. */
function SharedFilesDialog({
  boardId,
  open,
  onOpenChange,
}: {
  boardId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="data-[vaul-drawer-direction=bottom]:max-h-[92dvh]">
          <DrawerHeader className="text-left">
            <DrawerTitle className="text-lg">{SHARED_FILES_TITLE}</DrawerTitle>
            <DrawerDescription>{SHARED_FILES_DESCRIPTION}</DrawerDescription>
          </DrawerHeader>
          <div className="overflow-y-auto overscroll-contain px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            {open && <FilesPanel scope="boards" id={boardId} />}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] grid-cols-1 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{SHARED_FILES_TITLE}</DialogTitle>
          <DialogDescription>{SHARED_FILES_DESCRIPTION}</DialogDescription>
        </DialogHeader>
        {open && <FilesPanel scope="boards" id={boardId} className="min-w-0" />}
      </DialogContent>
    </Dialog>
  );
}

/** Header overflow menu: project settings, shared files, refresh, delete. */
export function BoardMenu({
  board,
  onUpdated,
  onRefresh,
  settingsOpen,
  onSettingsOpenChange: setSettingsOpen,
}: {
  board: Board;
  onUpdated: (board: Board) => void;
  onRefresh: () => void;
  /** Settings dialog state; owned by the page so the board's right-click menu can open it too. */
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
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
          <DropdownMenuItem className="max-md:min-h-11" onSelect={() => setFilesOpen(true)}>
            <Paperclip />
            Shared files
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

      <SharedFilesDialog boardId={board.id} open={filesOpen} onOpenChange={setFilesOpen} />

      <AlertDialog open={deleteOpen} onOpenChange={(open) => !deleting && setDeleteOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{board.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes all cards, comments and agent logs, and stops running agents. Files in <span className="font-mono break-all">{board.workdir}</span> are not
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
