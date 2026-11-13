"use client";

import { memo, useState } from "react";
import { ArchiveIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LOG_SOURCE_META, type LogEntry, type LogLevel } from "@/lib/log-types";
import { cn } from "@/lib/utils";

/** Per-level colors, shared by the row badge and the toolbar's level chips. */
export const LEVEL_STYLES: Record<LogLevel, { label: string; badge: string; dot: string; row?: string }> = {
  error: {
    label: "Error",
    badge: "bg-destructive/10 text-destructive dark:bg-destructive/20",
    dot: "bg-destructive",
    row: "bg-destructive/[0.04]",
  },
  warn: {
    label: "Warn",
    badge: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    dot: "bg-amber-500",
    row: "bg-amber-500/[0.04]",
  },
  info: { label: "Info", badge: "bg-sky-500/10 text-sky-700 dark:text-sky-400", dot: "bg-sky-500" },
  debug: { label: "Debug", badge: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/50" },
};

/** Local date and time to the second, e.g. "Nov 13, 14:05:09". */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * One log entry: local timestamp (`~` when inferred), level badge, category chip and the full
 * message. Details (stack traces, run summaries) and meta fields show when expanded.
 */
export const LogEntryRow = memo(function LogEntryRow({
  entry,
  archived,
}: {
  entry: LogEntry;
  archived: boolean;
}) {
  const [open, setOpen] = useState(false);
  const meta = entry.meta ? Object.entries(entry.meta) : [];
  const expandable = Boolean(entry.details) || meta.length > 0;
  const level = LEVEL_STYLES[entry.level];
  const timeTitle = entry.time
    ? entry.approximateTime
      ? `${entry.time} (approximate: this line has no timestamp of its own)`
      : entry.time
    : "This line has no timestamp";

  return (
    <li className={cn("content-auto border-b border-border/60 last:border-b-0", level.row)}>
      <div className="flex items-start gap-2 py-2 pr-1 pl-3 md:pr-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1 md:flex-row md:items-start md:gap-3">
          <div className="flex shrink-0 items-center gap-2 md:pt-px">
            <time
              dateTime={entry.time ?? undefined}
              title={timeTitle}
              className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums md:w-[8.75rem]"
            >
              {entry.time ? `${entry.approximateTime ? "~" : ""}${formatTime(entry.time)}` : "—"}
            </time>
            <span
              className={cn(
                "inline-flex h-5 w-12 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold tracking-wide uppercase",
                level.badge,
              )}
            >
              {level.label}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[13px] leading-relaxed whitespace-pre-wrap wrap-anywhere md:text-xs">
              <span className="mr-2 inline-block max-w-full truncate rounded-md border border-border/70 bg-background/60 px-1.5 align-top font-sans text-[11px] leading-[18px] text-muted-foreground">
                {entry.category ?? LOG_SOURCE_META[entry.source].label}
              </span>
              {archived && entry.file && (
                <span
                  title="From a rotated (archived) log file"
                  className="mr-2 inline-flex h-5 max-w-full items-center gap-1 rounded-md bg-muted px-1.5 align-top font-sans text-[11px] text-muted-foreground"
                >
                  <ArchiveIcon className="size-3 shrink-0" aria-hidden="true" />
                  {entry.file}
                </span>
              )}
              {entry.message}
            </p>
            {open && (
              <div className="mt-2 space-y-2">
                {entry.details && (
                  <pre className="max-h-96 overflow-auto overscroll-contain rounded-lg bg-muted/70 p-2.5 font-mono text-xs leading-relaxed whitespace-pre scrollbar-subtle">
                    {entry.details}
                  </pre>
                )}
                {meta.length > 0 && (
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-lg bg-muted/40 p-2.5 font-mono text-xs">
                    {meta.map(([key, value]) => (
                      <div key={key} className="contents">
                        <dt className="text-muted-foreground">{key}</dt>
                        <dd className="wrap-anywhere">{value === null ? "null" : String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            )}
          </div>
        </div>
        {expandable && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="pressable-icon -my-1.5 size-11 shrink-0 text-muted-foreground md:-my-0.5 md:size-7"
            aria-expanded={open}
            aria-label={open ? "Hide details" : "Show details"}
            title={open ? "Hide details" : "Show details"}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronDownIcon
              className={cn(
                "transition-transform duration-200 ease-(--ease-fluid) motion-reduce:transition-none",
                open && "rotate-180",
              )}
            />
          </Button>
        )}
      </div>
    </li>
  );
});
