// Server-only readers behind `/api/v1/logs/**`: lists the log files of every source, parses text logs
// (omp-ui.log, restart.log, tunnel.log), JSON-line event logs (security/access/database) and agent runs
// into `LogEntry`s, and filters / paginates them newest first.
import type { Dirent } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Repository } from "@/lib/db/types";
import {
  EVENT_LOG_SOURCES,
  LOG_LEVELS,
  LOG_SOURCE_META,
  LOG_SOURCES,
  type EventLogSource,
  type LogEntry,
  type LogFileInfo,
  type LogLevel,
  type LogPage,
  type LogSource,
  type LogSourceInfo,
  type StoredLogEvent,
} from "@/lib/log-types";
import { HttpError } from "@/lib/server/http";
import { eventLogPath, logDataDir } from "@/lib/server/log-store";
import type { Run } from "@/lib/types";

type SourceKind = LogSourceInfo["kind"];

/** Text logs written by the CLI / supervisor / restart helper, by source. */
const TEXT_LOG_FILES: Partial<Record<LogSource, string>> = {
  system: "omp-ui.log",
  restart: "restart.log",
  tunnel: "tunnel.log",
};

/** Only the last 20 MB of a file is read; the partial line at the cut is dropped. */
export const MAX_LOG_READ_BYTES = 20 * 1024 * 1024;
/** Agent runs considered by the "agent" source (newest first). */
const MAX_RUNS = 5000;
/** Most entries an export returns. */
export const MAX_EXPORT_ENTRIES = 50_000;
export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;
/** Run error/summary text kept in `details`. */
const RUN_DETAILS_MAX = 4000;
const RUN_HEADLINE_MAX = 200;

export function isLogSource(value: string): value is LogSource {
  return (LOG_SOURCES as readonly string[]).includes(value);
}

function isEventSource(source: LogSource): source is EventLogSource {
  return (EVENT_LOG_SOURCES as readonly string[]).includes(source);
}

/** Route param → source; unknown → 404. */
export function requireLogSource(value: string): LogSource {
  if (!isLogSource(value)) throw new HttpError(404, `Unknown log source "${value}"`);
  return value;
}

function sourceKind(source: LogSource): SourceKind {
  if (source === "agent") return "runs";
  return isEventSource(source) ? "events" : "file";
}

/** Base file name of a file-backed source (`omp-ui.log`, `security.log`, ...); null for runs. */
function baseFileName(source: LogSource): string | null {
  if (isEventSource(source)) return path.basename(eventLogPath(source));
  return TEXT_LOG_FILES[source] ?? null;
}

/** `<base>` → 0, `<base>.<n>` → n, anything else → null. */
function archiveIndex(base: string, name: string): number | null {
  if (name === base) return 0;
  if (!name.startsWith(`${base}.`)) return null;
  const suffix = name.slice(base.length + 1);
  return /^[1-9]\d{0,5}$/.test(suffix) ? Number(suffix) : null;
}

// ---------------------------------------------------------------------------------------------
// Files

interface LogFile extends LogFileInfo {
  path: string;
  /** Exact mtime (cache key). */
  mtimeMs: number;
}

async function readDataDir(): Promise<Dirent[]> {
  try {
    return await fs.readdir(logDataDir(), { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Current file first, then archives `.1`, `.2`, ... (newest first). Missing files are absent. */
async function listLogFiles(source: LogSource, dirents: Dirent[]): Promise<LogFile[]> {
  const base = baseFileName(source);
  if (!base) return [];
  const dir = logDataDir();
  const found: { name: string; index: number }[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    const index = archiveIndex(base, dirent.name);
    if (index !== null) found.push({ name: dirent.name, index });
  }
  found.sort((a, b) => a.index - b.index);
  const files = await Promise.all(
    found.map(async ({ name, index }): Promise<LogFile | null> => {
      const file = path.join(dir, name);
      try {
        const stat = await fs.stat(file);
        return {
          name,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          archived: index > 0,
          path: file,
          mtimeMs: stat.mtimeMs,
        };
      } catch {
        return null; // rotated away meanwhile
      }
    }),
  );
  return files.filter((f): f is LogFile => f !== null);
}

function publicFile({ name, size, modifiedAt, archived }: LogFile): LogFileInfo {
  return { name, size, modifiedAt, archived };
}

/** Every source in tab order with its files. */
export async function listLogSources(): Promise<LogSourceInfo[]> {
  const dirents = await readDataDir();
  return Promise.all(
    LOG_SOURCES.map(async (id) => ({
      id,
      ...LOG_SOURCE_META[id],
      kind: sourceKind(id),
      files: (await listLogFiles(id, dirents)).map(publicFile),
    })),
  );
}

async function countNewlines(handle: FileHandle, end: number): Promise<number> {
  const chunk = Buffer.alloc(1024 * 1024);
  let count = 0;
  for (let pos = 0; pos < end; ) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, end - pos), pos);
    if (bytesRead === 0) break;
    for (let i = 0; i < bytesRead; i++) if (chunk[i] === 10) count++;
    pos += bytesRead;
  }
  return count;
}

/** Text of the file's first `size` bytes, capped at the last MAX_LOG_READ_BYTES, and its first line number. */
async function readLogText(file: LogFile): Promise<{ text: string; firstLine: number }> {
  const handle = await fs.open(file.path, "r");
  try {
    const start = Math.max(0, file.size - MAX_LOG_READ_BYTES);
    const buf = Buffer.alloc(file.size - start);
    let filled = 0;
    while (filled < buf.length) {
      const { bytesRead } = await handle.read(buf, filled, buf.length - filled, start + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const data = buf.subarray(0, filled);
    if (start === 0) return { text: data.toString("utf8"), firstLine: 1 };
    // Drop the (possibly partial) line at the cut; keep line numbers true to the whole file.
    const newline = data.indexOf(10);
    if (newline === -1) return { text: "", firstLine: 1 };
    return {
      text: data.subarray(newline + 1).toString("utf8"),
      firstLine: (await countNewlines(handle, start)) + 2,
    };
  } finally {
    await handle.close();
  }
}

// Parsed files keyed by source + path, valid while mtime and size are unchanged. Few entries: a
// parsed 10 MB log is large, and pages mostly re-read the same current file.
const PARSE_CACHE_MAX = 6;
const g = globalThis as unknown as {
  __ompUiLogParseCache?: Map<string, { mtimeMs: number; size: number; entries: LogEntry[] }>;
};
const parseCache = (g.__ompUiLogParseCache ??= new Map());

/** Entries of one file in file order (oldest first). Unreadable file → none. */
async function fileEntries(source: LogSource, file: LogFile): Promise<LogEntry[]> {
  const key = `${source}\0${file.path}`;
  const hit = parseCache.get(key);
  if (hit && hit.mtimeMs === file.mtimeMs && hit.size === file.size) {
    parseCache.delete(key);
    parseCache.set(key, hit); // most recently used last
    return hit.entries;
  }
  let entries: LogEntry[];
  try {
    const { text, firstLine } = await readLogText(file);
    entries = isEventSource(source)
      ? parseEventLog(text, source, file.name, firstLine)
      : parseTextLog(text, source, file.name, firstLine);
  } catch {
    return [];
  }
  parseCache.delete(key);
  parseCache.set(key, { mtimeMs: file.mtimeMs, size: file.size, entries });
  while (parseCache.size > PARSE_CACHE_MAX) parseCache.delete(parseCache.keys().next().value as string);
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Parsing

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ISO_TIME = String.raw`\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?`;
/** `=== omp-ui start <ISO> · port 3000 ===`, `=== restart requested <ISO> · cli ===`. */
const MARKER = new RegExp(String.raw`^=== (.+?) (${ISO_TIME})(?: · (.+?))? ===$`);
/** Line starting with its own timestamp; cloudflared adds a level (`... INF msg`). */
const LEADING_TIME = new RegExp(String.raw`^(${ISO_TIME})\s+(.*)$`);
const CLOUDFLARED_LEVEL = /^(DBG|INF|WRN|ERR|FTL)\s+(.*)$/;
/** ngrok logfmt: `t=<time> lvl=info msg="..." ...`. */
const NGROK = /^t=(\S+)\s+lvl=(\w+)\s+(.*)$/;
const NGROK_MSG = /\bmsg=(?:"((?:[^"\\]|\\.)*)"|(\S+))/;
/** `[tag] msg` or `[supervisor <ISO>] msg`. */
const TAG = new RegExp(String.raw`^\[([A-Za-z][\w:./-]*)(?:\s+(${ISO_TIME}))?\]\s*(.*)$`);
/** Stack frames, indented lines, closing braces and error fields belong to the previous entry. */
const CONTINUATION = /^(?:\s|at\s|[}\])]|(?:code|errno|syscall|cause):\s)/;
const ERROR_WORDS = /\b(?:error|fatal|failed|exception|ENOENT)\b|\bERR_/i;
const WARN_WORDS = /\bwarn(?:ing)?s?\b/i;

const CLOUDFLARED_LEVELS: Record<string, LogLevel> = {
  DBG: "debug",
  INF: "info",
  WRN: "warn",
  ERR: "error",
  FTL: "error",
};
const NGROK_LEVELS: Record<string, LogLevel> = {
  dbug: "debug",
  debug: "debug",
  info: "info",
  warn: "warn",
  eror: "error",
  error: "error",
  crit: "error",
};

// Secrets the CLI may print (generated admin password, database URL credentials, token query params).
const REDACTIONS: [RegExp, string][] = [
  [/(PASSWORD[^:\n]*:\s*)\S+/gi, "$1[redacted]"],
  [/(\w+:\/\/[^\s:/@]+:)[^\s@/]+@/g, "$1***@"],
  [/([?&](?:token|key|secret|password|api[_-]?key)=)[^&\s]+/gi, "$1[redacted]"],
];

function redact(line: string): string {
  let out = line;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

function toIso(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function guessLevel(text: string): LogLevel {
  if (text.includes("✗") || ERROR_WORDS.test(text)) return "error";
  if (WARN_WORDS.test(text)) return "warn";
  return "info";
}

function markerMessage(what: string, detail: string | undefined): string {
  const headline = what === "omp-ui start" ? "Server started" : what.charAt(0).toUpperCase() + what.slice(1);
  return detail ? `${headline} (${detail})` : headline;
}

/**
 * Parse a plain text log. Markers and timestamped lines carry their own time; other lines inherit the
 * last known time (`approximateTime`), or none before it. Continuation lines join the previous
 * entry's `details`.
 */
export function parseTextLog(text: string, source: LogSource, file: string, firstLine = 1): LogEntry[] {
  const entries: LogEntry[] = [];
  let lastTime: string | null = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = redact(lines[i].replace(ANSI, "").trimEnd());
    if (!line.trim()) continue;
    const previous = entries.at(-1);
    if (previous && CONTINUATION.test(line)) {
      previous.details = previous.details ? `${previous.details}\n${line}` : line;
      continue;
    }
    const entry: LogEntry = {
      id: `${file}:${firstLine + i}`,
      time: null,
      level: "info",
      source,
      category: null,
      message: line,
      details: null,
      file,
    };
    let own: string | null = null;
    const marker = MARKER.exec(line);
    const stamped = marker ? null : LEADING_TIME.exec(line);
    const ngrok = marker || stamped ? null : NGROK.exec(line);
    const tag = marker || stamped || ngrok ? null : TAG.exec(line);
    if (marker) {
      own = toIso(marker[2]);
      entry.message = markerMessage(marker[1], marker[3]);
    } else if (stamped) {
      own = toIso(stamped[1]);
      const cf = CLOUDFLARED_LEVEL.exec(stamped[2]);
      if (cf) {
        entry.level = CLOUDFLARED_LEVELS[cf[1]];
        entry.category = "cloudflared";
        entry.message = cf[2];
      } else {
        entry.level = guessLevel(stamped[2]);
        entry.message = stamped[2];
      }
    } else if (ngrok) {
      own = toIso(ngrok[1]);
      entry.level = NGROK_LEVELS[ngrok[2].toLowerCase()] ?? guessLevel(ngrok[3]);
      entry.category = "ngrok";
      const msg = NGROK_MSG.exec(ngrok[3]);
      entry.message = msg ? (msg[1] ?? msg[2]).replace(/\\(.)/g, "$1") : ngrok[3];
    } else if (tag) {
      own = tag[2] ? toIso(tag[2]) : null;
      entry.category = tag[1];
      entry.message = tag[3] || line;
      entry.level = guessLevel(tag[3]);
    } else {
      entry.level = guessLevel(line);
    }
    if (own) {
      entry.time = own;
      lastTime = own;
    } else if (lastTime) {
      entry.time = lastTime;
      entry.approximateTime = true;
    }
    entries.push(entry);
  }
  return entries;
}

function isLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Parse a JSON-lines event log in file order; malformed lines are skipped. */
export function parseEventLog(text: string, source: EventLogSource, file: string, firstLine = 1): LogEntry[] {
  const entries: LogEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let event: Partial<StoredLogEvent>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object" || typeof event.message !== "string" || typeof event.t !== "string") {
      continue;
    }
    const time = toIso(event.t);
    if (!time) continue;
    entries.push({
      id: `${file}:${firstLine + i}`,
      time,
      level: isLevel(event.level) ? event.level : "info",
      source,
      category: typeof event.category === "string" && event.category ? event.category : null,
      message: event.message,
      details: typeof event.details === "string" && event.details ? event.details : null,
      ...(event.meta && typeof event.meta === "object" && !Array.isArray(event.meta) ? { meta: event.meta } : {}),
      file,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Query

export interface LogFilter {
  /** null = every level. */
  levels: Set<LogLevel> | null;
  /** Epoch ms bounds, inclusive. */
  since: number | null;
  until: number | null;
  /** Lower-cased search text. */
  q: string | null;
  /** "all" or one file name. */
  file: string;
}

export interface ParsedLogQuery {
  filter: LogFilter;
  limit: number;
  offset: number;
}

function intParam(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = params.get(name)?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${name} must be an integer from ${min} to ${max}`);
  }
  return n;
}

function timeParam(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name)?.trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new HttpError(400, `${name} must be an ISO-8601 date`);
  return ms;
}

/** Validate the LogQuery search params (400 on bad input). */
export function parseLogQuery(params: URLSearchParams): ParsedLogQuery {
  const limit = intParam(params, "limit", DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT);
  const offset = intParam(params, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
  let levels: Set<LogLevel> | null = null;
  const rawLevels = params.get("level")?.trim();
  if (rawLevels) {
    levels = new Set();
    for (const part of rawLevels.split(",")) {
      const level = part.trim().toLowerCase();
      if (!level) continue;
      if (!isLevel(level)) {
        throw new HttpError(400, `Invalid level "${part.trim()}" (expected ${LOG_LEVELS.join(", ")})`);
      }
      levels.add(level);
    }
    if (levels.size === 0) levels = null;
  }
  const q = params.get("q")?.trim().toLowerCase() || null;
  const file = params.get("file")?.trim() || "all";
  return {
    filter: { levels, since: timeParam(params, "since"), until: timeParam(params, "until"), q, file },
    limit,
    offset,
  };
}

function matchesLevelAndTime(level: LogLevel, time: string | null, filter: LogFilter): boolean {
  if (filter.levels && !filter.levels.has(level)) return false;
  if (filter.since === null && filter.until === null) return true;
  if (!time) return false;
  const ms = Date.parse(time);
  return (filter.since === null || ms >= filter.since) && (filter.until === null || ms <= filter.until);
}

function matchesText(entry: LogEntry, q: string | null): boolean {
  if (!q) return true;
  return (
    entry.message.toLowerCase().includes(q) ||
    (entry.details?.toLowerCase().includes(q) ?? false) ||
    (entry.category?.toLowerCase().includes(q) ?? false)
  );
}

function matches(entry: LogEntry, filter: LogFilter): boolean {
  return matchesLevelAndTime(entry.level, entry.time, filter) && matchesText(entry, filter.q);
}

/** Files the `file` filter selects; 400 for a name that isn't one of this source's files. */
function selectFiles(source: LogSource, files: LogFile[], wanted: string): LogFile[] {
  if (wanted === "all") return files;
  const base = baseFileName(source);
  if (!base || archiveIndex(base, wanted) === null) {
    throw new HttpError(400, `Unknown file "${wanted}" for log source "${source}"`);
  }
  return files.filter((f) => f.name === wanted); // rotated away → empty
}

interface LogWindow {
  entries: LogEntry[];
  total: number;
}

/** Text logs: current file newest first, then each archive newest first. */
async function textWindow(source: LogSource, files: LogFile[], filter: LogFilter, offset: number, limit: number) {
  const all: LogEntry[] = [];
  for (const file of files) {
    const entries = await fileEntries(source, file);
    for (let i = entries.length - 1; i >= 0; i--) if (matches(entries[i], filter)) all.push(entries[i]);
  }
  return { entries: all.slice(offset, offset + limit), total: all.length };
}

/** Event logs: by time, newest first; ties keep the newer file and the later line first. */
async function eventWindow(source: LogSource, files: LogFile[], filter: LogFilter, offset: number, limit: number) {
  const all: { entry: LogEntry; ms: number; fileIndex: number; order: number }[] = [];
  for (const [fileIndex, file] of files.entries()) {
    const entries = await fileEntries(source, file);
    entries.forEach((entry, order) => {
      if (matches(entry, filter)) all.push({ entry, ms: Date.parse(entry.time as string), fileIndex, order });
    });
  }
  all.sort((a, b) => b.ms - a.ms || a.fileIndex - b.fileIndex || b.order - a.order);
  return { entries: all.slice(offset, offset + limit).map((x) => x.entry), total: all.length };
}

interface RunLabel {
  title: string;
  boardId: string | null;
  board: string | null;
}

const DELETED_CARD: RunLabel = { title: "(deleted card)", boardId: null, board: null };

/** Card title and board name of each run's card, fetched once per id. */
async function loadRunLabels(repo: Repository, runs: Run[], labels: Map<string, RunLabel>): Promise<void> {
  const taskIds = [...new Set(runs.map((r) => r.taskId))].filter((id) => !labels.has(id));
  const boardNames = new Map<string, string | null>();
  for (let i = 0; i < taskIds.length; i += 50) {
    const batch = taskIds.slice(i, i + 50);
    const tasks = await Promise.all(batch.map((id) => repo.getTask(id)));
    const boardIds = [...new Set(tasks.flatMap((t) => (t ? [t.boardId] : [])))].filter((id) => !boardNames.has(id));
    const boards = await Promise.all(boardIds.map((id) => repo.getBoard(id)));
    boardIds.forEach((id, j) => boardNames.set(id, boards[j]?.name ?? null));
    batch.forEach((id, j) => {
      const task = tasks[j];
      labels.set(
        id,
        task ? { title: task.title, boardId: task.boardId, board: boardNames.get(task.boardId) ?? null } : DELETED_CARD,
      );
    });
  }
}

function runLevel(run: Run): LogLevel {
  if (run.status === "failed") return "error";
  if (run.status === "aborted") return "warn";
  return "info";
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const RUN_VERBS: Record<Run["status"], string> = {
  running: "Run started",
  succeeded: "Run succeeded",
  failed: "Run failed",
  aborted: "Run aborted",
};

function runEntry(run: Run, label: RunLabel): LogEntry {
  const reason = run.status === "failed" || run.status === "aborted" ? run.error?.trim().split("\n")[0] : "";
  const headline = `${RUN_VERBS[run.status]} — ${label.title}`;
  const details = run.error?.trim() || run.summary?.trim() || null;
  const meta: NonNullable<LogEntry["meta"]> = {
    runId: run.id,
    taskId: run.taskId,
    boardId: label.boardId,
    status: run.status,
  };
  if (run.endedAt) {
    const durationMs = Date.parse(run.endedAt) - Date.parse(run.startedAt);
    if (Number.isFinite(durationMs) && durationMs >= 0) meta.durationMs = durationMs;
  }
  return {
    id: run.id,
    time: toIso(run.endedAt ?? run.startedAt),
    level: runLevel(run),
    source: "agent",
    category: label.board,
    message: reason ? `${headline}: ${clip(reason, RUN_HEADLINE_MAX)}` : headline,
    details: details ? clip(details, RUN_DETAILS_MAX) : null,
    meta,
    file: null,
  };
}

/** Agent runs as returned (newest first). Card/board names are fetched for the page only, unless `q` needs them. */
async function runWindow(repo: Repository, filter: LogFilter, offset: number, limit: number): Promise<LogWindow> {
  if (filter.file !== "all") throw new HttpError(400, `Log source "agent" has no files`);
  const runs = (await repo.listRecentRuns(MAX_RUNS)).filter((r) =>
    matchesLevelAndTime(runLevel(r), toIso(r.endedAt ?? r.startedAt), filter),
  );
  const labels = new Map<string, RunLabel>();
  const toEntry = (run: Run) => runEntry(run, labels.get(run.taskId) ?? DELETED_CARD);
  if (filter.q) {
    await loadRunLabels(repo, runs, labels);
    const all = runs.map(toEntry).filter((e) => matchesText(e, filter.q));
    return { entries: all.slice(offset, offset + limit), total: all.length };
  }
  const page = runs.slice(offset, offset + limit);
  await loadRunLabels(repo, page, labels);
  return { entries: page.map(toEntry), total: runs.length };
}

/** Matching entries `[offset, offset + limit)` of a source, newest first, with the source's files. */
export async function readLogWindow(
  repo: Repository,
  source: LogSource,
  filter: LogFilter,
  offset: number,
  limit: number,
): Promise<LogWindow & { files: LogFileInfo[] }> {
  const kind = sourceKind(source);
  if (kind === "runs") return { ...(await runWindow(repo, filter, offset, limit)), files: [] };
  const files = await listLogFiles(source, await readDataDir());
  const selected = selectFiles(source, files, filter.file);
  const window =
    kind === "events"
      ? await eventWindow(source, selected, filter, offset, limit)
      : await textWindow(source, selected, filter, offset, limit);
  return { ...window, files: files.map(publicFile) };
}

/** One page of a source (GET /api/v1/logs/[source]). */
export async function queryLogs(repo: Repository, source: LogSource, query: ParsedLogQuery): Promise<LogPage> {
  const { filter, offset, limit } = query;
  const { entries, total, files } = await readLogWindow(repo, source, filter, offset, limit);
  const next = offset + entries.length;
  return { source, entries, total, offset, limit, nextOffset: next < total ? next : null, files };
}

// ---------------------------------------------------------------------------------------------
// Export

/** One entry as plain text: `<time or ->  <LEVEL>  [<category>] <message>` plus indented details. */
export function formatLogEntryText(entry: LogEntry): string {
  const category = entry.category ? `[${entry.category}] ` : "";
  const head = `${entry.time ?? "-"}  ${entry.level.toUpperCase().padEnd(5)}  ${category}${entry.message}`;
  if (!entry.details) return head;
  return `${head}\n${entry.details
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")}`;
}
