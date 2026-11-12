import { Play, RotateCcw, Square, Undo2, type LucideIcon } from "lucide-react";
import type { Task } from "@/lib/types";

/**
 * A card's column follows its agent; the user never picks a status directly. These quick actions
 * are the only ways to change it: Start/Resume/Retry run the agent (card goes to In progress),
 * Stop halts it in place, Revert sends the card back to To do (stopping the agent first).
 */
export type QuickActionId = "start" | "resume" | "retry" | "stop" | "revert";

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

const ACTIONS: Record<QuickActionId, QuickAction> = {
  start: { id: "start", label: "Start", hint: "Start the agent on this card", icon: Play, shortcut: "R", filled: true },
  resume: { id: "resume", label: "Resume", hint: "Resume the agent where it left off", icon: Play, shortcut: "R", filled: true },
  retry: { id: "retry", label: "Retry", hint: "Run the agent again after the failure", icon: RotateCcw, shortcut: "R", filled: false },
  stop: { id: "stop", label: "Stop", hint: "Stop the agent; the card stays where it is", icon: Square, shortcut: "S", filled: true },
  revert: {
    id: "revert",
    label: "Revert to To do",
    hint: "Stop the agent and move the card back to To do",
    icon: Undo2,
    shortcut: "Z",
    filled: false,
  },
};

/** Available quick actions for a card, most useful first (index 0 is the primary action). */
export function quickActionsFor(task: Pick<Task, "status" | "agentState">): QuickAction[] {
  const active = task.agentState === "running" || task.agentState === "queued";
  const primary = active
    ? ACTIONS.stop
    : task.agentState === "error"
      ? ACTIONS.retry
      : task.status === "todo"
        ? ACTIONS.start
        : ACTIONS.resume;
  return task.status === "todo" ? [primary] : [primary, ACTIONS.revert];
}

export interface QuickActionHandlers {
  runAgent: (taskId: string) => Promise<void>;
  stopAgent: (taskId: string) => Promise<void>;
  revertToTodo: (taskId: string) => Promise<void>;
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
  }
}

/**
 * Maps a key press on a focused card to one of its quick actions (case-insensitive, no modifiers).
 * Returns null when the key isn't a quick-action shortcut for this card.
 */
export function quickActionForKey(
  task: Pick<Task, "status" | "agentState">,
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
): QuickAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  const key = event.key.toUpperCase();
  return quickActionsFor(task).find((action) => action.shortcut === key) ?? null;
}
