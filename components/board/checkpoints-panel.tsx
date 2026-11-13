"use client";

import { useCallback, useEffect, useState } from "react";
import { History, LoaderCircle, RotateCcw } from "lucide-react";
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
import { api, type TaskCheckpointList } from "@/lib/api-client";
import type { Task, TaskCheckpoint } from "@/lib/types";
import { DetailSection } from "@/components/board/detail-section";
import { errorMessage, formatDateTime, formatRelative } from "@/components/board/format";
import { folderName } from "@/components/board/ship-actions";

/** Rows shown before "Show all": a card keeps up to 20 checkpoints per repository. */
const COLLAPSED_ROWS = 5;

/**
 * The card's git checkpoints (snapshots taken before each run, Settings → Git checkpoints), each
 * restorable. Re-read whenever the agent's state changes (a run start adds one). Hidden when
 * there are none and the setting is off.
 */
export function CheckpointsPanel({ task, onRestored }: { task: Task; onRestored?: () => void }) {
  const [data, setData] = useState<TaskCheckpointList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState<TaskCheckpoint | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const active = task.agentState === "running" || task.agentState === "queued";

  const load = useCallback(
    (isCancelled: () => boolean = () => false) =>
      api.checkpoints.list(task.id).then(
        (next) => {
          if (isCancelled()) return;
          setData(next);
          setError(null);
        },
        (err: unknown) => {
          if (!isCancelled()) setError(errorMessage(err));
        },
      ),
    [task.id],
  );

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load, task.agentState, task.lastRunId]);

  const restore = async (checkpoint: TaskCheckpoint) => {
    setRestoring(`${checkpoint.folder}:${checkpoint.id}`);
    try {
      const result = await api.checkpoints.restore(task.id, { id: checkpoint.id, folder: checkpoint.folder });
      toast.success("Checkpoint restored", {
        description: `${result.restored} file${result.restored === 1 ? "" : "s"} restored, ${result.removed} removed in ${folderName(checkpoint.folder)}/.`,
      });
      onRestored?.();
      await load();
    } catch (err) {
      toast.error("Couldn't restore the checkpoint", { description: errorMessage(err) });
    } finally {
      setRestoring(null);
    }
  };

  if (data === null && error === null) return null;
  if (data && data.checkpoints.length === 0 && !data.enabled) return null;
  const checkpoints = data?.checkpoints ?? [];
  const visible = expanded ? checkpoints : checkpoints.slice(0, COLLAPSED_ROWS);

  return (
    <DetailSection
      icon={History}
      title="Checkpoints"
      action={
        checkpoints.length > COLLAPSED_ROWS && (
          <Button variant="ghost" size="sm" className="h-11 md:h-8" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show fewer" : `Show all (${checkpoints.length})`}
          </Button>
        )
      }
    >
      {error ? (
        <p className="text-xs text-destructive">Couldn&apos;t load checkpoints: {error}</p>
      ) : checkpoints.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          A snapshot of the card&apos;s git folders is saved before each run, so you can roll its changes
          back.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {visible.map((checkpoint) => {
            const key = `${checkpoint.folder}:${checkpoint.id}`;
            return (
              <li key={key} className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-medium" title={checkpoint.runId ? `Run ${checkpoint.runId}` : undefined}>
                    {checkpoint.label}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <time dateTime={checkpoint.createdAt} title={formatDateTime(checkpoint.createdAt)}>
                      {formatRelative(checkpoint.createdAt)}
                    </time>
                    <span aria-hidden>·</span>
                    <span className="truncate" title={checkpoint.folder}>
                      {folderName(checkpoint.folder)}/
                    </span>
                    <span aria-hidden>·</span>
                    <span className="font-mono" title={checkpoint.sha}>
                      {checkpoint.sha.slice(0, 7)}
                    </span>
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-11 shrink-0 md:h-8"
                  disabled={active || restoring !== null}
                  title={active ? "Stop the agent before restoring a checkpoint" : undefined}
                  onClick={() => setConfirm(checkpoint)}
                >
                  {restoring === key ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}
                  Restore
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this checkpoint?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm &&
                `The files in ${folderName(confirm.folder)}/ go back to how they were ${formatRelative(confirm.createdAt)} (${confirm.label}); files created since are deleted. Ignored files, commits and staged changes are left alone. The current files are saved as a new checkpoint first, so you can undo this.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="max-md:h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="max-md:h-11"
              onClick={() => {
                if (confirm) void restore(confirm);
              }}
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailSection>
  );
}
