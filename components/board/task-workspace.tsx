"use client";

import { useEffect, useState } from "react";
import { FolderGit2, GitBranch, LoaderCircle, Trash2 } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import type { Task, TaskWorkspace, WorkspaceFolder } from "@/lib/types";
import { DetailSection } from "@/components/board/detail-section";
import { errorMessage } from "@/components/board/format";
import { folderName } from "@/components/board/ship-actions";

/**
 * The card's dedicated workspace (one git worktree per project repo) on boards with
 * `worktrees` on. Re-read whenever the agent's state changes (a run creates the worktrees).
 */
export function WorkspaceSection({ task, onRemoved }: { task: Task; onRemoved: () => void }) {
  const [workspace, setWorkspace] = useState<TaskWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const active = task.agentState === "running" || task.agentState === "queued";

  useEffect(() => {
    let cancelled = false;
    api.tasks.workspace(task.id).then(
      (next) => {
        if (cancelled) return;
        setWorkspace(next);
        setError(null);
      },
      (err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [task.id, task.agentState]);

  const remove = async () => {
    setRemoving(true);
    try {
      setWorkspace(await api.tasks.removeWorkspace(task.id));
      toast.success("Workspace removed");
      onRemoved();
    } catch (err) {
      toast.error("Couldn't remove the workspace", { description: errorMessage(err) });
    } finally {
      setRemoving(false);
    }
  };

  if (workspace && !workspace.enabled) return null;
  const created = workspace?.folders.some((folder) => folder.isolated && folder.exists) ?? false;

  return (
    <DetailSection
      icon={FolderGit2}
      title="Workspace"
      action={
        created && (
          <Button
            variant="ghost"
            size="sm"
            className="h-11 text-destructive hover:text-destructive md:h-8"
            disabled={active || removing}
            title={active ? "Stop the agent before removing its workspace" : undefined}
            onClick={() => setConfirmOpen(true)}
          >
            {removing ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
            Remove workspace
          </Button>
        )
      }
    >
      <p className="text-xs text-muted-foreground">
        The agent works on its own branch in a separate worktree of each git folder, so parallel cards
        never touch each other&apos;s files.
      </p>
      {workspace === null ? (
        error ? (
          <p className="text-xs text-destructive">Couldn&apos;t load the workspace: {error}</p>
        ) : (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" />
            Loading workspace…
          </p>
        )
      ) : (
        <ul className="flex flex-col gap-1.5">
          {workspace.folders.map((folder) => (
            <WorkspaceFolderItem key={folder.source} folder={folder} />
          ))}
        </ul>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this card&apos;s workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes the card&apos;s worktrees and local branches. Unshipped changes are lost. The next
              run starts from a fresh workspace.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="max-md:h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="max-md:h-11"
              onClick={() => void remove()}
            >
              Remove workspace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailSection>
  );
}

function WorkspaceFolderItem({ folder }: { folder: WorkspaceFolder }) {
  return (
    <li className="flex flex-col gap-1 rounded-lg border bg-card px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{folderName(folder.source)}</span>
        {!folder.isolated ? (
          <Badge variant="outline">Shared</Badge>
        ) : folder.exists ? (
          <Badge
            variant="outline"
            className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          >
            Ready
          </Badge>
        ) : (
          <Badge variant="secondary">Not created yet</Badge>
        )}
      </div>
      {folder.branch && (
        <p className="flex min-w-0 items-center gap-1.5 text-xs">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono">{folder.branch}</span>
        </p>
      )}
      <p className="font-mono text-xs break-all text-muted-foreground">{folder.path}</p>
      {!folder.isolated ? (
        <p className="text-xs text-muted-foreground">
          Not a git repository; the agent works in the project folder directly.
        </p>
      ) : (
        !folder.exists && (
          <p className="text-xs text-muted-foreground">Created when the agent first runs.</p>
        )
      )}
    </li>
  );
}
