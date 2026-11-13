"use client";

import { formatDateTime, formatRelative } from "@/components/board/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CredentialHealth } from "@/lib/credential-types";
import { cn } from "@/lib/utils";

export interface HealthToneClasses {
  label: string;
  /** Status dot fill. */
  dot: string;
  /** Pill background + text. */
  pill: string;
}

const TONES: Record<CredentialHealth, HealthToneClasses> = {
  healthy: { label: "Healthy", dot: "bg-success", pill: "bg-success/15 text-success" },
  failing: {
    label: "Failing",
    dot: "bg-destructive",
    pill: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  },
  // Gray, not amber: amber is reserved for keys that are about to expire.
  untested: { label: "Untested", dot: "bg-muted-foreground/60", pill: "bg-muted text-muted-foreground" },
};

/** Label and theme-token classes for a health state (shared by the row badge and the bell). */
export function healthTone(health: CredentialHealth): HealthToneClasses {
  return TONES[health] ?? TONES.untested;
}

/** "230 ms" / "1.4 s". */
export function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Dot + label pill; the tooltip carries the last check's message, time and latency. */
export function HealthBadge({
  health,
  lastCheckedAt,
  lastMessage,
  lastLatencyMs,
  checking = false,
  className,
}: {
  health: CredentialHealth;
  lastCheckedAt: string | null;
  lastMessage: string | null;
  lastLatencyMs: number | null;
  /** A check is running right now. */
  checking?: boolean;
  className?: string;
}) {
  const tone = healthTone(health);
  const when = lastCheckedAt ? formatRelative(lastCheckedAt) : null;
  const detail = [when ? `Checked ${when}` : "Never checked", lastLatencyMs != null ? formatLatency(lastLatencyMs) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "inline-flex h-6 shrink-0 cursor-default items-center gap-1.5 rounded-full px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
            checking ? "bg-primary/10 text-primary" : tone.pill,
            className,
          )}
        >
          {/* Live states (checking, healthy) breathe; failing/untested stay still. */}
          <span className="relative flex size-1.5 shrink-0" aria-hidden="true">
            {(checking || health === "healthy") && (
              <span
                className={cn("absolute inset-0 animate-breathe rounded-full", checking ? "bg-primary" : tone.dot)}
              />
            )}
            <span className={cn("relative size-1.5 rounded-full", checking ? "bg-primary" : tone.dot)} />
          </span>
          {checking ? "Checking…" : tone.label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        <p className="break-words">{lastMessage || (health === "untested" ? "Not checked since it was saved" : tone.label)}</p>
        <p className="mt-0.5 opacity-70" title={lastCheckedAt ? formatDateTime(lastCheckedAt) : undefined}>
          {detail}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
