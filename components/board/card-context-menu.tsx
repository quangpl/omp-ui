"use client";

import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  ArrowRightLeft,
  Check,
  Copy,
  Link2,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  Square,
  Trash2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { StatusDot } from "@/components/board/board-column";
import { STATUS_LABELS, TASK_STATUSES, type Task, type TaskStatus } from "@/lib/types";

/** Everything a card / board right-click menu can do. */
export interface BoardMenuActions {
  boardId: string;
  openCard: (taskId: string) => void;
  moveToStatus: (taskId: string, status: TaskStatus) => Promise<void>;
  runAgent: (taskId: string) => Promise<void>;
  stopAgent: (taskId: string) => Promise<void>;
  duplicate: (task: Task) => Promise<void>;
  /** Asks for confirmation before deleting. */
  requestDelete: (task: Task) => void;
  newCard: (start: boolean) => void;
  refresh: () => void;
  openSettings: () => void;
}

/**
 * Touch long-press would open the menu while dnd-kit picks the card up; phones and tablets get
 * the card's own actions instead, so only mouse/pen right-click (and the keyboard menu key) open it.
 */
function suppressTouchLongPress(event: ReactPointerEvent) {
  if (event.pointerType === "touch") event.preventDefault();
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error(`Couldn't copy ${what.toLowerCase()}`);
  }
}

function NewCardItems({ actions }: { actions: BoardMenuActions }) {
  return (
    <>
      <ContextMenuItem onSelect={() => actions.newCard(false)}>
        <Plus />
        New card…
        <ContextMenuShortcut>N</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => actions.newCard(true)}>
        <Zap />
        New card &amp; start agent…
        <ContextMenuShortcut>⇧N</ContextMenuShortcut>
      </ContextMenuItem>
    </>
  );
}

/** Right-click menu for one card: open, agent, move, duplicate, copy, delete, plus "New card". */
export function CardContextMenu({
  task,
  actions,
  children,
}: {
  task: Task;
  actions: BoardMenuActions;
  /** Single element (the card); receives the trigger props. */
  children: ReactNode;
}) {
  const active = task.agentState === "running" || task.agentState === "queued";
  const link = () =>
    `${location.origin}/b/${encodeURIComponent(actions.boardId)}?task=${encodeURIComponent(task.id)}`;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onPointerDown={suppressTouchLongPress}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <ContextMenuLabel className="truncate" title={task.title}>
          {task.title}
        </ContextMenuLabel>
        <ContextMenuItem onSelect={() => actions.openCard(task.id)}>
          <PanelRightOpen />
          Open card
          <ContextMenuShortcut>↵</ContextMenuShortcut>
        </ContextMenuItem>
        {active ? (
          <ContextMenuItem onSelect={() => void actions.stopAgent(task.id)}>
            <Square className="fill-current" />
            Stop agent
          </ContextMenuItem>
        ) : task.agentState === "error" ? (
          <ContextMenuItem onSelect={() => void actions.runAgent(task.id)}>
            <RotateCcw />
            Retry agent
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => void actions.runAgent(task.id)}>
            <Play className="fill-current" />
            Run agent
          </ContextMenuItem>
        )}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <ArrowRightLeft />
            Move to
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-44">
            {TASK_STATUSES.map((status) => (
              <ContextMenuItem
                key={status}
                disabled={status === task.status}
                onSelect={() => void actions.moveToStatus(task.id, status)}
              >
                <StatusDot status={status} />
                {STATUS_LABELS[status]}
                {status === task.status && <Check className="ml-auto" />}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void actions.duplicate(task)}>
          <Copy />
          Duplicate
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copy(link(), "Link")}>
          <Link2 />
          Copy link
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copy(task.title, "Title")}>
          <Copy />
          Copy title
        </ContextMenuItem>
        <ContextMenuSeparator />
        <NewCardItems actions={actions} />
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => actions.requestDelete(task)}>
          <Trash2 />
          Delete card…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Right-click anywhere on the board (outside a card): create cards and board-level actions. */
export function BoardContextMenu({
  actions,
  children,
}: {
  actions: BoardMenuActions;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <NewCardItems actions={actions} />
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={actions.refresh}>
          <RefreshCw />
          Refresh board
        </ContextMenuItem>
        <ContextMenuItem onSelect={actions.openSettings}>
          <Settings2 />
          Project settings…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
