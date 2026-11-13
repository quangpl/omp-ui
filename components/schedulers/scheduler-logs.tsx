"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, ScrollText } from "lucide-react";
import { toast } from "sonner";
import { errorMessage, formatDateTime } from "@/components/board/format";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import type { SchedulerLogEntry, SchedulerRunView } from "@/lib/types";
import { cn } from "@/lib/utils";

const KIND_CLASS: Record<SchedulerLogEntry["kind"], string> = {
  scheduler: "bg-primary/10 text-primary",
  status: "bg-muted text-muted-foreground",
  text: "bg-sky-500/10 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
  thinking: "bg-violet-500/10 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300",
  tool: "bg-amber-500/10 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  agent: "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
  error: "bg-destructive/10 text-destructive",
};

function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** Log lines of one scheduler run, in the order the runs first appear in the log. */
interface LogGroup {
  runId: string;
  entries: SchedulerLogEntry[];
}

function groupByRun(entries: SchedulerLogEntry[]): LogGroup[] {
  const groups = new Map<string, LogGroup>();
  for (const entry of entries) {
    let group = groups.get(entry.schedulerRunId);
    if (!group) {
      group = { runId: entry.schedulerRunId, entries: [] };
      groups.set(entry.schedulerRunId, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}

/**
 * Aggregated log of a scheduler (its own fired/failed lines plus its cards' agent run events),
 * grouped by run. Fetched on mount, on Refresh and whenever `refreshKey` changes (live updates of
 * the scheduler or its cards). `runs` labels the groups with their time and card.
 */
export function SchedulerLogs({
  schedulerId,
  runs,
  refreshKey,
}: {
  schedulerId: string;
  runs: SchedulerRunView[] | null;
  refreshKey: number;
}) {
  const [entries, setEntries] = useState<SchedulerLogEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Follow new lines only while the view is scrolled to the bottom (or on the first load). */
  const stickRef = useRef(true);
  const requestRef = useRef(0);

  const load = useCallback(
    async (manual = false) => {
      const request = ++requestRef.current;
      setLoading(true);
      try {
        const next = await api.schedulers.logs(schedulerId);
        if (request === requestRef.current) setEntries(next);
      } catch (err) {
        if (request !== requestRef.current) return;
        if (manual) toast.error("Couldn't load the log", { description: errorMessage(err) });
        setEntries((current) => current ?? []);
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [schedulerId],
  );

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && stickRef.current) node.scrollTop = node.scrollHeight;
  }, [entries]);

  const groups = useMemo(() => (entries ? groupByRun(entries) : []), [entries]);
  const runsById = useMemo(() => new Map((runs ?? []).map((run) => [run.id, run])), [runs]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Scheduler events and the agent logs of the cards it created.</p>
        <Button
          variant="outline"
          size="sm"
          className="h-9 shrink-0 max-md:h-11"
          disabled={loading}
          onClick={() => void load(true)}
        >
          <RefreshCw className={cn(loading && "animate-spin")} />
          Refresh
        </Button>
      </div>
      {entries === null ? (
        <Skeleton className="h-64 w-full rounded-xl" aria-label="Loading log" />
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-dashed px-4 py-10 text-center">
          <ScrollText className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No log yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Lines appear here once the scheduler fires and its cards&apos; agents run.
          </p>
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const node = event.currentTarget;
            stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
          }}
          className="max-h-[70dvh] overflow-auto overscroll-contain rounded-xl border bg-muted/30 font-mono text-xs"
        >
          {groups.map((group) => {
            const run = runsById.get(group.runId);
            return (
              <section key={group.runId} className="border-b last:border-b-0">
                <h3 className="sticky top-0 z-10 flex flex-wrap items-center gap-x-2 border-b bg-muted/95 px-3 py-1.5 font-sans text-xs font-medium backdrop-blur">
                  <span>Run {run ? formatDateTime(run.scheduledFor) : formatDateTime(group.entries[0].at)}</span>
                  {run && (
                    <span className="min-w-0 truncate font-normal text-muted-foreground">
                      {run.trigger === "manual" ? "Manual" : "Scheduled"}
                      {run.task ? ` · ${run.task.title || "Untitled card"}` : run.taskId ? " · card deleted" : ""}
                    </span>
                  )}
                </h3>
                <ol className="space-y-0.5 px-3 py-2">
                  {group.entries.map((entry, index) => (
                    <li key={`${entry.at}-${index}`} className="flex items-start gap-2">
                      <time
                        dateTime={entry.at}
                        title={formatDateTime(entry.at)}
                        className="shrink-0 pt-px text-muted-foreground tabular-nums"
                      >
                        {formatClock(entry.at)}
                      </time>
                      <span
                        className={cn(
                          "inline-flex h-4 w-[4.5rem] shrink-0 items-center justify-center rounded px-1 text-[10px] font-medium uppercase",
                          KIND_CLASS[entry.kind],
                        )}
                      >
                        {entry.kind}
                      </span>
                      <span
                        className={cn(
                          "min-w-0 flex-1 break-words whitespace-pre-wrap",
                          entry.kind === "error" && "text-destructive",
                        )}
                      >
                        {entry.text}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
