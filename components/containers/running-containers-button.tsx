"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BoxIcon,
  ChevronDownIcon,
  LayersIcon,
  Loader2Icon,
  RefreshCwIcon,
  RotateCwIcon,
  ScrollTextIcon,
  SquareIcon,
  ZapIcon,
} from "lucide-react";
import { toast } from "sonner";
import { refreshRunning, runningCount, useRunningContainers } from "@/components/containers/running-store";
import { errorMessage, StateDot } from "@/components/containers/shared";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import type { ComposeProject, DockerContainer } from "@/lib/docker-types";
import { cn } from "@/lib/utils";

/**
 * Live running-container count (shared poll every 10 s while the tab is visible); null while
 * unknown or when Docker is unavailable, so callers can hide their badge.
 */
export function useRunningContainerCount(): number | null {
  return runningCount(useRunningContainers());
}

/** Count pill; renders nothing while unknown, zero, or Docker is unavailable. */
export function RunningCountBadge({ className }: { className?: string }) {
  const count = useRunningContainerCount();
  if (!count) return null;
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.65rem] leading-none font-semibold text-primary-foreground tabular-nums",
        className,
      )}
      aria-label={`${count} running`}
    >
      {count}
    </span>
  );
}

function RowAction({
  label,
  onClick,
  busy,
  children,
}: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-11 shrink-0 text-muted-foreground hover:text-foreground md:size-7"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      title={label}
    >
      {children}
    </Button>
  );
}

/** "Running containers" panel: one-click stop / restart / logs, plus the way into fast start. */
function RunningPanel({ close }: { close: () => void }) {
  const router = useRouter();
  const { summary, error } = useRunningContainers();
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);

  const track = async (key: string, work: () => Promise<void>) => {
    setBusy((s) => new Set(s).add(key));
    try {
      await work();
    } finally {
      await refreshRunning();
      setBusy((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  };

  const containerAction = (c: DockerContainer, action: "stop" | "restart") =>
    void track(`c:${c.id}`, async () => {
      try {
        await api.docker.containerAction(c.id, action);
        toast.success(`${action === "stop" ? "Stopped" : "Restarted"} ${c.name}`);
      } catch (err) {
        toast.error(errorMessage(err, `Could not ${action} ${c.name}`));
      }
    });

  const composeAction = (p: ComposeProject, action: "stop" | "restart") =>
    void track(`p:${p.name}`, async () => {
      try {
        const result = await api.docker.composeAction(p.name, action);
        if (result.ok) toast.success(`${action === "stop" ? "Stopped" : "Restarted"} ${p.name}`);
        else toast.error(result.message);
      } catch (err) {
        toast.error(errorMessage(err, `Could not ${action} ${p.name}`));
      }
    });

  const go = (href: string) => {
    close();
    router.push(href);
  };

  const standalone = summary?.containers.filter((c) => !c.composeProject) ?? [];
  const projects = summary?.composeProjects ?? [];
  const host = typeof window === "undefined" ? "localhost" : window.location.hostname;

  let body: React.ReactNode;
  if (!summary && !error) {
    body = (
      <div className="space-y-2 p-3" aria-busy="true">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-3/4" />
      </div>
    );
  } else if (!summary) {
    body = <p className="p-3 text-xs text-destructive">{error}</p>;
  } else if (!summary.available) {
    body = (
      <div className="space-y-1 p-3 text-xs">
        <p className="font-medium text-destructive">Docker is not available</p>
        {summary.error && <p className="text-muted-foreground">{summary.error}</p>}
      </div>
    );
  } else if (standalone.length === 0 && projects.length === 0) {
    body = <p className="p-3 text-xs text-muted-foreground">Nothing is running.</p>;
  } else {
    body = (
      <ul className="max-h-[min(24rem,60dvh)] overflow-y-auto py-1">
        {projects.map((p) => (
          <li key={`p:${p.name}`} className="flex items-center gap-2 px-3 py-1">
            <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{p.name}</p>
              <p className="truncate text-[0.7rem] text-muted-foreground">Compose · {p.running} running</p>
            </div>
            {busy.has(`p:${p.name}`) ? (
              <Loader2Icon className="mx-2 size-4 animate-spin text-muted-foreground" />
            ) : (
              <>
                <RowAction label={`Logs of ${p.name}`} onClick={() => go(`/containers?logs=${encodeURIComponent(`compose:${p.name}`)}`)}>
                  <ScrollTextIcon />
                </RowAction>
                <RowAction label={`Restart ${p.name}`} onClick={() => composeAction(p, "restart")}>
                  <RotateCwIcon />
                </RowAction>
                <RowAction label={`Stop ${p.name}`} onClick={() => composeAction(p, "stop")}>
                  <SquareIcon />
                </RowAction>
              </>
            )}
          </li>
        ))}
        {standalone.map((c) => {
          const published = c.ports.filter((port) => port.hostPort);
          return (
            <li key={`c:${c.id}`} className="flex items-center gap-2 px-3 py-1">
              <StateDot state={c.state} className="shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{c.name}</p>
                <p className="flex min-w-0 items-center gap-1.5 text-[0.7rem] text-muted-foreground">
                  <span className="truncate font-mono">{c.image}</span>
                  {published.slice(0, 2).map((port) => (
                    <a
                      key={`${port.hostPort}/${port.protocol}`}
                      href={`http://${host}:${port.hostPort}`}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 font-mono tabular-nums underline-offset-2 hover:text-foreground hover:underline"
                      title={`Open port ${port.hostPort} → ${port.containerPort}/${port.protocol}`}
                    >
                      :{port.hostPort}
                    </a>
                  ))}
                </p>
              </div>
              {busy.has(`c:${c.id}`) ? (
                <Loader2Icon className="mx-2 size-4 animate-spin text-muted-foreground" />
              ) : (
                <>
                  <RowAction label={`Logs of ${c.name}`} onClick={() => go(`/containers?logs=${encodeURIComponent(c.id)}&name=${encodeURIComponent(c.name)}`)}>
                    <ScrollTextIcon />
                  </RowAction>
                  <RowAction label={`Restart ${c.name}`} onClick={() => containerAction(c, "restart")}>
                    <RotateCwIcon />
                  </RowAction>
                  <RowAction label={`Stop ${c.name}`} onClick={() => containerAction(c, "stop")}>
                    <SquareIcon />
                  </RowAction>
                </>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  const count = runningCount({ summary, error });
  return (
    <>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <BoxIcon className="size-4 text-muted-foreground" />
        <p className="flex-1 text-sm font-semibold">
          Running containers
          {count !== null && <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">{count}</span>}
        </p>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 md:size-7"
          aria-label="Refresh"
          title="Refresh"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            await refreshRunning();
            setRefreshing(false);
          }}
        >
          <RefreshCwIcon className={cn(refreshing && "animate-spin motion-reduce:animate-none")} />
        </Button>
      </div>
      {body}
      <div className="flex items-center gap-1 border-t p-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-11 flex-1 justify-start gap-2 md:h-8"
          onClick={() => go("/containers?launch=1")}
          disabled={summary?.available === false}
        >
          <ZapIcon />
          Launch…
        </Button>
        <Button asChild variant="ghost" size="sm" className="h-11 md:h-8">
          <Link href="/containers" onClick={close}>
            Manage
          </Link>
        </Button>
      </div>
    </>
  );
}

/**
 * Self-contained "Running containers" popover: a trigger button (a chevron by default, or
 * `children`) opening the list with one-click stop / restart / logs and "Launch…". Usable in the
 * header, a sidebar or anywhere else; it shares one poll with every other running-count consumer.
 */
export function RunningContainersButton({
  className,
  children,
  align = "start",
  side = "bottom",
}: {
  className?: string;
  /** Custom trigger content; defaults to a small chevron. */
  children?: React.ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Running containers"
          title="Running containers"
          className={cn(
            "inline-flex h-9 min-w-6 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-muted data-[state=open]:text-foreground",
            className,
          )}
        >
          {children ?? <ChevronDownIcon className="size-3.5" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} side={side} className="w-[min(24rem,calc(100vw-2rem))] gap-0 p-0">
        <RunningPanel close={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** The desktop header's Containers tab: link with the live running count + the popover chevron. */
export function ContainersNavTab({
  linkClassName,
  active,
  children,
}: {
  linkClassName: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center">
      <Link
        href="/containers"
        aria-current={active ? "page" : undefined}
        className={cn(linkClassName, "rounded-r-none pr-2")}
      >
        {children}
        <RunningCountBadge />
      </Link>
      <RunningContainersButton className={cn("w-6 rounded-l-none", active && "bg-muted")} />
    </div>
  );
}
