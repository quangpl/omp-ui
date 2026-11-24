"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ListTreeIcon, RowsIcon, SearchIcon } from "lucide-react";
import { SubagentStatusIcon } from "@/components/board/run-agents";
import { formatDateTime, formatDuration, formatRelative } from "@/components/board/format";
import { cardHref } from "@/components/home/shared";
import { compactNumber, errorMessage, usd, wholeNumber } from "@/components/stats/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import type { AgentHubActivity, AgentHubAgent, AgentHubData, SubagentSnapshot } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ACTIVITY_FILTERS,
  type ActivityFilter,
  type HubCard,
  type HubRow,
  HUB_STATUS_LABEL,
  type SeenSnapshots,
  childrenOf,
  filterActivity,
  filterAgents,
  flatRows,
  hasUsage,
  mergeLive,
  subtreeKeys,
  toolActivity,
  totals,
  treeGroups,
} from "./agent-hub-model";
import { modelLabel } from "./roles";
import type { LiveAgent } from "./use-live-agents";

/** Rows drawn before "Show more". */
const PAGE = 60;
const ACTIVITY_PAGE = 100;
/** Tool calls of live agents kept in the activity log (the server cannot persist them). */
const TOOL_LOG_MAX = 200;
/** Wait after the live agent set changes before reloading the roster. */
const LIVE_RELOAD_MS = 800;

const money = (value: number) => (value > 0 && value < 0.01 ? "<$0.01" : usd.format(value));

const STATUS_TEXT: Record<SubagentSnapshot["status"], string> = {
  running: "text-primary",
  pending: "text-muted-foreground",
  completed: "text-success",
  failed: "text-destructive",
  aborted: "text-muted-foreground",
};

const KIND_STYLE: Record<AgentHubActivity["kind"], { label: string; className: string }> = {
  lifecycle: { label: "Status", className: "bg-muted text-muted-foreground" },
  response: { label: "Response", className: "bg-success/15 text-success" },
  tool: { label: "Tool", className: "bg-primary/10 text-primary" },
  error: { label: "Error", className: "bg-destructive/10 text-destructive" },
};

function StatusBadge({ status }: { status: SubagentSnapshot["status"] }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", STATUS_TEXT[status])}>
      <SubagentStatusIcon status={status} />
      {HUB_STATUS_LABEL[status]}
    </span>
  );
}

/** What it works on now, or what it was assigned. */
function currentLine(s: SubagentSnapshot): string {
  if (s.status === "running" && s.currentTool) return `${s.currentTool}${s.currentToolDetail ? `: ${s.currentToolDetail}` : ""}`;
  if (s.status === "failed" && s.error) return s.error;
  return s.intent ?? s.description ?? s.task ?? "";
}

/** cost · active time · requests · tool calls · tokens, or `usage —` when omp reported none. */
function Metrics({ s }: { s: SubagentSnapshot }) {
  if (!hasUsage(s)) return <span className="text-muted-foreground">usage —</span>;
  const parts = [
    s.cost !== undefined && money(s.cost),
    s.durationMs !== undefined && formatDuration(s.durationMs),
    s.requests !== undefined && `${wholeNumber.format(s.requests)} req`,
    s.toolCount !== undefined && `${wholeNumber.format(s.toolCount)} tools`,
    s.tokens !== undefined && `${compactNumber.format(s.tokens)} tok`,
  ].filter(Boolean);
  return <span>{parts.join(" · ")}</span>;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 bg-background p-3">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate font-mono text-lg font-semibold tabular-nums">{value}</p>
      {sub && <p className="truncate font-mono text-xs text-muted-foreground tabular-nums">{sub}</p>}
    </div>
  );
}

/** Status counts and usage across the listed agents, like the header of omp's Agent Hub. */
function Summary({ agents }: { agents: readonly AgentHubAgent[] }) {
  const sum = useMemo(() => totals(agents), [agents]);
  const { counts } = sum;
  const active = counts.running + counts.pending;
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[3px] border bg-border sm:grid-cols-3 lg:grid-cols-6">
      <Stat
        label="Agents"
        value={wholeNumber.format(agents.length)}
        sub={`${counts.running} running · ${counts.pending} queued`}
      />
      <Stat
        label="Finished"
        value={wholeNumber.format(counts.completed + counts.failed + counts.aborted)}
        sub={`${counts.completed} parked · ${counts.failed} failed · ${counts.aborted} aborted`}
      />
      <Stat label="Cost" value={money(sum.cost)} sub={active > 0 ? `${active} still spending` : undefined} />
      <Stat label="Requests" value={wholeNumber.format(sum.requests)} sub={`${wholeNumber.format(sum.toolCalls)} tool calls`} />
      <Stat label="Tokens" value={compactNumber.format(sum.tokens)} />
      <Stat label="Active time" value={formatDuration(sum.durationMs)} sub={`${sum.measured} of ${agents.length} measured`} />
    </div>
  );
}

function AgentRow({
  row,
  selected,
  showCard,
  now,
  onSelect,
}: {
  row: HubRow;
  selected: boolean;
  showCard: boolean;
  now: number;
  onSelect: (key: string) => void;
}) {
  const { agent, depth } = row;
  const s = agent.snapshot;
  const line = currentLine(s);
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(agent.key)}
        style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}
        className={cn(
          "grid w-full min-w-0 gap-1 border-b py-2.5 pr-3 text-left transition-colors outline-none last:border-b-0 focus-visible:ring-3 focus-visible:ring-ring/50",
          selected ? "bg-muted" : "hover:bg-muted/50",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <SubagentStatusIcon status={s.status} />
          <span className="min-w-0 truncate font-mono text-sm font-medium" title={s.id}>
            {s.id}
          </span>
          <span className="shrink-0 rounded-[3px] bg-muted px-1.5 py-px text-xs text-muted-foreground">{s.agent}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums" title={formatDateTime(agent.lastActivityAt)}>
            {formatRelative(agent.lastActivityAt, now)}
          </span>
        </span>
        {(showCard || s.model) && (
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {showCard && (
              <span className="min-w-0 truncate" title={`${agent.boardName}: ${agent.taskTitle}`}>
                in {agent.taskTitle}
              </span>
            )}
            {s.model && (
              <span className="ml-auto shrink-0 font-mono" title={s.model}>
                {modelLabel(s.model)}
              </span>
            )}
          </span>
        )}
        {line && <span className="truncate text-sm text-muted-foreground">{line}</span>}
        <span className="truncate font-mono text-xs text-muted-foreground tabular-nums">
          <Metrics s={s} />
        </span>
      </button>
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <h4 className="text-xs font-medium text-muted-foreground uppercase">{title}</h4>
      {children}
    </div>
  );
}

function AgentLink({ agent, onSelect }: { agent: AgentHubAgent; onSelect: (key: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(agent.key)}
      className="flex min-w-0 items-center gap-2 rounded-[3px] px-1.5 py-1 text-left text-sm hover:bg-muted"
    >
      <SubagentStatusIcon status={agent.snapshot.status} />
      <span className="min-w-0 truncate font-mono">{agent.snapshot.id}</span>
    </button>
  );
}

/** The selected agent in detail, like the inspector of omp's Agent Hub. */
function Inspector({
  agent,
  agents,
  now,
  onSelect,
}: {
  agent: AgentHubAgent;
  agents: readonly AgentHubAgent[];
  now: number;
  onSelect: (key: string) => void;
}) {
  const s = agent.snapshot;
  const parent = agent.parentId ? agents.find((a) => a.runId === agent.runId && a.snapshot.id === agent.parentId) : undefined;
  const children = childrenOf(agents, agent);
  return (
    <div className="grid min-w-0 content-start gap-4 p-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="min-w-0 truncate font-mono text-base font-semibold" title={s.id}>
            {s.id}
          </h3>
          <StatusBadge status={s.status} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {s.agent}
          {s.model && (
            <>
              {" · "}
              <span className="font-mono" title={s.model}>
                {modelLabel(s.model)}
              </span>
            </>
          )}
          {" · active "}
          <span title={formatDateTime(agent.lastActivityAt)}>{formatRelative(agent.lastActivityAt, now)}</span>
        </p>
      </div>

      {s.status === "running" && (s.currentTool || s.intent) && (
        <Section title="Now">
          {s.currentTool && (
            <p className="font-mono text-sm break-words">
              {s.currentTool}
              {s.currentToolDetail && <span className="text-muted-foreground">: {s.currentToolDetail}</span>}
            </p>
          )}
          {s.intent && <p className="text-sm text-muted-foreground">{s.intent}</p>}
        </Section>
      )}

      {(s.description || s.task) && (
        <Section title="Assignment">
          {s.description && <p className="text-sm font-medium">{s.description}</p>}
          {s.task && <p className="text-sm whitespace-pre-wrap text-muted-foreground">{s.task}</p>}
        </Section>
      )}

      <Section title="Usage">
        {hasUsage(s) ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm tabular-nums">
            {s.cost !== undefined && <MetricItem label="cost" value={money(s.cost)} />}
            {s.durationMs !== undefined && <MetricItem label="active" value={formatDuration(s.durationMs)} />}
            {s.requests !== undefined && <MetricItem label="requests" value={wholeNumber.format(s.requests)} />}
            {s.toolCount !== undefined && <MetricItem label="tool calls" value={wholeNumber.format(s.toolCount)} />}
            {s.tokens !== undefined && <MetricItem label="tokens" value={compactNumber.format(s.tokens)} />}
            {s.contextTokens !== undefined && <MetricItem label="context" value={`${compactNumber.format(s.contextTokens)} tok`} />}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">usage —</p>
        )}
      </Section>

      <Section title="Lineage">
        <p className="text-sm text-muted-foreground">
          Card{" "}
          <Link
            href={cardHref({ boardId: agent.boardId, id: agent.taskId })}
            className="text-foreground underline-offset-2 hover:underline"
          >
            {agent.taskTitle}
          </Link>
          {agent.boardName && ` · ${agent.boardName}`}
        </p>
        {agent.parentId && (parent ? <AgentLink agent={parent} onSelect={onSelect} /> : <p className="font-mono text-sm">{agent.parentId}</p>)}
        {children.length > 0 && (
          <ul className="grid">
            {children.map((child) => (
              <li key={child.key} className="min-w-0">
                <AgentLink agent={child} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {s.recentTools && s.recentTools.length > 0 && (
        <Section title="Recent tools">
          <ul className="grid gap-0.5 font-mono text-xs">
            {s.recentTools.map((call, i) => (
              <li key={i} className={cn("truncate", call.isError && "text-destructive")} title={call.detail}>
                {call.tool}
                {call.detail && <span className="text-muted-foreground">: {call.detail}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {s.recentOutput && s.recentOutput.length > 0 && s.status === "running" && (
        <Section title="Output">
          <pre className="max-h-40 overflow-auto font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
            {[...s.recentOutput].reverse().join("\n")}
          </pre>
        </Section>
      )}

      {s.error && (
        <Section title="Error">
          <p className="text-sm break-words whitespace-pre-wrap text-destructive">{s.error}</p>
        </Section>
      )}

      {s.output && (
        <Section title="Final report">
          <p className="max-h-72 overflow-auto text-sm break-words whitespace-pre-wrap">{s.output}</p>
        </Section>
      )}
    </div>
  );
}

function MetricItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <dt className="font-sans text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  );
}

function ActivityLog({
  lines,
  now,
  onOpen,
}: {
  lines: readonly AgentHubActivity[];
  now: number;
  onOpen: (agentKey: string) => void;
}) {
  const [limit, setLimit] = useState(ACTIVITY_PAGE);
  if (lines.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">No activity matches.</p>;
  return (
    <>
      <ul>
        {lines.slice(0, limit).map((line) => (
          <li key={line.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-b px-3 py-2 last:border-b-0 sm:grid-cols-[5.5rem_auto_minmax(0,1fr)]">
            <span className="text-xs text-muted-foreground tabular-nums" title={formatDateTime(line.at)}>
              {formatRelative(line.at, now)}
            </span>
            <span className={cn("h-fit w-fit rounded-[3px] px-1.5 py-px text-xs", KIND_STYLE[line.kind].className)}>
              {KIND_STYLE[line.kind].label}
            </span>
            <div className="col-span-2 min-w-0 sm:col-span-1">
              <button
                type="button"
                onClick={() => onOpen(line.agentKey)}
                className="mr-2 font-mono text-xs font-medium underline-offset-2 hover:underline"
              >
                {line.agentId}
              </button>
              <span className="text-sm break-words text-muted-foreground">{line.text}</span>
            </div>
          </li>
        ))}
      </ul>
      {lines.length > limit && (
        <div className="border-t p-2 text-center">
          <Button variant="ghost" size="sm" onClick={() => setLimit((n) => n + ACTIVITY_PAGE)}>
            Show more ({lines.length - limit})
          </Button>
        </div>
      )}
    </>
  );
}

function HubSkeleton() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-24 w-full rounded-[3px]" />
      <div className="grid gap-4 lg:grid-cols-5">
        <Skeleton className="h-72 w-full rounded-[3px] lg:col-span-3" />
        <Skeleton className="h-72 w-full rounded-[3px] lg:col-span-2" />
      </div>
    </div>
  );
}

function Toggle<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { id: T; label: ReactNode; title?: string }[];
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex overflow-hidden rounded-[3px] border">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          title={option.title}
          onClick={() => onChange(option.id)}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 border-r px-3 text-sm outline-none last:border-r-0 focus-visible:ring-3 focus-visible:ring-ring/50 md:h-8",
            value === option.id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type View = "agents" | "activity";
type Layout = "flat" | "tree";
type Scope = "all" | "agent" | "subtree";

/**
 * The roster of omp's Agent Hub rendered here: every subagent of the recent runs with its status,
 * model, age, assignment or current activity and usage, an inspector for the selected one and the
 * combined activity log. Persisted state comes from GET /agent-hub; `live` (the page's event
 * stream) keeps running agents current between loads.
 */
export function AgentHub({
  refreshKey,
  live,
  cards,
  now,
}: {
  /** Reload the roster when this changes. */
  refreshKey: string | number;
  live: Readonly<Record<string, LiveAgent>>;
  /** Cards of the running agents, to place subagents the server has not listed yet. */
  cards: ReadonlyMap<string, HubCard>;
  now: number;
}) {
  const [data, setData] = useState<AgentHubData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("agents");
  const [layout, setLayout] = useState<Layout>("flat");
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [scope, setScope] = useState<Scope>("all");
  const [toolLog, setToolLog] = useState<AgentHubActivity[]>([]);
  const seen = useRef<SeenSnapshots>(new Map());
  const seenTools = useRef<ReadonlyMap<string, string>>(new Map());
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const next = await api.agentHub();
      if (seq !== loadSeq.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (seq === loadSeq.current) setError(errorMessage(err, "Could not load the agent hub"));
    }
  }, []);

  // Subagents appear and finish while their card runs; reload shortly after the live set changes.
  const liveSignature = useMemo(
    () =>
      Object.values(live)
        .flatMap((entry) => (entry.runId ? Object.keys(entry.helpers).map((id) => `${entry.runId}:${id}`) : []))
        .sort()
        .join("|"),
    [live],
  );
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), data === null ? 0 : LIVE_RELOAD_MS);
    return () => window.clearTimeout(timer);
    // `data === null` only decides the first delay; reloading on its change would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, liveSignature, load]);

  const merged = useMemo(
    () => mergeLive(data?.agents ?? [], live, cards, seen.current, new Date().toISOString()),
    [data, live, cards],
  );

  useEffect(() => {
    const { next, lines } = toolActivity(seenTools.current, merged.agents, merged.liveKeys, new Date().toISOString());
    seenTools.current = next;
    if (lines.length > 0) setToolLog((prev) => [...lines, ...prev].slice(0, TOOL_LOG_MAX));
  }, [merged]);

  const activity = useMemo(
    () => [...toolLog, ...(data?.activity ?? [])].sort((a, b) => b.at.localeCompare(a.at)),
    [toolLog, data],
  );

  const visible = useMemo(() => filterAgents(merged.agents, query), [merged.agents, query]);
  const flat = useMemo(() => flatRows(visible), [visible]);
  const groups = useMemo(() => treeGroups(visible), [visible]);
  const selected = merged.agents.find((a) => a.key === selectedKey) ?? flat[0]?.agent ?? null;

  const scopeKeys = useMemo(() => {
    if (!selected || scope === "all") return null;
    return scope === "agent" ? new Set([selected.key]) : subtreeKeys(merged.agents, selected);
  }, [selected, scope, merged.agents]);
  const lines = useMemo(() => filterActivity(activity, filter, query, scopeKeys), [activity, filter, query, scopeKeys]);

  const select = useCallback((key: string) => setSelectedKey(key), []);
  const openFromActivity = useCallback((key: string) => {
    setSelectedKey(key);
    setView("agents");
  }, []);

  let body: ReactNode;
  if (data === null) body = error ? <HubError message={error} onRetry={() => void load()} /> : <HubSkeleton />;
  else if (merged.agents.length === 0) {
    body = (
      <p className="py-10 text-center text-sm text-muted-foreground">
        No subagents yet. When a card's agent delegates work, its crew shows up here.
      </p>
    );
  } else {
    body = (
      <div className="grid gap-4">
        <Summary agents={merged.agents} />
        <div className="flex flex-wrap items-center gap-2">
          <Toggle
            label="Section"
            value={view}
            onChange={setView}
            options={[
              { id: "agents", label: `Agents ${merged.agents.length}` },
              { id: "activity", label: "Activity" },
            ]}
          />
          {view === "agents" ? (
            <Toggle
              label="Layout"
              value={layout}
              onChange={setLayout}
              options={[
                { id: "flat", label: <RowsIcon className="size-4" />, title: "Flat roster, most urgent first" },
                { id: "tree", label: <ListTreeIcon className="size-4" />, title: "Cards with their subagent tree" },
              ]}
            />
          ) : (
            <>
              <Toggle
                label="Kind"
                value={filter}
                onChange={setFilter}
                options={ACTIVITY_FILTERS.map(({ id, label }) => ({ id, label }))}
              />
              <Toggle
                label="Scope"
                value={scope}
                onChange={setScope}
                options={[
                  { id: "all", label: "All agents" },
                  { id: "agent", label: "Selected" },
                  { id: "subtree", label: "Subtree" },
                ]}
              />
            </>
          )}
          <div className="relative min-w-40 flex-1 sm:max-w-xs">
            <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={view === "agents" ? "Filter by id, model or card" : "Search activity"}
              aria-label={view === "agents" ? "Filter agents" : "Search activity"}
              className="pl-8"
            />
          </div>
        </div>

        {view === "agents" ? (
          <div className="grid gap-4 lg:grid-cols-5">
            <div className="min-w-0 rounded-[3px] border lg:col-span-3">
              {visible.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No agents match.</p>
              ) : layout === "flat" ? (
                <>
                  <ul>
                    {flat.slice(0, limit).map((row) => (
                      <AgentRow key={row.agent.key} row={row} selected={row.agent.key === selected?.key} showCard now={now} onSelect={select} />
                    ))}
                  </ul>
                  {flat.length > limit && (
                    <div className="border-t p-2 text-center">
                      <Button variant="ghost" size="sm" onClick={() => setLimit((n) => n + PAGE)}>
                        Show more ({flat.length - limit})
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                groups.map((group) => (
                  <div key={group.runId} className="border-b last:border-b-0">
                    <div className="flex min-w-0 items-baseline gap-2 bg-muted/40 px-3 py-1.5 text-xs">
                      <Link
                        href={cardHref({ boardId: group.boardId, id: group.taskId })}
                        className="min-w-0 truncate font-medium underline-offset-2 hover:underline"
                      >
                        {group.title}
                      </Link>
                      <span className="shrink-0 text-muted-foreground">{group.boardName}</span>
                    </div>
                    <ul>
                      {group.rows.map((row) => (
                        <AgentRow key={row.agent.key} row={row} selected={row.agent.key === selected?.key} showCard={false} now={now} onSelect={select} />
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>
            <div className="min-w-0 rounded-[3px] border lg:sticky lg:top-4 lg:col-span-2 lg:max-h-[calc(100dvh-2rem)] lg:self-start lg:overflow-y-auto">
              {selected ? (
                <Inspector agent={selected} agents={merged.agents} now={now} onSelect={select} />
              ) : (
                <p className="p-6 text-sm text-muted-foreground">Select an agent to inspect it.</p>
              )}
            </div>
          </div>
        ) : (
          <div className="min-w-0 rounded-[3px] border">
            <ActivityLog lines={lines} now={now} onOpen={openFromActivity} />
          </div>
        )}
      </div>
    );
  }

  return (
    <section aria-labelledby="viz-agent-hub" className="min-w-0">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b pb-3">
        <h2 id="viz-agent-hub" className="text-2xl font-semibold tracking-tight">
          Agent hub
        </h2>
        <p className="font-mono text-xs text-muted-foreground tabular-nums">subagents across recent runs</p>
      </header>
      {error && data !== null && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          Couldn't refresh: {error}
        </p>
      )}
      {body}
    </section>
  );
}

function HubError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 py-4 text-sm text-muted-foreground">
      <p className="min-w-0 break-words">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
