"use client";

// System section of the Stats page: live vitals with 5-minute history, then load, server process and host.
import { ActivityIcon, CpuIcon, GaugeIcon, HardDriveIcon, MemoryStickIcon, ServerIcon } from "lucide-react";
import { AnimatedNumber, Sparkline } from "@/components/stats/charts";
import {
  formatBytes,
  formatDuration,
  formatPercent,
  Meter,
  Notice,
  PANEL,
  PanelHeader,
  SectionHeader,
  TONE_BG,
  TONE_TEXT,
  toneForFraction,
} from "@/components/stats/shared";
import { HISTORY_CAPACITY, SYSTEM_REFRESH_MS, type SystemState } from "@/components/stats/use-stats";
import { Skeleton } from "@/components/ui/skeleton";
import type { SystemStats } from "@/lib/types";
import { cn } from "@/lib/utils";

const REFRESH_SECONDS = Math.round(SYSTEM_REFRESH_MS / 1000);
const WINDOW_MINUTES = Math.round((HISTORY_CAPACITY * SYSTEM_REFRESH_MS) / 60_000);
const LABEL = "text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground";
const DB_NAMES: Record<SystemStats["app"]["db"], string> = {
  mongodb: "MongoDB",
  postgres: "PostgreSQL",
  sqlite: "SQLite",
};

function stagger(n: number): React.CSSProperties {
  return { "--stagger": n } as React.CSSProperties;
}

// ---------------------------------------------------------------------------------------------
// Shared chart frame

/**
 * Where Sparkline draws 100% and 50% of its range (top padding 8, bottom padding 4 viewBox
 * units, see PAD_TOP/PAD_BOTTOM in charts.tsx), so the gridlines line up with the plotted values.
 */
const GRIDLINES = ["8%", "52%"] as const;

/** Sparkline area with faint 50%/100% gridlines and a "−N min … now" time axis caption. */
function ChartFrame({ children, grow = false }: { children?: React.ReactNode; grow?: boolean }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", grow && "flex-1")}>
      <div className={cn("relative", grow ? "min-h-16 flex-1" : "h-16")}>
        <div aria-hidden className="pointer-events-none absolute inset-y-0 right-1 left-0">
          {GRIDLINES.map((top) => (
            <div key={top} className="absolute inset-x-0 border-t border-dashed border-foreground/10" style={{ top }} />
          ))}
        </div>
        <div className="absolute inset-0">{children}</div>
      </div>
      <div aria-hidden className="flex h-3 justify-between font-mono text-[10px] leading-3 text-muted-foreground">
        <span>−{WINDOW_MINUTES} min</span>
        <span>now</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Vitals

/** Label row shared by every vital tile (and its skeleton/unavailable variants). */
function TileLabel({ icon, label, dot }: { icon: React.ReactNode; label: string; dot?: string }) {
  return (
    <div className="flex h-5 items-center justify-between gap-2">
      <span className={cn("flex min-w-0 items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0", LABEL)}>
        {icon}
        <span className="truncate">{label}</span>
      </span>
      {dot && (
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full transition-colors duration-500 motion-reduce:transition-none", dot)}
        />
      )}
    </div>
  );
}

const TILE = "flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-5";
/** Big number + detail line; fixed height so the tile never changes size between polls. */
const NUMBER_ROW = "flex h-8 min-w-0 items-end gap-3";
/** CPU leads: a slightly wider first column instead of three equal tiles. */
const VITALS_GRID =
  "grid divide-y @2xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] @2xl:divide-x @2xl:divide-y-0";

function VitalTile({
  icon,
  label,
  fraction,
  detail,
  series,
}: {
  icon: React.ReactNode;
  label: string;
  fraction: number;
  detail: string;
  series: number[];
}) {
  const tone = toneForFraction(fraction);
  return (
    <div className={TILE}>
      <TileLabel icon={icon} label={label} dot={TONE_BG[tone]} />
      <div className={NUMBER_ROW}>
        <AnimatedNumber
          value={fraction}
          format={formatPercent}
          className={cn(
            "w-[4.5ch] shrink-0 font-mono text-3xl leading-none font-semibold tracking-tighter transition-colors duration-500 motion-reduce:transition-none",
            tone === "primary" ? "text-foreground" : TONE_TEXT[tone],
          )}
        />
        <p className="min-w-0 truncate pb-0.5 text-xs leading-4 text-muted-foreground tabular-nums" title={detail}>
          {detail}
        </p>
      </div>
      <ChartFrame>
        <Sparkline
          values={series}
          capacity={HISTORY_CAPACITY}
          min={0}
          max={1}
          tone={tone}
          label={`${label} usage, last ${WINDOW_MINUTES} minutes`}
        />
      </ChartFrame>
      <Meter fraction={fraction} label={`${label} usage`} />
    </div>
  );
}

/** Same rows as VitalTile (number, chart, meter track) so the grid never shifts. */
function DiskUnavailableTile() {
  return (
    <div className={TILE}>
      <TileLabel icon={<HardDriveIcon />} label="Disk" />
      <div className={NUMBER_ROW}>
        <span className="font-mono text-3xl leading-none font-semibold tracking-tighter text-muted-foreground/50">—</span>
      </div>
      <ChartFrame>
        <p className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Not available on this system
        </p>
      </ChartFrame>
      <div aria-hidden className="h-1.5 w-full rounded-full bg-foreground/[0.07]" />
    </div>
  );
}

function VitalsPanel({ stats, history, lastUpdated }: { stats: SystemStats } & Omit<SystemState, "stats" | "error">) {
  const { cpu, memory, disk } = stats;
  const cpuSeries = history.map((s) => s.cpu);
  const memorySeries = history.map((s) => s.memory);
  const diskSeries: number[] = [];
  for (const s of history) if (s.disk !== null) diskSeries.push(s.disk);
  const samples = history.length;

  return (
    <div className={cn(PANEL, "animate-card-in")} style={stagger(5)}>
      <div className={VITALS_GRID}>
        <VitalTile
          icon={<CpuIcon />}
          label="CPU"
          fraction={cpu.usagePercent / 100}
          detail={`${cpu.cores} ${cpu.cores === 1 ? "core" : "cores"}`}
          series={cpuSeries}
        />
        <VitalTile
          icon={<MemoryStickIcon />}
          label="Memory"
          fraction={memory.totalBytes > 0 ? memory.usedBytes / memory.totalBytes : 0}
          detail={`${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`}
          series={memorySeries}
        />
        {disk ? (
          <VitalTile
            icon={<HardDriveIcon />}
            label="Disk"
            fraction={disk.totalBytes > 0 ? disk.usedBytes / disk.totalBytes : 0}
            detail={`${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)} · ${formatBytes(disk.freeBytes)} free`}
            series={diskSeries}
          />
        ) : (
          <DiskUnavailableTile />
        )}
      </div>
      <div className="flex h-10 items-center justify-between gap-3 border-t px-4 text-xs text-muted-foreground tabular-nums sm:px-5">
        <span className="truncate">
          Last {WINDOW_MINUTES} min · <span className="font-mono">{samples}</span> {samples === 1 ? "sample" : "samples"}
        </span>
        {lastUpdated !== null && (
          <span className="shrink-0">
            Updated{" "}
            <span className="font-mono">
              {new Date(lastUpdated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Load average

const LOAD_WINDOWS = ["1 min", "5 min", "15 min"] as const;
const LOAD_TRACK = "h-20 w-full max-w-12 justify-self-center rounded-sm";

/** Load + process side by side at medium widths; with host in one asymmetric row when wide. */
const DETAILS_ROW =
  "grid items-stretch gap-4 @2xl:grid-cols-2 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)]";
const HOST_CELL = "@2xl:col-span-2 @4xl:col-span-1";

function LoadPanel({ cpu }: { cpu: SystemStats["cpu"] }) {
  const cores = Math.max(1, cpu.cores);
  const coresText = `${cpu.cores} ${cpu.cores === 1 ? "core" : "cores"}`;
  const summary = cpu.loadAvg.map((n, i) => `${LOAD_WINDOWS[i]} ${n.toFixed(2)}`).join(", ");
  return (
    <div className={cn(PANEL, "flex flex-col animate-card-in")} style={stagger(6)}>
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            <GaugeIcon className="size-4 text-muted-foreground" />
            Load average
          </span>
        }
      />
      <div
        role="img"
        aria-label={`Load average on ${coresText}: ${summary}`}
        className="flex flex-1 flex-col justify-center gap-2 px-4 py-4 sm:px-5"
      >
        <div aria-hidden className="flex h-3 justify-end font-mono text-[10px] leading-3 text-muted-foreground">
          100% = {coresText}
        </div>
        <div className="relative grid grid-cols-3 gap-3">
          {cpu.loadAvg.map((load, i) => {
            const fraction = load / cores;
            const tone = toneForFraction(fraction);
            return (
              <div key={LOAD_WINDOWS[i]} className={cn("relative overflow-hidden bg-foreground/[0.05]", LOAD_TRACK)}>
                <div
                  className={cn(
                    "absolute inset-0 origin-bottom rounded-sm transition-[transform,background-color] duration-700 ease-(--ease-out-smooth) motion-reduce:transition-none",
                    TONE_BG[tone],
                  )}
                  style={{ transform: `scaleY(${Math.min(1, Math.max(0, fraction))})` }}
                />
              </div>
            );
          })}
          {/* Reference line: the track top is every core busy. */}
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-foreground/25" />
        </div>
        <div className="grid grid-cols-3 gap-3 text-center">
          {cpu.loadAvg.map((load, i) => (
            <div key={LOAD_WINDOWS[i]} className="flex min-w-0 flex-col items-center">
              <span className="h-5 font-mono text-sm leading-5 font-semibold tracking-tight tabular-nums">{load.toFixed(2)}</span>
              <span className={cn("h-4 leading-4", LABEL)}>{LOAD_WINDOWS[i]}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Server process

function ProcessPanel({ process, history }: { process: SystemStats["process"]; history: SystemState["history"] }) {
  const rssSeries = history.map((s) => s.rssBytes);
  return (
    <div className={cn(PANEL, "flex flex-col animate-card-in")} style={stagger(7)}>
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            <ActivityIcon className="size-4 text-muted-foreground" />
            Server process
          </span>
        }
        note={<span className="font-mono">pid {process.pid}</span>}
      />
      <div className="flex flex-1 flex-col gap-3 px-4 py-4 sm:px-5">
        <div className={NUMBER_ROW}>
          <AnimatedNumber
            value={process.rssBytes}
            format={formatBytes}
            className="shrink-0 font-mono text-2xl leading-none font-semibold tracking-tighter"
          />
          <span className={cn("truncate pb-0.5 leading-4", LABEL)}>Resident memory</span>
        </div>
        <ChartFrame grow>
          <Sparkline values={rssSeries} capacity={HISTORY_CAPACITY} label={`Server memory (RSS), last ${WINDOW_MINUTES} minutes`} />
        </ChartFrame>
        <dl className="grid grid-cols-2 gap-3 border-t pt-3 text-sm">
          <div className="min-w-0">
            <dt className={LABEL}>Heap used</dt>
            <dd className="mt-1 truncate font-mono font-medium tabular-nums">{formatBytes(process.heapUsedBytes)}</dd>
          </div>
          <div className="min-w-0">
            <dt className={LABEL}>Uptime</dt>
            <dd className="mt-1 truncate font-mono font-medium tabular-nums">{formatDuration(process.uptimeSec)}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Host

/** Host panel is its own container: one column when narrow, more as its cell widens. */
const HOST_PANEL = "@container flex flex-col overflow-hidden";
const DL = "grid flex-1 content-start gap-x-6 gap-y-3 px-4 py-4 text-sm sm:px-5 @sm:grid-cols-2 @2xl:grid-cols-3";
const DL_ITEM = "min-w-0";

function HostPanel({ stats, className }: { stats: SystemStats; className?: string }) {
  const { cpu, disk, app, host } = stats;
  const details: [string, string][] = [
    ["Host", host.hostname],
    ["OS", `${host.platform} ${host.release} (${host.arch})`],
    ["Uptime", formatDuration(host.uptimeSec)],
    ["CPU model", cpu.model],
    ["Node", host.nodeVersion],
    ["OMP-UI", app.version],
    ["Database", DB_NAMES[app.db]],
  ];
  if (disk) details.push(["Data disk", disk.path]);

  return (
    <div className={cn(PANEL, HOST_PANEL, "animate-card-in", className)} style={stagger(8)}>
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            <ServerIcon className="size-4 text-muted-foreground" />
            Host
          </span>
        }
      />
      <dl className={DL}>
        {details.map(([label, value]) => (
          <div key={label} className={DL_ITEM}>
            <dt className={cn("h-4 truncate leading-4", LABEL)}>{label}</dt>
            <dd className="mt-1 h-5 truncate font-mono text-xs leading-5" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Skeleton (mirrors the loaded layout so nothing moves when data arrives)

function PanelHeaderSkeleton({ note = true }: { note?: boolean }) {
  return (
    <div className="flex h-[2.8125rem] items-center justify-between gap-3 border-b px-4 sm:px-5">
      <Skeleton className="h-4 w-28" />
      {note && <Skeleton className="h-3 w-12" />}
    </div>
  );
}

function SystemSkeleton() {
  return (
    <div className="@container space-y-4" aria-busy="true" aria-label="Loading system stats">
      <div className={PANEL}>
        <div className={VITALS_GRID}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={TILE}>
              <div className="flex h-5 items-center">
                <Skeleton className="h-3 w-16" />
              </div>
              <div className={NUMBER_ROW}>
                <Skeleton className="h-[1.875rem] w-[4.5ch] shrink-0 text-3xl" />
                <Skeleton className="mb-0.5 h-3 w-24" />
              </div>
              <ChartFrame>
                <Skeleton className="h-full w-full rounded-md" />
              </ChartFrame>
              <Skeleton className="h-1.5 w-full rounded-full" />
            </div>
          ))}
        </div>
        <div className="flex h-10 items-center border-t px-4 sm:px-5">
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
      <div className={DETAILS_ROW}>
        <div className={cn(PANEL, "flex flex-col")}>
          <PanelHeaderSkeleton note={false} />
          <div className="flex flex-1 flex-col justify-center gap-2 px-4 py-4 sm:px-5">
            <div className="flex h-3 justify-end">
              <Skeleton className="h-3 w-20" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className={LOAD_TRACK} />
              ))}
            </div>
            <div className="grid grid-cols-3 gap-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex flex-col items-center">
                  <div className="flex h-5 items-center">
                    <Skeleton className="h-4 w-10" />
                  </div>
                  <div className="flex h-4 items-center">
                    <Skeleton className="h-3 w-10" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className={cn(PANEL, "flex flex-col")}>
          <PanelHeaderSkeleton />
          <div className="flex flex-1 flex-col gap-3 px-4 py-4 sm:px-5">
            <div className={NUMBER_ROW}>
              <Skeleton className="h-6 w-20 shrink-0" />
              <Skeleton className="mb-0.5 h-3 w-24" />
            </div>
            <ChartFrame grow>
              <Skeleton className="h-full w-full rounded-md" />
            </ChartFrame>
            <div className="grid grid-cols-2 gap-3 border-t pt-3">
              <Skeleton className="h-10 w-20" />
              <Skeleton className="h-10 w-20" />
            </div>
          </div>
        </div>
        <div className={cn(PANEL, HOST_PANEL, HOST_CELL)}>
          <PanelHeaderSkeleton note={false} />
          <div className={DL}>
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <div key={i} className={DL_ITEM}>
                <div className="flex h-4 items-center">
                  <Skeleton className="h-3 w-16" />
                </div>
                <div className="mt-1 flex h-5 items-center">
                  <Skeleton className="h-3.5 w-28 max-w-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function SystemDetails({ system, stats }: { system: SystemState; stats: SystemStats }) {
  return (
    <div className="@container space-y-4">
      <VitalsPanel stats={stats} history={system.history} lastUpdated={system.lastUpdated} />
      <div className={DETAILS_ROW}>
        <LoadPanel cpu={stats.cpu} />
        <ProcessPanel process={stats.process} history={system.history} />
        <HostPanel stats={stats} className={HOST_CELL} />
      </div>
    </div>
  );
}

export function SystemSection({ system }: { system: SystemState }) {
  const { stats, error } = system;
  return (
    <section
      aria-labelledby="system-stats"
      className="min-w-0 scroll-mt-20 animate-card-in space-y-4"
      style={stagger(4)}
    >
      <SectionHeader
        id="system-stats"
        index="01"
        icon={<CpuIcon />}
        title="System"
        description={
          error && stats ? (
            <span className="text-destructive">Can't reach the server; showing last values</span>
          ) : (
            `Live, updates every ${REFRESH_SECONDS} seconds`
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
        <SystemDetails system={system} stats={stats} />
      )}
    </section>
  );
}
