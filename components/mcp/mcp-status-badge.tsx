"use client";

import { formatDateTime, formatRelative } from "@/components/board/format";
import { formatLatency, type HealthToneClasses } from "@/components/credentials/health-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { McpServerStatus } from "@/lib/mcp-types";
import { cn } from "@/lib/utils";

/** A connected server's status, or "not-configured" for a catalog entry nobody connected yet. */
export type McpBadgeStatus = McpServerStatus | "not-configured";

// Same palette as the credential health badge: green passes, red fails, gray is unknown.
// "error" (credential deleted or undecryptable) is amber: it needs the user, not a retry.
const TONES: Record<McpBadgeStatus, HealthToneClasses> = {
  connected: { label: "Connected", dot: "bg-success", pill: "bg-success/15 text-success" },
  failing: {
    label: "Failing",
    dot: "bg-destructive",
    pill: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  },
  untested: { label: "Untested", dot: "bg-muted-foreground/60", pill: "bg-muted text-muted-foreground" },
  disabled: {
    label: "Disabled",
    dot: "bg-muted-foreground/40",
    pill: "bg-muted/60 text-muted-foreground/80",
  },
  error: { label: "Error", dot: "bg-amber-500", pill: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  "not-configured": {
    label: "Not configured",
    dot: "bg-muted-foreground/40",
    pill: "bg-transparent text-muted-foreground ring-1 ring-inset ring-foreground/10",
  },
};

/** Fallback tooltip text when the server sent no message. */
const DEFAULT_DETAIL: Record<McpBadgeStatus, string> = {
  connected: "The last check passed",
  failing: "The last check failed",
  untested: "Not checked since it was connected",
  disabled: "Switched off: agents do not load it",
  error: "Its credential is missing or cannot be decrypted",
  "not-configured": "Not connected yet",
};

/** Dot + label pill; the tooltip carries the status message, when it was checked and the latency. */
export function McpStatusBadge({
  status,
  message = null,
  checkedAt = null,
  latencyMs = null,
  checking = false,
  className,
}: {
  status: McpBadgeStatus;
  message?: string | null;
  checkedAt?: string | null;
  latencyMs?: number | null;
  /** A test is running right now. */
  checking?: boolean;
  className?: string;
}) {
  const tone = TONES[status];
  const live = checking || status === "connected";
  const detail =
    status === "not-configured"
      ? null
      : [checkedAt ? `Checked ${formatRelative(checkedAt)}` : "Never checked", latencyMs != null ? formatLatency(latencyMs) : null]
          .filter(Boolean)
          .join(" · ");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "inline-flex h-6 shrink-0 cursor-default items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
            checking ? "bg-primary/10 text-primary" : tone.pill,
            className,
          )}
        >
          {/* Live states (testing, connected) breathe; the others stay still. */}
          <span className="relative flex size-1.5 shrink-0" aria-hidden="true">
            {live && (
              <span className={cn("absolute inset-0 animate-breathe rounded-full", checking ? "bg-primary" : tone.dot)} />
            )}
            <span className={cn("relative size-1.5 rounded-full", checking ? "bg-primary" : tone.dot)} />
          </span>
          {checking ? "Testing…" : tone.label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        <p className="break-words">{message || DEFAULT_DETAIL[status]}</p>
        {detail && (
          <p className="mt-0.5 opacity-70" title={checkedAt ? formatDateTime(checkedAt) : undefined}>
            {detail}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
