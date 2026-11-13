"use client";

import { useMemo } from "react";
import { BotIcon, LayersIcon, SparklesIcon } from "lucide-react";
import { AnimatedNumber, LiveIndicator, SegmentBar, Sparkline } from "@/components/stats/charts";
import { OMP_MISSING, PANEL, compactNumber, formatDate, usd, wholeNumber } from "@/components/stats/shared";
import type { AiState, SystemState } from "@/components/stats/use-stats";
import { HISTORY_CAPACITY } from "@/components/stats/use-stats";
import { Skeleton } from "@/components/ui/skeleton";
import { STATUS_LABELS, TASK_STATUSES, type TaskStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const LABEL = "text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground";
// Each tile is a size container so its header and legends adapt to the tile, not the viewport.
const TILE = cn(PANEL, "@container flex min-w-0 flex-col p-5 sm:p-6 animate-card-in motion-reduce:animate-none");

const STATUS_TONE: Record<TaskStatus, string> = {
  todo: "bg-muted-foreground/40",
  in_progress: "bg-primary",
  done: "bg-success",
};

const TOKEN_TONE = {
  input: "bg-primary",
  cached: "bg-primary/35",
  output: "bg-foreground/70",
} as const;

function stagger(n: number): React.CSSProperties {
  return { "--stagger": n } as React.CSSProperties;
}

/** Muted em dash shown where a value is unavailable. */
function Dash({ className }: { className?: string }) {
  return <span className={cn("text-muted-foreground/50", className)}>—</span>;
}

/**
 * A metric value slot of fixed height: skeleton while loading, the animated value once known,
 * a dash when unavailable. Keeps the layout identical across all three states.
 */
function ValueSlot({
  value,
  loading,
  format,
  className,
  slotClassName,
  skeletonClassName,
}: {
  value: number | null | undefined;
  loading: boolean;
  format?: (n: number) => string;
  className: string;
  slotClassName: string;
  skeletonClassName: string;
}) {
  return (
    <div className={cn("flex items-end", slotClassName)}>
      {value != null ? (
        <AnimatedNumber value={value} format={format} className={cn("font-mono", className)} />
      ) : loading ? (
        <Skeleton className={cn("h-full", skeletonClassName)} />
      ) : (
        <Dash className={cn("font-mono", className)} />
      )}
    </div>
  );
}

export function Overview({ system, ai }: { system: SystemState; ai: AiState }) {
  // The bento follows the width actually available to it (the app sidebar eats into the viewport):
  // AI tiles go side by side once there is room, the hero split only on wide containers.
  return (
    <section aria-label="Overview" className="@container">
      <div className="grid gap-4 @4xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] @4xl:gap-6">
        <AgentsTile system={system} />
        <div className="grid min-w-0 gap-4 @2xl:grid-cols-2 @4xl:grid-cols-1 @4xl:gap-6">
          <SpendTile ai={ai} />
          <TokensTile ai={ai} />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Agents

/** Dashed scale lines behind the agents sparkline, spaced evenly above its baseline. */
const SPARK_GRIDLINES = ["8%", "37%", "66%"] as const;

/** Primary metric: agents running now, its recent trend, and the card pipeline. */
function AgentsTile({ system }: { system: SystemState }) {
  const { stats, error, history } = system;
  const app = stats?.app ?? null;
  const loading = !stats && !error;
  const live = !stats && !error ? "connecting" : error ? "stale" : "live";
  const running = useMemo(() => history.map((sample) => sample.agentsRunning), [history]);
  const totalTasks = app ? TASK_STATUSES.reduce((sum, status) => sum + app.tasks[status], 0) : 0;
  const segments = TASK_STATUSES.map((status) => ({
    key: status,
    value: app?.tasks[status] ?? 0,
    label: STATUS_LABELS[status],
    className: STATUS_TONE[status],
  }));

  return (
    <div className={TILE} style={stagger(0)} aria-busy={loading}>
      <div className="flex items-center justify-between gap-3">
        <p className={cn(LABEL, "flex items-center gap-2")}>
          <BotIcon className="size-3.5" aria-hidden="true" />
          Agents running
        </p>
        <LiveIndicator state={live} />
      </div>

      <div className="mt-6 flex flex-wrap items-end gap-x-10 gap-y-4">
        <ValueSlot
          value={app?.agentsRunning}
          loading={loading}
          className="text-6xl leading-none font-semibold tracking-tighter md:text-7xl"
          slotClassName="h-15 md:h-18"
          skeletonClassName="w-20 md:w-24"
        />
        <dl className="flex gap-8 pb-1">
          {(
            [
              ["Queued", app?.agentsQueued],
              ["Projects", app?.boards],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className={LABEL}>{label}</dt>
              <dd className="mt-1.5">
                <ValueSlot
                  value={value}
                  loading={loading}
                  className="text-xl leading-none font-semibold tracking-tight"
                  slotClassName="h-5"
                  skeletonClassName="w-8"
                />
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="mt-6 flex flex-1 flex-col">
        <div className="relative min-h-16 flex-1">
          {stats ? (
            <>
              <div aria-hidden="true" className="pointer-events-none absolute inset-0">
                {SPARK_GRIDLINES.map((top) => (
                  <div
                    key={top}
                    className="absolute inset-x-0 border-t border-dashed border-foreground/[0.06]"
                    style={{ top }}
                  />
                ))}
              </div>
              <div className="absolute inset-0">
                <Sparkline
                  values={running}
                  capacity={HISTORY_CAPACITY}
                  tone="success"
                  label="Agents running, last 5 minutes"
                />
              </div>
            </>
          ) : error ? (
            <p className="absolute inset-0 flex items-center text-sm text-destructive">{error}</p>
          ) : (
            <Skeleton className="absolute inset-0 rounded-lg" />
          )}
        </div>
        <div className="mt-2 flex items-center justify-between gap-3 font-mono text-[10px] text-muted-foreground/70 tabular-nums">
          <span>−5 min</span>
          {stats && error ? (
            <span className="truncate text-amber-600 dark:text-amber-400" title={error}>
              Last update failed
            </span>
          ) : (
            <span>now</span>
          )}
        </div>
      </div>

      <div className="mt-6 space-y-3 border-t pt-5">
        <div className="flex items-baseline justify-between gap-3">
          <span className={LABEL}>Cards</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {app ? `${wholeNumber.format(totalTasks)} total` : "—"}
          </span>
        </div>
        <SegmentBar segments={segments} />
        <dl className="grid grid-cols-3 gap-3">
          {TASK_STATUSES.map((status) => (
            <div key={status} className="min-w-0">
              <dt className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                <span className={cn("size-2 shrink-0 rounded-full", STATUS_TONE[status])} aria-hidden="true" />
                {STATUS_LABELS[status]}
              </dt>
              <dd className="mt-1.5">
                <ValueSlot
                  value={app?.tasks[status]}
                  loading={loading}
                  className="text-xl leading-none font-semibold tracking-tight"
                  slotClassName="h-5"
                  skeletonClassName="w-8"
                />
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// AI

/** Usage totals when recorded, plus the header line: date range or why usage is unavailable. */
function aiTotals({ stats, error }: AiState) {
  const usage = stats?.usage;
  const totals = usage?.available ? usage.totals : null;
  const used = totals && totals.requests > 0 ? totals : null;
  const range =
    totals?.firstAt && totals.lastAt ? `${formatDate(totals.firstAt)} → ${formatDate(totals.lastAt)}` : null;
  const unavailable = stats
    ? !usage?.available
      ? usage?.error === OMP_MISSING
        ? "omp is not installed"
        : "Usage unavailable"
      : !used
        ? "No usage recorded yet"
        : null
    : error
      ? "Could not load AI stats"
      : null;
  return {
    used,
    loading: !stats && !error,
    caption: range ?? unavailable ?? "All recorded omp sessions",
    failed: !stats && error ? error : null,
  };
}

/** Tile label with the caption beside it on roomy tiles, on its own line under it on narrow ones. */
function TileHeader({ icon, title, caption }: { icon: React.ReactNode; title: string; caption: string }) {
  return (
    <div className="flex flex-col gap-1.5 @xs:flex-row @xs:items-center @xs:justify-between @xs:gap-3">
      <p className={cn(LABEL, "flex shrink-0 items-center gap-2")}>
        {icon}
        {title}
      </p>
      <p className="min-w-0 truncate text-xs text-muted-foreground tabular-nums" title={caption}>
        {caption}
      </p>
    </div>
  );
}

const BIG_VALUE = "text-4xl leading-none font-semibold tracking-tighter md:text-5xl";
const BIG_SLOT = "h-9 md:h-12";

/** Secondary metric: total AI spend, requests and failures. */
function SpendTile({ ai }: { ai: AiState }) {
  const { used, loading, caption, failed } = aiTotals(ai);
  const perRequest = used ? used.costUsd / used.requests : null;

  return (
    <div className={TILE} style={stagger(1)} aria-busy={loading}>
      <TileHeader icon={<SparklesIcon className="size-3.5" aria-hidden="true" />} title="AI spend" caption={caption} />

      <div className="mt-6">
        <ValueSlot
          value={used?.costUsd}
          loading={loading}
          format={usd.format}
          className={BIG_VALUE}
          slotClassName={BIG_SLOT}
          skeletonClassName="w-36"
        />
        <p className={cn(LABEL, "mt-2.5")}>Total cost</p>
      </div>

      <div aria-hidden="true" className="min-h-6 flex-1" />
      <dl className="grid grid-cols-2 gap-4 border-t pt-4">
        <div className="min-w-0">
          <dt className={LABEL}>Requests</dt>
          <dd className="mt-1.5">
            <ValueSlot
              value={used?.requests}
              loading={loading}
              format={wholeNumber.format}
              className="text-xl leading-none font-semibold tracking-tight"
              slotClassName="h-5"
              skeletonClassName="w-14"
            />
          </dd>
          <dd className="mt-1 h-4 truncate text-xs text-destructive tabular-nums">
            {used && used.failedRequests > 0 ? `${wholeNumber.format(used.failedRequests)} failed` : null}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className={LABEL}>Per request</dt>
          <dd className="mt-1.5">
            <ValueSlot
              value={perRequest}
              loading={loading}
              format={usd.format}
              className="text-xl leading-none font-semibold tracking-tight"
              slotClassName="h-5"
              skeletonClassName="w-14"
            />
          </dd>
          <dd className="mt-1 h-4 truncate text-xs text-destructive" title={failed ?? undefined}>
            {failed}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** Token totals and the input / cache-read / output split. */
function TokensTile({ ai }: { ai: AiState }) {
  const { used, loading, caption } = aiTotals(ai);
  const total = used ? used.inputTokens + used.cacheReadTokens + used.outputTokens : null;
  const parts = [
    { key: "input", label: "In", title: "Tokens in", value: used?.inputTokens, className: TOKEN_TONE.input },
    { key: "cached", label: "Cached", title: "Cache reads", value: used?.cacheReadTokens, className: TOKEN_TONE.cached },
    { key: "output", label: "Out", title: "Tokens out", value: used?.outputTokens, className: TOKEN_TONE.output },
  ];
  const segments = parts.map((part) => ({
    key: part.key,
    label: part.title,
    value: part.value ?? 0,
    className: part.className,
  }));

  return (
    <div className={TILE} style={stagger(2)} aria-busy={loading}>
      <TileHeader icon={<LayersIcon className="size-3.5" aria-hidden="true" />} title="Tokens" caption={caption} />

      <div className="mt-6">
        <ValueSlot
          value={total}
          loading={loading}
          format={compactNumber.format}
          className={BIG_VALUE}
          slotClassName={BIG_SLOT}
          skeletonClassName="w-28"
        />
        <p className={cn(LABEL, "mt-2.5")}>Total tokens</p>
      </div>

      <div aria-hidden="true" className="min-h-6 flex-1" />
      <div className="space-y-3 border-t pt-4">
        <SegmentBar segments={segments} />
        <dl className="grid grid-cols-3 gap-x-4">
          {parts.map((part) => (
            <div key={part.key} className="min-w-0">
              <dt className="flex items-center gap-1.5 text-xs text-muted-foreground" title={part.title}>
                <span className={cn("size-2 shrink-0 rounded-full", part.className)} aria-hidden="true" />
                <span className="truncate">{part.label}</span>
              </dt>
              <dd className="mt-1.5">
                <ValueSlot
                  value={part.value}
                  loading={loading}
                  format={compactNumber.format}
                  className="min-w-0 truncate text-lg leading-none font-semibold tracking-tight"
                  slotClassName="h-5"
                  skeletonClassName="w-12"
                />
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
