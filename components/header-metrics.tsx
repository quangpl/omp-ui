"use client";

// Live AI quota, CPU, RAM and load in the page header. Same pollers and formatting as the Stats page.
import Link from "next/link";
import { ActivityIcon, CpuIcon, MemoryStickIcon, SparklesIcon, type LucideIcon } from "lucide-react";
import { formatPercent, providerName, TONE_TEXT, toneForFraction } from "@/components/stats/shared";
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
  label: string;
  /** Screen-reader name of the metric, e.g. "AI quota". */
  name: string;
  icon: LucideIcon;
  /** Formatted value; null while loading or when unavailable. */
  value: string | null;
  /** 0–1 usage that drives the warning tone; null for no tone. */
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
  /** Value text colour: tone from 75%, muted while there is no value. */
  tone: string;
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
      label: "AI",
      name: "AI quota",
      icon: SparklesIcon,
      value: tightest ? formatPercent(tightest.fraction) : null,
      fraction: tightest?.fraction ?? null,
      error: ai.error ?? (quota && !quota.available ? (quota.error ?? "Quota unavailable") : null),
    },
    {
      key: "cpu",
      label: "CPU",
      name: "CPU",
      icon: CpuIcon,
      value: cpuFraction === null ? null : formatPercent(cpuFraction),
      fraction: cpuFraction,
      error: system.error,
    },
    {
      key: "ram",
      label: "RAM",
      name: "Memory",
      icon: MemoryStickIcon,
      value: memoryFraction === null ? null : formatPercent(memoryFraction),
      fraction: memoryFraction,
      error: system.error,
    },
    {
      key: "load",
      label: "Load",
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
    let tone = "text-foreground";
    if (input.value === null) tone = "text-muted-foreground";
    else if (input.fraction !== null && input.fraction >= 0.75) tone = TONE_TEXT[toneForFraction(input.fraction)];
    return {
      ...input,
      stale,
      note: input.error === null ? undefined : stale ? `Stale: ${input.error}` : input.error,
      spoken: `${input.name} ${input.value ?? "unavailable"}`,
      tone,
    };
  });
}

/** Fixed min width + tabular digits so the header never jitters between polls. */
function MetricValue({ metric }: { metric: Metric }) {
  return (
    <span
      className={cn(
        "min-w-[4ch] text-right font-mono font-medium tabular-nums transition-opacity",
        metric.tone,
        metric.stale && "opacity-60",
      )}
    >
      {metric.value ?? "—"}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Tooltips (desktop only)

const TOOLTIP_ROW = "flex justify-between gap-4 tabular-nums";
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
          <span className="truncate">
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
            <span>{LOAD_WINDOWS[i]}</span>
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
  "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50";

function InlineChip({ metric, tooltip }: { metric: Metric; tooltip?: React.ReactNode }) {
  const Icon = metric.icon;
  const chip = (
    <Link
      href="/stats"
      aria-label={`${metric.spoken} — open Stats`}
      title={tooltip ? undefined : metric.note}
      className={INLINE_CHIP}
    >
      <Icon aria-hidden="true" className="hidden size-3.5 shrink-0 text-muted-foreground xl:block" />
      <span className="text-muted-foreground">{metric.label}</span>
      <MetricValue metric={metric} />
    </Link>
  );
  if (!tooltip) return chip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
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
          "scroll-row flex h-9 items-center justify-between gap-4 text-[11px] whitespace-nowrap outline-none transition-colors [-webkit-tap-highlight-color:transparent] active:bg-muted focus-visible:bg-muted sm:justify-start sm:gap-6",
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
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <span key={metric.key} title={metric.note} className="flex shrink-0 items-center gap-1">
              <Icon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground">{metric.label}</span>
              <MetricValue metric={metric} />
            </span>
          );
        })}
      </Link>
    );
  }

  const [aiMetric, cpuMetric, ramMetric, loadMetric] = metrics;
  return (
    <nav aria-label="System metrics" className={cn("flex shrink-0 items-center gap-0.5", className)}>
      <InlineChip metric={aiMetric} tooltip={<AiTooltip ai={ai} metric={aiMetric} />} />
      <InlineChip metric={cpuMetric} />
      <InlineChip metric={ramMetric} />
      <InlineChip metric={loadMetric} tooltip={<LoadTooltip system={system} metric={loadMetric} />} />
    </nav>
  );
}
