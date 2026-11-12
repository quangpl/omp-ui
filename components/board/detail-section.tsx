"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

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
    <section aria-label={title} className={cn("flex flex-col gap-2", className)}>
      <div className="flex min-h-9 items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Icon className="size-4 text-muted-foreground" />
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}
