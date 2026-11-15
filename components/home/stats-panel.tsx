"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { formatDuration } from "@/components/board/format";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import type { AiStats, DashboardStats } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FOCUS_RING, SectionTitle } from "./shared";

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const pct = (succeeded: number, failed: number) =>
  succeeded + failed > 0 ? Math.round((succeeded / (succeeded + failed)) * 100) : null;

const rate = (succeeded: number, failed: number) => {
  const p = pct(succeeded, failed);
  return p === null ? null : `${p}%`;
};

/** Tone a success rate only when it says something: clearly healthy or clearly failing. */
const rateTone = (succeeded: number, failed: number) => {
  const p = pct(succeeded, failed);
  if (p === null || succeeded + failed < 3) return undefined;
  if (p >= 90) return "text-success";
  if (p < 50) return "text-destructive";
  return undefined;
};

/**
 * Runs per rolling day as stacked bars: succeeded, failed, stopped. Past days are muted so today,
 * the rightmost bar, carries full colour and a primary tick. No dependencies, just SVG.
 */
function RunsSparkline({ daily }: { daily: DashboardStats["daily"] }) {
  const clipId = useId();
  const max = Math.max(1, ...daily.map((d) => d.runs));
  const height = 40;
  const marker = 4;
  const bar = 10;
  const gap = 4;
  const width = daily.length * (bar + gap) - gap;
  const summary = daily.map((d, i) => `${daily.length - 1 - i === 0 ? "today" : `${daily.length - 1 - i}d ago`}: ${d.runs}`);
  return (
    <svg
      viewBox={`0 0 ${width} ${height + marker}`}
      // Pinned bottom-right so the bar floor sits on the figure's baseline whatever the day count.
      preserveAspectRatio="xMaxYMax meet"
      className="h-12 w-28 shrink-0 overflow-visible"
      role="img"
      aria-label={`Runs per day, oldest first: ${summary.join(", ")}`}
    >
      {daily.map((d, i) => {
        const x = i * (bar + gap);
        const today = i === daily.length - 1;
        const scale = (n: number) => (n / max) * height;
        const ok = scale(d.succeeded);
        const bad = scale(d.failed);
        const other = scale(Math.max(0, d.runs - d.succeeded - d.failed));
        const id = `${clipId}-${i}`;
        return (
          <g key={i}>
            <title>{`${summary[i]} runs · ${d.succeeded} succeeded · ${d.failed} failed · ${d.shipped} shipped`}</title>
            <clipPath id={id}>
              <rect x={x} y={0} width={bar} height={height} rx={1.5} />
            </clipPath>
            <rect x={x} y={0} width={bar} height={height} rx={1.5} className="fill-muted" />
            {d.runs > 0 && (
              <g clipPath={`url(#${id})`} className={today ? undefined : "opacity-45"}>
                <rect x={x} y={height - ok} width={bar} height={ok} className="fill-success" />
                <rect x={x} y={height - ok - bad} width={bar} height={bad} className="fill-destructive" />
                <rect x={x} y={height - ok - bad - other} width={bar} height={other} className="fill-muted-foreground/60" />
              </g>
            )}
            {today && <rect x={x} y={height + 2} width={bar} height={1.5} rx={0.75} className="fill-primary" />}
          </g>
        );
      })}
    </svg>
  );
}

function Metric({
  label,
  value,
  detail,
  valueClassName,
  labelClassName,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
  valueClassName?: string;
  labelClassName?: string;
}) {
  return (
    <div className="min-w-0 border-t py-3">
      <dt className={cn("truncate text-[11px] font-medium text-muted-foreground", labelClassName)}>{label}</dt>
      <dd className={cn("mt-1 font-mono text-lg leading-tight font-semibold tabular-nums", valueClassName)}>{value}</dd>
      {detail && <dd className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground tabular-nums">{detail}</dd>}
    </div>
  );
}

/** All-time token use and cost from `omp stats` (optional: omitted when omp reports nothing). */
function OmpUsage() {
  const [usage, setUsage] = useState<AiStats["usage"] | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    api.stats
      .ai()
      .then((stats) => !cancelled && setUsage(stats.usage))
      .catch(() => !cancelled && setUsage(null));
    return () => {
      cancelled = true;
    };
  }, []);

  // Loading and loaded rows share one box (rule, padding, 16px line) so the async swap never shifts the rail.
  if (usage === undefined)
    return (
      <div className="flex min-h-10 items-center border-t py-3" aria-busy="true">
        <Skeleton className="h-4 w-40" />
      </div>
    );
  const totals = usage?.available ? usage.totals : null;
  if (!totals) return null;
  return (
    <p className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-t py-3 text-xs text-muted-foreground">
      <span>
        <span className="font-mono font-medium text-foreground tabular-nums">
          {compact.format(totals.inputTokens + totals.outputTokens)}
        </span>{" "}
        tokens
      </span>
      {totals.costUsd > 0 && (
        <span>
          <span className="font-mono font-medium text-foreground tabular-nums">{usd.format(totals.costUsd)}</span> spent
        </span>
      )}
      <span className="ml-auto">all time, from omp</span>
    </p>
  );
}

export function StatsPanel({ stats }: { stats: DashboardStats }) {
  const { day, week, daily } = stats;
  const weekRate = rate(week.succeeded, week.failed);
  const dayRate = rate(day.succeeded, day.failed);
  const weekTone = rateTone(week.succeeded, week.failed);

  return (
    <section aria-labelledby="home-stats">
      <SectionTitle
        id="home-stats"
        title="Last 7 days"
        action={
          <Link
            href="/stats"
            className={cn(
              "pressable inline-flex min-h-11 items-center gap-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground md:min-h-0",
              FOCUS_RING,
            )}
          >
            Stats
            <ArrowRightIcon className="size-3" aria-hidden="true" />
          </Link>
        }
      />
      {/* Figures breathe on negative space: hairline rules group them, no card around them. */}
      <div className="border-t">
        <div className="pt-4 pb-3">
          <p className="text-[11px] font-medium text-muted-foreground">Agent runs</p>
          {/* Figure and sparkline share a bottom edge: the bars rise from the number's baseline. */}
          <div className="mt-1.5 flex items-end justify-between gap-4">
            <p className="min-w-0 font-mono text-3xl leading-none font-semibold tracking-tight tabular-nums">
              {week.runs}
            </p>
            <RunsSparkline daily={daily} />
          </div>
          <p className="mt-2 truncate text-[11px] text-muted-foreground">
            <span className="font-mono tabular-nums">{day.runs}</span> in the last 24 h
            {dayRate && (
              <>
                {" · "}
                <span className="font-mono tabular-nums">{dayRate}</span> succeeded
              </>
            )}
          </p>
        </div>
        {week.runs === 0 && week.shipped === 0 && week.created === 0 ? (
          <p className="truncate border-t py-3 text-xs text-muted-foreground">No activity this week yet.</p>
        ) : (
          <dl className="grid grid-cols-2 gap-x-6 [&>*:last-child:nth-child(odd)]:col-span-2">
            {weekRate && (
              <Metric
                label="Success rate"
                value={weekRate}
                valueClassName={weekTone}
                // A clearly failing week tints its label too, so the warning reads before the figure.
                labelClassName={weekTone === "text-destructive" ? "text-destructive/80" : undefined}
                detail={`${week.succeeded} ok · ${week.failed} failed`}
              />
            )}
            {week.avgDurationMs !== null && (
              <Metric
                label="Avg run"
                value={formatDuration(week.avgDurationMs)}
                detail={day.avgDurationMs !== null ? `${formatDuration(day.avgDurationMs)} today` : undefined}
              />
            )}
            <Metric label="Shipped" value={week.shipped} detail={`${day.shipped} in the last 24 h`} />
            <Metric label="Cards created" value={week.created} detail={`${day.created} in the last 24 h`} />
          </dl>
        )}
        <OmpUsage />
      </div>
    </section>
  );
}
