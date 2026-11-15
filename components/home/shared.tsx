"use client";

import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export const cardHref = (card: { boardId: string; id: string }) =>
  `/b/${encodeURIComponent(card.boardId)}?task=${encodeURIComponent(card.id)}`;

export const boardHref = (boardId: string) => `/b/${encodeURIComponent(boardId)}`;

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * True while the dashboard plays its first-load entrance. The page turns it off once the cascade
 * has finished, so rows mounted by later refreshes appear in place instead of animating again.
 */
export const EntranceContext = createContext(true);

/** Class + style for row `index` of the `animate-card-in` cascade (see globals.css); empty once the entrance is over. */
export function useEntrance(): (index: number) => { className?: string; style?: CSSProperties } {
  const entering = useContext(EntranceContext);
  return (index) => (entering ? { className: "animate-card-in", style: { "--stagger": index } as CSSProperties } : {});
}

export const FOCUS_RING = "outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

export function SectionTitle({
  id,
  title,
  count,
  hint,
  action,
}: {
  id: string;
  title: string;
  count?: number;
  /** Quiet one-liner after the title (hidden on narrow screens). */
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex min-h-8 items-center gap-2">
      <h2
        id={id}
        tabIndex={-1}
        className="scroll-mt-20 text-[13px] font-semibold tracking-tight text-foreground outline-none"
      >
        {title}
      </h2>
      {count !== undefined && (
        <span className="rounded-md bg-muted px-1.5 font-mono text-[11px] font-medium text-muted-foreground tabular-nums">
          {count}
        </span>
      )}
      {hint && <span className="hidden truncate text-xs text-muted-foreground md:inline">{hint}</span>}
      {action && <div className="ml-auto flex shrink-0 items-center gap-1">{action}</div>}
    </div>
  );
}

/** The bordered surface for sections whose elevation carries meaning (actionable or live lists). */
export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("shadow-panel rounded-xl border bg-card text-card-foreground", className)}>{children}</div>
  );
}

const EMPTY_TONE = {
  muted: "bg-muted text-muted-foreground",
  success: "bg-success/10 text-success",
  primary: "bg-primary/10 text-primary",
} as const;

/** Consistent composed empty state: icon bubble, short title, optional hint and action. */
export function EmptyState({
  icon,
  title,
  hint,
  action,
  tone = "muted",
}: {
  icon: ReactNode;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  tone?: keyof typeof EMPTY_TONE;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-dashed px-3 py-3">
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4.5",
          EMPTY_TONE[tone],
        )}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium break-words">{title}</p>
        {hint && <p className="text-xs text-pretty text-muted-foreground">{hint}</p>}
      </div>
      {action && <div className="ml-auto shrink-0">{action}</div>}
    </div>
  );
}
