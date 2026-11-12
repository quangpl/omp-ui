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

/** Rows and tiles that respond to a press; transform-only, so reduced motion skips nothing visible. */
export const PRESSABLE = "transition-[scale,background-color] duration-150 active:scale-[0.98] motion-reduce:active:scale-100";

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
    <div className="mb-2.5 flex min-h-8 items-center gap-2">
      <h2 id={id} className="text-sm font-semibold tracking-tight">
        {title}
      </h2>
      {count !== undefined && (
        <span className="rounded-md bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular-nums">
          {count}
        </span>
      )}
      {hint && <span className="hidden truncate text-xs text-muted-foreground md:inline">{hint}</span>}
      {action && <div className="ml-auto flex shrink-0 items-center gap-1">{action}</div>}
    </div>
  );
}

/** The bordered surface every home section sits on. */
export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-xl border bg-card text-card-foreground", className)}>{children}</div>;
}
