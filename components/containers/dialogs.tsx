"use client";

import { useState } from "react";
import { CheckCircle2Icon, Loader2Icon, XCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { appendJobLine, errorMessage, JobLog } from "@/components/containers/shared";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import type { DockerJobResult } from "@/lib/api-client";

export interface ConfirmRequest {
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  /** Optional extra switch, e.g. "Also remove volumes". */
  option?: string;
  onConfirm: (optionChecked: boolean) => Promise<void> | void;
}

export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  return (
    <AlertDialog
      open={Boolean(request)}
      onOpenChange={(open) => {
        if (!open && !busy) {
          setChecked(false);
          onClose();
        }
      }}
    >
      <AlertDialogContent>
        {request && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{request.title}</AlertDialogTitle>
              <AlertDialogDescription>{request.description}</AlertDialogDescription>
            </AlertDialogHeader>
            {request.option && (
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={checked} onCheckedChange={setChecked} disabled={busy} />
                {request.option}
              </label>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel className="max-md:h-11" disabled={busy}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                variant={request.destructive ? "destructive" : "default"}
                className="max-md:h-11"
                disabled={busy}
                onClick={async (event) => {
                  event.preventDefault();
                  setBusy(true);
                  try {
                    await request.onConfirm(checked);
                  } catch (err) {
                    toast.error(errorMessage(err, "Something went wrong"));
                  } finally {
                    setBusy(false);
                    setChecked(false);
                    onClose();
                  }
                }}
              >
                {busy && <Loader2Icon className="animate-spin" />}
                {request.confirmLabel}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface JobRequest {
  title: string;
  run: (onLine: (line: string) => void) => Promise<DockerJobResult>;
}

type JobState = { lines: string[]; status: "running" | "ok" | "failed"; message: string };

/**
 * Runs a streamed docker job (compose up/down, pull, …) and shows its output. Closes itself
 * with a toast on success; stays open with the error on failure.
 */
export function useJobDialog(onFinished: () => void): {
  start: (job: JobRequest) => void;
  dialog: React.ReactNode;
} {
  const [job, setJob] = useState<JobRequest | null>(null);
  const [state, setState] = useState<JobState>({ lines: [], status: "running", message: "" });

  const start = (next: JobRequest) => {
    setJob(next);
    setState({ lines: [], status: "running", message: "" });
    next
      .run((line) => setState((s) => ({ ...s, lines: appendJobLine(s.lines, line) })))
      .then(
        (result) => {
          onFinished();
          if (result.ok) {
            toast.success(result.message);
            setJob(null);
          } else {
            setState((s) => ({ ...s, status: "failed", message: result.message }));
          }
        },
        (err: unknown) => {
          onFinished();
          setState((s) => ({ ...s, status: "failed", message: errorMessage(err, "The job failed") }));
        },
      );
  };

  const running = state.status === "running";
  const dialog = (
    <Dialog open={Boolean(job)} onOpenChange={(open) => !open && !running && setJob(null)}>
      <DialogContent className="sm:max-w-xl" showCloseButton={!running}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {running ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : state.status === "ok" ? (
              <CheckCircle2Icon className="size-4 text-emerald-500" />
            ) : (
              <XCircleIcon className="size-4 text-destructive" />
            )}
            {job?.title}
          </DialogTitle>
          <DialogDescription>
            {running ? "Working… this can take a while when images are downloaded." : state.message}
          </DialogDescription>
        </DialogHeader>
        <JobLog lines={state.lines.length ? state.lines : ["Waiting for docker…"]} className="max-h-80" />
        <DialogFooter>
          <Button variant="outline" onClick={() => setJob(null)} disabled={running} className="h-11 md:h-9">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { start, dialog };
}
