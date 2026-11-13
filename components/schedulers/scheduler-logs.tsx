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
  text: "bg-foreground/[0.07] text-foreground",
  thinking: "text-muted-foreground ring-1 ring-border ring-inset",
  tool: "bg-chart-3/15 text-foreground/80",
  agent: "bg-success/10 text-success",
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
          <RefreshCw className={cn(loading && "animate-spin motion-reduce:animate-none")} />
          Refresh
        </Button>
      </div>
      {entries === null ? (
        <div className="overflow-hidden rounded-xl border bg-muted/30" aria-busy="true" aria-label="Loading log">
          <div className="border-b px-3 py-2">
            <Skeleton className="h-3.5 w-48 max-w-full" />
          </div>
          <div className="space-y-2.5 px-3 py-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 sm:grid-cols-[auto_auto_minmax(0,1fr)]">
                <Skeleton className="h-3.5 w-14" />
                <Skeleton className="h-3.5 w-[4.5rem]" />
                <Skeleton className="col-span-2 h-3.5 sm:col-span-1" style={{ width: `${45 + ((i * 23) % 50)}%` }} />
              </div>
            ))}
          </div>
        </div>
      ) : entries.length === 0 ? (
        <div className="flex animate-fade-in-soft flex-col items-center rounded-xl border border-dashed px-4 py-10 text-center">
          <ScrollText className="size-6 text-muted-foreground" />
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
          className="max-h-[70dvh] overflow-auto overscroll-contain rounded-xl border bg-muted/30 font-mono text-xs scrollbar-subtle"
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
                    <li
                      key={`${entry.at}-${index}`}
                      className="grid grid-cols-[auto_1fr] items-start gap-x-2 gap-y-0.5 sm:grid-cols-[auto_auto_minmax(0,1fr)]"
                    >
                      <time
                        dateTime={entry.at}
                        title={formatDateTime(entry.at)}
                        className="shrink-0 pt-px text-muted-foreground tabular-nums"
                      >
                        {formatClock(entry.at)}
                      </time>
                      <span
                        className={cn(
                          "inline-flex h-4 w-[4.5rem] shrink-0 items-center justify-center justify-self-start rounded px-1 text-[10px] font-medium uppercase",
                          KIND_CLASS[entry.kind],
                        )}
                      >
                        {entry.kind}
                      </span>
                      <span
                        className={cn(
                          "col-span-2 min-w-0 break-words whitespace-pre-wrap max-sm:pb-1.5 sm:col-span-1",
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
