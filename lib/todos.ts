// The card agent's todo list (omp's `todo` tool) and the progress shown on cards.

import type { TaskStatus, TodoItemStatus, TodoPhase } from "@/lib/types";

const ITEM_STATUSES: Record<TodoItemStatus, true> = { pending: true, in_progress: true, completed: true, abandoned: true };

/** Caps on what a card stores, so a runaway list can't bloat every board payload. */
const MAX_PHASES = 20;
const MAX_ITEMS = 100;
const MAX_TEXT = 200;

/** Raw shapes of omp's `details.phases` entries; every field is checked before use. */
interface RawPhase {
  name?: unknown;
  tasks?: unknown;
}
interface RawItem {
  content?: unknown;
  status?: unknown;
}

function isItemStatus(value: unknown): value is TodoItemStatus {
  return typeof value === "string" && Object.hasOwn(ITEM_STATUSES, value);
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT - 1)}…` : trimmed;
}

/**
 * Todo phases from omp (`todo` tool result `details.phases`) or storage (a JSON string in the
 * SQL drivers, an array in MongoDB). Malformed input yields `[]`; bad entries are dropped and
 * unknown item statuses read as `pending`.
 */
export function parseTodoPhases(value: unknown): TodoPhase[] {
  let list = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const phases: TodoPhase[] = [];
  let items = 0;
  for (const entry of list) {
    if (phases.length >= MAX_PHASES || items >= MAX_ITEMS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as RawPhase;
    if (!Array.isArray(raw.tasks)) continue;
    const tasks: TodoPhase["tasks"] = [];
    for (const value of raw.tasks) {
      if (items >= MAX_ITEMS) break;
      if (typeof value !== "object" || value === null) continue;
      const item = value as RawItem;
      if (typeof item.content !== "string" || !item.content.trim()) continue;
      tasks.push({ content: clip(item.content), status: isItemStatus(item.status) ? item.status : "pending" });
      items++;
    }
    if (tasks.length > 0) phases.push({ name: typeof raw.name === "string" ? clip(raw.name) : "", tasks });
  }
  return phases;
}

export interface TodoProgress {
  /** Completed items. */
  done: number;
  /** Items still counted: abandoned ones are dropped from the list. */
  total: number;
  /** The item the agent is on (`in_progress`), if any. */
  current: string | null;
}

/** Completed / counted items of a todo list; null when the agent never kept one. */
export function todoProgress(phases: readonly TodoPhase[]): TodoProgress | null {
  let done = 0;
  let total = 0;
  let current: string | null = null;
  for (const phase of phases) {
    for (const item of phase.tasks) {
      if (item.status === "abandoned") continue;
      total++;
      if (item.status === "completed") done++;
      else if (item.status === "in_progress" && current === null) current = item.content;
    }
  }
  return total > 0 ? { done, total, current } : null;
}

/** Ring fill a card shows without a todo list: To do empty, In progress half, Done full. */
const STATUS_FRACTION: Record<TaskStatus, number> = { todo: 0, in_progress: 0.5, done: 1 };

/**
 * Fraction (0–1) of a card's progress ring: the todo list when the agent kept one, else the
 * card's column. A Done card is always full.
 */
export function progressFraction(status: TaskStatus, progress: TodoProgress | null): number {
  if (status === "done" || !progress) return STATUS_FRACTION[status];
  return progress.done / progress.total;
}
