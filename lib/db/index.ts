import path from "node:path";

import type { DbDriver, Repository } from "@/lib/db/types";
import { logEvent } from "@/lib/server/log-store";

type DatabaseConfig =
  | { driver: "sqlite"; file: string }
  | { driver: "mongodb"; url: string; dbName: string }
  | { driver: "postgres"; url: string };

const MONGO_URL = /^mongodb(\+srv)?:\/\//i;
const POSTGRES_URL = /^postgres(ql)?:\/\//i;

/** Replaces `user:pass@` in a `scheme://user:pass@host/...` URL with `***@`. */
function redactCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1***@");
}

/** Database name from the path segment of a mongodb URL (`mongodb://host/<db>?opts`), if any. */
function mongoDbNameFromUrl(url: string): string | null {
  const afterCredentials = url.replace(MONGO_URL, "").replace(/^[^/?#]*@/, "");
  const match = /^[^/?#]*\/([^?#]*)/.exec(afterCredentials);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function resolveConfig(): DatabaseConfig {
  const raw = process.env.DATABASE_URL?.trim();
  if (raw && POSTGRES_URL.test(raw)) return { driver: "postgres", url: raw };
  if (raw && MONGO_URL.test(raw)) {
    return {
      driver: "mongodb",
      url: raw,
      dbName: mongoDbNameFromUrl(raw) || process.env.MONGODB_DB?.trim() || "omp_ui",
    };
  }
  if (!raw) {
    const dataDir = process.env.DATA_DIR?.trim() || "./data";
    return { driver: "sqlite", file: path.resolve(process.cwd(), dataDir, "omp-ui.db") };
  }
  // `sqlite:<path>`, `file:<path>`, URL-ish `sqlite:///abs/path` / `file://rel/path`, or a bare path.
  let file = raw.replace(/^(sqlite|file):/i, "");
  if (file !== raw && file.startsWith("//")) file = file.slice(2);
  if (file === ":memory:") return { driver: "sqlite", file };
  if (!file) throw new Error(`DATABASE_URL "${raw}" does not specify a SQLite file path`);
  return { driver: "sqlite", file: path.resolve(process.cwd(), file) };
}

/** Driver and target of the configured database, safe to display (credentials redacted). */
export function describeDatabase(): { driver: DbDriver; target: string } {
  return describeConfig(resolveConfig());
}

function describeConfig(config: DatabaseConfig): { driver: DbDriver; target: string } {
  if (config.driver === "sqlite") return { driver: "sqlite", target: config.file };
  return { driver: config.driver, target: redactCredentials(config.url) };
}

/** Calls taking at least this long are logged as slow queries. */
const SLOW_QUERY_MS = 500;

/** Error text for the database log, with any `scheme://user:pass@` credentials redacted. */
function errorText(err: unknown, withStack: boolean): string {
  const text = err instanceof Error ? (withStack && err.stack) || err.message : String(err);
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, "$1***@");
}

/**
 * Wraps `repo` so every method call is timed and recorded in the database log: failures (error),
 * slow calls (warn), `compact` and `close` (info). Successful fast calls and call arguments (which
 * may hold user content) are never logged. Methods run with `this` bound to the real repository;
 * non-function properties (`driver`) and absent optional methods pass through unchanged.
 */
function withQueryLogging(repo: Repository): Repository {
  const driver = repo.driver;
  // Keyed by the underlying function, so a method replaced later (e.g. a test spy) gets a fresh wrapper.
  const wrappers = new WeakMap<(...args: unknown[]) => unknown, (...args: unknown[]) => unknown>();

  const settle = (method: string, started: number, failed: boolean, err?: unknown) => {
    const durationMs = Math.round(performance.now() - started);
    const meta = { driver, method, durationMs };
    if (failed) {
      void logEvent("database", {
        level: "error",
        category: "query",
        message: `${method} failed: ${errorText(err, false)}`,
        details: errorText(err, true),
        meta,
      });
    } else if (method === "compact") {
      void logEvent("database", { level: "info", category: "maintenance", message: "Database compacted", meta });
    } else if (method === "close") {
      void logEvent("database", { level: "info", category: "connection", message: "Database closed", meta });
    } else if (durationMs >= SLOW_QUERY_MS) {
      const message = `Slow query: ${method} took ${durationMs} ms`;
      void logEvent("database", { level: "warn", category: "query", message, meta });
    }
  };

  const wrap = (method: string, fn: (...args: unknown[]) => unknown) =>
    function timed(...args: unknown[]): unknown {
      const started = performance.now();
      let result: unknown;
      try {
        result = fn.apply(repo, args);
      } catch (err) {
        settle(method, started, true, err);
        throw err;
      }
      if (!(result instanceof Promise)) return result;
      return result.then(
        (value: unknown) => {
          settle(method, started, false);
          return value;
        },
        (err: unknown) => {
          settle(method, started, true, err);
          throw err;
        },
      );
    };

  return new Proxy(repo, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function" || typeof prop === "symbol") return value;
      const fn = value as (...args: unknown[]) => unknown;
      let wrapper = wrappers.get(fn);
      if (!wrapper) {
        wrapper = wrap(prop, fn);
        wrappers.set(fn, wrapper);
      }
      return wrapper;
    },
  });
}

async function createRepo(): Promise<Repository> {
  const config = resolveConfig();
  let repo: Repository;
  // Dynamic imports: the driver is chosen at runtime, and only that driver's module (and its
  // runtime dependency: node:sqlite, mongodb or pg) should load.
  if (config.driver === "mongodb") {
    const { MongoRepository } = await import("@/lib/db/mongo");
    repo = new MongoRepository(config.url, config.dbName);
  } else if (config.driver === "postgres") {
    const { PostgresRepository } = await import("@/lib/db/postgres");
    repo = new PostgresRepository(config.url);
  } else {
    const { SqliteRepository } = await import("@/lib/db/sqlite");
    repo = new SqliteRepository(config.file);
  }
  const { driver, target } = describeConfig(config);
  const started = performance.now();
  try {
    await repo.init();
  } catch (err) {
    void logEvent("database", {
      level: "error",
      category: "connection",
      message: `Failed to connect to ${driver} (${target}): ${errorText(err, false)}`,
      details: errorText(err, true),
      meta: { driver, durationMs: Math.round(performance.now() - started) },
    });
    await repo.close().catch((closeErr: unknown) => {
      console.error("[db] failed to close repository after init error", closeErr);
    });
    throw err;
  }
  void logEvent("database", {
    level: "info",
    category: "connection",
    message: `Connected to ${driver} (${target})`,
    meta: { driver, durationMs: Math.round(performance.now() - started) },
  });
  return withQueryLogging(repo);
}

const globalForRepo = globalThis as typeof globalThis & {
  __ompUiRepo?: Promise<Repository>;
};

/** Process-wide repository singleton; concurrent first calls share one initialization. */
export function getRepo(): Promise<Repository> {
  if (!globalForRepo.__ompUiRepo) {
    const pending = createRepo();
    globalForRepo.__ompUiRepo = pending;
    pending.catch(() => {
      if (globalForRepo.__ompUiRepo === pending) globalForRepo.__ompUiRepo = undefined;
    });
  }
  return globalForRepo.__ompUiRepo;
}
