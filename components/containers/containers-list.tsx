"use client";

import { useMemo, useState } from "react";
import {
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
import { EmptyState, STATE_STYLES, StateDot } from "@/components/containers/shared";
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

function PortLinks({ ports }: { ports: DockerPort[] }) {
  const published = publishedPorts(ports);
  if (published.length === 0) return null;
  const host = typeof window === "undefined" ? "localhost" : window.location.hostname;
  return (
    <div className="flex flex-wrap gap-1">
      {published.map((p) => (
        <a
          key={`${p.hostPort}-${p.containerPort}-${p.protocol}`}
          href={`http://${host}:${p.hostPort}`}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.7rem] text-muted-foreground hover:bg-primary/10 hover:text-primary"
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
  stats,
  busy,
  onAction,
  onLogs,
  onRemove,
}: {
  container: DockerContainer;
  stats?: DockerContainerStats;
  busy: boolean;
  onAction: (action: ContainerAction) => void;
  onLogs: () => void;
  onRemove: () => void;
}) {
  const running = c.state === "running";
  const paused = c.state === "paused";
  return (
    <li className="group flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-4">
      <button
        type="button"
        onClick={onLogs}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label={`Show logs of ${c.name}`}
      >
        <StateDot state={c.state} className="mt-1.5" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-mono text-sm font-medium">{c.name}</span>
            {c.composeProject && (
              <Badge variant="secondary" className="font-normal">
                {c.composeProject}
                {c.composeService && c.composeService !== c.name && ` · ${c.composeService}`}
              </Badge>
            )}
            {c.health && (
              <Badge
                variant={c.health === "unhealthy" ? "destructive" : "outline"}
                className={cn("font-normal", c.health === "healthy" && "text-emerald-600 dark:text-emerald-400")}
              >
                {c.health}
              </Badge>
            )}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground" title={c.image}>
            {c.image}
          </p>
          <p className="text-xs text-muted-foreground">
            {STATE_STYLES[c.state].label} · {c.status}
            {stats && running && (
              <span className="tabular-nums">
                {" "}
                · CPU {stats.cpuPercent.toFixed(1)}% · {stats.memUsage.split(" / ")[0]}
              </span>
            )}
          </p>
          <PortLinks ports={c.ports} />
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-1 self-end sm:self-center">
        {busy ? (
          <Loader2Icon className="m-2 size-4 animate-spin text-muted-foreground" />
        ) : running ? (
          <>
            <Button variant="ghost" size="icon" className="size-11 md:size-8" onClick={() => onAction("stop")} aria-label={`Stop ${c.name}`} title="Stop">
              <SquareIcon />
            </Button>
            <Button variant="ghost" size="icon" className="size-11 md:size-8" onClick={() => onAction("restart")} aria-label={`Restart ${c.name}`} title="Restart">
              <RotateCwIcon />
            </Button>
          </>
        ) : paused ? (
          <Button variant="ghost" size="icon" className="size-11 md:size-8" onClick={() => onAction("unpause")} aria-label={`Resume ${c.name}`} title="Resume">
            <PlayIcon />
          </Button>
        ) : (
          <Button variant="ghost" size="icon" className="size-11 md:size-8" onClick={() => onAction("start")} aria-label={`Start ${c.name}`} title="Start">
            <PlayIcon />
          </Button>
        )}
        <Button variant="ghost" size="icon" className="size-11 md:size-8" onClick={onLogs} aria-label={`Logs of ${c.name}`} title="Logs">
          <ScrollTextIcon />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-11 md:size-8" aria-label={`More actions for ${c.name}`} disabled={busy}>
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

  const filters: [Filter, string][] = [
    ["all", `All ${containers.length}`],
    ["running", `Running ${runningCount}`],
    ["stopped", `Stopped ${containers.length - runningCount}`],
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {filters.map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? "outline" : "ghost"}
              className={cn("h-9 flex-1 md:h-7", filter !== value && "text-muted-foreground")}
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      {containers.length === 0 ? (
        <EmptyState title="No containers yet">Start one from Quick launch or the App catalog.</EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState title="Nothing matches this filter" />
      ) : (
        <ul className="divide-y rounded-xl bg-card ring-1 ring-foreground/10">
          {visible.map((c) => (
            <ContainerRow
              key={c.id}
              container={c}
              stats={stats.get(c.id)}
              busy={busyIds.has(c.id)}
              onAction={(action) => onAction(c, action)}
              onLogs={() => onLogs(c)}
              onRemove={() => onRemove(c)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
