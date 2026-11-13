"use client";

import { DownloadIcon, Loader2Icon, RefreshCwIcon, SearchIcon, TimerIcon, XIcon } from "lucide-react";
import { formatBytes } from "@/components/containers/shared";
import { LEVEL_STYLES } from "@/components/logs/log-entry-row";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  LOG_LEVELS,
  type LogExportFormat,
  type LogFileInfo,
  type LogLevel,
  type LogQuery,
} from "@/lib/log-types";
import { cn } from "@/lib/utils";

export const TIME_RANGES = [
  { value: "all", label: "All time", ms: 0 },
  { value: "15m", label: "Last 15 min", ms: 15 * 60_000 },
  { value: "1h", label: "Last hour", ms: 60 * 60_000 },
  { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60_000 },
  { value: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60_000 },
] as const;
export type TimeRange = (typeof TIME_RANGES)[number]["value"];

const AUTO_REFRESH = [
  { ms: 0, label: "Off" },
  { ms: 5_000, label: "5s" },
  { ms: 15_000, label: "15s" },
  { ms: 60_000, label: "60s" },
] as const;

const EXPORTS: { format: LogExportFormat; label: string; hint: string }[] = [
  { format: "json", label: "JSON", hint: ".json" },
  { format: "ndjson", label: "NDJSON", hint: ".ndjson" },
  { format: "txt", label: "Text", hint: ".txt" },
];

/** One tab's filters; the page keeps one per source so switching tabs does not reset them. */
export interface LogFilters {
  /** Search box text as typed; the viewer debounces it into the `q` query. */
  search: string;
  /** Empty = every level. */
  levels: LogLevel[];
  range: TimeRange;
  /** "all" or a file name from the source's files. */
  file: string;
  /** Auto-refresh interval; 0 = off. */
  refreshMs: number;
}

export const DEFAULT_LOG_FILTERS: LogFilters = {
  search: "",
  levels: [],
  range: "all",
  file: "all",
  refreshMs: 0,
};

/** Whether anything narrows the results (auto-refresh does not). */
export function hasActiveFilters(filters: LogFilters): boolean {
  return (
    filters.search.trim() !== "" || filters.levels.length > 0 || filters.range !== "all" || filters.file !== "all"
  );
}

/** Server query for `filters` with search text `q`; a relative time range is resolved against now. */
export function filtersToQuery(filters: Pick<LogFilters, "levels" | "range" | "file">, q: string): LogQuery {
  const rangeMs = TIME_RANGES.find((range) => range.value === filters.range)?.ms ?? 0;
  return {
    levels: filters.levels.length > 0 ? filters.levels : undefined,
    q: q || undefined,
    since: rangeMs ? new Date(Date.now() - rangeMs).toISOString() : undefined,
    file: filters.file === "all" ? undefined : filters.file,
  };
}

const CONTROL = "h-11! md:h-9!";

/**
 * Filters and actions above a log list: search, level chips, time range, file (only when the
 * source has rotated archives), refresh, auto-refresh interval and export.
 */
export function LogToolbar({
  filters,
  onChange,
  files,
  loading,
  onRefresh,
  onExport,
}: {
  filters: LogFilters;
  onChange: (patch: Partial<LogFilters>) => void;
  files: LogFileInfo[];
  loading: boolean;
  onRefresh: () => void;
  onExport: (format: LogExportFormat) => void;
}) {
  // A file filter that no longer exists (archive pruned) falls back to every file.
  const fileValue = files.some((file) => file.name === filters.file) ? filters.file : "all";
  const autoLabel = AUTO_REFRESH.find((option) => option.ms === filters.refreshMs)?.label ?? "Off";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={filters.search}
            onChange={(e) => onChange({ search: e.target.value })}
            placeholder="Search logs"
            aria-label="Search log entries"
            className="pr-9 pl-8 md:h-9 [&::-webkit-search-cancel-button]:hidden"
          />
          {filters.search && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="pressable-icon absolute top-1/2 right-1 size-9 -translate-y-1/2 text-muted-foreground md:size-7"
              aria-label="Clear search"
              onClick={() => onChange({ search: "" })}
            >
              <XIcon />
            </Button>
          )}
        </div>
        <Button
          variant="outline"
          size="icon"
          className="pressable-icon size-11 md:size-9"
          onClick={onRefresh}
          aria-label="Refresh"
          title="Refresh"
        >
          {loading ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <RefreshCwIcon />}
        </Button>
        <Select
          value={String(filters.refreshMs)}
          onValueChange={(value) => onChange({ refreshMs: Number(value) })}
        >
          <SelectTrigger
            className={cn(CONTROL, "shrink-0", filters.refreshMs > 0 && "border-primary/40 text-primary")}
            aria-label="Auto-refresh interval"
            title="Auto-refresh (paused while the browser tab is hidden)"
          >
            <TimerIcon aria-hidden="true" className={cn("size-4", !filters.refreshMs && "text-muted-foreground")} />
            <SelectValue>{autoLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            {AUTO_REFRESH.map((option) => (
              <SelectItem key={option.ms} value={String(option.ms)}>
                {option.ms === 0 ? "Auto-refresh off" : `Every ${option.label}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="h-11 shrink-0 max-sm:w-11 max-sm:px-0 md:h-9" aria-label="Export">
              <DownloadIcon />
              <span className="max-sm:sr-only">Export</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>Export matching entries</DropdownMenuLabel>
            {EXPORTS.map((item) => (
              <DropdownMenuItem
                key={item.format}
                className="min-h-11 justify-between gap-2.5 px-2.5 md:min-h-8"
                onSelect={() => onExport(item.format)}
              >
                {item.label}
                <span className="font-mono text-xs text-muted-foreground">{item.hint}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="scroll-row flex min-w-0 gap-1 rounded-lg bg-muted p-1" role="group" aria-label="Levels">
          {LOG_LEVELS.map((level) => {
            const active = filters.levels.includes(level);
            return (
              <Button
                key={level}
                variant={active ? "outline" : "ghost"}
                size="xs"
                aria-pressed={active}
                onClick={() =>
                  onChange({
                    levels: active
                      ? filters.levels.filter((value) => value !== level)
                      : LOG_LEVELS.filter((value) => value === level || filters.levels.includes(value)),
                  })
                }
                className={cn("pressable h-9 shrink-0 gap-1.5 px-2.5 md:h-7", !active && "text-muted-foreground")}
              >
                <span aria-hidden="true" className={cn("size-2 rounded-full", LEVEL_STYLES[level].dot)} />
                {LEVEL_STYLES[level].label}
              </Button>
            );
          })}
        </div>
        <Select value={filters.range} onValueChange={(value) => onChange({ range: value as TimeRange })}>
          <SelectTrigger className={cn(CONTROL, "min-w-36")} aria-label="Time range">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {TIME_RANGES.map((range) => (
              <SelectItem key={range.value} value={range.value}>
                {range.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {files.length > 1 && (
          <Select value={fileValue} onValueChange={(value) => onChange({ file: value })}>
            <SelectTrigger className={cn(CONTROL, "max-w-full min-w-36")} aria-label="Log file">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="all">All files</SelectItem>
              {files.map((file) => (
                <SelectItem key={file.name} value={file.name}>
                  <span className="font-mono">{file.name}</span>
                  <span className="text-muted-foreground">
                    {file.archived ? "(archived) · " : ""}
                    {formatBytes(file.size)}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}
