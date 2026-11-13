"use client";

import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  Brain,
  ChevronRight,
  Info,
  ListTree,
  LoaderCircle,
  MessageSquareText,
  Network,
  ScrollText,
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
import {
  type StepAction,
  type SubagentChange,
  type TimelineItem,
  type ToolAction,
  buildTimeline,
  parseToolCall,
} from "@/lib/run-log";
import type { Run, RunEvent, RunStatus, SubagentSnapshot } from "@/lib/types";
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
import { ACTIVITY_ICON } from "@/components/visualize/activity-icons";
import { toolActivityKind } from "@/components/visualize/activity";

const PAGE_SIZE = 500;
const COLLAPSED_RUN_COUNT = 3;
/** Distance from the bottom (px) still treated as "following" the log. */
const STICK_THRESHOLD = 48;
/** A step with more actions than this shows only `ACTIONS_PEEK` of them until expanded. */
const ACTIONS_INLINE = 5;
const ACTIONS_PEEK = 3;
/** Text longer than this (or with more lines than its clamp) gets a "Show more" toggle. */
const CLAMP_CHARS = 220;
/** localStorage keys of the view preferences. */
const WRAP_KEY = "omp-ui:agent-log-wrap";
const VIEW_KEY = "omp-ui:agent-log-view";
/** Tools whose recorded detail is code (a shell command) rather than prose. */
const CODE_TOOLS: Record<string, true> = { bash: true };

type LogView = "steps" | "raw";

/**
 * Monospace output in the raw view wraps by default; with wrapping off it keeps its lines and
 * the timeline scrolls sideways inside its own box (driven by `data-wrap` on `group/log`).
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

function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not persisted (private mode); the choice still applies.
  }
}

/** Prose clamped to a few lines, with a toggle when there is more to read. */
function ClampText({ text, lines = 3, className }: { text: string; lines?: 2 | 3; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > CLAMP_CHARS || text.split("\n").length > lines;
  return (
    <div className={cn("min-w-0", className)}>
      <p
        className={cn(
          "whitespace-pre-wrap break-words",
          !open && long && (lines === 2 ? "line-clamp-2" : "line-clamp-3"),
        )}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="relative mt-0.5 text-xs font-medium text-muted-foreground outline-none after:absolute after:-inset-2 hover:text-foreground focus-visible:underline"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** Time into the run ("3m 05s"), with the wall-clock time as tooltip. */
function Offset({ at, start }: { at: string; start: string }) {
  return (
    <time
      dateTime={at}
      title={formatDateTime(at)}
      className="shrink-0 text-[11px] text-muted-foreground/80 tabular-nums"
    >
      {formatDuration(new Date(at).getTime() - new Date(start).getTime())}
    </time>
  );
}

/** One event as recorded, for the raw view. */
function RawEventLine({ event }: { event: RunEvent }) {
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
    case "agent":
      return (
        <div className={cn("font-mono text-xs leading-relaxed text-muted-foreground", MONO_WRAP)}>{event.text}</div>
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

/**
 * One tool call: what it was for (its intent, else what it touched) on one line; tap it for the
 * exact command or arguments and the error of a failed call.
 */
function ToolActionRow({ action }: { action: ToolAction }) {
  const { name, detail, intent } = action.call;
  const kind = toolActivityKind(name);
  const Icon = ACTIVITY_ICON[kind.icon];
  const failed = action.error !== undefined;
  const codeDetail = detail !== undefined && (CODE_TOOLS[name] === true || detail.startsWith("{"));
  const title = intent ?? detail ?? kind.label;
  const titleIsCode = !intent && codeDetail;
  const expandable = detail !== undefined || (failed && action.error !== "");
  const row = (
    <>
      <Icon className={cn("size-3.5 shrink-0", failed ? "text-destructive" : "text-muted-foreground")} />
      <span className={cn("min-w-0 flex-1 truncate", titleIsCode && "font-mono text-xs")}>{title}</span>
      {failed && (
        <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive dark:bg-destructive/20">
          Failed
        </span>
      )}
    </>
  );
  const rowClass = "flex min-h-9 items-center gap-2 rounded-md px-1.5 text-[13px] leading-snug md:min-h-8";
  if (!expandable) {
    return (
      <li data-testid="log-action" className={rowClass} title={`${kind.label} (${name})`}>
        {row}
      </li>
    );
  }
  return (
    <li data-testid="log-action">
      <details className="group/action">
        <summary
          title={`${kind.label} (${name})`}
          className={cn(
            rowClass,
            "cursor-pointer list-none outline-none select-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden",
          )}
        >
          {row}
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/action:rotate-90" />
        </summary>
        <div className="mt-1 mb-2 ml-7 flex flex-col gap-1.5">
          <span className="text-[11px] text-muted-foreground">
            {kind.label} · <span className="font-mono">{name}</span>
          </span>
          {detail !== undefined && (
            <pre
              className={cn(
                "max-h-60 overflow-auto rounded-md bg-muted px-2.5 py-1.5 text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere",
                codeDetail ? "font-mono" : "font-sans",
              )}
            >
              {detail}
            </pre>
          )}
          {failed && action.error !== "" && (
            <pre className="max-h-60 overflow-auto rounded-md bg-destructive/10 px-2.5 py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere text-destructive dark:bg-destructive/20">
              {action.error}
            </pre>
          )}
        </div>
      </details>
    </li>
  );
}

/** "Delegated to …" / "Finished: …" marker; each chip jumps to the agent's card. */
function SubagentChanges({ runId, changes }: { runId: string; changes: SubagentChange[] }) {
  const spawned = changes[0].change === "spawned";
  return (
    <li className="flex min-h-9 flex-wrap items-center gap-1.5 px-1.5 py-1 text-xs text-muted-foreground md:min-h-8">
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
    </li>
  );
}

/** "read ×5 · bash ×3" for a set of actions. */
function actionBreakdown(actions: StepAction[]): string {
  const byTool = new Map<string, number>();
  for (const action of actions) {
    if (action.type === "tool") byTool.set(action.call.name, (byTool.get(action.call.name) ?? 0) + 1);
  }
  const sorted = [...byTool].sort((a, b) => b[1] - a[1]);
  return (
    sorted
      .slice(0, 3)
      .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
      .join(" · ") + (sorted.length > 3 ? " …" : "")
  );
}

/**
 * The actions of a step; a long list shows its first few (the latest few while it is the live
 * tail) behind a "N more" toggle.
 */
function StepActions({ runId, actions, live }: { runId: string; actions: StepAction[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const folded = !open && actions.length > ACTIONS_INLINE;
  const shown = !folded ? actions : live ? actions.slice(-ACTIONS_PEEK) : actions.slice(0, ACTIONS_PEEK);
  const hidden = folded ? actions.filter((action) => !shown.includes(action)) : [];
  const hiddenFailures = hidden.filter((action) => action.type === "tool" && action.error !== undefined).length;
  const toggle = actions.length > ACTIONS_INLINE && (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-9 w-full items-center gap-2 rounded-md px-1.5 text-left text-xs text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 md:min-h-8"
      >
        <ListTree className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium">
          {open ? "Show fewer" : `${live ? "" : "+"}${hidden.length} ${live ? "earlier" : "more"}`}
        </span>
        {!open && <span className="min-w-0 truncate font-mono text-[11px]">{actionBreakdown(hidden)}</span>}
        {!open && hiddenFailures > 0 && (
          <span className="shrink-0 text-destructive tabular-nums">{hiddenFailures} failed</span>
        )}
      </button>
    </li>
  );
  return (
    <ul className="flex flex-col" data-testid="step-actions">
      {folded && live && toggle}
      {shown.map((action) =>
        action.type === "tool" ? (
          <ToolActionRow key={action.key} action={action} />
        ) : (
          <SubagentChanges key={action.key} runId={runId} changes={action.changes} />
        ),
      )}
      {!(folded && live) && toggle}
    </ul>
  );
}

/** Marker on the timeline rail. */
function RailDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute top-[3px] -left-[21.5px] size-2.5 rounded-full bg-muted-foreground/40 ring-4 ring-background",
        className,
      )}
    />
  );
}

/** One timeline entry: a step (what the agent thought or said, then did), a status line or an error. */
function TimelineEntry({
  item,
  runId,
  start,
  live,
  final,
}: {
  item: TimelineItem;
  runId: string;
  start: string;
  /** The live tail of a running run. */
  live: boolean;
  /** The run's closing message. */
  final: boolean;
}) {
  if (item.type === "status") {
    return (
      <li className="relative">
        <RailDot className="top-[4px] -left-[20.5px] size-2 bg-border" />
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0" />
          <ClampText text={item.event.text} lines={2} className="flex-1" />
          <Offset at={item.event.createdAt} start={start} />
        </div>
      </li>
    );
  }
  if (item.type === "error") {
    return (
      <li className="relative">
        <RailDot className="bg-destructive" />
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive dark:bg-destructive/20">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <ClampText text={item.event.text} className="flex-1 font-mono" />
        </div>
      </li>
    );
  }
  const { lead, actions } = item;
  const at = lead?.createdAt ?? (actions[0]?.type === "tool" ? actions[0].event.createdAt : undefined);
  const heading =
    lead?.kind === "text"
      ? { icon: MessageSquareText, label: final ? "Summary" : "Message" }
      : lead
        ? { icon: Brain, label: "Thinking" }
        : { icon: Wrench, label: "Actions" };
  const HeadingIcon = heading.icon;
  return (
    <li className="relative" data-testid="log-step">
      <RailDot className={cn(lead?.kind === "text" && "bg-primary")} />
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <HeadingIcon className="size-3.5" />
        {heading.label}
        {at && (
          <>
            <span aria-hidden className="text-muted-foreground/50">
              ·
            </span>
            <Offset at={at} start={start} />
          </>
        )}
      </div>
      {lead?.kind === "text" ? (
        <div className={cn("rounded-lg border px-3 py-2", final ? "border-primary/30 bg-primary/5" : "bg-muted/30")}>
          <RichText text={lead.text} className="text-sm leading-relaxed" />
        </div>
      ) : (
        lead && <ClampText text={lead.text} className="text-sm leading-relaxed text-foreground/85" />
      )}
      {actions.length > 0 && (
        <div className={cn(lead && "mt-1.5", "-mx-1.5")}>
          <StepActions runId={runId} actions={actions} live={live} />
        </div>
      )}
    </li>
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
      const { name } = parseToolCall(event.text);
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

function WorkingIndicator() {
  return (
    <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-500 opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-sky-500" />
      </span>
      Working…
    </div>
  );
}

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
  // "steps": readable timeline (default); "raw": every event as recorded.
  const [view, setViewState] = useState<LogView>("steps");
  // Raw view: wrap long monospace lines (default) or keep them and scroll the timeline sideways.
  const [wrap, setWrapState] = useState(true);
  useEffect(() => {
    setViewState(readPreference(VIEW_KEY) === "raw" ? "raw" : "steps");
    setWrapState(readPreference(WRAP_KEY) !== "false");
  }, []);
  const setView = (next: LogView) => {
    setViewState(next);
    writePreference(VIEW_KEY, next);
  };
  const setWrap = (next: boolean) => {
    setWrapState(next);
    writePreference(WRAP_KEY, String(next));
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

  const items = useMemo(() => buildTimeline(events), [events]);
  // The run's closing message: its last message, unless the agent did more after it.
  const finalKey = useMemo(() => {
    const last = items.findLast((item) => item.type === "step");
    return last?.type === "step" && last.lead?.kind === "text" && last.actions.length === 0 ? last.key : null;
  }, [items]);
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
  }, [items, live, visible, running, scrollToEnd]);

  if (sortedRuns.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Terminal className="size-5" />
        </span>
        <p className="max-w-xs text-sm text-muted-foreground">
          No runs yet. Press Start to run the agent.
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
        <div data-wrap={view === "raw" ? wrap : true} className="group/log flex min-w-0 flex-col gap-3">
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
            <div className="ml-auto flex items-center gap-1">
              {view === "raw" && (
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
              )}
              <div role="radiogroup" aria-label="Log view" className="inline-flex rounded-lg bg-muted p-0.5">
                {(
                  [
                    { value: "steps", label: "Steps", icon: ListTree, title: "What the agent did, step by step" },
                    { value: "raw", label: "Raw", icon: ScrollText, title: "Every event as recorded" },
                  ] as const
                ).map(({ value, label, icon: Icon, title }) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={view === value}
                    title={title}
                    onClick={() => setView(value)}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 max-md:h-10 max-md:px-3",
                      view === value
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="size-3.5" />
                    {label}
                  </button>
                ))}
              </div>
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
          {loadedRunId !== runId && events.length === 0 ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              Loading log…
            </div>
          ) : events.length === 0 && !running ? (
            <p className="py-4 text-sm text-muted-foreground">No output recorded for this run.</p>
          ) : view === "steps" ? (
            <ol data-testid="log-steps" className="mt-1 ml-[5px] flex min-w-0 flex-col gap-4 border-l pl-4">
              {items.map((item, i) => (
                <TimelineEntry
                  key={item.key}
                  item={item}
                  runId={selectedRun.id}
                  start={selectedRun.startedAt}
                  live={running && !live && i === items.length - 1}
                  final={!running && item.key === finalKey}
                />
              ))}
              {running && (
                <li className="relative">
                  <RailDot className="bg-sky-500 motion-safe:animate-pulse" />
                  {live ? <LiveBlock live={live} /> : <WorkingIndicator />}
                </li>
              )}
            </ol>
          ) : (
            <div
              data-vaul-no-drag
              className="flex min-w-0 flex-col gap-2.5 group-data-[wrap=false]/log:overflow-x-auto group-data-[wrap=false]/log:overscroll-x-contain group-data-[wrap=false]/log:pb-2"
            >
              {events.map((event) => (
                <RawEventLine key={event.seq} event={event} />
              ))}
              {running && (live ? <LiveBlock live={live} /> : <WorkingIndicator />)}
            </div>
          )}
          <div ref={endRef} />
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
