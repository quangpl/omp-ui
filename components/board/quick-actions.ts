import { Play, RotateCcw, Square, Undo2, Upload, type LucideIcon } from "lucide-react";
import type { Task } from "@/lib/types";

/**
 * A card's column follows its agent; the user never picks a status directly. These quick actions
 * are the only ways to change it: Start/Resume/Retry run the agent (card goes to In progress),
 * Stop halts it in place, Revert sends the card back to To do (stopping the agent first).
 * Push ships a finished card: commits its changes and pushes them to the project's push branch.
 */
export type QuickActionId = "start" | "resume" | "retry" | "stop" | "revert" | "push";

export interface QuickAction {
  id: QuickActionId;
  label: string;
  /** One-line explanation for tooltips. */
  hint: string;
  icon: LucideIcon;
  /** Single key that triggers the action while the card is focused (shown as a hint). */
  shortcut: string;
  /** Play/Square read better solid (`fill-current`); RotateCcw/Undo2 are line icons. */
  filled: boolean;
}

/**
 * Quick actions that stay visible on a card instead of appearing on hover: Stop while the agent
 * runs, Push to main once a finished card is ready to ship.
 */
export function isPinnedQuickAction(id: QuickActionId): boolean {
  return id === "stop" || id === "push";
}

const ACTIONS: Record<QuickActionId, QuickAction> = {
  start: { id: "start", label: "Start", hint: "Start the agent on this card", icon: Play, shortcut: "R", filled: true },
  resume: { id: "resume", label: "Resume", hint: "Resume the agent where it left off", icon: Play, shortcut: "R", filled: true },
  retry: { id: "retry", label: "Retry", hint: "Run the agent again", icon: RotateCcw, shortcut: "R", filled: false },
  stop: { id: "stop", label: "Stop", hint: "Stop the agent; the card stays where it is", icon: Square, shortcut: "S", filled: true },
  revert: {
    id: "revert",
    label: "Revert to To do",
    hint: "Stop the agent and move the card back to To do",
    icon: Undo2,
    shortcut: "Z",
    filled: false,
  },
  push: {
    id: "push",
    label: "Push to main",
    hint: "Commit this card's changes and push to the project's push branch",
    icon: Upload,
    shortcut: "P",
    filled: false,
  },
};

type QuickActionTask = Pick<Task, "status" | "agentState"> & Partial<Pick<Task, "retryAt" | "pushedAt">>;

export interface QuickActionOptions {
  /** The project can ship (a git repo with a remote): Done cards not pushed yet offer Push to main. */
  canPush?: boolean;
}

/** Available quick actions for a card, most useful first (index 0 is the primary action). */
export function quickActionsFor(task: QuickActionTask, { canPush = false }: QuickActionOptions = {}): QuickAction[] {
  const active = task.agentState === "running" || task.agentState === "queued";
  // A failed card waiting for its automatic retry: retry now, or stop (cancels the retry).
  if (task.agentState === "error" && task.retryAt && task.status !== "todo") {
    return [ACTIONS.retry, ACTIONS.stop, ACTIONS.revert];
  }
  const primary = active
    ? ACTIONS.stop
    : task.agentState === "error"
      ? ACTIONS.retry
      : task.status === "todo"
        ? ACTIONS.start
        : ACTIONS.resume;
  if (task.status === "todo") return [primary];
  // A finished card's next step is shipping it; once pushed, its title is struck through instead.
  if (canPush && !active && task.status === "done" && !task.pushedAt) {
    return [ACTIONS.push, primary, ACTIONS.revert];
  }
  return [primary, ACTIONS.revert];
}

export interface QuickActionHandlers {
  runAgent: (taskId: string) => Promise<void>;
  stopAgent: (taskId: string) => Promise<void>;
  revertToTodo: (taskId: string) => Promise<void>;
  /** Null when the project can't ship (no git repo with a remote); hides Push to main. */
  pushToMain: ((taskId: string) => Promise<void>) | null;
}

export function runQuickAction(id: QuickActionId, taskId: string, handlers: QuickActionHandlers): Promise<void> {
  switch (id) {
    case "start":
    case "resume":
    case "retry":
      return handlers.runAgent(taskId);
    case "stop":
      return handlers.stopAgent(taskId);
    case "revert":
      return handlers.revertToTodo(taskId);
    case "push":
      return handlers.pushToMain?.(taskId) ?? Promise.resolve();
  }
}

/**
 * Maps a key press on a focused card to one of its quick actions (case-insensitive, no modifiers).
 * Returns null when the key isn't a quick-action shortcut for this card.
 */
export function quickActionForKey(
  task: QuickActionTask,
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  options?: QuickActionOptions,
): QuickAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  const key = event.key.toUpperCase();
  return quickActionsFor(task, options).find((action) => action.shortcut === key) ?? null;
}
