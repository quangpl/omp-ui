"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  BotIcon,
  CpuIcon,
  FolderKanbanIcon,
  HardDriveIcon,
  ListTodoIcon,
  Loader2Icon,
  MemoryStickIcon,
  RefreshCwIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

// ---------------------------------------------------------------------------------------------
// Building blocks

/** Horizontal usage bar; turns amber at 75% and red at 90%. */
function Meter({ fraction, label }: { fraction: number; label: string }) {
  const clamped = Math.min(1, Math.max(0, fraction));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500",
          clamped >= 0.9 ? "bg-destructive" : clamped >= 0.75 ? "bg-amber-500" : "bg-primary",
        )}
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
}

function SectionTitle({
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
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4.5">
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

function Tile({
  icon,
  label,
  className,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0 rounded-xl bg-card p-4 ring-1 ring-foreground/10", className)}>
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground [&_svg]:size-4">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}

function MeterTile({
  icon,
  label,
  fraction,
  detail,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  fraction: number;
  detail: React.ReactNode;
  className?: string;
}) {
  return (
    <Tile icon={icon} label={label} className={className}>
      <p className="text-2xl font-semibold tabular-nums tracking-tight">{formatPercent(fraction)}</p>
      <Meter fraction={fraction} label={`${label} usage`} />
      <p className="mt-2 truncate text-xs text-muted-foreground tabular-nums">{detail}</p>
    </Tile>
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
      className={cn(
        "flex gap-3 rounded-xl border border-dashed p-4 text-sm",
        tone === "error" && "border-destructive/40 bg-destructive/5",
      )}
    >
      <TriangleAlertIcon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{title}</p>
        {children && <div className="text-muted-foreground">{children}</div>}
      </div>
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
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
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

function ProviderCard({ provider, now }: { provider: AiProviderQuota; now: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{providerName(provider.provider)}</CardTitle>
        {provider.account && (
          <CardDescription className="truncate">{provider.account}</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        {provider.limits.length === 0 ? (
          <p className="text-sm text-muted-foreground">This provider did not report any limits.</p>
        ) : (
          <ul className="divide-y">
            {provider.limits.map((limit) => (
              <QuotaLimitRow key={limit.id} limit={limit} now={now} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
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
      <Notice title="No provider quota reported">
        Sign in to a provider with <code className="font-mono text-xs">omp</code> on this server to
        see its limits here.
      </Notice>
    );
  }
  return (
    <div className="space-y-3">
      {quota.providers.map((provider, index) => (
        <ProviderCard key={`${provider.provider}-${index}`} provider={provider} now={now} />
      ))}
    </div>
  );
}

function UsageCard({ usage }: { usage: AiStats["usage"] }) {
  const totals = usage.totals;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage</CardTitle>
        <CardDescription>
          {totals?.firstAt && totals.lastAt
            ? `${formatDate(totals.firstAt)} → ${formatDate(totals.lastAt)}`
            : "All recorded omp sessions on this server."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!usage.available ? (
          <Notice tone="error" title={usage.error ?? "Could not read usage."}>
            {usage.error === OMP_MISSING ? (
              <OmpMissingHint />
            ) : (
              <>
                Run <code className="font-mono text-xs">omp stats</code> on the server to see why.
              </>
            )}
          </Notice>
        ) : !totals || totals.requests === 0 ? (
          <p className="text-sm text-muted-foreground">No usage recorded yet.</p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-muted/50 p-3">
                <dt className="text-xs text-muted-foreground">Total cost</dt>
                <dd className="text-lg font-semibold tabular-nums">{usd.format(totals.costUsd)}</dd>
              </div>
              <div className="rounded-lg bg-muted/50 p-3">
                <dt className="text-xs text-muted-foreground">Requests</dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {wholeNumber.format(totals.requests)}
                </dd>
                {totals.failedRequests > 0 && (
                  <dd className="text-xs text-destructive tabular-nums">
                    {wholeNumber.format(totals.failedRequests)} failed
                  </dd>
                )}
              </div>
              <div className="rounded-lg bg-muted/50 p-3">
                <dt className="text-xs text-muted-foreground">Tokens in</dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {compactNumber.format(totals.inputTokens)}
                </dd>
                {totals.cacheReadTokens > 0 && (
                  <dd className="text-xs text-muted-foreground tabular-nums">
                    +{compactNumber.format(totals.cacheReadTokens)} cached
                  </dd>
                )}
              </div>
              <div className="rounded-lg bg-muted/50 p-3">
                <dt className="text-xs text-muted-foreground">Tokens out</dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {compactNumber.format(totals.outputTokens)}
                </dd>
              </div>
            </dl>

            {usage.byModel.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground">By model</h3>
                <ul className="divide-y rounded-lg border">
                  {usage.byModel.map((m) => (
                    <li key={`${m.provider}/${m.model}`} className="space-y-1 px-3 py-2.5">
                      <div className="flex items-baseline gap-3">
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.model}</span>
                        <span className="shrink-0 text-sm font-semibold tabular-nums">
                          {usd.format(m.costUsd)}
                        </span>
                      </div>
                      <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
                        <span>{providerName(m.provider)}</span>
                        <span>{wholeNumber.format(m.requests)} req</span>
                        <span>{compactNumber.format(m.inputTokens)} in</span>
                        <span>{compactNumber.format(m.outputTokens)} out</span>
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AiSection() {
  const [stats, setStats] = useState<AiStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow(30_000);

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

  return (
    <section aria-labelledby="ai-quota" className="min-w-0 space-y-3">
      <SectionTitle
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
            onClick={() => void load(true)}
            disabled={refreshing}
            className="h-11 shrink-0 gap-2 px-3.5 md:h-9"
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
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-44 w-full rounded-xl" />
            <Skeleton className="h-56 w-full rounded-xl" />
          </div>
        )
      ) : (
        <>
          <QuotaList quota={stats.quota} now={now} />
          {/* Without omp there is no usage either; one notice is enough. */}
          {stats.quota.error !== OMP_MISSING && <UsageCard usage={stats.usage} />}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// System

function SystemSection() {
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

  return (
    <section aria-labelledby="system-stats" className="min-w-0 space-y-3">
      <SectionTitle
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-busy="true">
            <Skeleton className="col-span-2 h-32 rounded-xl sm:col-span-1" />
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="col-span-2 h-24 rounded-xl sm:col-span-1" />
            <Skeleton className="col-span-2 h-64 rounded-xl sm:col-span-3" />
          </div>
        )
      ) : (
        <SystemTiles stats={stats} />
      )}
    </section>
  );
}

function SystemTiles({ stats }: { stats: SystemStats }) {
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
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <MeterTile
          icon={<CpuIcon />}
          label="CPU"
          fraction={cpu.usagePercent / 100}
          detail={`${cpu.cores} cores · load ${cpu.loadAvg.map((n) => n.toFixed(2)).join(" ")}`}
          className="col-span-2 sm:col-span-1"
        />
        <MeterTile
          icon={<MemoryStickIcon />}
          label="Memory"
          fraction={memory.totalBytes > 0 ? memory.usedBytes / memory.totalBytes : 0}
          detail={`${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`}
        />
        {disk ? (
          <MeterTile
            icon={<HardDriveIcon />}
            label="Disk"
            fraction={disk.totalBytes > 0 ? disk.usedBytes / disk.totalBytes : 0}
            detail={`${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}`}
          />
        ) : (
          <Tile icon={<HardDriveIcon />} label="Disk">
            <p className="text-sm text-muted-foreground">Not available on this system.</p>
          </Tile>
        )}

        <Tile icon={<BotIcon />} label="Agents">
          <p className="text-2xl font-semibold tabular-nums tracking-tight">{app.agentsRunning}</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            running · {app.agentsQueued} queued
          </p>
        </Tile>
        <Tile icon={<FolderKanbanIcon />} label="Projects">
          <p className="text-2xl font-semibold tabular-nums tracking-tight">{app.boards}</p>
          <p className="text-xs text-muted-foreground">{app.boards === 1 ? "board" : "boards"}</p>
        </Tile>
        <Tile icon={<ListTodoIcon />} label="Tasks" className="col-span-2 sm:col-span-1">
          <div className="grid grid-cols-3 gap-2">
            {TASK_STATUSES.map((status) => (
              <div key={status} className="min-w-0">
                <p className="text-xl font-semibold tabular-nums tracking-tight">
                  {app.tasks[status]}
                </p>
                <p className="truncate text-xs text-muted-foreground">{STATUS_LABELS[status]}</p>
              </div>
            ))}
          </div>
        </Tile>
      </div>

      <dl className="divide-y rounded-xl bg-card text-sm ring-1 ring-foreground/10">
        {details.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-4 px-4 py-2.5">
            <dt className="shrink-0 text-muted-foreground">{label}</dt>
            <dd className="min-w-0 truncate text-right font-mono text-xs" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export default function StatsPage() {
  useDocumentTitle("Stats");
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader title="Stats" />
      <main className="px-safe pb-safe mx-auto w-full max-w-6xl flex-1">
        <div className="grid gap-8 px-4 py-5 sm:px-6 sm:py-8 lg:grid-cols-2 lg:items-start">
          <AiSection />
          <SystemSection />
        </div>
      </main>
    </div>
  );
}
