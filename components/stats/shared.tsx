"use client";

// Formatters and building blocks shared by the Stats page sections.
import { TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** Seconds → "3d 4h", "3h 12m", "12m", "<1m". */
export function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

export function formatPercent(fraction: number): string {
  if (fraction > 0 && fraction < 0.01) return "<1%";
  return `${Math.round(fraction * 100)}%`;
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Shared surface for every panel on the page. */
export const PANEL = "min-w-0 rounded-xl bg-card ring-1 ring-foreground/10";

/** Horizontal usage bar; turns amber at 75% and red at 90%. */
export function Meter({ fraction, label, className }: { fraction: number; label: string; className?: string }) {
  const clamped = Math.min(1, Math.max(0, fraction));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className={cn(
          "h-full w-full origin-left rounded-full transition-transform duration-500 ease-(--ease-out-smooth) motion-reduce:transition-none",
          clamped >= 0.9 ? "bg-destructive" : clamped >= 0.75 ? "bg-amber-500" : "bg-primary",
        )}
        style={{ transform: `scaleX(${clamped})` }}
      />
    </div>
  );
}

export function SectionHeader({
  id,
  icon,
  title,
  description,
  action,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <h2 id={id} className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        <p className="truncate text-xs text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

/** Small heading inside a panel, with an optional right-aligned note. */
export function PanelHeader({ title, note }: { title: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b px-4 py-3 sm:px-5">
      <h3 className="min-w-0 truncate text-sm font-medium">{title}</h3>
      {note && <p className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">{note}</p>}
    </div>
  );
}

export function Notice({
  tone = "muted",
  title,
  children,
}: {
  tone?: "muted" | "error";
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "flex gap-3 rounded-xl border border-dashed p-4 text-sm",
        tone === "error" && "border-destructive/40 bg-destructive/5",
      )}
    >
      <TriangleAlertIcon
        className={cn("mt-0.5 size-4 shrink-0", tone === "error" ? "text-destructive" : "text-muted-foreground")}
      />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{title}</p>
        {children && <div className="text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}

/** Centered empty state: icon, title, one line of guidance. */
export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
        {icon}
      </span>
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-pretty text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}
