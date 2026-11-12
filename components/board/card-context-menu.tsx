"use client";

import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  Copy,
  Link2,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { StatusDot } from "@/components/board/board-column";
import { quickActionsFor, runQuickAction } from "@/components/board/quick-actions";
import { STATUS_LABELS, type Task } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Everything a card / board right-click menu can do. */
export interface BoardMenuActions {
  boardId: string;
  openCard: (taskId: string) => void;
  /** Quick action: back to To do (stops the agent). Cards never move to an arbitrary column. */
  revertToTodo: (taskId: string) => Promise<void>;
  runAgent: (taskId: string) => Promise<void>;
  stopAgent: (taskId: string) => Promise<void>;
  /** Quick action on Done cards: commit and push to the default branch. Null when the project can't ship. */
  pushToMain: ((taskId: string) => Promise<void>) | null;
  duplicate: (task: Task) => Promise<void>;
  /** Asks for confirmation before deleting. */
  requestDelete: (task: Task) => void;
  newCard: () => void;
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
    <ContextMenuItem onSelect={() => actions.newCard()}>
      <Plus />
      New card…
      <ContextMenuShortcut>N</ContextMenuShortcut>
    </ContextMenuItem>
  );
}

/**
 * Right-click menu for one card: open, quick actions (start/resume/retry/stop/revert/push),
 * duplicate, copy, delete, plus "New card". The card's column follows its agent, so there is no
 * "Move to".
 */
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
  const link = () =>
    `${location.origin}/b/${encodeURIComponent(actions.boardId)}?task=${encodeURIComponent(task.id)}`;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onPointerDown={suppressTouchLongPress}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <ContextMenuLabel className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate" title={task.title}>
            {task.title}
          </span>
          <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
            <StatusDot status={task.status} />
            {STATUS_LABELS[task.status]}
          </span>
        </ContextMenuLabel>
        <ContextMenuItem onSelect={() => actions.openCard(task.id)}>
          <PanelRightOpen />
          Open card
          <ContextMenuShortcut>↵</ContextMenuShortcut>
        </ContextMenuItem>
        {quickActionsFor(task, { canPush: actions.pushToMain !== null }).map((action) => (
          <ContextMenuItem
            key={action.id}
            title={action.hint}
            onSelect={() => void runQuickAction(action.id, task.id, actions)}
          >
            <action.icon className={cn(action.filled && "fill-current")} />
            {action.label}
            <ContextMenuShortcut>{action.shortcut}</ContextMenuShortcut>
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void actions.duplicate(task)}>
          <Copy />
          Duplicate
          <ContextMenuShortcut>D</ContextMenuShortcut>
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
          <ContextMenuShortcut>⌫</ContextMenuShortcut>
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
