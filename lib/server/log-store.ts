// Server-only. Appends JSON-line events to `DATA_DIR/<source>.log` (security, access, database)
// for the Logs page. Fire-and-forget: logging never throws into or blocks the caller. Must not
// import the database or route helpers (lib/db and lib/server/http import this module).
import fs from "node:fs/promises";
import path from "node:path";
import type { EventLogSource, LogLevel, StoredLogEvent } from "@/lib/log-types";

/** Rotate `<source>.log` to `<source>.log.1` (replacing the previous archive) past this size. */
export const EVENT_LOG_ROTATE_BYTES = 5 * 1024 * 1024;

export interface LogEventInput {
  level: LogLevel;
  category: string;
  message: string;
  details?: string;
  meta?: StoredLogEvent["meta"];
}

/** Absolute DATA_DIR (default ./data); same resolution as lib/files.ts `dataDir()`. */
export function logDataDir(): string {
  return path.resolve(process.cwd(), process.env.DATA_DIR?.trim() || "./data");
}

export function eventLogPath(source: EventLogSource): string {
  return path.join(logDataDir(), `${source}.log`);
}

// One write chain per file keeps lines whole and in order; survives dev HMR module reloads.
const g = globalThis as unknown as { __ompUiLogChains?: Map<string, Promise<void>> };
const chains: Map<string, Promise<void>> = (g.__ompUiLogChains ??= new Map());

async function rotateIfNeeded(file: string): Promise<void> {
  try {
    if ((await fs.stat(file)).size > EVENT_LOG_ROTATE_BYTES) await fs.rename(file, `${file}.1`);
  } catch {
    // no log yet
  }
}

async function append(file: string, line: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await rotateIfNeeded(file);
    await fs.appendFile(file, line);
  } catch (err) {
    console.error(`[logs] could not write ${path.basename(file)}:`, err);
  }
}

/** Record one event. Returns the pending write (tests await it; callers normally ignore it). */
export function logEvent(source: EventLogSource, input: LogEventInput): Promise<void> {
  const event: StoredLogEvent = {
    t: new Date().toISOString(),
    level: input.level,
    category: input.category,
    message: input.message,
    ...(input.details ? { details: input.details } : {}),
    ...(input.meta && Object.keys(input.meta).length > 0 ? { meta: input.meta } : {}),
  };
  const file = eventLogPath(source);
  const line = `${JSON.stringify(event)}\n`;
  const next = (chains.get(file) ?? Promise.resolve()).then(() => append(file, line));
  chains.set(file, next);
  void next.finally(() => {
    if (chains.get(file) === next) chains.delete(file);
  });
  return next;
}

/** Resolves once every queued write has reached disk (tests, shutdown). */
export async function flushLogEvents(): Promise<void> {
  await Promise.all([...chains.values()]);
}
