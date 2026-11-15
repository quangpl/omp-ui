"use client";

// Cluster section of the Stats page (cluster mode only): totals across the nodes, then one row per
// node with its CPU, memory, agents and link health. Fed by the shared live cluster status.
import { BotIcon, CpuIcon, HouseIcon, MemoryStickIcon, NetworkIcon, ServerIcon } from "lucide-react";
import { formatRelative, useNow } from "@/components/board/format";
import {
  formatBytes,
  formatDuration,
  Meter,
  PANEL,
  PanelHeader,
  SectionHeader,
  wholeNumber,
} from "@/components/stats/shared";
import type { ClusterNodeStatus, ClusterStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const LABEL = "text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground";
const TILE = "flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-5";
/** Two tiles per row, four when wide; the 1px gaps over a tinted backdrop draw the hairlines. */
const TILES_GRID = "grid grid-cols-2 gap-px bg-foreground/[0.06] @2xl:grid-cols-4 [&>*]:bg-card";

function stagger(n: number): React.CSSProperties {
  return { "--stagger": n } as React.CSSProperties;
}

function fraction(used: number, total: number): number {
  return total > 0 ? used / total : 0;
}

/** One cluster-wide figure: label, big value, detail line and an optional usage meter. */
function TotalTile({
  icon,
  label,
  value,
  detail,
  meter,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  /** Usage fraction drawn under the value; omitted for plain counts. */
  meter?: number;
}) {
  return (
    <div className={TILE}>
      <span className={cn("flex min-w-0 items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0", LABEL)}>
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-mono text-2xl leading-none font-semibold tracking-tighter tabular-nums">{value}</span>
        <span className="truncate text-xs text-muted-foreground tabular-nums" title={detail}>
          {detail}
        </span>
      </div>
      {meter !== undefined && <Meter fraction={meter} label={`${label} usage`} />}
    </div>
  );
}

function TotalsPanel({ status }: { status: ClusterStatus }) {
  const { totals } = status;
  const usedMemory = totals.totalMemoryBytes - totals.freeMemoryBytes;
  return (
    <div className={cn(PANEL, "@container overflow-hidden animate-card-in")} style={stagger(5)}>
      <div className={TILES_GRID}>
        <TotalTile
          icon={<NetworkIcon />}
          label="Nodes online"
          value={`${totals.online}/${totals.nodes}`}
          detail={totals.online === totals.nodes ? "All nodes reachable" : `${totals.nodes - totals.online} offline`}
        />
        <TotalTile
          icon={<CpuIcon />}
          label="CPU"
          value={wholeNumber.format(totals.cpus)}
          detail={`${totals.cpus === 1 ? "core" : "cores"} across online nodes`}
        />
        <TotalTile
          icon={<MemoryStickIcon />}
          label="Memory"
          value={formatBytes(usedMemory)}
          detail={`of ${formatBytes(totals.totalMemoryBytes)} in use`}
          meter={fraction(usedMemory, totals.totalMemoryBytes)}
        />
        <TotalTile
          icon={<BotIcon />}
          label="Agents"
          value={`${totals.running}/${totals.slots}`}
          detail={`running of ${totals.slots} ${totals.slots === 1 ? "slot" : "slots"}`}
          meter={fraction(totals.running, totals.slots)}
        />
      </div>
    </div>
  );
}

/** Small label + value cell of a node row. */
function NodeFigure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className={cn("h-4 truncate leading-4", LABEL)}>{label}</dt>
      <dd className="min-w-0 text-xs tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * How far behind a replica's copy of the primary's state is ("Up to date", "12 s behind",
 * "3h 12m behind"); "Source" for the primary. Shared with Settings → Cluster.
 */
export function replicationText(node: ClusterNodeStatus): string {
  if (node.role === "primary" || !node.replication) return "Source";
  const lag = node.replication.lagSeconds;
  if (lag === null) return "Waiting for the first sync";
  if (lag < 1) return "Up to date";
  return `${lag < 60 ? `${Math.round(lag)} s` : formatDuration(lag)} behind`;
}

function NodeRow({ node, home, now }: { node: ClusterNodeStatus; home: boolean; now: number }) {
  const res = node.resources;
  const running = node.runningTaskIds.length;
  const usedMemory = res ? res.totalMemoryBytes - res.freeMemoryBytes : 0;
  const load = res ? fraction(res.loadAvg1, Math.max(1, res.cpus)) : 0;
  return (
    <li className="space-y-3 px-4 py-4 sm:px-5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", node.online ? "bg-success" : "bg-muted-foreground/40")}
        />
        <span className="min-w-0 truncate text-sm font-medium" title={node.name}>
          {node.name}
        </span>
        <span className="sr-only">{node.online ? "online" : "offline"}</span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-medium",
            node.role === "primary" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
          )}
        >
          {node.role === "primary" ? "Primary" : "Replica"}
        </span>
        {node.self && <span className="text-xs text-muted-foreground">this server</span>}
        {home && (
          <span
            title="Home primary: gets control back after a failover"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground"
          >
            <HouseIcon className="size-3.5" aria-hidden />
            Home
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">{node.address}</span>
      </div>
      {node.online ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 @2xl:grid-cols-4">
          <NodeFigure label="CPU">
            {res ? (
              <div className="flex flex-col gap-1.5">
                <span>
                  {res.cpus} {res.cpus === 1 ? "core" : "cores"} · load{" "}
                  <span className="font-mono">{res.loadAvg1.toFixed(2)}</span>
                </span>
                <Meter fraction={load} label={`${node.name} load`} />
              </div>
            ) : (
              <span className="text-muted-foreground">Not reported</span>
            )}
          </NodeFigure>
          <NodeFigure label="Memory">
            {res ? (
              <div className="flex flex-col gap-1.5">
                <span>
                  {formatBytes(usedMemory)} / {formatBytes(res.totalMemoryBytes)}
                </span>
                <Meter fraction={fraction(usedMemory, res.totalMemoryBytes)} label={`${node.name} memory usage`} />
              </div>
            ) : (
              <span className="text-muted-foreground">Not reported</span>
            )}
          </NodeFigure>
          <NodeFigure label="Agents">
            <div className="flex flex-col gap-1.5">
              <span>
                {running} running · {node.slots} {node.slots === 1 ? "slot" : "slots"}
              </span>
              <Meter fraction={fraction(running, node.slots)} label={`${node.name} agent slots in use`} />
            </div>
          </NodeFigure>
          <NodeFigure label="Link">
            <span className="flex flex-col gap-0.5">
              <span>{node.latencyMs === null ? "—" : `${Math.round(node.latencyMs)} ms`}</span>
              <span className="truncate text-muted-foreground">{replicationText(node)}</span>
            </span>
          </NodeFigure>
        </dl>
      ) : (
        <p className="text-xs text-muted-foreground">
          Offline · last seen{" "}
          <time dateTime={node.lastSeenAt}>{formatRelative(node.lastSeenAt, now)}</time>
        </p>
      )}
    </li>
  );
}

function NodesPanel({ status }: { status: ClusterStatus }) {
  const now = useNow();
  return (
    <div className={cn(PANEL, "@container animate-card-in")} style={stagger(6)}>
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            <ServerIcon className="size-4 text-muted-foreground" />
            Nodes
          </span>
        }
        note={`Term ${status.term}`}
      />
      <ul aria-label="Cluster nodes" className="divide-y divide-foreground/[0.06]">
        {status.nodes.map((node) => (
          <NodeRow key={node.nodeId} node={node} home={node.nodeId === status.preferredPrimaryId} now={now} />
        ))}
      </ul>
    </div>
  );
}

/** Stats → Cluster: rendered by the page only when this server is a primary or a replica. */
export function ClusterSection({ status }: { status: ClusterStatus }) {
  const description =
    status.role === "replica" && status.primary
      ? `This server is a replica of ${status.primary.name}; figures as the primary last shared them.`
      : "Every machine of the cluster, live.";
  return (
    <section aria-labelledby="cluster-stats" className="min-w-0 scroll-mt-20 animate-card-in space-y-4" style={stagger(4)}>
      <SectionHeader id="cluster-stats" icon={<NetworkIcon />} title="Cluster" description={description} />
      <TotalsPanel status={status} />
      <NodesPanel status={status} />
    </section>
  );
}
