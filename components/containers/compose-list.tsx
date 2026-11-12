"use client";

import {
  ArrowDownToLineIcon,
  FileCode2Icon,
  LayersIcon,
  MoreHorizontalIcon,
  PlayIcon,
  PlusIcon,
  PowerOffIcon,
  RotateCwIcon,
  ScrollTextIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { EmptyState } from "@/components/containers/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ComposeAction, ComposeProject } from "@/lib/docker-types";
import { cn } from "@/lib/utils";

export function ComposeList({
  projects,
  onAction,
  onLogs,
  onOpenFile,
  onRemove,
  onNew,
}: {
  projects: ComposeProject[];
  onAction: (project: ComposeProject, action: ComposeAction) => void;
  onLogs: (project: ComposeProject) => void;
  onOpenFile: (project: ComposeProject) => void;
  onRemove: (project: ComposeProject) => void;
  onNew: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Stacks created here live in OMP UI&apos;s data folder; other compose projects on this host show too.
        </p>
        <Button onClick={onNew} className="h-11 shrink-0 gap-1.5 md:h-9">
          <PlusIcon />
          New stack
        </Button>
      </div>

      {projects.length === 0 ? (
        <EmptyState title="No compose projects">Deploy one from the App catalog or paste a compose file.</EmptyState>
      ) : (
        <ul className="divide-y rounded-xl bg-card ring-1 ring-foreground/10">
          {projects.map((p) => {
            const up = p.running > 0;
            const hasFile = p.configFiles.length > 0;
            return (
              <li key={p.name} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-4">
                <button
                  type="button"
                  onClick={() => onOpenFile(p)}
                  className="flex min-w-0 flex-1 items-start gap-3 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  aria-label={`Open the compose file of ${p.name}`}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
                      up ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground",
                    )}
                  >
                    <LayersIcon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-mono text-sm font-medium">{p.name}</span>
                      {p.managed && (
                        <Badge variant="secondary" className="font-normal">
                          OMP UI
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {p.total === 0 ? "Down" : `${p.running}/${p.total} running`} · {p.status}
                    </p>
                    {hasFile && (
                      <p className="truncate font-mono text-[0.7rem] text-muted-foreground" title={p.configFiles.join(", ")}>
                        {p.configFiles.join(", ")}
                      </p>
                    )}
                  </div>
                </button>
                <div className="flex shrink-0 items-center gap-1 self-end sm:self-center">
                  {up ? (
                    <>
                      <Button variant="ghost" size="icon" className="size-11 md:size-8" title="Stop" aria-label={`Stop ${p.name}`} onClick={() => onAction(p, "stop")}>
                        <SquareIcon />
                      </Button>
                      <Button variant="ghost" size="icon" className="size-11 md:size-8" title="Restart" aria-label={`Restart ${p.name}`} onClick={() => onAction(p, "restart")}>
                        <RotateCwIcon />
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-11 md:size-8"
                      title="Up"
                      aria-label={`Start ${p.name}`}
                      disabled={!hasFile && p.total === 0}
                      onClick={() => onAction(p, hasFile ? "up" : "start")}
                    >
                      <PlayIcon />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 md:size-8"
                    title="Logs"
                    aria-label={`Logs of ${p.name}`}
                    disabled={p.total === 0}
                    onClick={() => onLogs(p)}
                  >
                    <ScrollTextIcon />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-11 md:size-8" aria-label={`More actions for ${p.name}`}>
                        <MoreHorizontalIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      {hasFile && (
                        <DropdownMenuItem onSelect={() => onOpenFile(p)}>
                          <FileCode2Icon />
                          {p.managed ? "Edit & redeploy" : "View compose file"}
                        </DropdownMenuItem>
                      )}
                      {hasFile && (
                        <DropdownMenuItem onSelect={() => onAction(p, "up")}>
                          <PlayIcon />
                          Up (recreate changed)
                        </DropdownMenuItem>
                      )}
                      {hasFile && (
                        <DropdownMenuItem onSelect={() => onAction(p, "pull")}>
                          <ArrowDownToLineIcon />
                          Pull latest images
                        </DropdownMenuItem>
                      )}
                      {p.total > 0 && (
                        <DropdownMenuItem onSelect={() => onAction(p, "down")}>
                          <PowerOffIcon />
                          Down (remove containers)
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => onRemove(p)}>
                        <Trash2Icon />
                        {p.managed ? "Delete stack" : "Down & remove"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
