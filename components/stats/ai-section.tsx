"use client";

import { ChartColumnIcon, GaugeIcon, Loader2Icon, RefreshCwIcon, SparklesIcon } from "lucide-react";
import { RadialGauge, SegmentBar, Sparkline } from "@/components/stats/charts";
import {
  EmptyState,
  Notice,
  OMP_MISSING,
  OmpMissingHint,
  PANEL,
  PanelHeader,
  SectionHeader,
  TONE_TEXT,
  compactNumber,
  formatDate,
  formatDuration,
  formatPercent,
  formatResetTime,
  providerName,
  toneForFraction,
  usd,
  wholeNumber,
} from "@/components/stats/shared";
import { useNow, type AiState } from "@/components/stats/use-stats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { AiFolderUsage, AiModelUsage, AiProviderBalance, AiProviderQuota, AiQuotaLimit, AiStats } from "@/lib/types";
import { cn } from "@/lib/utils";

const GAUGE_SIZE = 52;
const GAUGE_THICKNESS = 5;
const LABEL = "text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground";
/** Colors for the top models in the share strip; everything else falls into "Other". */
const SERIES = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"] as const;
const OTHER_SERIES = "bg-foreground/15";

function stagger(n: number): React.CSSProperties {
  return { "--stagger": n } as React.CSSProperties;
}

// ---------------------------------------------------------------------------------------------
// Quota

function resetText(limit: AiQuotaLimit, now: number): string {
  const resetsAt = limit.resetsAt;
  const resetMs = resetsAt ? Date.parse(resetsAt) - now : null;
  if (!resetsAt || resetMs === null || Number.isNaN(resetMs)) {
    return limit.windowLabel ? `${limit.windowLabel} window` : "No reset time reported";
  }
  if (resetMs <= 0) return "Resetting now";
  return `Resets in ${formatDuration(resetMs / 1000)} · ${formatResetTime(resetsAt)}`;
}

/** Ring placeholder for limits that report no usage fraction. */
function EmptyGauge() {
  const r = (GAUGE_SIZE - GAUGE_THICKNESS) / 2;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: GAUGE_SIZE, height: GAUGE_SIZE }}
    >
      <svg
        viewBox={`0 0 ${GAUGE_SIZE} ${GAUGE_SIZE}`}
        className="absolute inset-0 size-full text-muted-foreground/40"
        aria-hidden="true"
      >
        <circle
          cx={GAUGE_SIZE / 2}
          cy={GAUGE_SIZE / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={GAUGE_THICKNESS / 2}
          strokeDasharray="3 4"
        />
      </svg>
      <span className="text-xs font-semibold text-muted-foreground" aria-hidden="true">
        –
      </span>
      <span className="sr-only">Usage not reported</span>
    </span>
  );
}

function QuotaLimitRow({ limit, now }: { limit: AiQuotaLimit; now: number }) {
  const fraction = limit.usedFraction;
  const status = limit.status?.toLowerCase();
  const showAmount =
    limit.unit !== "percent" && limit.used !== null && limit.limit !== null && limit.limit > 0;
  const fmt = limit.unit === "usd" ? usd : wholeNumber;
  const unitSuffix = limit.unit && limit.unit !== "usd" ? ` ${limit.unit}` : "";
  const amount = `${fmt.format(limit.used ?? 0)} / ${fmt.format(limit.limit ?? 0)}${unitSuffix}`;

  return (
    <li className="flex items-center gap-3.5 px-4 py-3.5 sm:px-5">
      {fraction === null ? (
        <EmptyGauge />
      ) : (
        <RadialGauge
          fraction={fraction}
          size={GAUGE_SIZE}
          thickness={GAUGE_THICKNESS}
          label={`${limit.label} used`}
          className="shrink-0"
        >
          <span
            className={cn(
              "font-mono text-[11px] leading-none font-semibold tracking-tight tabular-nums",
              TONE_TEXT[toneForFraction(fraction)],
            )}
          >
            {formatPercent(fraction)}
          </span>
        </RadialGauge>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={limit.label}>
            {limit.label}
          </span>
          {status && status !== "ok" && (
            <Badge
              variant={status === "warning" ? "secondary" : "destructive"}
              className={cn("shrink-0", status === "warning" && "bg-amber-500/15 text-amber-700 dark:text-amber-400")}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </Badge>
          )}
        </div>
        <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
          <span>{resetText(limit, now)}</span>
          {showAmount && <span className="font-mono text-foreground/80">{amount}</span>}
        </p>
      </div>
    </li>
  );
}

function ProviderPanel({ provider, now, index }: { provider: AiProviderQuota; now: number; index: number }) {
  return (
    <div className={cn(PANEL, "animate-card-in")} style={stagger(4 + index)}>
      <PanelHeader
        title={providerName(provider.provider)}
        note={provider.account ? <span className="font-mono">{provider.account}</span> : undefined}
      />
      {provider.limits.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground sm:px-5">This provider did not report any limits.</p>
      ) : (
        <ul className="divide-y">
          {provider.limits.map((limit) => (
            <QuotaLimitRow key={limit.id} limit={limit} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** A provider balance amount in its currency, e.g. "¥110.00"; falls back to a plain decimal. */
function formatBalance(value: number, currency: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
    } catch {
      // Unknown currency code: fall through to the plain decimal.
    }
  }
  return `${value.toFixed(2)}${currency ? ` ${currency}` : ""}`;
}

function BalanceRow({ label, value, currency }: { label: string; value: number | null; currency: string | null }) {
  return (
    <li className="flex items-baseline justify-between gap-4 px-4 py-3.5 sm:px-5">
      <span className="min-w-0 truncate text-sm font-medium">{label}</span>
      <span className="shrink-0 font-mono text-sm font-semibold tracking-tight tabular-nums">
        {value === null ? "Not reported" : formatBalance(value, currency)}
      </span>
    </li>
  );
}

/** A prepaid-balance provider (DeepSeek): its current balance, granted and topped-up amounts. */
function BalancePanel({ balance, index }: { balance: AiProviderBalance; index: number }) {
  return (
    <div className={cn(PANEL, "animate-card-in")} style={stagger(4 + index)}>
      <PanelHeader
        title={providerName(balance.provider)}
        note={balance.available === false ? <Badge variant="destructive">Unavailable</Badge> : undefined}
      />
      <ul className="divide-y">
        <BalanceRow label="Balance" value={balance.total} currency={balance.currency} />
        {balance.granted !== null && (
          <BalanceRow label="Granted balance" value={balance.granted} currency={balance.currency} />
        )}
        {balance.toppedUp !== null && (
          <BalanceRow label="Topped up balance" value={balance.toppedUp} currency={balance.currency} />
        )}
      </ul>
    </div>
  );
}

const CALLOUT_TONE = {
  warning: "bg-amber-500/[0.08] ring-amber-500/25",
  destructive: "bg-destructive/[0.07] ring-destructive/25",
} as const;

/** The single most-used limit, surfaced when it crosses 75%. */
function TightestLimit({ providers, now }: { providers: AiProviderQuota[]; now: number }) {
  let tightest: { provider: AiProviderQuota; limit: AiQuotaLimit; fraction: number } | null = null;
  for (const provider of providers) {
    for (const limit of provider.limits) {
      const fraction = limit.usedFraction;
      if (fraction !== null && fraction >= 0.75 && (!tightest || fraction > tightest.fraction)) {
        tightest = { provider, limit, fraction };
      }
    }
  }
  if (!tightest) return null;

  const tone = toneForFraction(tightest.fraction) === "destructive" ? "destructive" : "warning";
  return (
    <div
      className={cn(
        "flex animate-card-in items-center gap-3 rounded-xl px-4 py-3 ring-1 sm:px-5",
        CALLOUT_TONE[tone],
      )}
      style={stagger(3)}
    >
      <GaugeIcon className={cn("size-4 shrink-0", TONE_TEXT[tone])} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className={LABEL}>Tightest limit</p>
        <p className="truncate text-sm font-medium">
          {providerName(tightest.provider.provider)} · {tightest.limit.label}
        </p>
        <p className="truncate text-xs text-muted-foreground tabular-nums">{resetText(tightest.limit, now)}</p>
      </div>
      <span
        className={cn(
          "shrink-0 font-mono text-2xl leading-none font-semibold tracking-tighter tabular-nums",
          TONE_TEXT[tone],
        )}
      >
        {formatPercent(tightest.fraction)}
      </span>
    </div>
  );
}

function QuotaList({
  quota,
  balances,
  now,
}: {
  quota: AiStats["quota"];
  balances: AiProviderBalance[];
  now: number;
}) {
  if (!quota.available) {
    return (
      <Notice tone="error" title={quota.error ?? "Could not read provider quota."}>
        {quota.error === OMP_MISSING ? (
          <OmpMissingHint />
        ) : (
          <>
            Retry in a moment. If it keeps failing, run{" "}
            <code className="font-mono text-xs">omp usage</code> on the server to see why.
          </>
        )}
      </Notice>
    );
  }
  if (quota.providers.length === 0 && balances.length === 0) {
    return (
      <EmptyState icon={<GaugeIcon />} title="No provider quota reported">
        Sign in to a provider with <code className="font-mono text-xs">omp</code> on this server to see its
        limits here.
      </EmptyState>
    );
  }
  return (
    <div className="@container space-y-4">
      <TightestLimit providers={quota.providers} now={now} />
      <div className="grid gap-4 @2xl:grid-cols-2 @2xl:items-start">
        {quota.providers.map((provider, index) => (
          <ProviderPanel key={`${provider.provider}-${index}`} provider={provider} now={now} index={index} />
        ))}
        {balances.map((balance, index) => (
          <BalancePanel key={balance.provider} balance={balance} index={quota.providers.length + index} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Usage by model

interface RankedModel {
  model: AiModelUsage;
  /** Value used for share bars: cost, or requests when nothing was billed. */
  value: number;
  colorClass: string;
}

interface Share {
  key: string;
  label: string;
  value: number;
  className: string;
  mono: boolean;
}

function rankModels(models: AiModelUsage[]) {
  const totalCost = models.reduce((sum, m) => sum + m.costUsd, 0);
  const byCost = totalCost > 0;
  const metric = (m: AiModelUsage) => (byCost ? m.costUsd : m.requests);
  const sorted = [...models].sort((a, b) => metric(b) - metric(a));
  const ranked: RankedModel[] = sorted.map((model, i) => ({
    model,
    value: metric(model),
    colorClass: SERIES[i] ?? OTHER_SERIES,
  }));
  const shares: Share[] = ranked.slice(0, SERIES.length).map((r) => ({
    key: `${r.model.provider}/${r.model.model}`,
    label: r.model.model,
    value: r.value,
    className: r.colorClass,
    mono: true,
  }));
  const rest = ranked.slice(SERIES.length);
  if (rest.length > 0) {
    shares.push({
      key: "__other",
      label: `Other (${rest.length})`,
      value: rest.reduce((sum, r) => sum + r.value, 0),
      className: OTHER_SERIES,
      mono: false,
    });
  }
  const total = ranked.reduce((sum, r) => sum + r.value, 0);
  const max = ranked.reduce((acc, r) => Math.max(acc, r.value), 0);
  return { ranked, shares, total, max, byCost, totalCost };
}

function formatTtft(ms: number | null): string {
  if (ms === null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** Thin bar: a model's share relative to the largest one. */
function ShareBar({ value, max, colorClass, className }: { value: number; max: number; colorClass: string; className?: string }) {
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-full bg-muted", className)} aria-hidden="true">
      <div
        className={cn(
          "h-full w-full origin-left rounded-full transition-transform duration-700 ease-(--ease-out-smooth) motion-reduce:transition-none",
          colorClass,
        )}
        style={{ transform: `scaleX(${max > 0 ? value / max : 0})` }}
      />
    </div>
  );
}

function UsageByModel({ usage }: { usage: AiStats["usage"] }) {
  const totals = usage.totals;
  const range =
    totals?.firstAt && totals.lastAt ? `${formatDate(totals.firstAt)} → ${formatDate(totals.lastAt)}` : undefined;

  if (!usage.available) {
    return (
      <Notice tone="error" title={usage.error ?? "Could not read usage."}>
        {usage.error === OMP_MISSING ? (
          <OmpMissingHint />
        ) : (
          <>
            Run <code className="font-mono text-xs">omp stats</code> on the server to see why.
          </>
        )}
      </Notice>
    );
  }
  if (!totals || totals.requests === 0) {
    return (
      <EmptyState icon={<ChartColumnIcon />} title="No usage recorded yet">
        Costs and token counts appear after agents run on this server.
      </EmptyState>
    );
  }

  const models = usage.byModel;
  const { ranked, shares, total, max, byCost, totalCost } = rankModels(models);
  // One provider: name it once in the header instead of repeating it on every row.
  const providers = new Set(models.map((m) => m.provider));
  const soleProvider = providers.size === 1 ? providerName(models[0].provider) : null;
  const scope = range ?? "All recorded omp sessions on this server.";

  return (
    <div className={cn(PANEL, "@container animate-card-in")} style={stagger(6)}>
      <PanelHeader title="Usage by model" note={soleProvider ? `${soleProvider} · ${scope}` : scope} />
      {models.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground sm:px-5">No per-model breakdown reported.</p>
      ) : (
        <>
          {/* Share strip: where the spend goes, at a glance. */}
          <div className="space-y-3 border-b px-4 py-4 sm:px-5">
            <div className="flex items-baseline justify-between gap-3">
              <p className={LABEL}>{byCost ? "Cost share" : "Request share"}</p>
              <p className="font-mono text-sm font-semibold tracking-tight tabular-nums">
                {byCost ? usd.format(totalCost) : `${wholeNumber.format(total)} req`}
              </p>
            </div>
            <SegmentBar
              segments={shares.map(({ key, label, value, className }) => ({ key, label, value, className }))}
            />
            <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
              {shares.map((share) => (
                <li key={share.key} className="flex min-w-0 max-w-full items-center gap-1.5">
                  <span className={cn("size-2 shrink-0 rounded-full", share.className)} aria-hidden="true" />
                  <span
                    className={cn("min-w-0 truncate", share.mono && "font-mono", "max-w-[14rem]")}
                    title={share.label}
                  >
                    {share.label}
                  </span>
                  <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                    {formatPercent(total > 0 ? share.value / total : 0)}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Narrow: stacked rows. With a Provider column the table needs a little more room. */}
          <ol className={cn("divide-y", soleProvider ? "@xl:hidden" : "@2xl:hidden")}>
            {ranked.map(({ model: m, value, colorClass }) => (
              <li
                key={`${m.provider}/${m.model}`}
                className="space-y-1.5 px-4 py-3 content-auto [contain-intrinsic-size:auto_4.5rem] sm:px-5"
              >
                <div className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={m.model}>
                    {m.model}
                  </span>
                  <span className="shrink-0 font-mono text-sm font-semibold tabular-nums">{usd.format(m.costUsd)}</span>
                </div>
                <ShareBar value={value} max={max} colorClass={colorClass} />
                <p className="flex flex-wrap gap-x-3 font-mono text-xs text-muted-foreground tabular-nums">
                  {!soleProvider && <span className="font-sans">{providerName(m.provider)}</span>}
                  <span>{wholeNumber.format(m.requests)} req</span>
                  {m.failedRequests > 0 && (
                    <span className="text-destructive">{wholeNumber.format(m.failedRequests)} failed</span>
                  )}
                  <span>TTFT {formatTtft(m.avgTtftMs)}</span>
                  <span>{m.avgTokensPerSecond !== null ? Math.round(m.avgTokensPerSecond) : "—"} tok/s</span>
                  <span>cache {m.cacheRate !== null ? formatPercent(m.cacheRate) : "—"}</span>
                  <span>{compactNumber.format(m.inputTokens)} in</span>
                  <span>{compactNumber.format(m.outputTokens)} out</span>
                </p>
              </li>
            ))}
          </ol>

          {/* Wide: a real table. Model takes the slack; the rest get fixed widths so nothing truncates. */}
          <table className={cn("hidden w-full table-fixed text-sm", soleProvider ? "@xl:table" : "@2xl:table")}>
            <thead>
              <tr className="border-b text-left [&>th]:px-3 [&>th]:py-2.5 [&>th]:text-[11px] [&>th]:font-medium [&>th]:tracking-[0.08em] [&>th]:text-muted-foreground [&>th]:uppercase [&>th:first-child]:pl-5 [&>th:last-child]:pr-5">
                <th scope="col">Model</th>
                {!soleProvider && (
                  <th scope="col" className="w-28">
                    Provider
                  </th>
                )}
                <th scope="col" className="w-24 text-right">
                  Requests
                </th>
                <th scope="col" className="hidden w-20 text-right @3xl:table-cell">
                  TTFT
                </th>
                <th scope="col" className="hidden w-20 text-right @3xl:table-cell">
                  Tok/s
                </th>
                <th scope="col" className="hidden w-20 text-right @4xl:table-cell">
                  Cache
                </th>
                <th scope="col" className="w-20 text-right">
                  In
                </th>
                <th scope="col" className="w-20 text-right">
                  Out
                </th>
                <th scope="col" className="w-28 text-right">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {ranked.map(({ model: m, value, colorClass }) => (
                <tr
                  key={`${m.provider}/${m.model}`}
                  className="tabular-nums transition-colors hover:bg-muted/40 [&>td]:px-3 [&>td]:py-2.5 [&>td:first-child]:pl-5 [&>td:last-child]:pr-5"
                >
                  <td>
                    <span className="block truncate font-mono text-xs" title={m.model}>
                      {m.model}
                    </span>
                    <ShareBar value={value} max={max} colorClass={colorClass} className="mt-1.5" />
                  </td>
                  {!soleProvider && (
                    <td className="truncate text-muted-foreground" title={providerName(m.provider)}>
                      {providerName(m.provider)}
                    </td>
                  )}
                  <td className="text-right font-mono text-[0.8125rem]">
                    {wholeNumber.format(m.requests)}
                    {m.failedRequests > 0 && (
                      <span className="block text-xs text-destructive">{wholeNumber.format(m.failedRequests)} failed</span>
                    )}
                  </td>
                  <td className="hidden text-right font-mono text-[0.8125rem] text-muted-foreground @3xl:table-cell">{formatTtft(m.avgTtftMs)}</td>
                  <td className="hidden text-right font-mono text-[0.8125rem] text-muted-foreground @3xl:table-cell">{m.avgTokensPerSecond !== null ? Math.round(m.avgTokensPerSecond) : "—"}</td>
                  <td className="hidden text-right font-mono text-[0.8125rem] text-muted-foreground @4xl:table-cell">{m.cacheRate !== null ? formatPercent(m.cacheRate) : "—"}</td>
                  <td className="text-right font-mono text-[0.8125rem] text-muted-foreground">{compactNumber.format(m.inputTokens)}</td>
                  <td className="text-right font-mono text-[0.8125rem] text-muted-foreground">{compactNumber.format(m.outputTokens)}</td>
                  <td className="text-right font-mono text-[0.8125rem] font-semibold">{usd.format(m.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

const FOLDER_LIMIT = 10;

/** Per-project spend: the folder omp ran in, ranked by cost (or requests when nothing is priced). */
function UsageByFolder({ usage }: { usage: AiStats["usage"] }) {
  if (!usage.available || usage.byFolder.length === 0) return null;
  const folders = usage.byFolder.slice(0, FOLDER_LIMIT);
  const hidden = usage.byFolder.length - folders.length;
  const byCost = usage.byFolder.some((f) => f.costUsd > 0);
  const metric = (f: AiFolderUsage) => (byCost ? f.costUsd : f.requests);
  const max = Math.max(...folders.map(metric));

  return (
    <div className={cn(PANEL, "@container animate-card-in")} style={stagger(7)}>
      <PanelHeader title="Usage by project" note={byCost ? "Ranked by cost" : "Ranked by requests"} />
      <ol className="divide-y">
        {folders.map((f) => (
          <li key={f.folder} className="space-y-1.5 px-4 py-3 content-auto [contain-intrinsic-size:auto_4.5rem] sm:px-5">
            <div className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.folder}>
                {f.folder.replace(/^-/, "")}
              </span>
              <span className="shrink-0 font-mono text-sm font-semibold tabular-nums">{usd.format(f.costUsd)}</span>
            </div>
            <ShareBar value={metric(f)} max={max} colorClass={SERIES[0]} />
            <p className="flex flex-wrap gap-x-3 font-mono text-xs text-muted-foreground tabular-nums">
              <span>{wholeNumber.format(f.requests)} req</span>
              {f.failedRequests > 0 && (
                <span className="text-destructive">{wholeNumber.format(f.failedRequests)} failed</span>
              )}
              <span>{compactNumber.format(f.inputTokens)} in</span>
              <span>{compactNumber.format(f.outputTokens)} out</span>
            </p>
          </li>
        ))}
      </ol>
      {hidden > 0 && <p className="border-t px-4 py-2.5 text-xs text-muted-foreground sm:px-5">+{hidden} more</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Usage overview

function StatTile({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1 px-4 py-3 sm:px-5">
      <p className={LABEL}>{label}</p>
      <p className="truncate font-mono text-lg font-semibold tracking-tight tabular-nums">{value}</p>
      {note && <p className="truncate font-mono text-xs text-muted-foreground tabular-nums">{note}</p>}
    </div>
  );
}

/** omp's headline numbers (spend, requests, tokens, cache, speed), spend per hour and the split by agent kind. */
function UsageOverview({ usage }: { usage: AiStats["usage"] }) {
  const totals = usage.totals;
  if (!usage.available || !totals || totals.requests === 0) return null;

  const agents = usage.byAgent;
  const agentCost = agents.reduce((sum, a) => sum + a.costUsd, 0);
  const byCost = agentCost > 0;
  const agentTotal = byCost ? agentCost : agents.reduce((sum, a) => sum + a.requests, 0);
  const spend = usage.series.map((p) => p.costUsd);
  const peak = usage.series.reduce((best, p) => (p.costUsd > best.costUsd ? p : best), usage.series[0]);
  const rangeNote = `${usage.series.length} active hours`;

  return (
    <div className={cn(PANEL, "@container animate-card-in")} style={stagger(5)}>
      <PanelHeader title="Usage overview" note="Totals across all recorded omp sessions" />
      <div className="grid grid-cols-2 @xl:grid-cols-3">
        <StatTile label="Spend" value={usd.format(totals.costUsd)} note={`${wholeNumber.format(totals.requests)} requests`} />
        <StatTile
          label="Failed"
          value={wholeNumber.format(totals.failedRequests)}
          note={formatPercent(totals.failedRequests / totals.requests)}
        />
        <StatTile
          label="Tokens in / out"
          value={`${compactNumber.format(totals.inputTokens)} / ${compactNumber.format(totals.outputTokens)}`}
        />
        <StatTile
          label="Cache read / write"
          value={`${compactNumber.format(totals.cacheReadTokens)} / ${compactNumber.format(totals.cacheWriteTokens)}`}
          note={
            totals.cacheRate !== null
              ? `${formatPercent(totals.cacheRate)} hit${totals.cacheSavings !== null ? ` · saved ${formatPercent(totals.cacheSavings)}` : ""}`
              : undefined
          }
        />
        <StatTile
          label="Speed"
          value={totals.avgTokensPerSecond !== null ? `${Math.round(totals.avgTokensPerSecond)} tok/s` : "–"}
        />
        <StatTile
          label="First token"
          value={totals.avgTtftMs !== null ? `${wholeNumber.format(Math.round(totals.avgTtftMs))} ms` : "–"}
        />
      </div>
      {spend.length > 1 && (
        <div className="space-y-2 border-t px-4 py-4 sm:px-5">
          <div className="flex items-baseline justify-between gap-3">
            <p className={LABEL}>Spend per hour</p>
            <p className="truncate font-mono text-xs text-muted-foreground tabular-nums">
              {rangeNote} · peak {usd.format(peak.costUsd)}
            </p>
          </div>
          <div className="h-16">
            <Sparkline values={spend} label="Spend per hour" />
          </div>
        </div>
      )}
      {agents.length > 0 && (
        <div className="space-y-3 border-t px-4 py-4 sm:px-5">
          <p className={LABEL}>{byCost ? "Cost by agent" : "Requests by agent"}</p>
          <SegmentBar
            segments={agents.map((a, i) => ({
              key: a.agent,
              label: a.agent,
              value: byCost ? a.costUsd : a.requests,
              className: SERIES[i] ?? OTHER_SERIES,
            }))}
          />
          <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
            {agents.map((a, i) => (
              <li key={a.agent} className="flex min-w-0 items-center gap-1.5">
                <span className={cn("size-2 shrink-0 rounded-full", SERIES[i] ?? OTHER_SERIES)} aria-hidden="true" />
                <span className="truncate font-mono">{a.agent}</span>
                <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                  {byCost ? usd.format(a.costUsd) : wholeNumber.format(a.requests)}
                  {agentTotal > 0 && ` · ${formatPercent((byCost ? a.costUsd : a.requests) / agentTotal)}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Skeletons + section

/**
 * Wide containers put quota and usage side by side; usage gets the larger share because its table
 * has more columns. Each column is its own container, so the provider grid only goes two-up when
 * the quota column itself is wide.
 */
const SPLIT = "grid gap-4 @5xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] @5xl:items-start";

function QuotaSkeleton() {
  return (
    <div className="@container" aria-busy="true">
      <div className="grid gap-4 @2xl:grid-cols-2 @2xl:items-start">
        {[0, 1].map((panel) => (
          <div key={panel} className={PANEL}>
            <div className="border-b px-4 py-3 sm:px-5">
              <Skeleton className="h-4 w-28" />
            </div>
            <div className="divide-y">
              {[0, 1].map((row) => (
                <div key={row} className="flex items-center gap-3.5 px-4 py-3.5 sm:px-5">
                  <Skeleton className="shrink-0 rounded-full" style={{ width: GAUGE_SIZE, height: GAUGE_SIZE }} />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-4 w-32 max-w-full" />
                    <Skeleton className="h-3 w-44 max-w-full" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div className={PANEL} aria-busy="true">
      <div className="border-b px-4 py-3 sm:px-5">
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="grid grid-cols-2 gap-4 border-b px-4 py-4 sm:px-5 @xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-24" />
          </div>
        ))}
      </div>
      <div className="space-y-3 border-b px-4 py-4 sm:px-5">
        <Skeleton className="h-2 w-full rounded-full" />
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-3 w-24" />
          ))}
        </div>
      </div>
      <div className="divide-y">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2 px-4 py-3 sm:px-5">
            <div className="flex items-center justify-between gap-4">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-4 w-16" />
            </div>
            <Skeleton className="h-1 w-full rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function AiSection({ ai }: { ai: AiState }) {
  const { stats, error, refreshing, reload } = ai;
  const now = useNow(30_000);
  const quota = stats?.quota ?? null;
  const usage = stats?.usage ?? null;

  return (
    <section aria-labelledby="ai-quota" className="min-w-0 scroll-mt-20 space-y-4">
      <SectionHeader
        id="ai-quota"
        index="02"
        icon={<SparklesIcon />}
        title="AI quota"
        description={
          stats
            ? `Updated ${formatDuration((now - Date.parse(stats.generatedAt)) / 1000)} ago`
            : "Provider limits and usage from omp"
        }
        action={
          <Button
            variant="outline"
            onClick={reload}
            disabled={refreshing}
            className="pressable h-11 shrink-0 gap-2 px-3.5 md:h-9"
          >
            {refreshing ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <RefreshCwIcon />}
            Refresh
          </Button>
        }
      />

      {!stats && error ? (
        <Notice tone="error" title="Could not load AI stats">
          {error}
        </Notice>
      ) : (
        <div className="@container">
          {/* Without omp there is no usage either; one notice is enough, and it gets the full width. */}
          <div className={quota?.error === OMP_MISSING ? undefined : SPLIT}>
            {quota ? <QuotaList quota={quota} balances={stats?.balances ?? []} now={now} /> : <QuotaSkeleton />}
            {quota?.error !== OMP_MISSING &&
              (usage ? (
                <div className="min-w-0 space-y-4">
                  <UsageOverview usage={usage} />
                  <UsageByFolder usage={usage} />
                  <UsageByModel usage={usage} />
                </div>
              ) : (
                <UsageSkeleton />
              ))}
          </div>
        </div>
      )}
    </section>
  );
}
