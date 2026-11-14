"use client";

// Live AI quota, CPU, RAM and load in the page header. Same pollers and formatting as the Stats page.
import Link from "next/link";
import { ActivityIcon, CpuIcon, MemoryStickIcon, SparklesIcon, type LucideIcon } from "lucide-react";
import {
  formatBytes,
  formatPercent,
  providerName,
  TONE_STROKE,
  TONE_TEXT,
  toneForFraction,
  type Tone,
} from "@/components/stats/shared";
import { useAiStats, useSystemStats, type AiState, type SystemState } from "@/components/stats/use-stats";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AiProviderQuota, AiQuotaLimit } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface TightestQuota {
  provider: AiProviderQuota;
  limit: AiQuotaLimit;
  fraction: number;
}

/** The most-used quota limit across all providers; limits without a known fraction are skipped. */
export function tightestQuota(providers: AiProviderQuota[]): TightestQuota | null {
  let tightest: TightestQuota | null = null;
  for (const provider of providers) {
    for (const limit of provider.limits) {
      const fraction = limit.usedFraction;
      if (fraction !== null && (!tightest || fraction > tightest.fraction)) tightest = { provider, limit, fraction };
    }
  }
  return tightest;
}

interface MetricInput {
  key: "ai" | "cpu" | "ram" | "load";
  /** Screen-reader name of the metric, e.g. "AI quota". */
  name: string;
  icon: LucideIcon;
  /** Formatted value; null while loading or when unavailable. */
  value: string | null;
  /** 0–1 usage that drives the ring arc and tone; null while loading or unavailable. */
  fraction: number | null;
  /** Latest error; with a value it means the value is stale. */
  error: string | null;
}

interface Metric extends MetricInput {
  stale: boolean;
  /** "Stale: …" when a value is shown, the bare error when there is nothing to show. */
  note: string | undefined;
  /** e.g. "CPU 23%". */
  spoken: string;
  /** Ring + icon tone: usage tone from `toneForFraction`, muted while there is no value. */
  tone: Tone;
}

const LOAD_WINDOWS = ["1 min", "5 min", "15 min"] as const;

function buildMetrics(system: SystemState, ai: AiState): Metric[] {
  const { stats } = system;
  const quota = ai.stats?.quota;
  const tightest = quota?.available ? tightestQuota(quota.providers) : null;
  const memoryFraction = stats
    ? stats.memory.totalBytes > 0
      ? stats.memory.usedBytes / stats.memory.totalBytes
      : 0
    : null;
  const cpuFraction = stats ? stats.cpu.usagePercent / 100 : null;
  const inputs: MetricInput[] = [
    {
      key: "ai",
      name: "AI quota",
      icon: SparklesIcon,
      value: tightest ? formatPercent(tightest.fraction) : null,
      fraction: tightest?.fraction ?? null,
      error: ai.error ?? (quota && !quota.available ? (quota.error ?? "Quota unavailable") : null),
    },
    {
      key: "cpu",
      name: "CPU",
      icon: CpuIcon,
      value: cpuFraction === null ? null : formatPercent(cpuFraction),
      fraction: cpuFraction,
      error: system.error,
    },
    {
      key: "ram",
      name: "Memory",
      icon: MemoryStickIcon,
      value: memoryFraction === null ? null : formatPercent(memoryFraction),
      fraction: memoryFraction,
      error: system.error,
    },
    {
      key: "load",
      name: "Load average",
      icon: ActivityIcon,
      value: stats ? stats.cpu.loadAvg[0].toFixed(2) : null,
      // Same tone rule as the Stats page load bars: load relative to the core count.
      fraction: stats ? stats.cpu.loadAvg[0] / Math.max(1, stats.cpu.cores) : null,
      error: system.error,
    },
  ];
  return inputs.map((input) => {
    const stale = input.value !== null && input.error !== null;
    return {
      ...input,
      stale,
      note: input.error === null ? undefined : stale ? `Stale: ${input.error}` : input.error,
      spoken: `${input.name} ${input.value ?? "unavailable"}`,
      tone: input.value === null || input.fraction === null ? "muted" : toneForFraction(input.fraction),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Icon ring

const RING_SIZE = 26;
const RING_THICKNESS = 2;
const RING_RADIUS = (RING_SIZE - RING_THICKNESS) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const RING_CENTER = RING_SIZE / 2;

/**
 * Icon inside a thin progress ring; arc length and tone carry the value so no text is needed.
 * Decorative only — the surrounding link labels the metric for screen readers.
 */
function MetricRing({ metric }: { metric: Metric }) {
  const Icon = metric.icon;
  const fraction = metric.fraction === null ? 0 : Math.min(1, Math.max(0, metric.fraction));
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative flex shrink-0 items-center justify-center transition-opacity",
        metric.stale && "opacity-60",
      )}
      style={{ width: RING_SIZE, height: RING_SIZE }}
    >
      <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} className="absolute inset-0">
        <circle
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={RING_RADIUS}
          fill="none"
          strokeWidth={RING_THICKNESS}
          className="stroke-foreground/10"
        />
        <circle
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={RING_RADIUS}
          fill="none"
          strokeWidth={RING_THICKNESS}
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - fraction)}
          transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
          className={cn(
            "transition-[stroke-dashoffset,opacity] duration-700 ease-(--ease-out-smooth) motion-reduce:transition-none",
            TONE_STROKE[metric.tone],
            fraction === 0 && "opacity-0",
          )}
        />
      </svg>
      <Icon
        className={cn(
          "size-3 transition-colors duration-500 motion-reduce:transition-none",
          metric.tone === "warning" || metric.tone === "destructive"
            ? TONE_TEXT[metric.tone]
            : "text-muted-foreground",
          // No value yet (loading/unavailable): dim the icon so it cannot pass for a healthy 0% reading.
          metric.tone === "muted" && "opacity-40",
        )}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Tooltips (desktop only)

const TOOLTIP_ROW = "flex justify-between gap-4 font-mono tabular-nums";
const TOOLTIP_MUTED = "text-background/70";

function StaleLine({ metric }: { metric: Metric }) {
  return metric.note ? <p className={cn("max-w-64", TOOLTIP_MUTED)}>{metric.note}</p> : null;
}

function AiTooltip({ ai, metric }: { ai: AiState; metric: Metric }) {
  const quota = ai.stats?.quota;
  let body: React.ReactNode;
  if (!quota) body = ai.error ? null : <p className={TOOLTIP_MUTED}>Loading AI quota…</p>;
  else if (!quota.available) body = null;
  else if (quota.providers.length === 0) body = <p className={TOOLTIP_MUTED}>No provider quota reported</p>;
  else {
    body = quota.providers.flatMap((provider, p) =>
      provider.limits.map((limit, l) => (
        <p key={`${p}-${l}`} className={TOOLTIP_ROW}>
          <span className="truncate font-sans">
            {providerName(provider.provider)} · {limit.label}
          </span>
          <span className="font-medium">{limit.usedFraction === null ? "—" : formatPercent(limit.usedFraction)}</span>
        </p>
      )),
    );
  }
  return (
    <>
      <p className="font-medium">AI quota used</p>
      {body}
      <StaleLine metric={metric} />
    </>
  );
}

function CpuTooltip({ system, metric }: { system: SystemState; metric: Metric }) {
  const cpu = system.stats?.cpu;
  return (
    <>
      <p className="font-medium">CPU</p>
      {cpu ? (
        <>
          <p className={TOOLTIP_ROW}>
            <span className="font-sans">Usage</span>
            <span className="font-medium">{formatPercent(cpu.usagePercent / 100)}</span>
          </p>
          <p className={TOOLTIP_ROW}>
            <span className="font-sans">Cores</span>
            <span className="font-medium">{cpu.cores}</span>
          </p>
        </>
      ) : system.error ? null : (
        <p className={TOOLTIP_MUTED}>Loading…</p>
      )}
      <StaleLine metric={metric} />
    </>
  );
}

function MemoryTooltip({ system, metric }: { system: SystemState; metric: Metric }) {
  const memory = system.stats?.memory;
  return (
    <>
      <p className="font-medium">Memory</p>
      {memory ? (
        <>
          <p className={TOOLTIP_ROW}>
            <span className="font-sans">Used</span>
            <span className="font-medium">
              {formatBytes(memory.usedBytes)}
              {metric.value !== null && <span className={TOOLTIP_MUTED}> · {metric.value}</span>}
            </span>
          </p>
          <p className={TOOLTIP_ROW}>
            <span className="font-sans">Total</span>
            <span className="font-medium">{formatBytes(memory.totalBytes)}</span>
          </p>
        </>
      ) : system.error ? null : (
        <p className={TOOLTIP_MUTED}>Loading…</p>
      )}
      <StaleLine metric={metric} />
    </>
  );
}

function LoadTooltip({ system, metric }: { system: SystemState; metric: Metric }) {
  const cpu = system.stats?.cpu;
  return (
    <>
      <p className="font-medium">
        Load average{cpu && <span className={TOOLTIP_MUTED}> · {cpu.cores} {cpu.cores === 1 ? "core" : "cores"}</span>}
      </p>
      {cpu ? (
        cpu.loadAvg.map((load, i) => (
          <p key={LOAD_WINDOWS[i]} className={TOOLTIP_ROW}>
            <span className="font-sans">{LOAD_WINDOWS[i]}</span>
            <span className="font-medium">{load.toFixed(2)}</span>
          </p>
        ))
      ) : system.error ? null : (
        <p className={TOOLTIP_MUTED}>Loading…</p>
      )}
      <StaleLine metric={metric} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------

const INLINE_CHIP =
  "flex h-8 shrink-0 items-center justify-center rounded-md px-1.5 outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50";

function InlineChip({ metric, tooltip }: { metric: Metric; tooltip: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link href="/stats" aria-label={`${metric.spoken} — open Stats`} className={INLINE_CHIP}>
          <MetricRing metric={metric} />
        </Link>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-stretch gap-0.5">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Always-visible system metrics linking to `/stats`: a pill group in the header row from `lg` up
 * (`inline`) or a slim full-width row under it on narrower screens (`strip`).
 */
export function HeaderMetrics({ className, variant }: { className?: string; variant: "inline" | "strip" }) {
  const system = useSystemStats();
  const ai = useAiStats();
  const metrics = buildMetrics(system, ai);

  if (variant === "strip") {
    // Fresh system numbers with no error: the polls are live.
    const live = system.stats !== null && system.error === null;
    return (
      <Link
        href="/stats"
        aria-label={`${metrics.map((metric) => metric.spoken).join(", ")} — open Stats`}
        className={cn(
          "scroll-row flex h-9 items-center justify-between gap-4 whitespace-nowrap outline-none transition-colors [-webkit-tap-highlight-color:transparent] active:bg-muted focus-visible:bg-muted sm:justify-start sm:gap-6",
          className,
        )}
      >
        <span aria-hidden="true" className="relative ml-1 flex size-1.5 shrink-0">
          {live && <span className="absolute inset-0 rounded-full bg-success motion-safe:animate-breathe" />}
          <span
            className={cn(
              "relative size-1.5 rounded-full transition-colors",
              live ? "bg-success" : "bg-muted-foreground/40",
            )}
          />
        </span>
        {metrics.map((metric) => (
          <span
            key={metric.key}
            title={metric.note ? `${metric.spoken} — ${metric.note}` : metric.spoken}
            className="flex shrink-0 items-center"
          >
            <MetricRing metric={metric} />
          </span>
        ))}
      </Link>
    );
  }

  const [aiMetric, cpuMetric, ramMetric, loadMetric] = metrics;
  return (
    <nav aria-label="System metrics" className={cn("flex shrink-0 items-center gap-0.5", className)}>
      <InlineChip metric={aiMetric} tooltip={<AiTooltip ai={ai} metric={aiMetric} />} />
      <InlineChip metric={cpuMetric} tooltip={<CpuTooltip system={system} metric={cpuMetric} />} />
      <InlineChip metric={ramMetric} tooltip={<MemoryTooltip system={system} metric={ramMetric} />} />
      <InlineChip metric={loadMetric} tooltip={<LoadTooltip system={system} metric={loadMetric} />} />
    </nav>
  );
}
