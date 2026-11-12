"use client";

import { useMemo, useState } from "react";
import {
  BoxIcon,
  CopyIcon,
  ExternalLinkIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  RotateCwIcon,
  ScrollTextIcon,
  SearchIcon,
  SkullIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { EmptyState, SectionHeader, STATE_STYLES, StateDot } from "@/components/containers/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { ContainerAction, DockerContainer, DockerContainerStats, DockerPort } from "@/lib/docker-types";
import { cn } from "@/lib/utils";

type Filter = "all" | "running" | "stopped";

/** Icon buttons: 44px touch targets on phones, dense on desktop. */
const ICON_BUTTON = "size-11 active:scale-[0.96] md:size-8";

/** IPv4 and IPv6 bindings of the same port show once. */
function publishedPorts(ports: DockerPort[]): DockerPort[] {
  const seen = new Set<string>();
  return ports.filter((p) => {
    if (p.hostPort === null) return false;
    const key = `${p.hostPort}/${p.containerPort}/${p.protocol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function PortLinks({ ports, className }: { ports: DockerPort[]; className?: string }) {
  const published = publishedPorts(ports);
  if (published.length === 0) return null;
  const host = typeof window === "undefined" ? "localhost" : window.location.hostname;
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {published.map((p) => (
        <a
          key={`${p.hostPort}-${p.containerPort}-${p.protocol}`}
          href={`http://${host}:${p.hostPort}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-9 items-center gap-1 rounded-md bg-muted px-2 font-mono text-xs text-muted-foreground tabular-nums transition-colors outline-none hover:bg-primary/10 hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.98] md:h-6 md:px-1.5 md:text-[0.7rem]"
          title={`Open http://${host}:${p.hostPort}`}
        >
          {p.hostPort}
          {p.hostPort !== p.containerPort && <span className="opacity-60">→{p.containerPort}</span>}
          {p.protocol !== "tcp" && <span className="opacity-60">/{p.protocol}</span>}
          <ExternalLinkIcon className="size-3 opacity-60" />
        </a>
      ))}
    </div>
  );
}

function ContainerRow({
  container: c,
  index,
  stats,
  busy,
  onAction,
  onLogs,
  onRemove,
}: {
  container: DockerContainer;
  index: number;
  stats?: DockerContainerStats;
  busy: boolean;
  onAction: (action: ContainerAction) => void;
  onLogs: () => void;
  onRemove: () => void;
}) {
  const running = c.state === "running";
  const paused = c.state === "paused";
  return (
    <li
      className="animate-card-in relative flex flex-col gap-2 px-3 py-3 transition-colors hover:bg-muted/40 sm:px-4 @2xl:flex-row @2xl:items-center @2xl:gap-4 @2xl:py-2.5"
      style={{ "--stagger": index } as React.CSSProperties}
    >
      {/* Identity: the whole row opens the logs (stretched button), ports and actions sit above it. */}
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <StateDot state={c.state} className="mt-1.5" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              onClick={onLogs}
              className="min-w-0 truncate text-left font-mono text-sm font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-md focus-visible:after:ring-3 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
              aria-label={`Show logs of ${c.name}`}
            >
              {c.name}
            </button>
            {c.composeProject && (
              <Badge variant="secondary" className="max-w-full truncate font-normal">
                {c.composeProject}
                {c.composeService && c.composeService !== c.name && ` · ${c.composeService}`}
              </Badge>
            )}
            {c.health && (
              <Badge
                variant={c.health === "unhealthy" ? "destructive" : "outline"}
                className={cn("font-normal", c.health === "healthy" && "text-emerald-700 dark:text-emerald-400")}
              >
                {c.health}
              </Badge>
            )}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground" title={c.image}>
            {c.image}
          </p>
          <PortLinks ports={c.ports} className="relative z-10 pt-0.5" />
        </div>
      </div>

      {/* Phones: status + actions share a footer line; desktop (@2xl): they become row columns. */}
      <div className="flex items-center gap-2 pl-[1.375rem] @2xl:contents">
        <div className="min-w-0 flex-1 text-xs @2xl:w-44 @2xl:flex-none">
          <p className="truncate" title={c.status}>
            <span className={cn("font-medium", STATE_STYLES[c.state].text)}>{STATE_STYLES[c.state].label}</span>
            <span className="text-muted-foreground"> · {c.status}</span>
          </p>
          {stats && running && (
            <p className="truncate text-muted-foreground tabular-nums">
              CPU {stats.cpuPercent.toFixed(1)}% · {stats.memUsage.split(" / ")[0]}
            </p>
          )}
        </div>

        <div className="relative z-10 flex shrink-0 items-center gap-0.5 @2xl:w-[8.5rem] @2xl:justify-end">
          {busy ? (
            <span className="flex size-11 items-center justify-center md:size-8">
              <Loader2Icon className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
            </span>
          ) : running ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className={ICON_BUTTON}
                onClick={() => onAction("stop")}
                aria-label={`Stop ${c.name}`}
                title="Stop"
              >
                <SquareIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={ICON_BUTTON}
                onClick={() => onAction("restart")}
                aria-label={`Restart ${c.name}`}
                title="Restart"
              >
                <RotateCwIcon />
              </Button>
            </>
          ) : paused ? (
            <Button
              variant="ghost"
              size="icon"
              className={ICON_BUTTON}
              onClick={() => onAction("unpause")}
              aria-label={`Resume ${c.name}`}
              title="Resume"
            >
              <PlayIcon />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className={ICON_BUTTON}
              onClick={() => onAction("start")}
              aria-label={`Start ${c.name}`}
              title="Start"
            >
              <PlayIcon />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={ICON_BUTTON}
            onClick={onLogs}
            aria-label={`Logs of ${c.name}`}
            title="Logs"
          >
            <ScrollTextIcon />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={ICON_BUTTON}
                aria-label={`More actions for ${c.name}`}
                disabled={busy}
              >
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {running && (
                <DropdownMenuItem onSelect={() => onAction("pause")}>
                  <PauseIcon />
                  Pause
                </DropdownMenuItem>
              )}
              {(running || paused) && (
                <DropdownMenuItem onSelect={() => onAction("kill")}>
                  <SkullIcon />
                  Kill
                </DropdownMenuItem>
              )}
              {!running && !paused && (
                <DropdownMenuItem onSelect={() => onAction("restart")}>
                  <RotateCwIcon />
                  Restart
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() =>
                  void navigator.clipboard.writeText(c.id).then(() => toast.success("Container id copied"))
                }
              >
                <CopyIcon />
                Copy id
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                <Trash2Icon />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </li>
  );
}

export function ContainersList({
  containers,
  stats,
  busyIds,
  onAction,
  onLogs,
  onRemove,
}: {
  containers: DockerContainer[];
  stats: Map<string, DockerContainerStats>;
  busyIds: Set<string>;
  onAction: (container: DockerContainer, action: ContainerAction) => void;
  onLogs: (container: DockerContainer) => void;
  onRemove: (container: DockerContainer) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const runningCount = containers.filter((c) => c.state === "running").length;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return containers
      .filter((c) =>
        filter === "running" ? c.state === "running" : filter === "stopped" ? c.state !== "running" : true,
      )
      .filter(
        (c) =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          c.image.toLowerCase().includes(q) ||
          (c.composeProject ?? "").toLowerCase().includes(q) ||
          c.ports.some((p) => String(p.hostPort ?? "").includes(q)),
      )
      .sort((a, b) => {
        const rank = (c: DockerContainer) => (c.state === "running" ? 0 : c.state === "paused" ? 1 : 2);
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
      });
  }, [containers, query, filter]);

  const filters: [Filter, string, number][] = [
    ["all", "All", containers.length],
    ["running", "Running", runningCount],
    ["stopped", "Stopped", containers.length - runningCount],
  ];

  return (
    <section aria-labelledby="containers-heading" className="@container space-y-3">
      <SectionHeader
        id="containers-heading"
        title="Containers"
        count={containers.length}
        description={
          containers.length > 0
            ? `${runningCount} running · ${containers.length - runningCount} stopped`
            : "Everything Docker runs on this host"
        }
      />

      {containers.length > 0 && (
        <div className="flex flex-col gap-2 @lg:flex-row @lg:items-center">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name, image, project or port"
              className="h-11 pl-9 md:h-9"
              aria-label="Filter containers"
            />
          </div>
          <div className="flex gap-1 rounded-lg bg-muted p-1" role="group" aria-label="Container state">
            {filters.map(([value, label, count]) => (
              <Button
                key={value}
                size="sm"
                variant={filter === value ? "outline" : "ghost"}
                className={cn("h-9 flex-1 gap-1.5 md:h-7", filter !== value && "text-muted-foreground")}
                onClick={() => setFilter(value)}
                aria-pressed={filter === value}
              >
                {label}
                <span className="text-xs opacity-70 tabular-nums">{count}</span>
              </Button>
            ))}
          </div>
        </div>
      )}

      {containers.length === 0 ? (
        <EmptyState title="No containers yet" icon={<BoxIcon />}>
          Search the launcher above, or pick one of the popular apps to start one with sensible defaults.
        </EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState title="Nothing matches this filter" icon={<SearchIcon />} />
      ) : (
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          <div
            aria-hidden="true"
            className="hidden border-b px-4 py-2 text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase @2xl:flex @2xl:gap-4"
          >
            <span className="flex-1 pl-[1.375rem]">Container</span>
            <span className="w-44">Status</span>
            <span className="w-[8.5rem] text-right">Actions</span>
          </div>
          <ul className="divide-y">
            {visible.map((c, index) => (
              <ContainerRow
                key={c.id}
                container={c}
                index={index}
                stats={stats.get(c.id)}
                busy={busyIds.has(c.id)}
                onAction={(action) => onAction(c, action)}
                onLogs={() => onLogs(c)}
                onRemove={() => onRemove(c)}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
