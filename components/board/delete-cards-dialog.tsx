"use client";

import { useState } from "react";
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
import { STATUS_LABELS, type Task } from "@/lib/types";

/**
 * Confirms deleting several cards at once (the Done column's "Delete all"). Stays open with
 * "Deleting…" until `onConfirm` settles: the server removes the cards one at a time.
 */
export function DeleteCardsDialog({
  tasks,
  onOpenChange,
  onConfirm,
}: {
  /** The cards to delete; `null` closes the dialog. */
  tasks: Task[] | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (taskIds: string[]) => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const count = tasks?.length ?? 0;
  const noun = count === 1 ? "card" : "cards";
  // Every caller passes one column's cards; name it ("Delete 4 Done cards?").
  const column = tasks?.[0] ? `${STATUS_LABELS[tasks[0].status]} ` : "";

  const confirm = async () => {
    if (!tasks) return;
    setDeleting(true);
    try {
      await onConfirm(tasks.map((task) => task.id));
    } finally {
      setDeleting(false);
      onOpenChange(false);
    }
  };

  return (
    <AlertDialog open={tasks !== null} onOpenChange={(open) => !deleting && onOpenChange(open)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {count} {column}
            {noun}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {count === 1 ? "The card" : `All ${count} cards`} and their comments, agent logs, shared files
            and workspaces will be removed. Files in the project are not touched.
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
              void confirm();
            }}
          >
            {deleting ? "Deleting…" : `Delete ${count} ${noun}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
