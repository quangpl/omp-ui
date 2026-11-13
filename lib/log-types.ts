// Shared types for the Logs page and `/api/v1/logs/**` (client-safe: no Node imports).

/** Log types shown as tabs on /logs, in tab order. */
export const LOG_SOURCES = ["system", "security", "access", "agent", "database", "restart", "tunnel"] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

/** Severity, lowest first. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Sources recorded by the server itself as JSON lines (`DATA_DIR/<source>.log`). */
export const EVENT_LOG_SOURCES = ["security", "access", "database"] as const;
export type EventLogSource = (typeof EVENT_LOG_SOURCES)[number];

export const LOG_SOURCE_META: Record<LogSource, { label: string; description: string }> = {
  system: { label: "System", description: "Server output: start/stop, warnings and errors (omp-ui.log)." },
  security: { label: "Security", description: "Logins, failed attempts, password and credential changes." },
  access: { label: "Access", description: "API requests and page views." },
  agent: { label: "Agents", description: "Agent runs across every card: starts, completions and failures." },
  database: { label: "Database", description: "Connections, migrations, slow queries and query errors." },
  restart: { label: "Restarts", description: "Restart and rebuild output (restart.log)." },
  tunnel: { label: "Tunnel", description: "Cloudflare tunnel output (tunnel.log)." },
};

/** One line of an event log file (`DATA_DIR/{security,access,database}.log`), JSON-encoded. */
export interface StoredLogEvent {
  /** ISO-8601 time the event happened. */
  t: string;
  level: LogLevel;
  /** Sub-source, e.g. "login", "credentials", "api", "page", "query", "migration". */
  category: string;
  message: string;
  /** Extra multi-line text (stack trace, error body). */
  details?: string;
  /** Small structured fields (ip, method, path, status, durationMs, ...). Never secrets. */
  meta?: Record<string, string | number | boolean | null>;
}

/** A log file of a file-backed source; `archived` = rotated copy (`*.log.1`, `*.log.2`, ...). */
export interface LogFileInfo {
  name: string;
  size: number;
  modifiedAt: string;
  archived: boolean;
}

export interface LogSourceInfo {
  id: LogSource;
  label: string;
  description: string;
  /** "file": parsed text log; "events": JSON-lines event log; "runs": agent runs from the database. */
  kind: "file" | "events" | "runs";
  /** Current file first, then archives newest first. Empty for "runs". */
  files: LogFileInfo[];
}

export interface LogEntry {
  /** Stable within a file/source: `<file>:<line>` for files, the run id for agent runs. */
  id: string;
  /** ISO-8601; null when the line has no timestamp of its own and none can be inferred. */
  time: string | null;
  /** True when `time` was inferred (e.g. from the last "=== omp-ui start ... ===" marker). */
  approximateTime?: boolean;
  level: LogLevel;
  source: LogSource;
  /** Sub-source: event category, "vinext", "[api]", board/card title, ... */
  category: string | null;
  /** First line / headline. */
  message: string;
  /** Continuation lines (stack traces), event details, run prompt/summary. */
  details: string | null;
  meta?: Record<string, string | number | boolean | null>;
  /** File the entry came from (file/event sources); null for agent runs. */
  file: string | null;
}

/** GET /api/v1/logs */
export interface LogSourcesResponse {
  sources: LogSourceInfo[];
}

/**
 * GET /api/v1/logs/[source] query: limit (1-500, default 100), offset (default 0),
 * level (comma list of LogLevel; omitted = all), since/until (ISO-8601, inclusive),
 * q (case-insensitive substring of message/details/category), file ("all" default | a file name
 * from `files`). Entries are newest first.
 */
export interface LogQuery {
  limit?: number;
  offset?: number;
  levels?: LogLevel[];
  since?: string;
  until?: string;
  q?: string;
  file?: string;
}

export interface LogPage {
  source: LogSource;
  entries: LogEntry[];
  /** Matches before pagination. */
  total: number;
  offset: number;
  limit: number;
  /** Offset of the next page, or null when this is the last. */
  nextOffset: number | null;
  files: LogFileInfo[];
}

/** Export formats of GET /api/v1/logs/[source]/export?format=... (same filters as LogQuery). */
export const LOG_EXPORT_FORMATS = ["json", "ndjson", "txt"] as const;
export type LogExportFormat = (typeof LOG_EXPORT_FORMATS)[number];
