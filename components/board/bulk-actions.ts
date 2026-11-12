"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  type QuickAction,
  type QuickActionHandlers,
  type QuickActionId,
  quickActionsFor,
  runQuickAction,
} from "@/components/board/quick-actions";
import type { Task } from "@/lib/types";

/**
 * A quick action applied to many cards at once, named by its shortcut: R starts/resumes/retries
 * (whichever each card offers), S stops, Z reverts to To do, P pushes to main.
 */
export type BulkKey = "R" | "S" | "Z" | "P";

export const BULK_KEYS: readonly BulkKey[] = ["R", "S", "Z", "P"];

export function isBulkKey(key: string): key is BulkKey {
  return (BULK_KEYS as readonly string[]).includes(key);
}

/** Past-tense verb for the summary toast, and the phrase for "none of them can be …". */
const BULK_VERBS: Record<BulkKey, { done: string; passive: string }> = {
  R: { done: "Started", passive: "started" },
  S: { done: "Stopped", passive: "stopped" },
  Z: { done: "Reverted", passive: "reverted to To do" },
  P: { done: "Pushed", passive: "pushed" },
};

export interface BulkTarget {
  task: Task;
  action: QuickAction;
}

/** The cards among `tasks` that offer the `key` quick action, with the exact action each runs. */
export function bulkTargets(tasks: readonly Task[], key: BulkKey, canPush: boolean): BulkTarget[] {
  const targets: BulkTarget[] = [];
  for (const task of tasks) {
    const action = quickActionsFor(task, { canPush }).find((a) => a.shortcut === key);
    if (action) targets.push({ task, action });
  }
  return targets;
}

/** Button label for the R targets: their shared action ("Start", "Resume", "Retry") or "Run" when mixed. */
export function runLabel(targets: readonly BulkTarget[]): string {
  const ids = new Set<QuickActionId>(targets.map((t) => t.action.id));
  if (ids.size === 1) return targets[0].action.label;
  return ids.size === 0 ? "Start" : "Run";
}

/**
 * Runs `key` on every card of `tasks` that offers it, then toasts one summary
 * ("Stopped 3 cards", "Started 2 cards, 1 skipped"). Runs in parallel, except pushes: they share
 * one git repository, so they go one after another. Per-card failures are toasted by the handlers.
 */
export async function runBulkQuickAction(
  tasks: readonly Task[],
  key: BulkKey,
  handlers: QuickActionHandlers,
): Promise<void> {
  const targets = bulkTargets(tasks, key, handlers.pushToMain !== null);
  const skipped = tasks.length - targets.length;
  const verb = BULK_VERBS[key];
  if (targets.length === 0) {
    toast(tasks.length === 1 ? `This card can't be ${verb.passive}` : `None of these cards can be ${verb.passive}`);
    return;
  }

  let results: PromiseSettledResult<void>[];
  if (key === "P") {
    results = [];
    for (const { task, action } of targets) {
      const [result] = await Promise.allSettled([runQuickAction(action.id, task.id, handlers)]);
      results.push(result);
    }
  } else {
    results = await Promise.allSettled(targets.map(({ task, action }) => runQuickAction(action.id, task.id, handlers)));
  }

  const failed = results.filter((r) => r.status === "rejected").length;
  const succeeded = targets.length - failed;
  const extras = [skipped > 0 && `${skipped} skipped`, failed > 0 && `${failed} failed`].filter(Boolean);
  const summary = `${verb.done} ${succeeded} ${succeeded === 1 ? "card" : "cards"}${extras.length > 0 ? `, ${extras.join(", ")}` : ""}`;
  if (succeeded === 0) toast.error(summary);
  else toast.success(summary);
}

/** One bulk run at a time; `pending` is the key in flight (buttons show it, others disable). */
export function useBulkRunner(handlers: QuickActionHandlers) {
  const [pending, setPending] = useState<BulkKey | null>(null);
  const busy = useRef(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  // Stable identity: hotkey handlers registered once can call it.
  const runRef = useRef((tasks: readonly Task[], key: BulkKey) => {
    if (busy.current || tasks.length === 0) return;
    busy.current = true;
    setPending(key);
    void runBulkQuickAction(tasks, key, handlersRef.current).finally(() => {
      busy.current = false;
      setPending(null);
    });
  });
  return { pending, run: runRef.current };
}
