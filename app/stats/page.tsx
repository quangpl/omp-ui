"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  BotIcon,
  ChartColumnIcon,
  CpuIcon,
  GaugeIcon,
  HardDriveIcon,
  Loader2Icon,
  MemoryStickIcon,
  RefreshCwIcon,
  ServerIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { api } from "@/lib/api-client";
import {
  STATUS_LABELS,
  TASK_STATUSES,
  type AiProviderQuota,
  type AiQuotaLimit,
  type AiStats,
  type SystemStats,
  type TaskStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const SYSTEM_REFRESH_MS = 5000;
/** Error text `/stats/ai` reports when the omp binary cannot be found. */
const OMP_MISSING = "omp is not installed";

// ---------------------------------------------------------------------------------------------
// Formatters

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** Seconds → "3d 4h", "3h 12m", "12m", "<1m". */
function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

const compactNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const wholeNumber = new Intl.NumberFormat();
const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });

function formatPercent(fraction: number): string {
  if (fraction > 0 && fraction < 0.01) return "<1%";
  return `${Math.round(fraction * 100)}%`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatResetTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  google: "Google",
  "google-gemini-cli": "Gemini CLI",
  "github-copilot": "GitHub Copilot",
};

function providerName(id: string): string {
  return (
    PROVIDER_NAMES[id] ??
    id.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Current time, re-read every `intervalMs` so relative labels stay fresh. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

const STATUS_TONE: Record<TaskStatus, string> = {
  todo: "bg-muted-foreground/40",
  in_progress: "bg-primary",
  done: "bg-success",
};

/** Shared surface for every panel on the page. */
const PANEL = "min-w-0 rounded-xl bg-card ring-1 ring-foreground/10";

// ---------------------------------------------------------------------------------------------
// Data

interface AiState {
  stats: AiStats | null;
  error: string | null;
  refreshing: boolean;
  reload: () => void;
}

function useAiStats(): AiState {
  const [stats, setStats] = useState<AiStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setRefreshing(true);
    try {
      setStats(await api.stats.ai(refresh));
      setError(null);
    } catch (err) {
      const message = errorMessage(err, "Could not load AI stats.");
      setError(message);
      if (refresh) toast.error(message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  return { stats, error, refreshing, reload: () => void load(true) };
}

interface SystemState {
  stats: SystemStats | null;
  error: string | null;
}

/** Live system stats, polled every few seconds while the tab is visible. */
function useSystemStats(): SystemState {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        const next = await api.stats.system();
        if (!cancelled) {
          setStats(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, "Could not load system stats."));
      } finally {
        inFlight = false;
      }
    };
    void load();
    const id = window.setInterval(() => void load(), SYSTEM_REFRESH_MS);
    const onVisibility = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return { stats, error };
}

// ---------------------------------------------------------------------------------------------
// Building blocks

/** Horizontal usage bar; turns amber at 75% and red at 90%. */
function Meter({ fraction, label, className }: { fraction: number; label: string; className?: string }) {
  const clamped = Math.min(1, Math.max(0, fraction));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className={cn(
          "h-full w-full origin-left rounded-full transition-transform duration-500 ease-(--ease-out-smooth) motion-reduce:transition-none",
          clamped >= 0.9 ? "bg-destructive" : clamped >= 0.75 ? "bg-amber-500" : "bg-primary",
        )}
        style={{ transform: `scaleX(${clamped})` }}
      />
    </div>
  );
}

function SectionHeader({
  id,
  icon,
  title,
  description,
  action,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <h2 id={id} className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        <p className="truncate text-xs text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

/** Small heading inside a panel, with an optional right-aligned note. */
function PanelHeader({ title, note }: { title: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b px-4 py-3 sm:px-5">
      <h3 className="min-w-0 truncate text-sm font-medium">{title}</h3>
      {note && <p className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">{note}</p>}
    </div>
  );
}

function Notice({
  tone = "muted",
  title,
  children,
}: {
  tone?: "muted" | "error";
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "flex gap-3 rounded-xl border border-dashed p-4 text-sm",
        tone === "error" && "border-destructive/40 bg-destructive/5",
      )}
    >
      <TriangleAlertIcon
        className={cn("mt-0.5 size-4 shrink-0", tone === "error" ? "text-destructive" : "text-muted-foreground")}
      />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{title}</p>
        {children && <div className="text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}

/** Centered empty state: icon, title, one line of guidance. */
function EmptyState({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
        {icon}
      </span>
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-pretty text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

function OmpMissingHint() {
  return (
    <>
      Install omp on this server, or set its path in{" "}
      <Link href="/settings" className="font-medium text-foreground underline underline-offset-4">
        Settings
      </Link>
      .
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Overview (KPI header)

function Overview({ system, ai }: { system: SystemState; ai: AiState }) {
  return (
    <section aria-label="Overview" className={cn(PANEL, "@container animate-card-in overflow-hidden")}>
      <div className="grid @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        <AgentsKpi stats={system.stats} error={system.error} />
        <AiKpis stats={ai.stats} error={ai.error} />
      </div>
    </section>
  );
}

/** Primary metric: agents running now, with the card pipeline underneath. */
function AgentsKpi({ stats, error }: { stats: SystemStats | null; error: string | null }) {
  if (!stats) {
    return (
      <div className="space-y-5 p-5 sm:p-6" aria-busy={!error}>
        <Skeleton className="h-4 w-32" />
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <>
            <Skeleton className="h-14 w-28" />
            <Skeleton className="h-2 w-full rounded-full" />
            <div className="grid grid-cols-3 gap-3">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          </>
        )}
      </div>
    );
  }

  const { app } = stats;
  const totalTasks = TASK_STATUSES.reduce((sum, status) => sum + app.tasks[status], 0);

  return (
    <div className="flex flex-col gap-5 p-5 sm:p-6">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <BotIcon className="size-4" />
        Agents running
        {app.agentsRunning > 0 && (
          <span className="relative ml-0.5 flex size-2" aria-hidden="true">
            <span className="absolute inset-0 animate-ping rounded-full bg-success/60 motion-reduce:animate-none" />
            <span className="relative size-2 rounded-full bg-success" />
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        <p className="text-5xl leading-none font-semibold tracking-tighter tabular-nums sm:text-6xl">
          {app.agentsRunning}
        </p>
        <dl className="flex gap-5 pb-1 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Queued</dt>
            <dd className="font-medium tabular-nums">{app.agentsQueued}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Projects</dt>
            <dd className="font-medium tabular-nums">{app.boards}</dd>
          </div>
        </dl>
      </div>

      <div className="mt-auto space-y-3">
        <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
          <span>Cards</span>
          <span className="tabular-nums">{wholeNumber.format(totalTasks)} total</span>
        </div>
        <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          {totalTasks > 0 &&
            TASK_STATUSES.map((status) =>
              app.tasks[status] > 0 ? (
                <span
                  key={status}
                  className={cn("h-full transition-[flex-grow] duration-500", STATUS_TONE[status])}
                  style={{ flexGrow: app.tasks[status] }}
                />
              ) : null,
            )}
        </div>
        <dl className="grid grid-cols-3 gap-3">
          {TASK_STATUSES.map((status) => (
            <div key={status} className="min-w-0">
              <dt className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                <span className={cn("size-2 shrink-0 rounded-full", STATUS_TONE[status])} aria-hidden="true" />
                {STATUS_LABELS[status]}
              </dt>
              <dd className="mt-0.5 text-lg font-semibold tracking-tight tabular-nums">{app.tasks[status]}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** Secondary metrics: AI spend and token totals. */
function AiKpis({ stats, error }: { stats: AiStats | null; error: string | null }) {
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

  const cells: { label: string; value: string | null; sub?: React.ReactNode }[] = [
    { label: "Total cost", value: used ? usd.format(used.costUsd) : null },
    {
      label: "Requests",
      value: used ? wholeNumber.format(used.requests) : null,
      sub:
        used && used.failedRequests > 0 ? (
          <span className="text-destructive">{wholeNumber.format(used.failedRequests)} failed</span>
        ) : null,
    },
    {
      label: "Tokens in",
      value: used ? compactNumber.format(used.inputTokens) : null,
      sub: used && used.cacheReadTokens > 0 ? `+${compactNumber.format(used.cacheReadTokens)} cached` : null,
    },
    { label: "Tokens out", value: used ? compactNumber.format(used.outputTokens) : null },
  ];

  return (
    <div className="flex min-w-0 flex-col border-t @3xl:border-t-0 @3xl:border-l">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-5 pt-4 pb-3 sm:px-6">
        <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <SparklesIcon className="size-4" />
          AI usage
        </p>
        <p className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">
          {range ?? unavailable ?? "All recorded omp sessions"}
        </p>
      </div>
      <dl className="grid flex-1 grid-cols-2 gap-px border-t bg-border">
        {cells.map((cell) => (
          <div key={cell.label} className="flex min-w-0 flex-col justify-center gap-1 bg-card px-5 py-4 sm:px-6">
            <dt className="text-xs text-muted-foreground">{cell.label}</dt>
            <dd className="truncate text-2xl font-semibold tracking-tight tabular-nums">
              {!stats && !error ? (
                <Skeleton className="h-7 w-20" />
              ) : (
                (cell.value ?? <span className="text-muted-foreground/60">—</span>)
              )}
            </dd>
            {cell.sub && <dd className="truncate text-xs text-muted-foreground tabular-nums">{cell.sub}</dd>}
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// AI quota + usage

function QuotaLimitRow({ limit, now }: { limit: AiQuotaLimit; now: number }) {
  const fraction = limit.usedFraction;
  const status = limit.status?.toLowerCase();
  const showAmount =
    limit.unit !== "percent" && limit.used !== null && limit.limit !== null && limit.limit > 0;
  const fmt = limit.unit === "usd" ? usd : wholeNumber;
  const unitSuffix = limit.unit && limit.unit !== "usd" ? ` ${limit.unit}` : "";
  const amount = `${fmt.format(limit.used ?? 0)} / ${fmt.format(limit.limit ?? 0)}${unitSuffix}`;
  const resetsAt = limit.resetsAt;
  const resetMs = resetsAt ? Date.parse(resetsAt) - now : null;

  return (
    <li className="space-y-2 px-4 py-3.5 sm:px-5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{limit.label}</span>
        {status && status !== "ok" && (
          <Badge
            variant={status === "warning" ? "secondary" : "destructive"}
            className={cn(status === "warning" && "bg-amber-500/15 text-amber-700 dark:text-amber-400")}
          >
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </Badge>
        )}
        <span className="shrink-0 text-sm font-semibold tabular-nums">
          {fraction === null ? "–" : `${formatPercent(fraction)} used`}
        </span>
      </div>
      {fraction !== null && <Meter fraction={fraction} label={`${limit.label} used`} />}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
        <span>
          {!resetsAt || resetMs === null
            ? limit.windowLabel
              ? `${limit.windowLabel} window`
              : "No reset time reported"
            : resetMs <= 0
              ? "Resetting now"
              : `Resets in ${formatDuration(resetMs / 1000)} · ${formatResetTime(resetsAt)}`}
        </span>
        {showAmount && <span>{amount}</span>}
      </div>
    </li>
  );
}

function ProviderPanel({ provider, now }: { provider: AiProviderQuota; now: number }) {
  return (
    <div className={PANEL}>
      <PanelHeader title={providerName(provider.provider)} note={provider.account} />
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

function QuotaList({ quota, now }: { quota: AiStats["quota"]; now: number }) {
  if (!quota.available) {
    return (
      <Notice tone="error" title={quota.error ?? "Could not read provider quota."}>
        {quota.error === OMP_MISSING ? (
          <OmpMissingHint />
        ) : (
          <>
            Try again in a moment. If it keeps failing, run{" "}
            <code className="font-mono text-xs">omp usage</code> on the server to see why.
          </>
        )}
      </Notice>
    );
  }
  if (quota.providers.length === 0) {
    return (
      <EmptyState icon={<GaugeIcon />} title="No provider quota reported">
        Sign in to a provider with <code className="font-mono text-xs">omp</code> on this server to see its
        limits here.
      </EmptyState>
    );
  }
  return (
    <div className="@container">
      <div className="grid gap-4 @2xl:grid-cols-2 @2xl:items-start">
        {quota.providers.map((provider, index) => (
          <ProviderPanel key={`${provider.provider}-${index}`} provider={provider} now={now} />
        ))}
      </div>
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
        Costs and token counts appear here once agents have run on this server.
      </EmptyState>
    );
  }

  const models = usage.byModel;
  const maxCost = Math.max(0, ...models.map((m) => m.costUsd));

  return (
    <div className={cn(PANEL, "@container")}>
      <PanelHeader title="Usage by model" note={range ?? "All recorded omp sessions on this server."} />
      {models.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground sm:px-5">No per-model breakdown was reported.</p>
      ) : (
        <>
          {/* Narrow: stacked rows. */}
          <ul className="divide-y @xl:hidden">
            {models.map((m) => (
              <li key={`${m.provider}/${m.model}`} className="space-y-1.5 px-4 py-3 sm:px-5">
                <div className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.model}</span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">{usd.format(m.costUsd)}</span>
                </div>
                <CostShare cost={m.costUsd} max={maxCost} />
                <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
                  <span>{providerName(m.provider)}</span>
                  <span>{wholeNumber.format(m.requests)} req</span>
                  <span>{compactNumber.format(m.inputTokens)} in</span>
                  <span>{compactNumber.format(m.outputTokens)} out</span>
                </p>
              </li>
            ))}
          </ul>

          {/* Wide: a real table. */}
          <table className="hidden w-full table-fixed text-sm @xl:table">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground [&>th]:px-3 [&>th]:py-2.5 [&>th]:font-medium [&>th:first-child]:pl-5 [&>th:last-child]:pr-5">
                <th scope="col" className="w-[38%]">Model</th>
                <th scope="col">Provider</th>
                <th scope="col" className="text-right">Requests</th>
                <th scope="col" className="text-right">In</th>
                <th scope="col" className="text-right">Out</th>
                <th scope="col" className="text-right">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {models.map((m) => (
                <tr
                  key={`${m.provider}/${m.model}`}
                  className="tabular-nums transition-colors hover:bg-muted/40 [&>td]:px-3 [&>td]:py-2.5 [&>td:first-child]:pl-5 [&>td:last-child]:pr-5"
                >
                  <td>
                    <span className="block truncate font-mono text-xs" title={m.model}>
                      {m.model}
                    </span>
                    <CostShare cost={m.costUsd} max={maxCost} className="mt-1.5" />
                  </td>
                  <td className="truncate text-muted-foreground">{providerName(m.provider)}</td>
                  <td className="text-right">{wholeNumber.format(m.requests)}</td>
                  <td className="text-right text-muted-foreground">{compactNumber.format(m.inputTokens)}</td>
                  <td className="text-right text-muted-foreground">{compactNumber.format(m.outputTokens)}</td>
                  <td className="text-right font-semibold">{usd.format(m.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/** Thin bar: a model's cost relative to the most expensive one. */
function CostShare({ cost, max, className }: { cost: number; max: number; className?: string }) {
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-full bg-muted", className)} aria-hidden="true">
      <div
        className="h-full w-full origin-left rounded-full bg-primary/60"
        style={{ transform: `scaleX(${max > 0 ? cost / max : 0})` }}
      />
    </div>
  );
}

function AiSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className={PANEL}>
        <div className="border-b px-4 py-3 sm:px-5">
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="divide-y">
          {[0, 1].map((i) => (
            <div key={i} className="space-y-2.5 px-4 py-3.5 sm:px-5">
              <div className="flex justify-between gap-4">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-16" />
              </div>
              <Skeleton className="h-2 w-full rounded-full" />
              <Skeleton className="h-3 w-40" />
            </div>
          ))}
        </div>
      </div>
      <div className={PANEL}>
        <div className="border-b px-4 py-3 sm:px-5">
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="divide-y">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AiSection({ ai }: { ai: AiState }) {
  const { stats, error, refreshing, reload } = ai;
  const now = useNow(30_000);

  return (
    <section
      aria-labelledby="ai-quota"
      className="min-w-0 animate-card-in space-y-4"
      style={{ "--stagger": 2 } as React.CSSProperties}
    >
      <SectionHeader
        id="ai-quota"
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
            className="h-11 shrink-0 gap-2 px-3.5 active:scale-[0.98] md:h-9"
          >
            {refreshing ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
            Refresh
          </Button>
        }
      />

      {!stats ? (
        error ? (
          <Notice tone="error" title="Could not load AI stats">
            {error}
          </Notice>
        ) : (
          <AiSkeleton />
        )
      ) : (
        <div className="space-y-4">
          <QuotaList quota={stats.quota} now={now} />
          {/* Without omp there is no usage either; one notice is enough. */}
          {stats.quota.error !== OMP_MISSING && <UsageByModel usage={stats.usage} />}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// System

function MeterRow({
  icon,
  label,
  fraction,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  fraction: number;
  detail: React.ReactNode;
}) {
  return (
    <li className="space-y-2 px-4 py-3.5 sm:px-5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
          {icon}
          {label}
        </span>
        <span className="text-xl font-semibold tracking-tight tabular-nums">{formatPercent(fraction)}</span>
      </div>
      <Meter fraction={fraction} label={`${label} usage`} />
      <p className="truncate text-xs text-muted-foreground tabular-nums">{detail}</p>
    </li>
  );
}

function SystemSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className={cn(PANEL, "divide-y")}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2.5 px-4 py-3.5 sm:px-5">
            <div className="flex justify-between gap-4">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-5 w-12" />
            </div>
            <Skeleton className="h-2 w-full rounded-full" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
      <div className={cn(PANEL, "divide-y")}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-28" />
          </div>
        ))}
      </div>
    </div>
  );
}

function SystemSection({ system }: { system: SystemState }) {
  const { stats, error } = system;
  return (
    <section
      aria-labelledby="system-stats"
      className="min-w-0 animate-card-in space-y-4"
      style={{ "--stagger": 4 } as React.CSSProperties}
    >
      <SectionHeader
        id="system-stats"
        icon={<CpuIcon />}
        title="System"
        description={
          error && stats ? (
            <span className="text-destructive">Can't reach the server, showing last values</span>
          ) : (
            "Live, updates every 5 seconds"
          )
        }
      />

      {!stats ? (
        error ? (
          <Notice tone="error" title="Could not load system stats">
            {error}
          </Notice>
        ) : (
          <SystemSkeleton />
        )
      ) : (
        <SystemDetails stats={stats} />
      )}
    </section>
  );
}

function SystemDetails({ stats }: { stats: SystemStats }) {
  const { cpu, memory, disk, app, host } = stats;
  const details: [string, string][] = [
    ["Host", host.hostname],
    ["OS", `${host.platform} ${host.release} (${host.arch})`],
    ["Uptime", formatDuration(host.uptimeSec)],
    ["CPU", cpu.model],
    ["Node", host.nodeVersion],
    ["OMP UI", app.version],
    ["Database", app.db === "mongodb" ? "MongoDB" : app.db === "postgres" ? "PostgreSQL" : "SQLite"],
    [
      "Server process",
      `${formatBytes(stats.process.rssBytes)} RSS · up ${formatDuration(stats.process.uptimeSec)}`,
    ],
  ];
  if (disk) details.push(["Data disk", disk.path]);

  return (
    <div className="space-y-4">
      <ul className={cn(PANEL, "divide-y")}>
        <MeterRow
          icon={<CpuIcon />}
          label="CPU"
          fraction={cpu.usagePercent / 100}
          detail={`${cpu.cores} cores · load ${cpu.loadAvg.map((n) => n.toFixed(2)).join(" ")}`}
        />
        <MeterRow
          icon={<MemoryStickIcon />}
          label="Memory"
          fraction={memory.totalBytes > 0 ? memory.usedBytes / memory.totalBytes : 0}
          detail={`${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`}
        />
        {disk ? (
          <MeterRow
            icon={<HardDriveIcon />}
            label="Disk"
            fraction={disk.totalBytes > 0 ? disk.usedBytes / disk.totalBytes : 0}
            detail={`${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}`}
          />
        ) : (
          <li className="flex items-center justify-between gap-3 px-4 py-3.5 text-sm sm:px-5">
            <span className="flex items-center gap-2 font-medium">
              <HardDriveIcon className="size-4 text-muted-foreground" />
              Disk
            </span>
            <span className="text-xs text-muted-foreground">Not available on this system</span>
          </li>
        )}
      </ul>

      <div className={PANEL}>
        <PanelHeader
          title={
            <span className="flex items-center gap-2">
              <ServerIcon className="size-4 text-muted-foreground" />
              Host
            </span>
          }
        />
        <dl className="divide-y text-sm">
          {details.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-4 px-4 py-2.5 sm:px-5">
              <dt className="shrink-0 text-muted-foreground">{label}</dt>
              <dd className="min-w-0 truncate text-right font-mono text-xs" title={value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export default function StatsPage() {
  useDocumentTitle("Stats");
  const ai = useAiStats();
  const system = useSystemStats();
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader title="Stats" />
      <main className="px-safe pb-safe flex-1">
        <div className="mx-auto w-full max-w-[1400px] space-y-8 px-4 py-6 sm:px-6 md:space-y-10 md:py-8 lg:px-8">
          <Overview system={system} ai={ai} />
          <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] xl:gap-8">
            <AiSection ai={ai} />
            <SystemSection system={system} />
          </div>
        </div>
      </main>
    </div>
  );
}
