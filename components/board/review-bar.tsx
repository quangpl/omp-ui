"use client";

import { Check, CircleAlert, CircleCheck, CircleDashed, History, LoaderCircle, MessageSquareWarning } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { BaseNote, Counts, type DiffSummaryState, SummaryBar } from "@/components/board/code-changes";
import { errorMessage, formatDateTime, formatRelative, useNow } from "@/components/board/format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api-client";
import type { TaskDiff } from "@/lib/diff-types";
import { modKeyLabel } from "@/lib/hotkeys";
import type { Task, TaskReview, TaskReviewResult } from "@/lib/types";
import { cn } from "@/lib/utils";

type ReviewStatusKind = "awaiting" | "approved" | "stale" | "changes_requested";

/**
 * Where the card's review stands. An approval is "stale" once the changes moved on (its hash differs
 * from the current diff's); without a diff or a recorded hash the approval is taken as current.
 */
export function reviewStatus(
  review: TaskReview | null,
  diff: TaskDiff | null,
  active: boolean,
): { kind: ReviewStatusKind; label: string } {
  if (!review) return { kind: "awaiting", label: "Awaiting review" };
  if (review.decision === "changes_requested") {
    return { kind: "changes_requested", label: active ? "Changes requested · agent working" : "Changes requested" };
  }
  if (diff && review.hash && review.hash !== diff.hash) return { kind: "stale", label: "Approved · changed since" };
  return { kind: "approved", label: "Approved" };
}

const PILL_STYLES: Record<ReviewStatusKind, { className: string; icon: typeof Check }> = {
  awaiting: { className: "border bg-background text-foreground", icon: CircleDashed },
  approved: { className: "bg-success/10 text-success", icon: CircleCheck },
  stale: { className: "border border-dashed bg-muted/50 text-muted-foreground", icon: History },
  changes_requested: {
    className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    icon: CircleAlert,
  },
};

type Busy = "approve" | "request_changes" | null;

/**
 * Review header of the card's changes: decision pill, change summary and stats, and the
 * Request changes / Approve actions. Errors are toasted, never thrown.
 */
export function ReviewBar({
  task,
  diff,
  summary,
  active,
  isMobile,
  onReviewed,
}: {
  task: Task;
  diff: TaskDiff | null;
  summary: DiffSummaryState;
  /** Agent queued/running. */
  active: boolean;
  isMobile: boolean;
  /** Called with the API result after a successful decision. */
  onReviewed: (result: TaskReviewResult) => void;
}) {
  const now = useNow();
  const [busy, setBusy] = useState<Busy>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [note, setNote] = useState("");

  const review = task.review;
  const status = reviewStatus(review, diff, active);
  const pill = PILL_STYLES[status.kind];
  const PillIcon = pill.icon;
  const approvedCurrent = review?.decision === "approved" && diff !== null && review.hash === diff.hash;
  const hasFiles = diff !== null && diff.stats.files > 0;
  const singleRepo = diff?.repos.length === 1 && diff.repos[0].isRepo ? diff.repos[0] : null;

  const approve = async () => {
    if (busy) return;
    setBusy("approve");
    const wasDone = task.status === "done";
    try {
      const result = await api.tasks.review(task.id, { decision: "approve", hash: diff?.hash ?? null });
      toast.success("Changes approved", wasDone ? undefined : { description: "Card moved to Done" });
      onReviewed(result);
    } catch (err) {
      toast.error("Couldn't approve the changes", { description: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const requestChanges = async () => {
    const text = note.trim();
    if (!text || busy) return;
    setBusy("request_changes");
    try {
      const result = await api.tasks.review(task.id, {
        decision: "request_changes",
        note: text,
        hash: diff?.hash ?? null,
      });
      toast.success("Changes requested");
      setRequestOpen(false);
      setNote("");
      onReviewed(result);
    } catch (err) {
      toast.error("Couldn't request changes", { description: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const buttonSize = isMobile ? "h-11 flex-1" : "h-9 px-3.5";
  const approveDisabled = active || approvedCurrent || busy !== null;
  const approveButton = (
    <Button
      className={cn("pressable", buttonSize)}
      disabled={approveDisabled}
      onClick={() => void approve()}
    >
      {busy === "approve" ? <LoaderCircle className="animate-spin" /> : <Check />}
      {approvedCurrent ? "Approved" : "Approve"}
    </Button>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <span
              title={review ? `${status.label} ${formatDateTime(review.at)}` : undefined}
              className={cn(
                "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium",
                pill.className,
              )}
            >
              <PillIcon className="size-3.5" aria-hidden />
              {status.label}
            </span>
            {review && (
              <time dateTime={review.at} title={formatDateTime(review.at)} className="truncate text-xs text-muted-foreground">
                {formatRelative(review.at, now)}
              </time>
            )}
          </div>
          {review?.note && (
            <p
              title={review.note}
              className="line-clamp-2 text-xs break-words whitespace-pre-line text-muted-foreground"
            >
              {review.note}
            </p>
          )}
        </div>
        <div className={cn("flex items-center gap-2", isMobile ? "w-full" : "ml-auto shrink-0")}>
          <Button
            variant="outline"
            className={cn("pressable", buttonSize)}
            disabled={busy !== null}
            onClick={() => setRequestOpen(true)}
          >
            {busy === "request_changes" ? <LoaderCircle className="animate-spin" /> : <MessageSquareWarning />}
            Request changes
          </Button>
          {active ? (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Disabled buttons get no pointer events; the wrapper carries the tooltip. */}
                <span tabIndex={0} className={cn("inline-flex rounded-md", isMobile && "flex-1 [&>button]:w-full")}>
                  {approveButton}
                </span>
              </TooltipTrigger>
              <TooltipContent>The agent is still working</TooltipContent>
            </Tooltip>
          ) : (
            approveButton
          )}
        </div>
      </div>

      {diff && hasFiles && <SummaryBar diff={diff} summary={summary} active={active} />}

      {diff && hasFiles && (
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">
            {diff.stats.files} {diff.stats.files === 1 ? "file" : "files"}
          </span>
          <Counts additions={diff.stats.additions} deletions={diff.stats.deletions} />
          {singleRepo && <BaseNote repo={singleRepo} />}
        </p>
      )}

      <Dialog
        open={requestOpen}
        onOpenChange={(open) => {
          if (busy === "request_changes") return;
          setRequestOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void requestChanges();
            }}
          >
            <DialogHeader>
              <DialogTitle>Request changes</DialogTitle>
              <DialogDescription>The agent gets your note as feedback and starts working on it.</DialogDescription>
            </DialogHeader>
            <Textarea
              autoFocus
              required
              value={note}
              disabled={busy === "request_changes"}
              placeholder="What should change?"
              aria-label="Requested changes"
              className="max-h-[40dvh] min-h-28 resize-none bg-background text-base md:text-sm"
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void requestChanges();
                }
              }}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="pressable"
                disabled={busy === "request_changes"}
                onClick={() => setRequestOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="pressable"
                disabled={!note.trim() || busy !== null}
                title={`Send to agent (${modKeyLabel()}+Enter)`}
              >
                {busy === "request_changes" && <LoaderCircle className="animate-spin" />}
                Send to agent
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
