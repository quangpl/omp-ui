"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ExternalLinkIcon,
  FolderIcon,
  MoreHorizontalIcon,
  GitBranchIcon,
  PanelsTopLeftIcon,
  PencilIcon,
  PlusIcon,
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
import {
  STATUS_LABELS,
  TASK_STATUSES,
  type BoardWithCounts,
  type DashboardBoard,
  type TaskStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const DOT_CLASS: Record<TaskStatus, string> = {
  todo: "bg-muted-foreground/50",
  in_progress: "bg-primary",
  done: "bg-success",
};

const TAG_CLASS = "inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium text-muted-foreground";

export function BoardCard({
  board,
  onEdit,
  onDelete,
  now,
  className,
  style,
}: {
  /** Dashboard boards add last activity and the "needs you" count. */
  board: BoardWithCounts & Partial<Pick<DashboardBoard, "lastActivityAt" | "attentionCount">>;
  /** Reference time for "active 5 minutes ago". */
  now?: number;
  onEdit: (board: BoardWithCounts) => void;
  onDelete: (board: BoardWithCounts) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const router = useRouter();
  const openNewCard = useNewCard();
  const total = board.counts.todo + board.counts.in_progress + board.counts.done;
  const href = `/b/${board.id}`;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <article
          style={style}
          className={cn(
            "group/board card-lift relative flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 text-card-foreground shadow-xs hover:border-primary/35 has-[a:focus-visible]:border-ring has-[a:focus-visible]:ring-3 has-[a:focus-visible]:ring-ring/50 data-[state=open]:border-ring data-[state=open]:ring-3 data-[state=open]:ring-ring/50",
            className,
          )}
        >
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-base leading-snug font-semibold tracking-tight">
                {/* Stretched link: the whole card is the tap target; the menu sits above it. */}
                <Link
                  href={href}
                  className="outline-none after:absolute after:inset-0 after:rounded-xl after:content-['']"
                >
                  {board.name}
                </Link>
              </h2>
              <p
                className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
                title={[board.workdir, ...board.extraFolders].join("\n")}
              >
                <FolderIcon className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate font-mono">{board.workdir}</span>
                {board.extraFolders.length > 0 && (
                  <span className="shrink-0 rounded-full bg-muted px-1.5 py-px font-medium text-foreground/80">
                    +{board.extraFolders.length} folder{board.extraFolders.length === 1 ? "" : "s"}
                  </span>
                )}
              </p>
            </div>

            <div className="relative z-10 -mt-2 -mr-2 flex shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="size-11 rounded-full text-muted-foreground md:size-9 md:opacity-0 md:transition-opacity md:group-hover/board:opacity-100 md:focus-visible:opacity-100"
                onClick={() => openNewCard({ boardId: board.id })}
                aria-label={`New card in ${board.name}`}
                title="New card"
              >
                <PlusIcon className="size-5 md:size-4" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 rounded-full text-muted-foreground md:size-9"
                    aria-label={`Project options for ${board.name}`}
                  >
                    <MoreHorizontalIcon className="size-5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem
                    onSelect={() => openNewCard({ boardId: board.id })}
                    className="min-h-11 gap-2.5 px-2.5 md:min-h-8"
                  >
                    <PlusIcon />
                    New card
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => openNewCard({ boardId: board.id, start: true })}
                    className="min-h-11 gap-2.5 px-2.5 md:min-h-8"
                  >
                    <ZapIcon />
                    New card &amp; start agent
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => onEdit(board)}
                    className="min-h-11 gap-2.5 px-2.5 md:min-h-8"
                  >
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

          <div className="mt-auto flex flex-wrap items-center gap-1.5">
            {TASK_STATUSES.map((status) => (
              <span
                key={status}
                className="inline-flex h-6 items-center gap-1.5 rounded-full bg-muted px-2 text-xs text-muted-foreground"
              >
                <span aria-hidden="true" className={cn("size-1.5 rounded-full", DOT_CLASS[status])} />
                {STATUS_LABELS[status]}
                <span className="font-medium text-foreground tabular-nums">{board.counts[status]}</span>
              </span>
            ))}

            {board.runningCount > 0 ? (
              <span className="ml-auto inline-flex h-6 items-center gap-1.5 rounded-full bg-primary/10 px-2 text-xs font-medium text-primary">
                <span aria-hidden="true" className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-primary" />
                </span>
                {board.runningCount} running
              </span>
            ) : (
              total === 0 && <span className="ml-auto text-xs text-muted-foreground">No cards yet</span>
            )}
          </div>

          {total > 0 && (
            <div
              className="-mt-1.5 flex h-1 gap-px overflow-hidden rounded-full bg-muted"
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

          {(board.attentionCount || board.lastActivityAt || board.model || board.autoRun || board.worktrees) && (
            <div className="-mt-1 flex min-w-0 flex-wrap items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground">
              {board.attentionCount ? (
                <span className="inline-flex h-5 items-center gap-1 rounded-md bg-destructive/10 px-1.5 text-[11px] font-medium text-destructive">
                  <TriangleAlertIcon className="size-3" aria-hidden="true" />
                  {board.attentionCount} need{board.attentionCount === 1 ? "s" : ""} you
                </span>
              ) : null}
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
                <span className={cn(TAG_CLASS, "max-w-36")} title={`Model: ${board.model}`}>
                  <SparklesIcon className="size-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{board.model}</span>
                </span>
              )}
              {board.lastActivityAt && (
                <span className="ml-auto shrink-0" title={formatDateTime(board.lastActivityAt)}>
                  Active {formatRelative(board.lastActivityAt, now)}
                </span>
              )}
            </div>
          )}
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
