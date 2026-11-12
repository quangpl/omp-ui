"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { formatDuration } from "@/components/board/format";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import type { AiStats, DashboardStats } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FOCUS_RING, Panel, SectionTitle } from "./shared";

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const rate = (succeeded: number, failed: number) =>
  succeeded + failed > 0 ? `${Math.round((succeeded / (succeeded + failed)) * 100)}%` : null;

/** Runs per rolling day as stacked bars: succeeded, failed, stopped. No dependencies, just SVG. */
function RunsSparkline({ daily }: { daily: DashboardStats["daily"] }) {
  const max = Math.max(1, ...daily.map((d) => d.runs));
  const height = 36;
  const bar = 8;
  const gap = 4;
  const width = daily.length * (bar + gap) - gap;
  const summary = daily.map((d, i) => `${daily.length - 1 - i === 0 ? "today" : `${daily.length - 1 - i}d ago`}: ${d.runs}`);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-9 w-24 shrink-0 overflow-visible"
      role="img"
      aria-label={`Runs per day, oldest first — ${summary.join(", ")}`}
    >
      {daily.map((d, i) => {
        const x = i * (bar + gap);
        const scale = (n: number) => (n / max) * height;
        const ok = scale(d.succeeded);
        const bad = scale(d.failed);
        const other = scale(Math.max(0, d.runs - d.succeeded - d.failed));
        return (
          <g key={i}>
            <title>{`${summary[i]} runs · ${d.succeeded} succeeded · ${d.failed} failed · ${d.shipped} shipped`}</title>
            <rect x={x} y={0} width={bar} height={height} rx={2} className="fill-muted" />
            {d.runs > 0 && (
              <>
                <rect x={x} y={height - ok} width={bar} height={ok} className="fill-success" />
                <rect x={x} y={height - ok - bad} width={bar} height={bad} className="fill-destructive" />
                <rect x={x} y={height - ok - bad - other} width={bar} height={other} className="fill-muted-foreground/50" />
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Metric({ label, value, detail, className }: { label: string; value: ReactNode; detail?: string; className?: string }) {
  return (
    <div className={cn("min-w-0 bg-card px-3 py-2.5", className)}>
      <dt className="truncate text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-lg leading-tight font-semibold tracking-tight tabular-nums">{value}</dd>
      {detail && <dd className="truncate text-[11px] text-muted-foreground">{detail}</dd>}
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

  if (usage === undefined) return <Skeleton className="mx-3 mb-3 h-4 w-40" />;
  const totals = usage?.available ? usage.totals : null;
  if (!totals) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
      <span>
        <span className="font-medium text-foreground tabular-nums">
          {compact.format(totals.inputTokens + totals.outputTokens)}
        </span>{" "}
        tokens
      </span>
      {totals.costUsd > 0 && (
        <span>
          <span className="font-medium text-foreground tabular-nums">{usd.format(totals.costUsd)}</span> spent
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

  return (
    <section aria-labelledby="home-stats">
      <SectionTitle
        id="home-stats"
        title="Last 7 days"
        action={
          <Link
            href="/stats"
            className={cn(
              "inline-flex min-h-11 items-center gap-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground md:min-h-0",
              FOCUS_RING,
            )}
          >
            Stats
            <ArrowRightIcon className="size-3" aria-hidden="true" />
          </Link>
        }
      />
      <Panel className="overflow-hidden">
        <div className="flex items-end gap-3 px-3 pt-3 pb-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium text-muted-foreground">Agent runs</p>
            <p className="text-2xl leading-none font-semibold tracking-tight tabular-nums">{week.runs}</p>
            <p className="mt-1 truncate text-[11px] text-muted-foreground">
              {day.runs} in the last 24 h{dayRate ? ` · ${dayRate} succeeded` : ""}
            </p>
          </div>
          <RunsSparkline daily={daily} />
        </div>
        {week.runs === 0 && week.shipped === 0 && week.created === 0 ? (
          <p className="border-t px-3 py-3 text-xs text-pretty text-muted-foreground">
            No activity this week. Start a card to see runs, success rate and shipped work.
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-px border-t bg-border [&>*:last-child:nth-child(odd)]:col-span-2">
            {weekRate && (
              <Metric label="Success rate" value={weekRate} detail={`${week.succeeded} ok · ${week.failed} failed`} />
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
      </Panel>
    </section>
  );
}
