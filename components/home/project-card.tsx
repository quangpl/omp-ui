"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRightIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  FolderIcon,
  GitBranchIcon,
  MoreHorizontalIcon,
  PanelsTopLeftIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
  TriangleAlertIcon,
  ZapIcon,
} from "lucide-react";
import { formatDateTime, formatRelative } from "@/components/board/format";
import { useNewCard } from "@/components/new-card";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { STATUS_LABELS, TASK_STATUSES, type BoardWithCounts, type DashboardBoard, type TaskStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FOCUS_RING, boardHref, plural, useEntrance } from "./shared";

const DOT_CLASS: Record<TaskStatus, string> = {
  todo: "bg-muted-foreground/50",
  in_progress: "bg-primary",
  done: "bg-success",
};

const TAG_CLASS =
  "inline-flex h-5 min-w-0 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium text-muted-foreground";

/** Show the project filter once scanning the grid gets slow. */
const FILTER_THRESHOLD = 5;
/** Projects shown before "View all". */
const COLLAPSED_PROJECTS = 8;

/** Branch, uncommitted files and unpushed commits across the project's git folders. */
function GitSummary({ git }: { git: DashboardBoard["git"] }) {
  const repos = git.filter((status) => status.isRepo);
  if (repos.length === 0) return null;
  const changed = repos.reduce((sum, repo) => sum + repo.changedFiles, 0);
  const ahead = repos.reduce((sum, repo) => sum + repo.ahead, 0);
  const branch = repos[0].branch ?? "detached";
  const title = repos
    .map((repo) => `${repo.folder}: ${repo.branch ?? "detached"}, ${repo.changedFiles} changed, ${repo.ahead} unpushed`)
    .join("\n");
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={title}>
      <span className={cn(TAG_CLASS, "max-w-32")}>
        <GitBranchIcon className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate font-mono">{branch}</span>
      </span>
      {changed > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-500" />
          {changed} uncommitted
        </span>
      )}
      {ahead > 0 && (
        <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground">
          <ArrowUpIcon className="size-3" aria-hidden="true" />
          {ahead} unpushed
        </span>
      )}
      {changed === 0 && ahead === 0 && <span className="text-[11px] text-muted-foreground">clean</span>}
    </span>
  );
}

export function ProjectCard({
  board,
  now,
  index,
  onEdit,
  onDelete,
}: {
  board: DashboardBoard;
  now: number;
  index: number;
  onEdit: (board: BoardWithCounts) => void;
  onDelete: (board: BoardWithCounts) => void;
}) {
  const router = useRouter();
  const openNewCard = useNewCard();
  const href = boardHref(board.id);
  const total = board.counts.todo + board.counts.in_progress + board.counts.done;
  const finishedRuns = board.runs30d.succeeded + board.runs30d.failed;
  const successRate = finishedRuns > 0 ? Math.round((board.runs30d.succeeded / finishedRuns) * 100) : null;
  const enter = useEntrance()(index);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <article
          style={enter.style}
          className={cn(
            enter.className,
            "group/board card-lift relative flex h-full min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground has-[a:focus-visible]:border-ring has-[a:focus-visible]:ring-3 has-[a:focus-visible]:ring-ring/50 hover:border-foreground/20 data-[state=open]:border-ring",
          )}
        >
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-base leading-snug font-semibold tracking-tight">
                {/* Stretched link: the whole card opens the board; the buttons sit above it. */}
                <Link href={href} className="outline-none after:absolute after:inset-0 after:rounded-xl after:content-['']">
                  {board.name}
                </Link>
              </h3>
              <p
                className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
                title={[board.workdir, ...board.extraFolders].join("\n")}
              >
                <FolderIcon className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate font-mono">{board.workdir}</span>
                {board.extraFolders.length > 0 && (
                  <span className="shrink-0 rounded bg-muted px-1 font-medium text-foreground/80">
                    +{board.extraFolders.length}
                  </span>
                )}
              </p>
            </div>
            <div className="relative z-10 -mt-1.5 -mr-1.5 flex shrink-0 items-center">
              <Button
                variant="outline"
                size="sm"
                className="h-11 gap-1 px-2.5 md:h-7"
                onClick={() => openNewCard({ boardId: board.id })}
                aria-label={`New card in ${board.name}`}
                title="New card here (N)"
              >
                <PlusIcon />
                <span className="hidden sm:inline">Card</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 rounded-full text-muted-foreground md:size-8"
                    aria-label={`Project options for ${board.name}`}
                  >
                    <MoreHorizontalIcon className="size-5 md:size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem onSelect={() => router.push(href)} className="min-h-11 gap-2.5 px-2.5 md:min-h-8">
                    <PanelsTopLeftIcon />
                    Open board
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => openNewCard({ boardId: board.id, start: true })}
                    className="min-h-11 gap-2.5 px-2.5 md:min-h-8"
                  >
                    <ZapIcon />
                    New card &amp; start agent
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onEdit(board)} className="min-h-11 gap-2.5 px-2.5 md:min-h-8">
                    <PencilIcon />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => onDelete(board)}
                    className="min-h-11 gap-2.5 px-2.5 md:min-h-8"
                  >
                    <Trash2Icon />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <dl className="grid grid-cols-3 divide-x">
            {TASK_STATUSES.map((status) => (
              <div key={status} className="flex min-w-0 flex-col gap-1 px-3 first:pl-0 last:pr-0">
                <dt className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                  <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[status])} />
                  {STATUS_LABELS[status]}
                </dt>
                <dd className="text-lg leading-none font-semibold tracking-tight tabular-nums">{board.counts[status]}</dd>
              </div>
            ))}
          </dl>

          {total > 0 && (
            <div
              className="flex h-1 gap-px overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`${board.counts.done} of ${total} cards done`}
            >
              {TASK_STATUSES.map(
                (status) =>
                  board.counts[status] > 0 && (
                    <span
                      key={status}
                      className={cn("h-full transition-[flex-grow] duration-500", DOT_CLASS[status])}
                      style={{ flexGrow: board.counts[status] }}
                    />
                  ),
              )}
            </div>
          )}

          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            {board.runningCount > 0 && (
              <span className="inline-flex items-center gap-1.5 font-medium text-primary">
                <span aria-hidden="true" className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none" />
                  <span className="relative inline-flex size-2 rounded-full bg-primary" />
                </span>
                {board.runningCount} running
              </span>
            )}
            {board.needsYouCount > 0 && (
              <span className="inline-flex items-center gap-1 font-medium text-destructive">
                <TriangleAlertIcon className="size-3" aria-hidden="true" />
                {board.needsYouCount} need{board.needsYouCount === 1 ? "s" : ""} you
              </span>
            )}
            <span title="Agent runs that succeeded, last 30 days (stopped runs not counted)">
              {successRate === null ? (
                "No runs in 30 days"
              ) : (
                <>
                  <span className="font-medium text-foreground tabular-nums">{successRate}%</span> success ·{" "}
                  {plural(finishedRuns, "run")}
                </>
              )}
            </span>
            <GitSummary git={board.git} />
          </div>

          <div className="mt-auto flex min-w-0 items-center gap-1.5 border-t pt-2.5 text-xs text-muted-foreground">
            {board.autoRun && (
              <span className={TAG_CLASS} title="Moving a card to In progress starts its agent">
                <ZapIcon className="size-3" aria-hidden="true" />
                Auto-run
              </span>
            )}
            {board.worktrees && (
              <span className={TAG_CLASS} title="Each card works in its own git worktree">
                <GitBranchIcon className="size-3" aria-hidden="true" />
                Worktrees
              </span>
            )}
            {board.model && (
              <span className={cn(TAG_CLASS, "max-w-32")} title={`Model: ${board.model}`}>
                <SparklesIcon className="size-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{board.model}</span>
              </span>
            )}
            <span className="ml-auto shrink-0" title={formatDateTime(board.lastActivityAt)}>
              Active {formatRelative(board.lastActivityAt, now)}
            </span>
            <ArrowRightIcon
              className="size-3.5 shrink-0 transition-transform group-hover/board:translate-x-0.5 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </div>
        </article>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <ContextMenuItem onSelect={() => router.push(href)}>
          <PanelsTopLeftIcon />
          Open board
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => window.open(href, "_blank", "noopener")}>
          <ExternalLinkIcon />
          Open in new tab
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => openNewCard({ boardId: board.id })}>
          <PlusIcon />
          New card…
          <ContextMenuShortcut>N</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => openNewCard({ boardId: board.id, start: true })}>
          <ZapIcon />
          New card &amp; start agent…
          <ContextMenuShortcut>⇧N</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onEdit(board)}>
          <PencilIcon />
          Edit project…
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => onDelete(board)}>
          <Trash2Icon />
          Delete project…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function ProjectsSection({
  boards,
  now,
  onEdit,
  onDelete,
}: {
  boards: DashboardBoard[];
  now: number;
  onEdit: (board: BoardWithCounts) => void;
  onDelete: (board: BoardWithCounts) => void;
}) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState(false);
  const query = filter.trim().toLowerCase();
  const matching = query
    ? boards.filter((b) => [b.name, b.workdir, ...b.extraFolders].some((text) => text.toLowerCase().includes(query)))
    : boards;
  // A filter shows every match; otherwise the most recently active few until "View all".
  const shown = query || expanded ? matching : matching.slice(0, COLLAPSED_PROJECTS);

  return (
    <section aria-labelledby="home-projects">
      <div className="mb-2.5 flex flex-wrap items-end gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <h2 id="home-projects" className="text-sm font-semibold tracking-tight">
            Projects
            <span className="ml-2 rounded-md bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular-nums">
              {boards.length}
            </span>
          </h2>
          <p className="text-xs text-muted-foreground">Most recently active first · tap one to open its board</p>
        </div>
        {boards.length >= FILTER_THRESHOLD && (
          <div className="relative w-full sm:w-56">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter projects"
              aria-label="Filter projects"
              className="h-11 pl-8 md:h-8"
            />
          </div>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          No project matches “{filter.trim()}”.
        </p>
      ) : (
        <div className="grid auto-rows-fr grid-cols-[repeat(auto-fill,minmax(min(18rem,100%),1fr))] gap-3">
          {shown.map((board, index) => (
            <ProjectCard key={board.id} board={board} now={now} index={index} onEdit={onEdit} onDelete={onDelete} />
          ))}
        </div>
      )}
      {!query && matching.length > COLLAPSED_PROJECTS && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className={cn(
            "mt-2.5 inline-flex min-h-11 items-center gap-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground md:min-h-8",
            FOCUS_RING,
          )}
        >
          {expanded ? "Show fewer" : `View all ${matching.length} projects`}
          <ChevronDownIcon className={cn("size-3.5 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
        </button>
      )}
    </section>
  );
}
