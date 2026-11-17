import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { TaskUsage } from "@/lib/types";

/** `TaskUsage` without its timestamp: what the session files add up to. */
export type UsageSums = Omit<TaskUsage, "updatedAt">;

/** Subagent session files sit at most this deep under the session's artifact directory. */
const MAX_DEPTH = 4;

interface FileTally {
  /** Bytes consumed so far: always just past a newline. */
  offset: number;
  sums: UsageSums;
}

export function emptyUsage(): UsageSums {
  return {
    costUsd: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    requests: 0,
  };
}

/**
 * Totals the model usage of one omp session from disk: the session JSONL (every run of the card
 * appends to it) plus the JSONL of every subagent under its artifact directory (the session path
 * without `.jsonl`). Each model request is recorded once, in the file of the agent that made it:
 * assistant messages carry `usage`, side requests (titles, captions, auto thinking) are
 * `model_usage` entries. Unlike omp's `get_session_stats`, this survives context compaction and
 * counts async subagents.
 *
 * Reads are incremental: each file is read from where the previous scan stopped, so keep one
 * scanner per session while a run goes. A file that shrank (rewritten) is read again from the
 * start.
 */
export class SessionUsageScanner {
  private readonly files = new Map<string, FileTally>();

  constructor(readonly sessionFile: string) {}

  /** Current totals; null when the session file does not exist (yet). */
  async scan(): Promise<UsageSums | null> {
    if (!(await isFile(this.sessionFile))) return null;
    const dir = this.sessionFile.endsWith(".jsonl") ? this.sessionFile.slice(0, -".jsonl".length) : null;
    const paths = [this.sessionFile, ...(dir ? await listJsonl(dir, MAX_DEPTH) : [])];
    let total = emptyUsage();
    for (const file of paths) {
      const tally = await this.readFile(file);
      if (tally) total = sumUsage(total, tally.sums);
    }
    return total;
  }

  private async readFile(file: string): Promise<FileTally | null> {
    let tally = this.files.get(file);
    let handle;
    try {
      handle = await open(file, "r");
      const { size } = await handle.stat();
      if (!tally || size < tally.offset) {
        tally = { offset: 0, sums: emptyUsage() };
        this.files.set(file, tally);
      }
      if (size === tally.offset) return tally;
      const buffer = Buffer.alloc(size - tally.offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, tally.offset);
      // Only whole lines: a line still being written is read next time.
      const end = buffer.lastIndexOf(0x0a, bytesRead - 1);
      if (end < 0) return tally;
      for (const line of buffer.toString("utf8", 0, end).split("\n")) addLine(tally.sums, line);
      tally.offset += end + 1;
      return tally;
    } catch {
      // Vanished or unreadable: what it held so far still counts.
      return tally ?? null;
    } finally {
      await handle?.close();
    }
  }
}

/** Adds one session entry's model usage, if it has any. */
export function addLine(sums: UsageSums, line: string): void {
  if (!line.includes('"usage"')) return;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (!isObject(entry)) return;
  if (entry.type === "message" && isObject(entry.message) && entry.message.role === "assistant") {
    addUsage(sums, entry.message.usage);
  } else if (entry.type === "model_usage") {
    addUsage(sums, entry.usage);
  }
}

function addUsage(sums: UsageSums, usage: unknown): void {
  if (!isObject(usage)) return;
  const input = figure(usage.input);
  const output = figure(usage.output);
  const cacheRead = figure(usage.cacheRead);
  const cacheWrite = figure(usage.cacheWrite);
  sums.inputTokens += input;
  sums.outputTokens += output;
  sums.cacheReadTokens += cacheRead;
  sums.cacheWriteTokens += cacheWrite;
  sums.totalTokens += figure(usage.totalTokens) || input + output + cacheRead + cacheWrite;
  sums.costUsd += isObject(usage.cost) ? figure(usage.cost.total) : 0;
  sums.requests += 1;
}

export function sumUsage(a: UsageSums, b: UsageSums): UsageSums {
  return {
    costUsd: a.costUsd + b.costUsd,
    totalTokens: a.totalTokens + b.totalTokens,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    requests: a.requests + b.requests,
  };
}

/** What `stored` counts beyond `session`, per figure (never negative): usage of earlier sessions. */
export function usageBeyond(stored: UsageSums, session: UsageSums): UsageSums {
  return {
    costUsd: Math.max(0, stored.costUsd - session.costUsd),
    totalTokens: Math.max(0, stored.totalTokens - session.totalTokens),
    inputTokens: Math.max(0, stored.inputTokens - session.inputTokens),
    outputTokens: Math.max(0, stored.outputTokens - session.outputTokens),
    cacheReadTokens: Math.max(0, stored.cacheReadTokens - session.cacheReadTokens),
    cacheWriteTokens: Math.max(0, stored.cacheWriteTokens - session.cacheWriteTokens),
    requests: Math.max(0, stored.requests - session.requests),
  };
}

/** Whether two totals match (cost compared to a hundredth of a cent). */
export function sameUsage(a: UsageSums, b: UsageSums): boolean {
  return a.requests === b.requests && a.totalTokens === b.totalTokens && Math.abs(a.costUsd - b.costUsd) < 0.0001;
}

async function listJsonl(dir: string, depth: number): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    else if (entry.isDirectory() && depth > 1 && entry.name !== "blobs") files.push(...(await listJsonl(full, depth - 1)));
  }
  return files.sort();
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function figure(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
