"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Heading style shared by every block of the card detail panel (also used by field labels). */
export const DETAIL_HEADING_CLASS =
  "flex min-w-0 items-center gap-1.5 text-[13px] font-semibold tracking-tight text-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

/** A titled block in the card detail panel (dependencies, workspace, files…). */
export function DetailSection({
  icon: Icon,
  title,
  action,
  children,
  className,
}: {
  icon: LucideIcon;
  title: string;
  /** Rendered at the right of the heading (e.g. an "Add" button). */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={title} className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex min-h-9 items-center justify-between gap-2">
        <h3 className={DETAIL_HEADING_CLASS}>
          <Icon aria-hidden />
          <span className="truncate">{title}</span>
        </h3>
        {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
      </div>
      {children}
    </section>
  );
}
