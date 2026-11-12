"use client";

import type { CSSProperties } from "react";
import { ArrowRight, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, type Task } from "@/lib/types";

const DURATION_MS = 5000;
/** Burst angles (deg) for the sparks around the check badge. */
const SPARKS = [0, 60, 120, 180, 240, 300];

export interface CardAddedToastOptions {
  /** Headline; defaults to "Card added successfully". */
  heading?: string;
  /** Shown when the card went to a project other than the one on screen. */
  boardName?: string;
  /** Adds an "Open" button that opens the new card. */
  onOpen?: () => void;
}

/** Success toast for a newly created card: animated check, card title, where it landed. */
export function toastCardAdded(
  task: Pick<Task, "id" | "title" | "status" | "agentState">,
  options: CardAddedToastOptions = {},
) {
  toast.custom((id) => <CardAddedToast toastId={id} task={task} {...options} />, {
    id: `card-added-${task.id}`,
    duration: DURATION_MS,
  });
}

function CardAddedToast({
  toastId,
  task,
  heading = "Card added",
  boardName,
  onOpen,
}: CardAddedToastOptions & {
  toastId: string | number;
  task: Pick<Task, "title" | "status" | "agentState">;
}) {
  const started = task.status === "in_progress" && (task.agentState === "queued" || task.agentState === "running");
  const where = started ? "In progress · agent started" : `Added to ${STATUS_LABELS[task.status]}`;

  return (
    <div
      role="status"
      className="relative flex w-full items-center gap-3 overflow-hidden rounded-xl border bg-popover py-3 pr-9 pl-3 text-popover-foreground shadow-lg"
    >
      <SuccessBadge />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-5 font-semibold">{heading}</p>
        <p className="truncate text-sm leading-5 text-muted-foreground" title={task.title}>
          {task.title}
        </p>
        <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              task.status === "in_progress" ? "bg-sky-500" : "bg-muted-foreground/50",
            )}
          />
          <span className="truncate">{boardName ? `${where} · ${boardName}` : where}</span>
        </p>
      </div>
      {onOpen && (
        <button
          type="button"
          onClick={() => {
            toast.dismiss(toastId);
            onOpen();
          }}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-3.5"
        >
          Open
          <ArrowRight aria-hidden />
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => toast.dismiss(toastId)}
        className="absolute top-1.5 right-1.5 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-3.5"
      >
        <X aria-hidden />
      </button>
      {/* Time left before the toast closes; pauses with sonner's timer on hover. */}
      <span
        aria-hidden
        className="animate-toast-countdown absolute inset-x-0 bottom-0 h-0.5 origin-left bg-success/60"
        style={{ animationDuration: `${DURATION_MS}ms` }}
      />
    </div>
  );
}

/** Check badge: pops in, draws its check, and throws a ring + sparks once. */
function SuccessBadge() {
  return (
    <span aria-hidden className="relative flex size-9 shrink-0 items-center justify-center">
      <span className="animate-success-ring absolute inset-0 rounded-full border-2 border-success" />
      {SPARKS.map((angle) => (
        <span
          key={angle}
          className="animate-success-spark absolute top-1/2 left-1/2 -mt-0.5 -ml-0.5 size-1 rounded-full bg-success"
          style={{ "--spark-angle": `${angle}deg` } as CSSProperties}
        />
      ))}
      <span className="animate-success-pop flex size-9 items-center justify-center rounded-full bg-success text-white shadow-sm dark:text-background">
        <svg viewBox="0 0 24 24" fill="none" className="size-5">
          <path
            d="M5 12.5 10 17.5 19 7"
            pathLength={1}
            stroke="currentColor"
            strokeWidth={2.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="animate-check-draw"
          />
        </svg>
      </span>
    </span>
  );
}
