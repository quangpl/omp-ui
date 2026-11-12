"use client";

// Stats → Optimize: analyze what uses CPU, memory and disk on the server, then free it (end
// leftover processes, close idle helper agents, clean OMP UI leftovers and Docker caches).
import { useState } from "react";
import Link from "next/link";
import {
  CircleCheckIcon,
  CpuIcon,
  HardDriveIcon,
  InfoIcon,
  Loader2Icon,
  MemoryStickIcon,
  OctagonAlertIcon,
  ScanSearchIcon,
  SquareIcon,
  TriangleAlertIcon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog, type ConfirmRequest } from "@/components/containers/dialogs";
import {
  EmptyState,
  Meter,
  Notice,
  PANEL,
  PanelHeader,
  SectionHeader,
  errorMessage,
  formatBytes,
  formatDuration,
  formatPercent,
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
} from "@/lib/types";
import { cn } from "@/lib/utils";

/** Rows shown in the CPU / Memory views (the Agents view shows every agent process). */
const TOP_ROWS = 8;

const TAGS: Record<ProcessTag, { label: string; className: string } | null> = {
  server: { label: "OMP UI", className: "bg-primary/10 text-primary" },
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
  critical: { icon: OctagonAlertIcon, className: "text-destructive" },
  warning: { icon: TriangleAlertIcon, className: "text-amber-600 dark:text-amber-400" },
  info: { icon: InfoIcon, className: "text-primary" },
} as const;

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

export function OptimizeSection() {
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
      description: "Its agent stops now; the card keeps its place and can run again later.",
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
      className="min-w-0 animate-card-in space-y-4"
      style={{ "--stagger": 6 } as React.CSSProperties}
    >
      <SectionHeader
        id="optimize"
        icon={<WandSparklesIcon />}
        title="Optimize"
        description={
          report
            ? `Analyzed at ${new Date(report.generatedAt).toLocaleTimeString()} in ${(report.durationMs / 1000).toFixed(1)} s`
            : "Find what uses CPU, memory and disk, then free it"
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

      {!report ? (
        analyzing ? (
          <OptimizeSkeleton />
        ) : error ? (
          <Notice tone="error" title="Could not analyze the server">
            {error}
          </Notice>
        ) : (
          <EmptyState icon={<ScanSearchIcon />} title="Check the server's health">
            Analyze lists the processes using the most CPU and memory, agent leftovers, and the space OMP UI and Docker
            can give back. Nothing changes until you choose an action.
          </EmptyState>
        )
      ) : (
        <div className={cn("space-y-4 transition-opacity", analyzing && "opacity-60")} aria-busy={analyzing}>
          <Summary report={report} />
          <Recommendations report={report} busy={busy} onRun={runRecommendation} />
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
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

function SummaryTile({
  icon,
  label,
  fraction,
  value,
  lines,
}: {
  icon: React.ReactNode;
  label: string;
  fraction: number;
  value: string;
  lines: React.ReactNode[];
}) {
  return (
    <div className={cn(PANEL, "space-y-2 px-4 py-3.5 sm:px-5")}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
          {icon}
          {label}
        </span>
        <span className="text-xl font-semibold tracking-tight tabular-nums">{value}</span>
      </div>
      <Meter fraction={fraction} label={`${label} usage`} />
      {lines.map((line, i) => (
        <p key={i} className="truncate text-xs text-muted-foreground tabular-nums">
          {line}
        </p>
      ))}
    </div>
  );
}

function Summary({ report }: { report: MaintenanceReport }) {
  const { cpu, memory, storage, processes } = report;
  const topCpu = [...processes].sort((a, b) => b.cpuPercent - a.cpuPercent)[0];
  const memUsed = memory.totalBytes > 0 ? 1 - memory.availableBytes / memory.totalBytes : 0;
  const disk = storage.disk;
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <SummaryTile
        icon={<CpuIcon />}
        label="CPU"
        fraction={cpu.usagePercent / 100}
        value={formatPercent(cpu.usagePercent / 100)}
        lines={[
          `${cpu.cores} cores · load ${cpu.loadAvg.map((n) => n.toFixed(2)).join(" ")}`,
          topCpu ? `Busiest: ${topCpu.name} ${topCpu.cpuPercent.toFixed(0)}%` : "No process data",
        ]}
      />
      <SummaryTile
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
      <SummaryTile
        icon={<HardDriveIcon />}
        label="Disk"
        fraction={disk && disk.totalBytes > 0 ? disk.usedBytes / disk.totalBytes : 0}
        value={disk && disk.totalBytes > 0 ? formatPercent(disk.usedBytes / disk.totalBytes) : "—"}
        lines={[
          disk ? `${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)}` : "Not available",
          storage.safeBytes > 0 ? `${formatBytes(storage.safeBytes)} can be freed safely` : "Nothing safe to free",
        ]}
      />
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
      <div className={cn(PANEL, "flex items-center gap-3 px-4 py-3 text-sm sm:px-5")}>
        <CircleCheckIcon className="size-4 shrink-0 text-success" />
        <span>
          <span className="font-medium">Looking good.</span>{" "}
          <span className="text-muted-foreground">No leftovers or pressure on CPU, memory or disk.</span>
        </span>
      </div>
    );
  }
  return (
    <ul className={cn(PANEL, "divide-y")} aria-label="Recommendations">
      {report.recommendations.map((rec) => {
        const { icon: Icon, className } = SEVERITY[rec.severity];
        return (
          <li key={rec.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
            <Icon className={cn("size-4 shrink-0", className)} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{rec.title}</p>
              <p className="text-xs text-pretty text-muted-foreground">{rec.detail}</p>
            </div>
            {rec.action && rec.actionLabel && (
              <Button
                size="sm"
                variant={rec.severity === "info" ? "outline" : "default"}
                disabled={busy !== null}
                onClick={() => onRun(rec)}
                className="h-11 gap-1.5 md:h-8"
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
    <div className={PANEL}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-3 sm:px-5">
        <h3 className="text-sm font-medium">Processes</h3>
        <Tabs value={view} onValueChange={(v) => onView(v as ProcessView)}>
          <TabsList>
            <TabsTrigger value="cpu" className="px-2.5">
              Top CPU
            </TabsTrigger>
            <TabsTrigger value="memory" className="px-2.5">
              Top memory
            </TabsTrigger>
            <TabsTrigger value="agents" className="px-2.5">
              Agents
              <span className="text-xs text-muted-foreground tabular-nums">{agents.length}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {report.processError ? (
        <div className="p-4 sm:p-5">
          <Notice title="Process list unavailable">{report.processError}</Notice>
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground sm:px-5">
          {view === "agents" ? "No agent processes are running." : "No processes found."}
        </p>
      ) : (
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
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t bg-muted/30 px-4 py-3 sm:px-5">
        <p className="min-w-0 text-xs text-muted-foreground tabular-nums">
          OMP UI server {formatBytes(memory.server.rssBytes)} (heap {formatBytes(memory.server.heapUsedBytes)}) ·{" "}
          {memory.idleHelpers.count} idle helper agent{memory.idleHelpers.count === 1 ? "" : "s"}
          {memory.idleHelpers.count > 0 && ` (${formatBytes(memory.idleHelpers.rssBytes)})`}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={onReleaseMemory}
          className="h-11 gap-1.5 md:h-8"
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
    <li className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{p.name}</span>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{p.pid}</span>
          {tag && <Badge className={cn("shrink-0", tag.className)}>{tag.label}</Badge>}
        </div>
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={p.command}>
          {p.taskId && p.taskTitle && p.taskBoardId ? (
            <>
              <Link href={`/b/${encodeURIComponent(p.taskBoardId)}?task=${encodeURIComponent(p.taskId)}`} className="font-sans text-foreground underline-offset-4 hover:underline">
                {p.taskTitle}
              </Link>
              {" · "}
            </>
          ) : null}
          {p.command}
        </p>
      </div>
      <div className="hidden shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">
        <p className={cn(highlight === "cpu" && "font-medium text-foreground")}>{p.cpuPercent.toFixed(1)}% CPU</p>
        <p className={cn(highlight === "memory" && "font-medium text-foreground")}>{formatBytes(p.rssBytes)}</p>
      </div>
      <div className="w-14 shrink-0 text-right text-xs text-muted-foreground tabular-nums max-sm:hidden">
        {p.elapsedSec !== null ? formatDuration(p.elapsedSec) : "—"}
      </div>
      <div className="flex w-20 shrink-0 justify-end">
        {p.tag === "card-agent" && p.taskId ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={onStopCard}
            className="h-11 gap-1.5 px-2 md:h-8"
            aria-label={`Stop the card ${p.taskTitle ?? ""}`}
          >
            <SquareIcon />
            Stop
          </Button>
        ) : p.killable ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={onKill}
            className="h-11 gap-1.5 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive md:h-8"
            aria-label={`End ${p.name} (${p.pid})`}
          >
            {killing ? <Loader2Icon className="animate-spin" /> : <XIcon />}
            End
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
  const largest = Math.max(1, ...storage.other.map((o) => o.bytes ?? 0));

  return (
    <div className="space-y-4">
      <div className={PANEL}>
        <PanelHeader
          title="Storage cleanup"
          note={storage.dataBytes !== null ? `OMP UI data ${formatBytes(storage.dataBytes)}` : undefined}
        />
        <ul className="divide-y">
          {pending.map((item) => (
            <li key={item.id}>
              <label className="flex cursor-pointer items-start gap-3 px-4 py-2.5 hover:bg-muted/40 sm:px-5">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                  checked={selected.has(item.id)}
                  disabled={busy !== null}
                  onChange={() => onToggle(item.id)}
                />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{item.label}</span>
                    {item.risk === "review" && (
                      <Badge className="shrink-0 bg-amber-500/15 text-amber-700 dark:text-amber-400">Review</Badge>
                    )}
                  </span>
                  <span className="block text-xs text-pretty text-muted-foreground">{item.description}</span>
                </span>
                <span className="shrink-0 text-right text-xs tabular-nums">
                  <span className="block font-medium">{item.bytes ? formatBytes(item.bytes) : "—"}</span>
                  <span className="block text-muted-foreground">
                    {item.count} item{item.count === 1 ? "" : "s"}
                  </span>
                </span>
              </label>
            </li>
          ))}
          {clean.length > 0 && (
            <li className="flex items-start gap-3 px-4 py-2.5 text-xs text-muted-foreground sm:px-5">
              <CircleCheckIcon className="mt-px size-4 shrink-0 text-success" />
              <span className="min-w-0 text-pretty">
                <span className="font-medium text-foreground">Nothing to clean:</span>{" "}
                {clean.map((c) => c.label).join(", ")}
              </span>
            </li>
          )}
        </ul>
        {storage.dockerError && (
          <p className="border-t px-4 py-2.5 text-xs text-muted-foreground sm:px-5">
            Docker cleanup unavailable: {storage.dockerError}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-muted/30 px-4 py-3 sm:px-5">
          <Button
            size="sm"
            variant="outline"
            disabled={picked.length === 0 || busy !== null}
            onClick={() => onClean("selected", picked)}
            className="h-11 gap-1.5 md:h-8"
          >
            {busy === "selected" && <Loader2Icon className="animate-spin" />}
            Clean selected{picked.length > 0 && ` (${picked.length})`}
          </Button>
          <Button
            size="sm"
            disabled={safe.length === 0 || busy !== null}
            onClick={() => onClean("safe", safe)}
            className="h-11 gap-1.5 md:h-8"
          >
            {busy === "safe" ? <Loader2Icon className="animate-spin" /> : <WandSparklesIcon />}
            Clean up safe items{storage.safeBytes > 0 && ` · ${formatBytes(storage.safeBytes)}`}
          </Button>
        </div>
      </div>

      {storage.other.length > 0 && (
        <div className={PANEL}>
          <PanelHeader title="Other large folders" note="For reference; not cleaned here" />
          <ul className="divide-y">
            {storage.other.map((o) => (
              <li key={o.path} className="space-y-1.5 px-4 py-2.5 sm:px-5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-medium" title={o.path}>
                    {o.label}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums">{o.bytes !== null ? formatBytes(o.bytes) : "—"}</span>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full origin-left rounded-full bg-muted-foreground/40"
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
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className={cn(PANEL, "space-y-2.5 px-4 py-3.5 sm:px-5")}>
            <div className="flex justify-between gap-4">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-5 w-12" />
            </div>
            <Skeleton className="h-2 w-full rounded-full" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        {[0, 1].map((i) => (
          <div key={i} className={cn(PANEL, "divide-y")}>
            {[0, 1, 2, 3, 4].map((j) => (
              <div key={j} className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
