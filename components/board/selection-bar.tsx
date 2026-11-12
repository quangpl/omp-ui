"use client";

import { LoaderCircle, type LucideIcon, Play, RotateCcw, Square, Undo2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type BulkKey, bulkTargets, runLabel } from "@/components/board/bulk-actions";
import type { Task } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Floating bar over the bottom of the desktop board while cards are selected: how many, and the
 * quick actions that apply to them (each with the number of selected cards it would affect).
 */
export function SelectionBar({
  tasks,
  canPush,
  pending,
  onRun,
  onClear,
}: {
  /** The selected cards. */
  tasks: readonly Task[];
  /** The project can ship; shows Push to main. */
  canPush: boolean;
  /** Bulk action in flight; every action button waits meanwhile. */
  pending: BulkKey | null;
  onRun: (key: BulkKey) => void;
  onClear: () => void;
}) {
  if (tasks.length === 0) return null;

  const run = bulkTargets(tasks, "R", canPush);
  const runAllRetry = run.length > 0 && run.every((t) => t.action.id === "retry");
  const buttons: { key: BulkKey; label: string; icon: LucideIcon; filled: boolean; count: number }[] = [
    { key: "R", label: runLabel(run), icon: runAllRetry ? RotateCcw : Play, filled: !runAllRetry, count: run.length },
    { key: "S", label: "Stop", icon: Square, filled: true, count: bulkTargets(tasks, "S", canPush).length },
    { key: "Z", label: "Revert", icon: Undo2, filled: false, count: bulkTargets(tasks, "Z", canPush).length },
  ];
  if (canPush) {
    buttons.push({ key: "P", label: "Push", icon: Upload, filled: false, count: bulkTargets(tasks, "P", canPush).length });
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4">
      <div
        role="group"
        aria-label="Selected cards"
        className="animate-card-in pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border bg-popover/95 p-1.5 text-popover-foreground shadow-lg backdrop-blur"
      >
        <span className="px-2 text-sm font-medium whitespace-nowrap tabular-nums" aria-live="polite">
          {tasks.length} selected
        </span>
        <Separator orientation="vertical" className="mx-0.5 my-1" />
        {buttons.map(({ key, label, icon: Icon, filled, count }) => (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              {/* Disabled buttons swallow pointer events; the span keeps the tooltip working. */}
              <span className="inline-flex">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={count === 0 || pending !== null}
                  aria-busy={pending === key || undefined}
                  aria-keyshortcuts={key}
                  onClick={() => onRun(key)}
                  className="gap-1.5"
                >
                  {pending === key ? (
                    <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Icon aria-hidden className={cn(filled && "fill-current")} />
                  )}
                  {label}
                  <span className="text-muted-foreground tabular-nums">{count}</span>
                  <Kbd className="ml-0.5">{key}</Kbd>
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              {count === 0
                ? "No selected card offers this"
                : `${label} ${count} of ${tasks.length} selected ${tasks.length === 1 ? "card" : "cards"}`}
            </TooltipContent>
          </Tooltip>
        ))}
        <Separator orientation="vertical" className="mx-0.5 my-1" />
        <Button type="button" variant="ghost" size="sm" onClick={onClear} aria-keyshortcuts="Escape" className="gap-1.5">
          <X aria-hidden />
          Clear
          <Kbd className="ml-0.5">Esc</Kbd>
        </Button>
      </div>
    </div>
  );
}
