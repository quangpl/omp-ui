"use client";

import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  Brain,
  ChevronRight,
  LoaderCircle,
  MessageSquareText,
  Network,
  Terminal,
  TextWrap,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api-client";
import { SUBAGENT_STATUS_LABELS, parseSubagent } from "@/lib/subagents";
import type { Run, RunEvent, RunStatus, SubagentSnapshot, SubagentStatus } from "@/lib/types";
import type { BoardStreamListener } from "@/hooks/use-board";
import {
  errorMessage,
  formatDateTime,
  formatDuration,
  formatRelative,
  useNow,
} from "@/components/board/format";
import { RichText } from "@/components/board/rich-text";
import { RunAgents, SubagentStatusIcon, subagentAnchor } from "@/components/board/run-agents";

const PAGE_SIZE = 500;
const COLLAPSED_RUN_COUNT = 3;
/** Distance from the bottom (px) still treated as "following" the log. */
const STICK_THRESHOLD = 48;
/** Consecutive tool calls beyond this fold into one expandable summary line. */
const TOOL_GROUP_INLINE = 3;
/** Lines of a folded tool group still shown while it is the live tail. */
const TOOL_GROUP_TAIL = 2;
/** localStorage key of the "wrap long lines" preference. */
const WRAP_KEY = "omp-ui:agent-log-wrap";
/**
 * Monospace output (tool calls, errors, prompt) wraps by default; with wrapping off it keeps its
 * lines and the timeline scrolls sideways inside its own box (driven by `data-wrap` on `group/log`).
 */
const MONO_WRAP =
  "whitespace-pre-wrap break-all group-data-[wrap=false]/log:whitespace-pre group-data-[wrap=false]/log:break-normal";

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

function withoutKey<V>(map: ReadonlyMap<string, V>, key: string): Map<string, V> {
  const next = new Map(map);
  next.delete(key);
  return next;
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
          <span className={cn("min-w-0", MONO_WRAP)}>{event.text.replace(/^▸\s*/, "")}</span>
        </div>
      );
    case "error":
      return (
        <div
          className={cn(
            "rounded-md bg-destructive/10 px-2.5 py-1.5 font-mono text-xs leading-relaxed text-destructive dark:bg-destructive/20",
            MONO_WRAP,
            "break-words group-data-[wrap=false]/log:w-max group-data-[wrap=false]/log:min-w-full",
          )}
        >
          {event.text}
        </div>
      );
    default:
      return <RichText text={event.text} className="text-sm leading-relaxed" />;
  }
}

/** "▸ bash: npm test" → "bash". */
function toolName(text: string): string {
  return text.replace(/^▸\s*/, "").split(":", 1)[0].trim() || "tool";
}

/** A failed tool call (`✗ bash failed: …`) belongs with the calls around it. */
function isToolFailure(event: RunEvent): boolean {
  return event.kind === "error" && event.text.startsWith("✗ ");
}

interface SubagentChange {
  agent: SubagentSnapshot;
  change: "spawned" | "ended";
}

type LogBlock =
  | { type: "event"; key: string; event: RunEvent }
  | { type: "tools"; key: string; events: RunEvent[] }
  | { type: "agents"; key: string; changes: SubagentChange[] };

/**
 * Arrange the raw event stream for reading: runs of tool calls become one group, and subagent
 * updates become "delegated"/"finished" markers (their full state lives in the Agents section).
 */
function arrangeEvents(events: RunEvent[]): LogBlock[] {
  const blocks: LogBlock[] = [];
  const seen = new Map<string, SubagentStatus>();
  for (const event of events) {
    const last = blocks.at(-1);
    if (event.kind === "tool" || isToolFailure(event)) {
      if (last?.type === "tools") last.events.push(event);
      else blocks.push({ type: "tools", key: `tools-${event.seq}`, events: [event] });
      continue;
    }
    if (event.kind === "agent") {
      const agent = parseSubagent(event.text);
      if (!agent) continue;
      const previous = seen.get(agent.id);
      seen.set(agent.id, agent.status);
      const ended = TERMINAL_SUBAGENT.has(agent.status);
      const change: SubagentChange["change"] | null =
        previous === undefined ? (ended ? "ended" : "spawned") : ended && previous !== agent.status ? "ended" : null;
      if (!change) continue;
      const lastChange = last?.type === "agents" ? last.changes.at(-1) : undefined;
      if (last?.type === "agents" && lastChange?.change === change) last.changes.push({ agent, change });
      else blocks.push({ type: "agents", key: `agents-${event.seq}`, changes: [{ agent, change }] });
      continue;
    }
    blocks.push({ type: "event", key: String(event.seq), event });
  }
  return blocks;
}

const TERMINAL_SUBAGENT = new Set<SubagentStatus>(["completed", "failed", "aborted"]);

/** A run of tool calls: inline when short, otherwise one expandable summary line. */
function ToolGroup({ events, live }: { events: RunEvent[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (events.length <= TOOL_GROUP_INLINE) {
    return events.map((event) => <EventLine key={event.seq} event={event} />);
  }
  const calls = events.filter((event) => event.kind === "tool");
  const failures = events.length - calls.length;
  const byTool = new Map<string, number>();
  for (const call of calls) byTool.set(toolName(call.text), (byTool.get(toolName(call.text)) ?? 0) + 1);
  const breakdown = [...byTool].sort((a, b) => b[1] - a[1]);
  const tail = !open && live ? events.slice(-TOOL_GROUP_TAIL) : [];
  return (
    <div className="flex flex-col gap-1.5" data-testid="tool-group">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="relative flex min-h-8 items-center gap-1.5 self-start rounded-md text-left text-xs text-muted-foreground outline-none select-none after:absolute after:-inset-y-1.5 after:inset-x-0 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <Wrench className="size-3.5 shrink-0" />
        <span className="font-medium tabular-nums">{calls.length} tool calls</span>
        <span className="truncate font-mono text-[11px]">
          {breakdown
            .slice(0, 4)
            .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
            .join(" · ")}
          {breakdown.length > 4 ? " …" : ""}
        </span>
        {failures > 0 && <span className="shrink-0 text-destructive tabular-nums">{failures} failed</span>}
      </button>
      {open ? (
        <div className="ml-1.5 flex flex-col gap-1.5 border-l-2 pl-3">
          {events.map((event) => (
            <EventLine key={event.seq} event={event} />
          ))}
        </div>
      ) : (
        tail.length > 0 && (
          <div className="ml-1.5 flex flex-col gap-1.5 border-l-2 border-dashed pl-3 opacity-80">
            {tail.map((event) => (
              <EventLine key={event.seq} event={event} />
            ))}
          </div>
        )
      )}
    </div>
  );
}

/** "Delegated to …" / "Finished: …" marker; each chip jumps to the agent's card. */
function SubagentChanges({ runId, changes }: { runId: string; changes: SubagentChange[] }) {
  const spawned = changes[0].change === "spawned";
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <Network className="size-3.5 shrink-0" />
      <span className="font-medium">{spawned ? "Delegated to" : "Finished"}</span>
      {changes.map(({ agent }) => (
        <button
          key={agent.id}
          type="button"
          title={spawned ? (agent.description ?? agent.task) : SUBAGENT_STATUS_LABELS[agent.status]}
          onClick={() => {
            const card = document.getElementById(subagentAnchor(runId, agent.id));
            card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
            card?.querySelector("details")?.setAttribute("open", "");
          }}
          className="inline-flex min-h-7 items-center gap-1 rounded-full border bg-background px-2 font-mono text-[11px] text-foreground/80 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {spawned ? (
            <span className="size-1.5 rounded-full bg-sky-500" />
          ) : (
            <SubagentStatusIcon status={agent.status} className="size-3" />
          )}
          {agent.id}
        </button>
      ))}
    </div>
  );
}

/** At-a-glance shape of the run: how much it did and through what. */
function RunOverview({ events, agents }: { events: RunEvent[]; agents: number }) {
  let tools = 0;
  let messages = 0;
  let errors = 0;
  const byTool = new Map<string, number>();
  for (const event of events) {
    if (event.kind === "tool") {
      tools++;
      const name = toolName(event.text);
      byTool.set(name, (byTool.get(name) ?? 0) + 1);
    } else if (event.kind === "text") messages++;
    else if (event.kind === "error") errors++;
  }
  const breakdown = [...byTool]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ×${count}`)
    .join(", ");
  const items = [
    tools > 0 && { icon: Wrench, label: `${tools} tool call${tools === 1 ? "" : "s"}`, title: breakdown },
    agents > 0 && { icon: Network, label: `${agents} agent${agents === 1 ? "" : "s"}` },
    messages > 0 && { icon: MessageSquareText, label: `${messages} message${messages === 1 ? "" : "s"}` },
    errors > 0 && { icon: TriangleAlert, label: `${errors} error${errors === 1 ? "" : "s"}`, danger: true },
  ].filter((item) => item !== false);
  if (items.length === 0) return null;
  return (
    <ul aria-label="Run overview" className="flex flex-wrap gap-1.5">
      {items.map(({ icon: Icon, label, title, danger }) => (
        <li
          key={label}
          title={title}
          className={cn(
            "inline-flex h-6 items-center gap-1 rounded-md bg-muted px-2 text-[11px] text-muted-foreground tabular-nums",
            danger && "bg-destructive/10 text-destructive dark:bg-destructive/20",
          )}
        >
          <Icon className="size-3" />
          {label}
        </li>
      ))}
    </ul>
  );
}

interface LiveOutput {
  kind: "text" | "thinking";
  /** Accumulated text of the message being written. */
  text: string;
}

const Caret = () => (
  <span
    aria-hidden
    className="ml-0.5 inline-block h-[1.1em] w-1.5 translate-y-[0.2em] animate-pulse rounded-[1px] bg-foreground/50"
  />
);

/** The agent's in-progress message, updated from `run.delta` until the persisted event lands. */
function LiveBlock({ live }: { live: LiveOutput }) {
  if (live.kind === "thinking") {
    return (
      <div data-testid="live-output" aria-live="polite" className="text-xs text-muted-foreground italic">
        <span className="inline-flex items-center gap-1.5 not-italic">
          <Brain className="size-3.5" />
          Thinking
        </span>
        <p className="mt-1 ml-1.5 line-clamp-2 border-l-2 pl-3 break-words">
          {live.text.slice(-400)}
          <Caret />
        </p>
      </div>
    );
  }
  return (
    <p
      data-testid="live-output"
      aria-live="polite"
      className="text-sm leading-relaxed whitespace-pre-wrap break-words"
    >
      {live.text}
      <Caret />
    </p>
  );
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
  // Wrap long monospace lines (default) or keep them and scroll the timeline sideways.
  const [wrap, setWrapState] = useState(true);
  useEffect(() => {
    try {
      setWrapState(localStorage.getItem(WRAP_KEY) !== "false");
    } catch {
      // Default.
    }
  }, []);
  const setWrap = (next: boolean) => {
    setWrapState(next);
    try {
      localStorage.setItem(WRAP_KEY, String(next));
    } catch {
      // Not persisted (private mode); the toggle still applies.
    }
  };
  const selectedRun =
    (pickedRunId && sortedRuns.find((run) => run.id === pickedRunId)) || sortedRuns[0] || null;
  const runId = selectedRun?.id ?? null;
  const running = selectedRun?.status === "running";
  const now = useNow(sortedRuns.some((run) => run.status === "running") ? 1000 : 30_000);

  const [events, setEvents] = useState<RunEvent[]>([]);
  const [loadedRunId, setLoadedRunId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Streaming preview of the message the agent is writing right now (selected run only).
  const [live, setLive] = useState<LiveOutput | null>(null);
  // Subagent progress published between their persisted `agent` events (selected run only).
  const [liveAgents, setLiveAgents] = useState<ReadonlyMap<string, SubagentSnapshot>>(new Map());
  useEffect(() => {
    setLive(null);
    setLiveAgents(new Map());
  }, [runId]);
  useEffect(() => {
    if (!running) {
      setLive(null);
      setLiveAgents(new Map());
    }
  }, [running]);
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
          const persisted = event.event;
          setEvents((prev) => mergeEvents(prev, [persisted]));
          if (persisted.kind === "agent") {
            // A persisted snapshot is newer than any live one before it.
            const id = parseSubagent(persisted.text)?.id;
            if (id) setLiveAgents((prev) => (prev.has(id) ? withoutKey(prev, id) : prev));
          } else {
            // The finished message replaces its streaming preview.
            setLive((prev) => (prev && prev.kind === persisted.kind ? null : prev));
          }
        } else if (event.type === "run.delta" && event.runId === runIdRef.current) {
          setLive({ kind: event.kind, text: event.text });
        } else if (event.type === "run.agent" && event.runId === runIdRef.current) {
          const { agent } = event;
          setLiveAgents((prev) => new Map(prev).set(agent.id, agent));
        }
      }),
    [subscribe],
  );

  const blocks = useMemo(() => arrangeEvents(events), [events]);
  const agents = useMemo(() => {
    const latest = new Map<string, SubagentSnapshot>();
    for (const event of events) {
      if (event.kind !== "agent") continue;
      const agent = parseSubagent(event.text);
      if (agent) latest.set(agent.id, agent);
    }
    for (const [id, agent] of liveAgents) if (latest.has(id)) latest.set(id, agent);
    return [...latest.values()];
  }, [events, liveAgents]);

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
  }, [blocks, live, visible, running, scrollToEnd]);

  if (sortedRuns.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Terminal className="size-5" />
        </span>
        <p className="max-w-xs text-sm text-muted-foreground">
          The agent hasn&apos;t run on this card yet. Press Start to run it.
        </p>
      </div>
    );
  }

  const visibleRuns = showAllRuns ? sortedRuns : sortedRuns.slice(0, COLLAPSED_RUN_COUNT);

  return (
    <div className="flex min-w-0 flex-col gap-5 px-4 py-5 md:px-5">
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
                      "flex min-h-11 w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-[background-color,border-color,transform] outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.99] md:min-h-10",
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
        <div data-wrap={wrap} className="group/log flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 text-xs text-muted-foreground">
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
            <div className="ml-auto flex items-center gap-1">
              {running && (
                <span
                  title={following ? "Scrolls with new output" : "Scroll to the end to follow again"}
                  className={cn(
                    "inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium",
                    following
                      ? "bg-sky-500/10 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 rounded-full",
                      following ? "bg-sky-500 motion-safe:animate-pulse" : "bg-muted-foreground/60",
                    )}
                  />
                  {following ? "Live" : "Paused"}
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                role="switch"
                aria-checked={wrap}
                title="Wrap long lines of tool calls, errors and the prompt"
                onClick={() => setWrap(!wrap)}
                className={cn(
                  "h-8 gap-1.5 px-2 text-xs text-muted-foreground max-md:h-11 max-md:px-3",
                  wrap && "bg-accent text-foreground",
                )}
              >
                <TextWrap />
                Wrap
              </Button>
            </div>
          </div>

          <RunOverview events={events} agents={agents.length} />

          {selectedRun.prompt && (
            <details className="group rounded-lg border text-xs">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-3 font-medium text-muted-foreground select-none md:min-h-9 [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                Prompt
              </summary>
              <pre className={cn("max-h-72 overflow-auto border-t px-3 py-2 font-mono leading-relaxed", MONO_WRAP, "break-words")}>
                {selectedRun.prompt}
              </pre>
            </details>
          )}

          {agents.length > 0 && <RunAgents runId={selectedRun.id} agents={agents} />}

          {agents.length > 0 && events.length > 0 && (
            <h3 className="-mb-1 text-xs font-medium text-muted-foreground">Timeline</h3>
          )}
          <div
            data-vaul-no-drag
            className="flex min-w-0 flex-col gap-2.5 group-data-[wrap=false]/log:overflow-x-auto group-data-[wrap=false]/log:overscroll-x-contain group-data-[wrap=false]/log:pb-2"
          >
            {loadedRunId !== runId && events.length === 0 ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                Loading log…
              </div>
            ) : events.length === 0 && !running ? (
              <p className="py-4 text-sm text-muted-foreground">No output recorded for this run.</p>
            ) : (
              blocks.map((block, i) =>
                block.type === "tools" ? (
                  <ToolGroup
                    key={block.key}
                    events={block.events}
                    live={running && !live && i === blocks.length - 1}
                  />
                ) : block.type === "agents" ? (
                  <SubagentChanges key={block.key} runId={selectedRun.id} changes={block.changes} />
                ) : (
                  <EventLine key={block.key} event={block.event} />
                ),
              )
            )}
            {running && live && <LiveBlock live={live} />}
            {running && !live && (
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
