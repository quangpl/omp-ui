import type { DbDriver, Repository, UpdateBoardInput, UpdateTaskInput } from "@/lib/db/types";
import { logEvent } from "@/lib/server/log-store";
import {
  TASK_STATUSES,
  type AgentResources,
  type Task,
  type TaskReview,
  type TaskStatus,
  type TaskUsage,
} from "@/lib/types";

/** Gap between consecutive card positions; new cards go to `max + POSITION_STEP`. */
export const POSITION_STEP = 1024;

/** Position that puts a card at the top of a column: `POSITION_STEP` above its current top card. */
export async function topPosition(
  repo: Pick<Repository, "listTasks">,
  boardId: string,
  status: TaskStatus,
  excludeId: string,
): Promise<number> {
  const tasks = await repo.listTasks(boardId);
  let min = Number.POSITIVE_INFINITY;
  for (const t of tasks) {
    if (t.status === status && t.id !== excludeId && t.position < min) min = t.position;
  }
  return Number.isFinite(min) ? min - POSITION_STEP : 0;
}

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

/**
 * A board patch's new `updatedAt`: undefined when it only (un)pins the board, which arranges the
 * dashboard and is not a change to the project (its "Active …" time stays put).
 */
export function boardPatchUpdatedAt(patch: UpdateBoardInput): string | undefined {
  const changes = Object.entries(patch).some(([key, value]) => key !== "pinned" && value !== undefined);
  return changes ? nowIso() : undefined;
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

/** Normalizes the `limit` of `listRecentRuns` into 1..5000 (default 500). */
export function normalizeRecentRunLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 500;
  return Math.min(5000, Math.max(1, Math.floor(limit)));
}

/** A SQL schema's tables (→ column names) and indexes (→ table), for detecting migrations. */
export interface SchemaSnapshot {
  columns: Map<string, Set<string>>;
  indexes: Map<string, string>;
}

/**
 * Records in the database log (category "migration") what `init()` added to an existing schema:
 * new tables, new columns of existing tables and new indexes on existing tables. Nothing is
 * logged for a fresh database (no tables before): creating the schema is not a migration.
 */
export function logSchemaMigrations(driver: DbDriver, before: SchemaSnapshot, after: SchemaSnapshot): void {
  if (before.columns.size === 0) return;
  const migration = (message: string, meta: Record<string, string>) =>
    void logEvent("database", { level: "info", category: "migration", message, meta: { driver, ...meta } });
  for (const [table, columns] of after.columns) {
    const existing = before.columns.get(table);
    if (!existing) {
      migration(`Created table ${table}`, { table });
      continue;
    }
    for (const column of columns) {
      if (!existing.has(column)) migration(`Added column ${table}.${column}`, { table, column });
    }
  }
  for (const [index, table] of after.indexes) {
    if (!before.indexes.has(index) && before.columns.has(table)) {
      migration(`Created index ${index} on ${table}`, { table, index });
    }
  }
}

/**
 * A stored string list (board `extraFolders`, task `blockedBy`): a JSON array string (SQL
 * drivers) or an array (MongoDB). Anything malformed or missing yields `[]`; non-string entries
 * are dropped.
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

/**
 * A stored task review: a JSON object string (SQL drivers) or an object (MongoDB). Anything
 * missing, malformed or with an unknown decision yields null.
 */
export function parseTaskReview(value: unknown): TaskReview | null {
  let raw = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.decision !== "approved" && r.decision !== "changes_requested") return null;
  if (typeof r.at !== "string") return null;
  return {
    decision: r.decision,
    hash: typeof r.hash === "string" ? r.hash : null,
    note: typeof r.note === "string" ? r.note : null,
    at: r.at,
  };
}

/**
 * A stored agent resource sample: a JSON object string (SQL drivers) or an object (MongoDB).
 * Anything missing, malformed, or with a negative or non-finite figure yields null.
 */
export function parseAgentResources(value: unknown): AgentResources | null {
  let raw = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const figure = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!figure(r.memoryBytes) || !figure(r.peakMemoryBytes) || !figure(r.cpuPercent) || !figure(r.cpuSeconds)) {
    return null;
  }
  if (typeof r.sampledAt !== "string") return null;
  return {
    memoryBytes: r.memoryBytes,
    peakMemoryBytes: r.peakMemoryBytes,
    cpuPercent: r.cpuPercent,
    cpuSeconds: r.cpuSeconds,
    sampledAt: r.sampledAt,
  };
}

const USAGE_FIGURES = [
  "costUsd",
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "requests",
] as const;

/**
 * Stored session usage: a JSON object string (SQL drivers) or an object (MongoDB). Anything
 * missing, malformed, or with a negative or non-finite figure yields null.
 */
export function parseTaskUsage(value: unknown): TaskUsage | null {
  let raw = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const figures = {} as Record<(typeof USAGE_FIGURES)[number], number>;
  for (const key of USAGE_FIGURES) {
    const v = r[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
    figures[key] = v;
  }
  if (typeof r.updatedAt !== "string") return null;
  return { ...figures, updatedAt: r.updatedAt };
}

/**
 * Whether a task patch bumps `updatedAt`: every patch does except one that only sets `usage`
 * (spend bookkeeping refreshed during and after runs is not a change to the card).
 */
export function touchesTask(patch: UpdateTaskInput): boolean {
  if (patch.usage === undefined) return true;
  return Object.entries(patch).some(([key, value]) => key !== "usage" && value !== undefined);
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
