import { TASK_STATUSES, type Task, type TaskStatus } from "@/lib/types";

/** Gap between consecutive card positions; new cards go to `max + POSITION_STEP`. */
export const POSITION_STEP = 1024;

export const DEFAULT_EVENT_LIMIT = 500;
export const MAX_EVENT_LIMIT = 2000;

let lastTimestamp = 0;

/**
 * Current time as an ISO-8601 string, strictly increasing within the process so rows
 * created in the same millisecond still sort in creation order.
 */
export function nowIso(): string {
  const now = Date.now();
  lastTimestamp = now > lastTimestamp ? now : lastTimestamp + 1;
  return new Date(lastTimestamp).toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Normalizes the `after` cursor of `listRunEvents`. */
export function normalizeAfter(after: number | undefined): number {
  return after !== undefined && Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;
}

/** Normalizes the `limit` of `listRunEvents` into 1..MAX_EVENT_LIMIT. */
export function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_EVENT_LIMIT;
  return Math.min(MAX_EVENT_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * Board `extraFolders` from storage: a JSON array string (SQL drivers) or an array (MongoDB).
 * Anything malformed or missing yields `[]`; non-string entries are dropped.
 */
export function parseFolderList(value: unknown): string[] {
  let list = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
}

export function emptyStatusCounts(): Record<TaskStatus, number> {
  return { todo: 0, in_progress: 0, done: 0 };
}

const STATUS_RANK: Record<TaskStatus, number> = Object.fromEntries(
  TASK_STATUSES.map((s, i) => [s, i]),
) as Record<TaskStatus, number>;

/** Board order: column (todo → in_progress → done), then position, then creation time. */
export function compareTasks(a: Task, b: Task): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    a.position - b.position ||
    (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
  );
}
