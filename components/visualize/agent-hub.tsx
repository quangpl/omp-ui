"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { formatDateTime, formatRelative, useNow } from "@/components/board/format";
import { compactNumber, errorMessage, formatPercent, usd, wholeNumber } from "@/components/stats/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import type { AiStats } from "@/lib/types";
import { cn } from "@/lib/utils";

type Usage = AiStats["usage"];

/** Hourly bars drawn in the activity strip. */
const MAX_POINTS = 48;
const TOP_N = 6;

const ms = (value: number | null) =>
  value == null ? "-" : value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
const rate = (value: number | null) => (value == null ? "-" : value.toFixed(1));
const pct = (value: number | null) => (value == null ? "-" : formatPercent(value));
const cost = (value: number) => (value > 0 && value < 0.01 ? "<$0.01" : usd.format(value));

function Panel({
  title,
  note,
  children,
  className,
}: {
  title: string;
  note?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 rounded-[3px] border p-4", className)}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        {note && <span className="font-mono text-xs text-muted-foreground tabular-nums">{note}</span>}
      </div>
      {children}
    </div>
  );
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

/** Label, value text and a share bar scaled by transform (no layout animation). */
function ShareRow({ label, title, value, share }: { label: string; title?: string; value: string; share: number }) {
  return (
    <li className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="truncate" title={title ?? label}>
          {label}
        </span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{value}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-[2px] bg-muted">
        <div
          className="h-full origin-left bg-foreground/70"
          style={{ transform: `scaleX(${Math.max(0, Math.min(1, share))})` }}
        />
      </div>
    </li>
  );
}

function Activity({ series }: { series: Usage["series"] }) {
  const points = series.slice(-MAX_POINTS);
  const peak = Math.max(1, ...points.map((p) => p.requests));
  if (points.length === 0) return <p className="py-6 text-sm text-muted-foreground">No hourly activity recorded.</p>;
  return (
    <div
      className="flex h-28 items-end gap-px border-b"
      role="img"
      aria-label={`Requests per hour, last ${points.length} hours`}
    >
      {points.map((p) => (
        <div
          key={p.at}
          className="flex h-full min-w-0 flex-1 items-end"
          title={`${formatDateTime(p.at)}\n${wholeNumber.format(p.requests)} requests, ${compactNumber.format(p.tokens)} tokens, ${cost(p.costUsd)}`}
        >
          <div
            className="h-full w-full origin-bottom bg-foreground/70 hover:bg-foreground"
            style={{ transform: `scaleY(${p.requests / peak})` }}
          />
        </div>
      ))}
    </div>
  );
}

function Totals({ totals }: { totals: NonNullable<Usage["totals"]> }) {
  const failRate = totals.requests > 0 ? totals.failedRequests / totals.requests : 0;
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[3px] border bg-border sm:grid-cols-4 lg:grid-cols-7">
      <Stat label="Requests" value={wholeNumber.format(totals.requests)} />
      <Stat label="Failure rate" value={pct(failRate)} sub={`${wholeNumber.format(totals.failedRequests)} failed`} />
      <Stat
        label="Tokens in / out"
        value={`${compactNumber.format(totals.inputTokens)} / ${compactNumber.format(totals.outputTokens)}`}
      />
      <Stat label="Cost" value={cost(totals.costUsd)} />
      <Stat label="Cache rate" value={pct(totals.cacheRate)} />
      <Stat label="Avg tok/s" value={rate(totals.avgTokensPerSecond)} />
      <Stat label="Avg TTFT" value={ms(totals.avgTtftMs)} />
    </div>
  );
}

function Loaded({ usage, now }: { usage: Usage; now: number }) {
  const { totals } = usage;
  if (!totals || totals.requests === 0) {
    return (
      <p className="py-6 text-sm text-muted-foreground">
        No omp usage recorded yet. Run an agent and it will show up here.
      </p>
    );
  }
  const agents = [...usage.byAgent].sort((a, b) => b.requests - a.requests);
  const models = [...usage.byModel].sort((a, b) => b.requests - a.requests).slice(0, TOP_N);
  const folders = [...usage.byFolder].sort((a, b) => b.requests - a.requests).slice(0, TOP_N);
  const maxAgent = Math.max(1, ...agents.map((a) => a.requests));
  const maxModel = Math.max(1, ...models.map((m) => m.requests));
  const maxFolder = Math.max(1, ...folders.map((f) => f.requests));

  return (
    <div className="space-y-4">
      <Totals totals={totals} />
      {usage.scope && !usage.scope.breakdowns && (
        <p className="rounded-[3px] border border-dashed p-3 text-xs text-muted-foreground">
          Breakdowns are limited to the Main provider ({usage.scope.provider}); agent, project and hourly splits are
          unavailable while other providers have usage.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="min-w-0 space-y-4 lg:col-span-7">
          <Panel title="Activity" note={`requests per hour, last ${Math.min(usage.series.length, MAX_POINTS)}h`}>
            <Activity series={usage.series} />
          </Panel>
          <Panel title="Agents" note="requests / cost">
            {agents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No agent breakdown.</p>
            ) : (
              <ul className="space-y-3">
                {agents.map((a) => (
                  <ShareRow
                    key={a.agent}
                    label={a.agent}
                    value={`${wholeNumber.format(a.requests)} req / ${cost(a.costUsd)}`}
                    share={a.requests / maxAgent}
                  />
                ))}
              </ul>
            )}
          </Panel>
        </div>
        <div className="min-w-0 space-y-4 lg:col-span-5">
          <Panel title="Models" note="top by requests">
            {models.length === 0 ? (
              <p className="text-sm text-muted-foreground">No model breakdown.</p>
            ) : (
              <ul className="space-y-3">
                {models.map((m) => (
                  <ShareRow
                    key={`${m.provider}/${m.model}`}
                    label={m.model}
                    title={`${m.provider}/${m.model}`}
                    value={`${wholeNumber.format(m.requests)} req, ${m.failedRequests} err, ${rate(m.avgTokensPerSecond)} tok/s, ${cost(m.costUsd)}`}
                    share={m.requests / maxModel}
                  />
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Projects" note="top by requests">
            {folders.length === 0 ? (
              <p className="text-sm text-muted-foreground">No project breakdown.</p>
            ) : (
              <ul className="space-y-3">
                {folders.map((f) => (
                  <ShareRow
                    key={f.folder}
                    label={f.folder.replace(/^-+/, "")}
                    title={f.folder}
                    value={`${wholeNumber.format(f.requests)} req${f.lastAt ? `, ${formatRelative(f.lastAt, now)}` : ""}`}
                    share={f.requests / maxFolder}
                  />
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function HubSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <Skeleton className="h-[74px] w-full rounded-[3px]" />
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-7">
          <Skeleton className="h-48 w-full rounded-[3px]" />
          <Skeleton className="h-40 w-full rounded-[3px]" />
        </div>
        <div className="space-y-4 lg:col-span-5">
          <Skeleton className="h-56 w-full rounded-[3px]" />
          <Skeleton className="h-56 w-full rounded-[3px]" />
        </div>
      </div>
    </div>
  );
}

/** omp usage statistics (`omp stats --json`): totals, hourly activity, agents, models and projects. */
export function AgentHub({ refreshKey }: { refreshKey: number }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const mounted = useRef(false);
  const now = useNow();

  const load = useCallback(async (refresh: boolean) => {
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    let got: Usage | null = null;
    let failure: string | null = null;
    try {
      await api.stats.ai(refresh, (e) => {
        if (e.type === "usage") got = e.usage;
        else if (e.type === "error") failure = e.message;
      });
    } catch (err) {
      failure = errorMessage(err, "Could not load usage statistics");
    }
    if (id !== seq.current) return; // superseded by a newer load
    if (got) setUsage(got);
    setError(got ? null : (failure ?? "No usage data returned"));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(mounted.current);
    mounted.current = true;
  }, [refreshKey, load]);

  const unavailable =
    usage && (!usage.available || usage.error) ? (usage.error ?? "omp usage statistics are unavailable") : null;
  const problem = error ?? unavailable;

  return (
    <section aria-labelledby="viz-agent-hub" className="min-w-0">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b pb-3">
        <h2 id="viz-agent-hub" className="text-2xl font-semibold tracking-tight">
          Agent hub
        </h2>
        <p className="font-mono text-xs text-muted-foreground tabular-nums">omp usage across every session</p>
      </header>
      {!usage && loading ? (
        <HubSkeleton />
      ) : problem ? (
        <div className="flex flex-wrap items-center gap-3 py-4 text-sm text-muted-foreground">
          <p className="min-w-0 break-words">{problem}</p>
          <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={loading}>
            Retry
          </Button>
        </div>
      ) : usage ? (
        <div className={cn(loading && "opacity-60 motion-safe:transition-opacity")} aria-busy={loading}>
          <Loaded usage={usage} now={now} />
        </div>
      ) : null}
    </section>
  );
}
