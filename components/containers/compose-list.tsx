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
import { EmptyState, SectionHeader } from "@/components/containers/shared";
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

const ICON_BUTTON = "size-11 active:scale-[0.96] md:size-8";

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
  const upCount = projects.filter((p) => p.running > 0).length;
  return (
    <section aria-labelledby="stacks-heading" className="@container space-y-3">
      <SectionHeader
        id="stacks-heading"
        title="Compose stacks"
        count={projects.length > 0 ? projects.length : undefined}
        description={
          projects.length > 0
            ? `${upCount} up · stacks created here live in AgentMan's data folder; other projects on this host are listed too`
            : undefined
        }
        actions={
          projects.length > 0 && (
            <Button variant="outline" onClick={onNew} className="h-11 gap-1.5 active:scale-[0.98] md:h-8">
              <PlusIcon />
              New stack
            </Button>
          )
        }
      />

      {projects.length === 0 ? (
        <EmptyState
          compact
          icon={<LayersIcon />}
          title="No compose projects"
          action={
            <Button variant="outline" onClick={onNew} className="h-11 shrink-0 gap-1.5 active:scale-[0.98] md:h-8">
              <PlusIcon />
              New stack
            </Button>
          }
        >
          Start one from the launcher or app catalog, or paste a compose file.
        </EmptyState>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          {projects.map((p, index) => {
            const up = p.running > 0;
            const hasFile = p.configFiles.length > 0;
            return (
              <li
                key={p.name}
                className="animate-card-in relative flex flex-col gap-2 px-3 py-3 transition-colors hover:bg-muted/40 sm:px-4 @2xl:flex-row @2xl:items-center @2xl:gap-4 @2xl:py-2.5"
                style={{ "--stagger": index } as React.CSSProperties}
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-lg",
                      up ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground",
                    )}
                  >
                    <LayersIcon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onOpenFile(p)}
                        className="min-w-0 truncate text-left font-mono text-sm font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-md focus-visible:after:ring-3 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
                        aria-label={`Open the compose file of ${p.name}`}
                      >
                        {p.name}
                      </button>
                      {p.managed && (
                        <Badge variant="secondary" className="font-normal">
                          AgentMan
                        </Badge>
                      )}
                    </div>
                    {hasFile ? (
                      <p
                        className="truncate font-mono text-xs text-muted-foreground"
                        title={p.configFiles.join(", ")}
                      >
                        {p.configFiles.join(", ")}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">No compose file on this host</p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 pl-11 @2xl:contents">
                  <div className="min-w-0 flex-1 text-xs @2xl:w-44 @2xl:flex-none">
                    <p className="truncate tabular-nums" title={p.status}>
                      <span
                        className={cn(
                          "font-medium",
                          up ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground",
                        )}
                      >
                        {p.total === 0 ? "Down" : `${p.running}/${p.total} running`}
                      </span>
                      <span className="text-muted-foreground"> · {p.status}</span>
                    </p>
                  </div>

                  <div className="relative z-10 flex shrink-0 items-center gap-0.5 @2xl:w-[8.5rem] @2xl:justify-end">
                    {up ? (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={ICON_BUTTON}
                          title="Stop"
                          aria-label={`Stop ${p.name}`}
                          onClick={() => onAction(p, "stop")}
                        >
                          <SquareIcon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={ICON_BUTTON}
                          title="Restart"
                          aria-label={`Restart ${p.name}`}
                          onClick={() => onAction(p, "restart")}
                        >
                          <RotateCwIcon />
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        className={ICON_BUTTON}
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
                      className={ICON_BUTTON}
                      title="Logs"
                      aria-label={`Logs of ${p.name}`}
                      disabled={p.total === 0}
                      onClick={() => onLogs(p)}
                    >
                      <ScrollTextIcon />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className={ICON_BUTTON} aria-label={`More actions for ${p.name}`}>
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
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
