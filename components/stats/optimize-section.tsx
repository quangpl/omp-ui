"use client";

// Stats → Optimize: the live resource guard (memory/CPU holds on queued cards), then analyze what
// uses CPU, memory and disk on the server and free it (end leftover processes, close idle helper
// agents, clean AgentMan leftovers and Docker caches).
import { useState } from "react";
import Link from "next/link";
import {
  CircleCheckIcon,
  CpuIcon,
  GaugeIcon,
  HardDriveIcon,
  InfoIcon,
  Loader2Icon,
  MemoryStickIcon,
  OctagonAlertIcon,
  PauseIcon,
  RotateCwIcon,
  ScanSearchIcon,
  SquareIcon,
  TriangleAlertIcon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog, type ConfirmRequest } from "@/components/containers/dialogs";
import { AnimatedNumber, RadialGauge } from "@/components/stats/charts";
import {
  EmptyState,
  Meter,
  Notice,
  PANEL,
  PanelHeader,
  SectionHeader,
  TONE_TEXT,
  type Tone,
  errorMessage,
  formatBytes,
  formatDuration,
  formatPercent,
  toneForFraction,
} from "@/components/stats/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api-client";
import type {
  CleanupId,
  CleanupItem,
  MaintenanceAction,
  MaintenanceRecommendation,
  MaintenanceReport,
  ProcessInfo,
  ProcessTag,
  ResourcePressure,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/** Rows shown in the CPU / Memory views (the Agents view shows every agent process). */
const TOP_ROWS = 8;

const TAGS: Record<ProcessTag, { label: string; className: string } | null> = {
  server: { label: "AgentMan", className: "bg-primary/10 text-primary" },
  "card-agent": { label: "Card agent", className: "bg-primary/10 text-primary" },
  helper: { label: "Helper agent", className: "bg-muted text-muted-foreground" },
  "orphan-agent": { label: "Orphaned agent", className: "bg-destructive/10 text-destructive" },
  "agent-spawned": { label: "Started by an agent", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  omp: { label: "omp", className: "bg-muted text-muted-foreground" },
  user: null,
  system: { label: "System", className: "bg-muted text-muted-foreground" },
};

/** Agents view order: leftovers first, then live agents, then what agents started. */
const AGENT_RANK: Partial<Record<ProcessTag, number>> = {
  "orphan-agent": 0,
  "card-agent": 1,
  helper: 2,
  "agent-spawned": 3,
};

const SEVERITY = {
  critical: { icon: OctagonAlertIcon, className: "text-destructive", chip: "bg-destructive/10", rule: "bg-destructive" },
  warning: {
    icon: TriangleAlertIcon,
    className: "text-amber-600 dark:text-amber-400",
    chip: "bg-amber-500/15",
    rule: "bg-amber-500",
  },
  info: { icon: InfoIcon, className: "text-primary", chip: "bg-primary/10", rule: "bg-primary/60" },
} as const;

/** Small caps-like label used for vitals and column headers. */
const MICRO = "text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground";

/** Transform-only bar fill; values update in place without layout shift. */
const BAR_FILL =
  "h-full origin-left rounded-full transition-transform duration-700 ease-(--ease-out-smooth) motion-reduce:transition-none";

type ProcessView = "cpu" | "memory" | "agents";

function sumBytes(items: CleanupItem[]): number {
  return items.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
}

function itemList(items: CleanupItem[]) {
  return (
    <ul className="mt-2 list-disc space-y-0.5 pl-5">
      {items.map((item) => (
        <li key={item.id}>
          {item.label}
          {item.bytes ? ` — ${formatBytes(item.bytes)}` : ""}
          {item.risk === "review" && <span className="text-amber-700 dark:text-amber-400"> (review)</span>}
        </li>
      ))}
    </ul>
  );
}

export function OptimizeSection({
  resourceGuard,
}: {
  /** Latest resource-guard sample; null where the guard does not run, undefined while system stats load. */
  resourceGuard: ResourcePressure | null | undefined;
}) {
  const [report, setReport] = useState<MaintenanceReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [selected, setSelected] = useState<Set<CleanupId>>(new Set());
  const [view, setView] = useState<ProcessView>("cpu");

  async function analyze() {
    setAnalyzing(true);
    try {
      const next = await api.stats.analyze();
      setReport(next);
      setError(null);
      // Keep only selections that still have something to clean.
      setSelected((prev) => new Set(next.storage.cleanup.filter((c) => !c.empty && prev.has(c.id)).map((c) => c.id)));
    } catch (err) {
      const message = errorMessage(err, "Could not analyze the server.");
      setError(message);
      toast.error(message);
    } finally {
      setAnalyzing(false);
    }
  }

  /** Run an action, report each step, then analyze again so the numbers reflect the result. */
  async function perform(key: string, action: MaintenanceAction) {
    setBusy(key);
    try {
      const { results, freedBytes } = await api.stats.maintain(action);
      const failed = results.filter((r) => !r.ok);
      const freed = freedBytes > 0 ? `Freed ${formatBytes(freedBytes)}.` : null;
      if (failed.length === 0) {
        toast.success(freed ?? results[0]?.message ?? "Done", {
          description: results.length > 1 || freed ? results.map((r) => r.message).join(" ") : undefined,
        });
      } else {
        toast.error(failed.map((r) => r.message).join(" "), { description: freed ?? undefined });
      }
      if (action.kind === "cleanup") setSelected(new Set());
      await analyze();
    } catch (err) {
      toast.error(errorMessage(err, "The action failed."));
    } finally {
      setBusy(null);
    }
  }

  function askCleanup(key: string, items: CleanupItem[]) {
    const review = items.some((item) => item.risk === "review");
    setConfirm({
      title: items.length === 1 ? `Clean up: ${items[0]!.label}?` : `Clean up ${items.length} items?`,
      description: (
        <>
          {sumBytes(items) > 0 ? `About ${formatBytes(sumBytes(items))} will be freed.` : "This removes:"}
          {itemList(items)}
          {review && <span className="mt-2 block">Items marked “review” can't be restored.</span>}
        </>
      ),
      confirmLabel: "Clean up",
      destructive: review,
      onConfirm: () => perform(key, { kind: "cleanup", ids: items.map((item) => item.id) }),
    });
  }

  function askKill(processes: ProcessInfo[]) {
    const rss = processes.reduce((sum, p) => sum + p.rssBytes, 0);
    const one = processes.length === 1 ? processes[0]! : null;
    setConfirm({
      title: one ? `End ${one.name} (${one.pid})?` : `End ${processes.length} processes?`,
      description: (
        <>
          {one ? (
            <code className="block max-h-24 overflow-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all">
              {one.command}
            </code>
          ) : (
            <span className="block">{processes.map((p) => `${p.name} (${p.pid})`).join(", ")}</span>
          )}
          <span className="mt-2 block">
            Frees about {formatBytes(rss)} of memory. Child processes end too; unsaved work in them is lost.
          </span>
        </>
      ),
      confirmLabel: one ? "End process" : "End processes",
      destructive: true,
      onConfirm: () => perform(`kill:${processes.map((p) => p.pid).join(",")}`, { kind: "kill", pids: processes.map((p) => p.pid) }),
    });
  }

  function askStopCard(p: ProcessInfo) {
    if (!p.taskId) return;
    const taskId = p.taskId;
    setConfirm({
      title: `Stop "${p.taskTitle ?? "this card"}"?`,
      description: "Stops its agent now. The card keeps its place and can run again later.",
      confirmLabel: "Stop card",
      destructive: true,
      onConfirm: () => perform(`stop:${taskId}`, { kind: "stop-card", taskId }),
    });
  }

  function runRecommendation(rec: MaintenanceRecommendation) {
    const action = rec.action;
    if (!report || !action) return;
    if (action.kind === "kill") {
      askKill(report.processes.filter((p) => action.pids.includes(p.pid)));
    } else if (action.kind === "cleanup") {
      askCleanup(rec.id, report.storage.cleanup.filter((c) => action.ids.includes(c.id)));
    } else {
      void perform(rec.id, action);
    }
  }

  return (
    <section
      aria-labelledby="optimize"
      className="min-w-0 scroll-mt-20 animate-card-in space-y-4"
      style={{ "--stagger": 6 } as React.CSSProperties}
    >
      <SectionHeader
        id="optimize"
        index="03"
        icon={<WandSparklesIcon />}
        title="Optimize"
        description={
          report
            ? `Analyzed at ${new Date(report.generatedAt).toLocaleTimeString()} in ${(report.durationMs / 1000).toFixed(1)} s`
            : "Find what uses CPU, memory and disk, and free it"
        }
        action={
          <Button
            variant={report ? "outline" : "default"}
            onClick={() => void analyze()}
            disabled={analyzing}
            className="h-11 shrink-0 gap-2 px-3.5 active:scale-[0.98] md:h-9"
          >
            {analyzing ? <Loader2Icon className="animate-spin" /> : <ScanSearchIcon />}
            {analyzing ? "Analyzing…" : report ? "Analyze again" : "Analyze"}
          </Button>
        }
      />

      <ResourceGuardPanel pressure={resourceGuard} />

      {!report ? (
        analyzing ? (
          <OptimizeSkeleton />
        ) : error ? (
          <Notice tone="error" title="Could not analyze the server">
            {error}
          </Notice>
        ) : (
          <EmptyState icon={<ScanSearchIcon />} title="Check the server's health">
            Lists top CPU and memory processes, agent leftovers, and space AgentMan and Docker can reclaim. Nothing
            changes until you pick an action.
          </EmptyState>
        )
      ) : (
        <div className={cn("space-y-4 transition-opacity", analyzing && "opacity-60")} aria-busy={analyzing}>
          <Summary report={report} />
          <Recommendations report={report} busy={busy} onRun={runRecommendation} />
          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
            <ProcessesPanel
              report={report}
              view={view}
              onView={setView}
              busy={busy}
              onKill={(p) => askKill([p])}
              onStopCard={askStopCard}
              onReleaseMemory={() => void perform("release-memory", { kind: "release-memory" })}
            />
            <StoragePanel
              report={report}
              selected={selected}
              busy={busy}
              onToggle={(id) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onClean={askCleanup}
            />
          </div>
        </div>
      )}

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </section>
  );
}


// ---------------------------------------------------------------------------------------------

/** Panel header shared by the resource guard panel and its loading / unavailable variants. */
function GuardHeader({ status }: { status?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-foreground/[0.06] px-4 py-3 sm:px-5">
      <h3 className="flex min-w-0 items-center gap-2 text-sm font-medium tracking-tight">
        <GaugeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        Resource guard
      </h3>
      {status}
    </div>
  );
}

/** Two gauges (memory, CPU): stacked when narrow, side by side once the panel is wide enough. */
const GUARD_GRID = "grid divide-y @md:grid-cols-2 @md:divide-x @md:divide-y-0";
const GUARD_TILE = "flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-5";
const GUARD_NUMBER = "font-mono text-3xl leading-none font-semibold tracking-tighter";

/** `heldSince` → "14:03:12" (24-hour clock). */
function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * Live memory/CPU guard (polled with the system stats, no Analyze needed): usage against each hold %,
 * whether queued cards are held right now, and the graceful-restart setting.
 */
function ResourceGuardPanel({ pressure }: { pressure: ResourcePressure | null | undefined }) {
  if (pressure === undefined) return <ResourceGuardSkeleton />;
  if (pressure === null) {
    return (
      <div className={PANEL}>
        <GuardHeader />
        <p className="px-4 py-3.5 text-sm text-pretty text-muted-foreground sm:px-5">
          The resource guard does not run on this server.
        </p>
      </div>
    );
  }
  const held = new Set(pressure.holding);
  return (
    <div className={cn(PANEL, "@container")}>
      <GuardHeader status={<GuardStatus pressure={pressure} />} />
      <div className={GUARD_GRID}>
        <GuardGauge
          icon={<MemoryStickIcon />}
          label="Memory"
          note="in use"
          percent={pressure.memoryPercent}
          held={held.has("memory")}
          hold={pressure.memoryHoldPct}
          resume={pressure.memoryResumePct}
        />
        <GuardGauge
          icon={<CpuIcon />}
          label="CPU"
          note={`avg over ${pressure.cpuWindowSec} s`}
          percent={pressure.cpuPercent}
          held={held.has("cpu")}
          hold={pressure.cpuHoldPct}
          resume={pressure.cpuResumePct}
        />
      </div>
      <div className="space-y-1.5 rounded-b-2xl border-t bg-muted/30 px-4 py-3 text-xs sm:px-5">
        <p className="flex items-start gap-1.5 text-pretty text-muted-foreground">
          <RotateCwIcon className="mt-px size-3.5 shrink-0" aria-hidden />
          {pressure.restartAfterMin > 0
            ? `Graceful restart after ${pressure.restartAfterMin} min of memory pressure (waits for running agents)`
            : "Graceful restart off"}
        </p>
        {pressure.restartPending && (
          <p role="status" className="flex items-start gap-1.5 font-medium text-pretty text-amber-700 dark:text-amber-400">
            <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
            Restart pending: restarts once no agent runs
          </p>
        )}
        <p className="text-pretty text-muted-foreground">
          Thresholds: <code className="font-mono text-[11px] break-all">OMP_UI_MEMORY_HOLD_PCT</code>,{" "}
          <code className="font-mono text-[11px] break-all">OMP_UI_CPU_HOLD_PCT</code> in{" "}
          <code className="font-mono text-[11px]">.env</code> — changes apply within 5 s.
        </p>
      </div>
    </div>
  );
}

/** Amber while queued cards are held (which resources, since when), green otherwise. */
function GuardStatus({ pressure }: { pressure: ResourcePressure }) {
  if (pressure.holding.length === 0) {
    return (
      <p
        role="status"
        className="inline-flex items-center gap-1.5 rounded-lg bg-success/10 px-2.5 py-1 text-xs font-medium text-success"
      >
        <CircleCheckIcon className="size-3.5 shrink-0" aria-hidden />
        Queued cards start normally
      </p>
    );
  }
  const resources = pressure.holding.map((r) => (r === "cpu" ? "CPU" : "memory")).join(" + ");
  return (
    <p
      role="status"
      className="inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-lg bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-400"
    >
      <PauseIcon className="size-3.5 shrink-0" aria-hidden />
      Holding queued cards
      <span className="font-normal tabular-nums">
        · {resources}
        {pressure.heldSince && ` · since ${formatClockTime(pressure.heldSince)}`}
      </span>
    </p>
  );
}

function GuardGauge({
  icon,
  label,
  note,
  percent,
  held,
  hold,
  resume,
}: {
  icon: React.ReactNode;
  label: string;
  note: string;
  /** null: no reading yet (CPU needs two samples). */
  percent: number | null;
  held: boolean;
  /** Hold %; 0 = this guard is off. */
  hold: number;
  resume: number;
}) {
  const fraction = percent === null ? 0 : percent / 100;
  const usage = toneForFraction(fraction);
  // A held resource reads amber even below the usage colour's own 75% threshold.
  const tone: Tone = percent === null ? "muted" : held && usage === "primary" ? "warning" : usage;
  return (
    <div className={GUARD_TILE}>
      <div className="flex h-5 items-center justify-between gap-2">
        <span className={cn(MICRO, "flex min-w-0 items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0")}>
          {icon}
          <span className="truncate">{label}</span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{note}</span>
      </div>
      <div className="flex h-8 items-end">
        {percent === null ? (
          <span className={cn(GUARD_NUMBER, "text-muted-foreground/50")}>n/a</span>
        ) : (
          <AnimatedNumber
            value={fraction}
            format={formatPercent}
            className={cn(
              GUARD_NUMBER,
              "transition-colors duration-500 motion-reduce:transition-none",
              tone === "primary" ? "text-foreground" : TONE_TEXT[tone],
            )}
          />
        )}
      </div>
      <div className="relative">
        <Meter fraction={fraction} label={`${label} usage`} tone={tone} />
        {hold > 0 && (
          // Hold threshold tick on the usage bar.
          <span
            aria-hidden
            className="absolute -top-0.5 h-2.5 w-px -translate-x-1/2 bg-foreground/40"
            style={{ left: `${Math.min(100, hold)}%` }}
          />
        )}
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        {hold > 0 ? `Hold ≥ ${hold}% · resume < ${resume}%` : "Off"}
      </p>
    </div>
  );
}

function ResourceGuardSkeleton() {
  return (
    <div className={cn(PANEL, "@container")} aria-busy="true">
      <GuardHeader status={<Skeleton className="h-6 w-44 rounded-lg" />} />
      <div className={GUARD_GRID}>
        {[0, 1].map((i) => (
          <div key={i} className={GUARD_TILE}>
            <div className="flex h-5 items-center justify-between gap-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-1.5 w-full rounded-full" />
            <Skeleton className="h-3 w-40 max-w-full" />
          </div>
        ))}
      </div>
      <div className="space-y-2 rounded-b-2xl border-t bg-muted/30 px-4 py-3 sm:px-5">
        <Skeleton className="h-3 w-56 max-w-full" />
        <Skeleton className="h-3 w-72 max-w-full" />
      </div>
    </div>
  );
}

function Vital({
  icon,
  label,
  fraction,
  value,
  available = true,
  lines,
}: {
  icon: React.ReactNode;
  label: string;
  fraction: number;
  value: string;
  available?: boolean;
  lines: [string, string];
}) {
  const tone: Tone = available ? toneForFraction(fraction) : "muted";
  return (
    <div className="flex min-w-0 items-center gap-4 px-4 py-4 sm:px-5">
      <RadialGauge
        fraction={available ? fraction : 0}
        size={64}
        thickness={6}
        tone={tone}
        label={`${label} usage`}
        className="shrink-0"
      >
        <span
          className={cn(
            "font-mono text-[13px] leading-none font-semibold tracking-tighter tabular-nums",
            tone === "primary" ? "text-foreground" : TONE_TEXT[tone],
          )}
        >
          {value}
        </span>
      </RadialGauge>
      <div className="min-w-0 flex-1 space-y-1">
        <p className={cn(MICRO, "flex items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0")}>
          {icon}
          {label}
        </p>
        <p className="truncate text-sm tabular-nums" title={lines[0]}>
          {lines[0]}
        </p>
        <p className="truncate text-xs text-muted-foreground tabular-nums" title={lines[1]}>
          {lines[1]}
        </p>
      </div>
    </div>
  );
}

/** One panel split into three vitals: stacked when narrow; once wide, CPU leads with a wider column. */
const VITALS_GRID =
  "grid divide-y @3xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] @3xl:divide-x @3xl:divide-y-0";

function Summary({ report }: { report: MaintenanceReport }) {
  const { cpu, memory, storage, processes } = report;
  const topCpu = [...processes].sort((a, b) => b.cpuPercent - a.cpuPercent)[0];
  const memUsed = memory.totalBytes > 0 ? 1 - memory.availableBytes / memory.totalBytes : 0;
  const disk = storage.disk;
  const diskKnown = !!disk && disk.totalBytes > 0;
  const diskUsed = diskKnown ? disk.usedBytes / disk.totalBytes : 0;
  return (
    <div className={cn(PANEL, "@container")}>
      <div className={VITALS_GRID}>
        <Vital
          icon={<CpuIcon />}
          label="CPU"
          fraction={cpu.usagePercent / 100}
          value={formatPercent(cpu.usagePercent / 100)}
          lines={[
            `${cpu.cores} cores · load ${cpu.loadAvg.map((n) => n.toFixed(2)).join(" ")}`,
            topCpu ? `Busiest: ${topCpu.name} ${topCpu.cpuPercent.toFixed(0)}%` : "No process data",
          ]}
        />
        <Vital
          icon={<MemoryStickIcon />}
          label="Memory"
          fraction={memUsed}
          value={formatPercent(memUsed)}
          lines={[
            `${formatBytes(memory.availableBytes)} available of ${formatBytes(memory.totalBytes)}`,
            memory.swapTotalBytes
              ? `Swap ${formatBytes(memory.swapUsedBytes ?? 0)} / ${formatBytes(memory.swapTotalBytes)}`
              : "No swap",
          ]}
        />
        <Vital
          icon={<HardDriveIcon />}
          label="Disk"
          fraction={diskUsed}
          available={diskKnown}
          value={diskKnown ? formatPercent(diskUsed) : "—"}
          lines={[
            disk ? `${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)}` : "Not available",
            storage.safeBytes > 0 ? `${formatBytes(storage.safeBytes)} can be freed safely` : "Nothing safe to free",
          ]}
        />
      </div>
    </div>
  );
}

function Recommendations({
  report,
  busy,
  onRun,
}: {
  report: MaintenanceReport;
  busy: string | null;
  onRun: (rec: MaintenanceRecommendation) => void;
}) {
  if (report.recommendations.length === 0) {
    return (
      <div className={cn(PANEL, "relative flex items-center gap-3 px-4 py-3.5 text-sm sm:px-5")}>
        <span aria-hidden className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-success" />
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-success/10 text-success">
          <CircleCheckIcon className="size-4" />
        </span>
        <span className="min-w-0 text-pretty">
          <span className="font-medium">Looking good.</span>{" "}
          <span className="text-muted-foreground">No leftovers or pressure on CPU, memory or disk.</span>
        </span>
      </div>
    );
  }
  return (
    <ul className={cn(PANEL, "divide-y")} aria-label="Recommendations">
      {report.recommendations.map((rec) => {
        const { icon: Icon, className, chip, rule } = SEVERITY[rec.severity];
        return (
          <li
            key={rec.id}
            className="relative grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2.5 px-4 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:px-5"
          >
            <span aria-hidden className={cn("absolute inset-y-3 left-0 w-[3px] rounded-r-full", rule)} />
            <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", chip, className)}>
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium text-balance">{rec.title}</p>
              <p className="text-xs text-pretty text-muted-foreground">{rec.detail}</p>
            </div>
            {rec.action && rec.actionLabel && (
              <Button
                size="sm"
                variant={rec.severity === "info" ? "outline" : "default"}
                disabled={busy !== null}
                onClick={() => onRun(rec)}
                className="col-start-2 h-11 gap-1.5 justify-self-start active:scale-[0.98] sm:col-start-3 sm:justify-self-end md:h-8"
              >
                {busy === rec.id && <Loader2Icon className="animate-spin" />}
                {rec.actionLabel}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Column widths shared by the process header and rows so they line up. */
const PROC_METRIC = "w-16 shrink-0 text-right sm:w-20";
const PROC_UPTIME = "w-14 shrink-0 text-right max-sm:hidden";
const PROC_ACTION = "flex w-11 shrink-0 justify-end sm:w-20";
/** Row action: icon-only (44 px touch target) on phones, icon + label from `sm` up. */
const PROC_BUTTON = "h-11 gap-1.5 px-2 active:scale-[0.98] max-sm:w-11 md:h-8";

function ProcessesPanel({
  report,
  view,
  onView,
  busy,
  onKill,
  onStopCard,
  onReleaseMemory,
}: {
  report: MaintenanceReport;
  view: ProcessView;
  onView: (view: ProcessView) => void;
  busy: string | null;
  onKill: (p: ProcessInfo) => void;
  onStopCard: (p: ProcessInfo) => void;
  onReleaseMemory: () => void;
}) {
  const { processes, memory } = report;
  const agents = processes
    .filter((p) => AGENT_RANK[p.tag] !== undefined)
    .sort((a, b) => AGENT_RANK[a.tag]! - AGENT_RANK[b.tag]! || b.rssBytes - a.rssBytes);
  const rows =
    view === "agents"
      ? agents
      : [...processes]
          .sort((a, b) => (view === "cpu" ? b.cpuPercent - a.cpuPercent : b.rssBytes - a.rssBytes))
          .slice(0, TOP_ROWS);

  return (
    <div className={cn(PANEL, "min-w-0")}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-3 sm:px-5">
        <h3 className="text-sm font-medium">Processes</h3>
        <Tabs value={view} onValueChange={(v) => onView(v as ProcessView)} className="max-sm:w-full">
          <TabsList className="max-sm:w-full group-data-horizontal/tabs:h-11 md:group-data-horizontal/tabs:h-8">
            <TabsTrigger value="cpu" className="min-w-0 px-2.5">
              <span className="sm:hidden">CPU</span>
              <span className="max-sm:hidden">Top CPU</span>
            </TabsTrigger>
            <TabsTrigger value="memory" className="min-w-0 px-2.5">
              <span className="sm:hidden">Memory</span>
              <span className="max-sm:hidden">Top memory</span>
            </TabsTrigger>
            <TabsTrigger value="agents" className="min-w-0 px-2.5">
              Agents
              <span className="font-mono text-xs text-muted-foreground tabular-nums">{agents.length}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {report.processError ? (
        <div className="p-4 sm:p-5">
          <Notice title="Process list unavailable">{report.processError}</Notice>
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground sm:px-5">
          {view === "agents" ? "No agent processes are running." : "No processes found."}
        </p>
      ) : (
        <>
          <div aria-hidden className={cn(MICRO, "flex min-w-0 items-center gap-3 border-b px-4 py-2 sm:px-5")}>
            <span className="min-w-0 flex-1">Process</span>
            <span className={PROC_METRIC}>{view === "cpu" ? "CPU" : "Memory"}</span>
            <span className={PROC_UPTIME}>Uptime</span>
            <span className={PROC_ACTION} />
          </div>
          <ul className="divide-y">
            {rows.map((p) => (
              <ProcessRow
                key={p.pid}
                process={p}
                highlight={view === "cpu" ? "cpu" : "memory"}
                busy={busy}
                onKill={() => onKill(p)}
                onStopCard={() => onStopCard(p)}
              />
            ))}
          </ul>
        </>
      )}

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-b-2xl border-t bg-muted/30 px-4 py-3 sm:px-5">
        <p className="min-w-0 text-xs text-pretty text-muted-foreground tabular-nums">
          AgentMan server {formatBytes(memory.server.rssBytes)} (heap {formatBytes(memory.server.heapUsedBytes)}) ·{" "}
          {memory.idleHelpers.count} idle helper agent{memory.idleHelpers.count === 1 ? "" : "s"}
          {memory.idleHelpers.count > 0 && ` (${formatBytes(memory.idleHelpers.rssBytes)})`}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={onReleaseMemory}
          className="h-11 gap-1.5 active:scale-[0.98] max-sm:w-full md:h-8"
        >
          {busy === "release-memory" ? <Loader2Icon className="animate-spin" /> : <MemoryStickIcon />}
          Free server memory
        </Button>
      </div>
    </div>
  );
}

function ProcessRow({
  process: p,
  highlight,
  busy,
  onKill,
  onStopCard,
}: {
  process: ProcessInfo;
  highlight: "cpu" | "memory";
  busy: string | null;
  onKill: () => void;
  onStopCard: () => void;
}) {
  const tag = TAGS[p.tag];
  const killing = busy?.startsWith("kill:") && busy.slice(5).split(",").includes(String(p.pid));
  return (
    <li className="flex min-w-0 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40 sm:px-5">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{p.name}</span>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{p.pid}</span>
          {tag && <Badge className={cn("shrink-0 max-sm:hidden", tag.className)}>{tag.label}</Badge>}
        </div>
        {tag && <Badge className={cn("sm:hidden", tag.className)}>{tag.label}</Badge>}
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={p.command}>
          {p.taskId && p.taskTitle && p.taskBoardId ? (
            <>
              <Link
                href={`/b/${encodeURIComponent(p.taskBoardId)}?task=${encodeURIComponent(p.taskId)}`}
                className="font-sans text-foreground underline-offset-4 hover:underline"
              >
                {p.taskTitle}
              </Link>
              {" · "}
            </>
          ) : null}
          {p.command}
        </p>
      </div>
      <div className={cn(PROC_METRIC, "font-mono text-xs text-muted-foreground tabular-nums")}>
        <p className={cn(highlight === "cpu" ? "font-medium text-foreground" : "max-sm:hidden")}>
          {p.cpuPercent.toFixed(1)}%<span className="max-sm:hidden"> CPU</span>
        </p>
        <p className={cn(highlight === "memory" ? "font-medium text-foreground" : "max-sm:hidden")}>
          {formatBytes(p.rssBytes)}
        </p>
      </div>
      <div className={cn(PROC_UPTIME, "font-mono text-xs text-muted-foreground tabular-nums")}>
        {p.elapsedSec !== null ? formatDuration(p.elapsedSec) : "—"}
      </div>
      <div className={PROC_ACTION}>
        {p.tag === "card-agent" && p.taskId ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={onStopCard}
            className={PROC_BUTTON}
            aria-label={`Stop the card ${p.taskTitle ?? ""}`}
          >
            <SquareIcon />
            <span className="max-sm:hidden">Stop</span>
          </Button>
        ) : p.killable ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={onKill}
            className={cn(PROC_BUTTON, "text-destructive hover:bg-destructive/10 hover:text-destructive")}
            aria-label={`End ${p.name} (${p.pid})`}
          >
            {killing ? <Loader2Icon className="animate-spin" /> : <XIcon />}
            <span className="max-sm:hidden">End</span>
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function StoragePanel({
  report,
  selected,
  busy,
  onToggle,
  onClean,
}: {
  report: MaintenanceReport;
  selected: Set<CleanupId>;
  busy: string | null;
  onToggle: (id: CleanupId) => void;
  onClean: (key: string, items: CleanupItem[]) => void;
}) {
  const { storage } = report;
  const safe = storage.cleanup.filter((c) => c.risk === "safe" && !c.empty);
  const picked = storage.cleanup.filter((c) => selected.has(c.id));
  const pending = storage.cleanup.filter((c) => !c.empty);
  const clean = storage.cleanup.filter((c) => c.empty);
  const largestPending = Math.max(1, ...pending.map((c) => c.bytes ?? 0));
  const largest = Math.max(1, ...storage.other.map((o) => o.bytes ?? 0));

  return (
    <div className="min-w-0 space-y-4">
      <div className={cn(PANEL, "min-w-0")}>
        <PanelHeader
          title="Storage cleanup"
          note={storage.dataBytes !== null ? `AgentMan data ${formatBytes(storage.dataBytes)}` : undefined}
        />
        <ul className="divide-y">
          {pending.map((item) => (
            <li key={item.id}>
              <label className="flex min-w-0 cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/40 has-[:checked]:bg-primary/[0.04] sm:px-5">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                  checked={selected.has(item.id)}
                  disabled={busy !== null}
                  onChange={() => onToggle(item.id)}
                />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">{item.label}</span>
                    {item.risk === "review" && (
                      <Badge className="shrink-0 bg-amber-500/15 text-amber-700 dark:text-amber-400">Review</Badge>
                    )}
                  </span>
                  <span className="block text-xs text-pretty text-muted-foreground">{item.description}</span>
                  <span aria-hidden className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-muted">
                    <span
                      className={cn(BAR_FILL, "block", item.risk === "review" ? "bg-amber-500/70" : "bg-primary/70")}
                      style={{ transform: `scaleX(${(item.bytes ?? 0) / largestPending})` }}
                    />
                  </span>
                </span>
                <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums">
                  <span className="block font-medium">{item.bytes ? formatBytes(item.bytes) : "—"}</span>
                  <span className="block font-sans text-muted-foreground">
                    {item.count} item{item.count === 1 ? "" : "s"}
                  </span>
                </span>
              </label>
            </li>
          ))}
          {clean.length > 0 && (
            <li className="flex items-start gap-3 px-4 py-3 text-xs text-muted-foreground sm:px-5">
              <CircleCheckIcon className="mt-px size-4 shrink-0 text-success" />
              <span className="min-w-0 text-pretty">
                <span className="font-medium text-foreground">Nothing to clean:</span>{" "}
                {clean.map((c) => c.label).join(", ")}
              </span>
            </li>
          )}
        </ul>
        {storage.dockerError && (
          <p className="border-t px-4 py-2.5 text-xs text-pretty text-muted-foreground sm:px-5">
            Docker cleanup unavailable: {storage.dockerError}
          </p>
        )}
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 rounded-b-2xl border-t bg-muted/30 px-4 py-3 sm:px-5">
          <Button
            size="sm"
            variant="outline"
            disabled={picked.length === 0 || busy !== null}
            onClick={() => onClean("selected", picked)}
            className="h-11 gap-1.5 tabular-nums active:scale-[0.98] max-sm:flex-1 md:h-8"
          >
            {busy === "selected" && <Loader2Icon className="animate-spin" />}
            Clean selected{picked.length > 0 && ` (${picked.length})`}
          </Button>
          <Button
            size="sm"
            disabled={safe.length === 0 || busy !== null}
            onClick={() => onClean("safe", safe)}
            className="h-11 gap-1.5 tabular-nums active:scale-[0.98] max-sm:flex-1 md:h-8"
          >
            {busy === "safe" ? <Loader2Icon className="animate-spin" /> : <WandSparklesIcon />}
            Clean up safe items{storage.safeBytes > 0 && ` · ${formatBytes(storage.safeBytes)}`}
          </Button>
        </div>
      </div>

      {storage.other.length > 0 && (
        <div className={cn(PANEL, "min-w-0")}>
          <PanelHeader title="Other large folders" note="For reference; not cleaned here" />
          <ul className="divide-y">
            {storage.other.map((o) => (
              <li key={o.path} className="space-y-1.5 px-4 py-3 transition-colors hover:bg-muted/40 sm:px-5">
                <div className="flex min-w-0 items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-medium" title={o.path}>
                    {o.label}
                  </span>
                  <span className="shrink-0 font-mono text-xs font-medium tabular-nums">
                    {o.bytes !== null ? formatBytes(o.bytes) : "—"}
                  </span>
                </div>
                <div aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(BAR_FILL, "bg-muted-foreground/40")}
                    style={{ transform: `scaleX(${(o.bytes ?? 0) / largest})` }}
                  />
                </div>
                <p className="truncate text-xs text-muted-foreground" title={o.path}>
                  {o.note}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function OptimizeSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className={cn(PANEL, "@container")}>
        <div className={VITALS_GRID}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-4 sm:px-5">
              <Skeleton className="size-16 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-4 w-40 max-w-full" />
                <Skeleton className="h-3 w-28" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className={cn(PANEL, "flex items-center gap-3 px-4 py-3.5 sm:px-5")}>
        <Skeleton className="size-8 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="h-4 w-48 max-w-full" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
      </div>
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        {[0, 1].map((i) => (
          <div key={i} className={cn(PANEL, "divide-y")}>
            <div className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-11 w-40 md:h-8" />
            </div>
            {[0, 1, 2, 3, 4].map((j) => (
              <div key={j} className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-36 max-w-full" />
                  <Skeleton className="h-3 w-52 max-w-full" />
                </div>
                <Skeleton className="h-4 w-14 shrink-0" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
