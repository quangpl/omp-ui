"use client";

import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Brain, ChevronRight, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api-client";
import type { Run, RunEvent, RunStatus } from "@/lib/types";
import type { BoardStreamListener } from "@/hooks/use-board";
import {
  errorMessage,
  formatDateTime,
  formatDuration,
  formatRelative,
  useNow,
} from "@/components/board/format";
import { RichText } from "@/components/board/rich-text";

const PAGE_SIZE = 500;
const COLLAPSED_RUN_COUNT = 3;
/** Distance from the bottom (px) still treated as "following" the log. */
const STICK_THRESHOLD = 48;

const RUN_STATUS: Record<RunStatus, { label: string; className: string }> = {
  running: {
    label: "Running",
    className: "bg-sky-500/10 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
  },
  succeeded: {
    label: "Succeeded",
    className: "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
  },
  failed: { label: "Failed", className: "bg-destructive/10 text-destructive dark:bg-destructive/20" },
  aborted: { label: "Stopped", className: "bg-muted text-muted-foreground" },
};

function RunStatusBadge({ status }: { status: RunStatus }) {
  const { label, className } = RUN_STATUS[status];
  return (
    <Badge className={cn("gap-1", className)}>
      {status === "running" && <LoaderCircle className="animate-spin" />}
      {label}
    </Badge>
  );
}

/** Merge events by `seq`, keeping ascending order and dropping duplicates. */
function mergeEvents(prev: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  if (incoming.length === 0) return prev;
  const lastSeq = prev.length ? prev[prev.length - 1].seq : Number.NEGATIVE_INFINITY;
  const ascending = incoming.every((event, i) => i === 0 || incoming[i - 1].seq < event.seq);
  if (ascending && incoming[0].seq > lastSeq) return prev.concat(incoming);
  const bySeq = new Map(prev.map((event) => [event.seq, event]));
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function EventLine({ event }: { event: RunEvent }) {
  switch (event.kind) {
    case "status":
      return (
        <div className="flex items-center gap-3 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          <span className="h-px flex-1 bg-border" />
          <span className="max-w-[75%] text-center break-words">{event.text}</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    case "thinking":
      return (
        <details className="group text-xs text-muted-foreground">
          <summary className="relative inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 italic select-none after:absolute after:-inset-y-1.5 after:inset-x-0 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
            <Brain className="size-3.5" />
            Thinking
          </summary>
          <div className="mt-1 ml-1.5 border-l-2 pl-3 leading-relaxed whitespace-pre-wrap italic break-words">
            {event.text}
          </div>
        </details>
      );
    case "tool":
      return (
        <div className="flex gap-1.5 font-mono text-xs leading-relaxed text-muted-foreground">
          <span aria-hidden className="shrink-0">
            ▸
          </span>
          <span className="min-w-0 break-all whitespace-pre-wrap">
            {event.text.replace(/^▸\s*/, "")}
          </span>
        </div>
      );
    case "error":
      return (
        <div className="rounded-md bg-destructive/10 px-2.5 py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-destructive break-words dark:bg-destructive/20">
          {event.text}
        </div>
      );
    default:
      return <RichText text={event.text} className="text-sm leading-relaxed" />;
  }
}

export function AgentLog({
  runs,
  subscribe,
  scrollRef,
  visible,
}: {
  runs: Run[];
  subscribe: (listener: BoardStreamListener) => () => void;
  /** The scroll container the log lives in (used for follow-the-tail scrolling). */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Whether the log tab is currently shown. */
  visible: boolean;
}) {
  const sortedRuns = useMemo(
    () => runs.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    [runs],
  );
  // null = follow the latest run.
  const [pickedRunId, setPickedRunId] = useState<string | null>(null);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const selectedRun =
    (pickedRunId && sortedRuns.find((run) => run.id === pickedRunId)) || sortedRuns[0] || null;
  const runId = selectedRun?.id ?? null;
  const running = selectedRun?.status === "running";
  const now = useNow(sortedRuns.some((run) => run.status === "running") ? 1000 : 30_000);

  const [events, setEvents] = useState<RunEvent[]>([]);
  const [loadedRunId, setLoadedRunId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const runIdRef = useRef(runId);
  runIdRef.current = runId;
  const lastSeqRef = useRef(0);
  lastSeqRef.current = events.length ? events[events.length - 1].seq : 0;

  // Initial page-through of a run's events; on reconnect, fetch only what was missed.
  useEffect(() => {
    if (!runId) {
      setEvents([]);
      setLoadedRunId(null);
      return;
    }
    let cancelled = false;
    const fresh = loadedRunId !== runId;
    if (fresh) setEvents([]);
    (async () => {
      let after = fresh ? 0 : lastSeqRef.current;
      for (;;) {
        const page = await api.runs.events(runId, after, PAGE_SIZE);
        if (cancelled) return;
        if (page.length > 0) {
          setEvents((prev) => mergeEvents(prev, page));
          after = page[page.length - 1].seq;
        }
        if (page.length < PAGE_SIZE) break;
      }
      setLoadedRunId(runId);
    })().catch((err) => {
      if (!cancelled) toast.error("Couldn't load agent log", { description: errorMessage(err) });
    });
    return () => {
      cancelled = true;
    };
    // loadedRunId is intentionally read, not tracked: it only distinguishes first load from refetch.
  }, [runId, reloadKey]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "stream.reconnected") {
          setReloadKey((key) => key + 1);
        } else if (event.type === "run.event" && event.event.runId === runIdRef.current) {
          setEvents((prev) => mergeEvents(prev, [event.event]));
        }
      }),
    [subscribe],
  );

  // Follow the tail while the run is live, unless the user scrolled up.
  const endRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [following, setFollowing] = useState(true);

  const distanceFromEnd = useCallback(() => {
    const container = scrollRef.current;
    const end = endRef.current;
    if (!container || !end) return 0;
    return end.getBoundingClientRect().bottom - container.getBoundingClientRect().bottom;
  }, [scrollRef]);

  const scrollToEnd = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const distance = distanceFromEnd();
    if (distance > 0) container.scrollTop += distance + 16;
  }, [scrollRef, distanceFromEnd]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !visible) return;
    const onScroll = () => {
      const follow = distanceFromEnd() < STICK_THRESHOLD;
      followRef.current = follow;
      setFollowing(follow);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [scrollRef, visible, distanceFromEnd]);

  useEffect(() => {
    followRef.current = true;
    setFollowing(true);
  }, [runId]);

  useLayoutEffect(() => {
    if (visible && running && followRef.current) scrollToEnd();
  }, [events, visible, running, scrollToEnd]);

  if (sortedRuns.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-sm text-muted-foreground">
        The agent hasn&apos;t run on this card yet. Move it to In progress or press Run agent.
      </div>
    );
  }

  const visibleRuns = showAllRuns ? sortedRuns : sortedRuns.slice(0, COLLAPSED_RUN_COUNT);

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      {sortedRuns.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">Runs</h3>
          <ul className="flex flex-col gap-1.5">
            {visibleRuns.map((run) => {
              const selected = run.id === runId;
              const end = run.endedAt ? new Date(run.endedAt).getTime() : now;
              return (
                <li key={run.id}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setPickedRunId(run.id === sortedRuns[0].id ? null : run.id)}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                      selected ? "border-foreground/25 bg-muted" : "hover:bg-muted/50",
                    )}
                  >
                    <RunStatusBadge status={run.status} />
                    <time
                      dateTime={run.startedAt}
                      title={formatDateTime(run.startedAt)}
                      className="min-w-0 truncate text-muted-foreground"
                    >
                      {formatRelative(run.startedAt, now)}
                    </time>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatDuration(end - new Date(run.startedAt).getTime())}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {sortedRuns.length > COLLAPSED_RUN_COUNT && (
            <Button
              variant="ghost"
              size="sm"
              className="self-start max-md:h-11"
              onClick={() => setShowAllRuns((value) => !value)}
            >
              {showAllRuns ? "Show fewer runs" : `Show all ${sortedRuns.length} runs`}
            </Button>
          )}
        </div>
      )}

      {selectedRun && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
            <RunStatusBadge status={selectedRun.status} />
            <span title={formatDateTime(selectedRun.startedAt)}>
              Started {formatRelative(selectedRun.startedAt, now)}
            </span>
            <span className="tabular-nums">
              ·{" "}
              {formatDuration(
                (selectedRun.endedAt ? new Date(selectedRun.endedAt).getTime() : now) -
                  new Date(selectedRun.startedAt).getTime(),
              )}
            </span>
          </div>

          {selectedRun.prompt && (
            <details className="group rounded-lg border text-xs">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-3 font-medium text-muted-foreground select-none [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                Prompt
              </summary>
              <pre className="max-h-72 overflow-auto border-t px-3 py-2 font-mono leading-relaxed break-words whitespace-pre-wrap">
                {selectedRun.prompt}
              </pre>
            </details>
          )}

          <div
            data-vaul-no-drag
            className="flex flex-col gap-2.5"
            aria-live={running ? "polite" : undefined}
          >
            {loadedRunId !== runId && events.length === 0 ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                Loading log…
              </div>
            ) : events.length === 0 && !running ? (
              <p className="py-4 text-sm text-muted-foreground">No output recorded for this run.</p>
            ) : (
              events.map((event) => <EventLine key={event.seq} event={event} />)
            )}
            {running && (
              <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-500 opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-sky-500" />
                </span>
                Working…
              </div>
            )}
            <div ref={endRef} />
          </div>
        </div>
      )}

      {running && !following && (
        <div className="pointer-events-none sticky bottom-3 flex justify-center">
          <Button
            size="sm"
            variant="secondary"
            className="pointer-events-auto rounded-full shadow-md max-md:h-11 max-md:px-4"
            onClick={() => {
              followRef.current = true;
              setFollowing(true);
              scrollToEnd();
            }}
          >
            <ArrowDown />
            Jump to latest
          </Button>
        </div>
      )}
    </div>
  );
}
