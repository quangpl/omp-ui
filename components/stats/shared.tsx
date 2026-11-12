"use client";

// Formatters, tone helpers and building blocks shared by the Stats page sections.
import Link from "next/link";
import { TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------------------------
// Formatters

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

export const compactNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
export const wholeNumber = new Intl.NumberFormat();
export const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatResetTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  google: "Google",
  "google-gemini-cli": "Gemini CLI",
  "github-copilot": "GitHub Copilot",
};

export function providerName(id: string): string {
  return (
    PROVIDER_NAMES[id] ??
    id.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}

// ---------------------------------------------------------------------------------------------
// omp availability

/** Error text `/stats/ai` reports when the omp binary cannot be found. */
export const OMP_MISSING = "omp is not installed";

export function OmpMissingHint() {
  return (
    <>
      Install omp on this server, or set its path in{" "}
      <Link href="/settings" className="font-medium text-foreground underline underline-offset-4">
        Settings
      </Link>
      .
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Tones

export type Tone = "primary" | "success" | "warning" | "destructive" | "muted";

/** Usage tone: red from 90%, amber from 75%, otherwise the primary data color. */
export function toneForFraction(fraction: number): Tone {
  if (fraction >= 0.9) return "destructive";
  if (fraction >= 0.75) return "warning";
  return "primary";
}

export const TONE_TEXT: Record<Tone, string> = {
  primary: "text-primary",
  success: "text-success",
  warning: "text-amber-500 dark:text-amber-400",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

export const TONE_BG: Record<Tone, string> = {
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-amber-500 dark:bg-amber-400",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground",
};

export const TONE_STROKE: Record<Tone, string> = {
  primary: "stroke-primary",
  success: "stroke-success",
  warning: "stroke-amber-500 dark:stroke-amber-400",
  destructive: "stroke-destructive",
  muted: "stroke-muted-foreground",
};

// ---------------------------------------------------------------------------------------------
// Building blocks

/** Shared surface for every panel on the page. */
export const PANEL =
  "min-w-0 rounded-2xl bg-card ring-1 ring-foreground/[0.07] shadow-[0_1px_2px_oklch(0.17_0.01_270/0.04),0_24px_48px_-28px_oklch(0.17_0.01_270/0.18)] dark:shadow-[inset_0_1px_0_oklch(1_0_0/0.05)]";

/** Horizontal usage bar; turns amber at 75% and red at 90%. */
export function Meter({ fraction, label, className }: { fraction: number; label: string; className?: string }) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.07]", className)}
    >
      <div
        className={cn(
          "h-full w-full origin-left rounded-full transition-transform duration-700 ease-(--ease-out-smooth) motion-reduce:transition-none",
          TONE_BG[toneForFraction(clamped)],
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
  index,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  action?: React.ReactNode;
  index?: string;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 flex-1 basis-64">
        <div className="mb-2 flex items-center gap-2.5">
          {index && (
            <>
              <span className="font-mono text-[11px] font-medium tracking-[0.08em] text-muted-foreground tabular-nums">
                {index}
              </span>
              <span aria-hidden className="h-px w-6 bg-foreground/15" />
            </>
          )}
          <span
            aria-hidden
            className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/15 [&_svg]:size-3.5"
          >
            {icon}
          </span>
        </div>
        <h2 id={id} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        <p className="mt-0.5 max-w-[65ch] text-sm text-pretty text-muted-foreground">{description}</p>
      </div>
      {action && <div className="flex max-w-full flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

/** Small heading inside a panel, with an optional right-aligned note. */
export function PanelHeader({ title, note }: { title: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-foreground/[0.06] px-4 py-3.5 sm:px-5">
      <h3 className="min-w-0 truncate text-sm font-medium tracking-tight">{title}</h3>
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
  const error = tone === "error";
  return (
    <div
      role={error ? "alert" : undefined}
      className={cn(
        "flex gap-3 rounded-xl p-4 text-sm ring-1 ring-inset",
        error ? "bg-destructive/[0.05] ring-destructive/20" : "bg-muted/50 ring-foreground/[0.06]",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5",
          error ? "bg-destructive/10 text-destructive" : "bg-foreground/[0.06] text-muted-foreground",
        )}
      >
        <TriangleAlertIcon />
      </span>
      <div className="min-w-0 space-y-1 pt-0.5">
        <p className="leading-tight font-medium">{title}</p>
        {children && <div className="text-pretty break-words text-muted-foreground">{children}</div>}
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
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-foreground/10 px-6 py-10 text-center">
      <span
        aria-hidden
        className="flex size-11 items-center justify-center rounded-xl bg-card text-muted-foreground ring-1 ring-foreground/[0.08] shadow-[0_1px_2px_oklch(0.17_0.01_270/0.06),0_8px_16px_-10px_oklch(0.17_0.01_270/0.2)] dark:bg-muted dark:shadow-[inset_0_1px_0_oklch(1_0_0/0.06)] [&_svg]:size-5"
      >
        {icon}
      </span>
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium tracking-tight">{title}</p>
        <p className="text-sm text-pretty text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}
