// The card agent's todo list (omp's `todo` tool) and the progress shown on cards.

import type { TaskStatus, TodoItem, TodoItemStatus, TodoPhase } from "@/lib/types";

const ITEM_STATUSES: Record<TodoItemStatus, true> = { pending: true, in_progress: true, completed: true, abandoned: true };

/** Caps on what a card stores, so a runaway list can't bloat every board payload. */
const MAX_PHASES = 20;
const MAX_ITEMS = 100;
const MAX_TEXT = 200;

/** Raw shapes of omp's `details.phases` entries (plus stored stamps); every field is checked before use. */
interface RawPhase {
  name?: unknown;
  tasks?: unknown;
}
interface RawItem {
  content?: unknown;
  status?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
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
 * unknown item statuses read as `pending`. Stored `startedAt`/`completedAt` stamps are kept.
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
      const todo: TodoItem = { content: clip(item.content), status: isItemStatus(item.status) ? item.status : "pending" };
      // Stored stamps (never in omp's lists) are kept when they parse as dates.
      for (const key of ["startedAt", "completedAt"] as const) {
        const stamp = item[key];
        if (typeof stamp === "string" && !Number.isNaN(Date.parse(stamp))) todo[key] = stamp;
      }
      tasks.push(todo);
      items++;
    }
    if (tasks.length > 0) phases.push({ name: typeof raw.name === "string" ? clip(raw.name) : "", tasks });
  }
  return phases;
}

/** Times of one run's todo list update, as ISO strings. */
export interface TodoClock {
  now: string;
  /** When the run started: an in-progress stamp older than this spans a pause between runs. */
  runStart: string;
  /** The run's previous todo list update; `runStart` before the first. */
  lastUpdate: string;
}

/**
 * `next` (a fresh omp list) with each item's `startedAt`/`completedAt` carried over from
 * `previous` (the stored list) or stamped now. Items match by content: omp keeps an item's text
 * while it moves through statuses. An item completed without ever being seen in progress
 * started at the previous update; an in-progress stamp from an earlier run is dropped, so a
 * pause between runs never counts as work.
 */
export function stampTodos(previous: readonly TodoPhase[], next: readonly TodoPhase[], clock: TodoClock): TodoPhase[] {
  const earlier = new Map<string, TodoItem[]>();
  for (const phase of previous) {
    for (const item of phase.tasks) {
      const same = earlier.get(item.content);
      if (same) same.push(item);
      else earlier.set(item.content, [item]);
    }
  }
  const runStart = Date.parse(clock.runStart);
  return next.map((phase) => ({
    name: phase.name,
    tasks: phase.tasks.map(({ content, status }): TodoItem => {
      const before = earlier.get(content)?.shift();
      if (status === "completed" && before?.completedAt) {
        return before.startedAt
          ? { content, status, startedAt: before.startedAt, completedAt: before.completedAt }
          : { content, status, completedAt: before.completedAt };
      }
      const started = before?.startedAt && Date.parse(before.startedAt) >= runStart ? before.startedAt : undefined;
      if (status === "in_progress") return { content, status, startedAt: started ?? clock.now };
      if (status === "completed") return { content, status, startedAt: started ?? clock.lastUpdate, completedAt: clock.now };
      return { content, status };
    }),
  }));
}

/**
 * Estimated milliseconds until the agent finishes its todo list, at the pace of the items it
 * completed so far: their combined working time (overlaps counted once, so items completed
 * together share it) per item, times the items left, less the time already spent on the
 * current one (at most one item's worth). Null without a completed, timed item or once nothing
 * is left.
 */
export function todoEta(phases: readonly TodoPhase[], now: number): number | null {
  const spans: Array<[start: number, end: number]> = [];
  let remaining = 0;
  let current: number | null = null;
  for (const phase of phases) {
    for (const item of phase.tasks) {
      if (item.status === "abandoned") continue;
      if (item.status === "completed") {
        const start = Date.parse(item.startedAt ?? "");
        const end = Date.parse(item.completedAt ?? "");
        if (end >= start) spans.push([start, end]);
        continue;
      }
      remaining++;
      if (item.status === "in_progress" && current === null && item.startedAt) current = Date.parse(item.startedAt);
    }
  }
  if (remaining === 0 || spans.length === 0) return null;
  spans.sort((a, b) => a[0] - b[0]);
  let busy = 0;
  let covered = Number.NEGATIVE_INFINITY;
  for (const [start, end] of spans) {
    if (end <= covered) continue;
    busy += end - Math.max(start, covered);
    covered = end;
  }
  if (busy <= 0) return null;
  const pace = busy / spans.length;
  const spent = current === null || Number.isNaN(current) ? 0 : Math.min(pace, Math.max(0, now - current));
  return pace * remaining - spent;
}

export interface TodoProgress {
  /** Completed items. */
  done: number;
  /** Items still counted (abandoned ones are dropped from the list), plus `feedback`. */
  total: number;
  /** The item the agent is on (`in_progress`), if any. */
  current: string | null;
  /** Open feedback comments counted as pending items in `total`: only while the list has nothing left, else 0. */
  feedback: number;
}

/**
 * Completed / counted items of a todo list; null when the agent never kept one. While the list
 * has nothing left, each open feedback comment counts as a pending item: the agent is back at
 * work on it, and the items it adds for it take over (no double counting).
 */
export function todoProgress(phases: readonly TodoPhase[], openFeedback = 0): TodoProgress | null {
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
  if (total === 0) return null;
  const feedback = done === total ? Math.max(0, openFeedback) : 0;
  return { done, total: total + feedback, current, feedback };
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
