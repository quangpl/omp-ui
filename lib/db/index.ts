import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { DbDriver, Repository } from "@/lib/db/types";
import { logEvent } from "@/lib/server/log-store";

/** The database the server opens: a SQLite file, or a shared MongoDB / PostgreSQL server. */
export type DatabaseConfig =
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

function resolveConfig(url: string | undefined = process.env.DATABASE_URL): DatabaseConfig {
  const raw = url?.trim();
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
  return describeConfig(withLiveSqliteFile(resolveConfig()));
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

/**
 * Shared database URL a cluster node got from its primary (node.json `secrets.databaseUrl`), which
 * wins over DATABASE_URL once the node is in a cluster. Standalone servers (no node.json, or role
 * standalone) are unaffected; an unreadable node.json falls back to DATABASE_URL.
 */
async function clusterDatabaseUrl(): Promise<string | null> {
  const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR?.trim() || "./data");
  if (!existsSync(path.join(dataDir, "cluster", "node.json"))) return null;
  try {
    // Dynamic, not static: lib/cluster/node.ts (and the cluster runtime it pulls in) imports this
    // module, and only cluster nodes need it; a static import would load it with every getRepo user.
    const { readNodeState } = await import("@/lib/cluster/node");
    const state = readNodeState();
    return state.role !== "standalone" ? state.secrets.databaseUrl : null;
  } catch (err) {
    console.error("[db] cannot read the cluster node state; using DATABASE_URL", err);
    return null;
  }
}

/** DATABASE_URL, or the cluster's shared database URL (the configured SQLite file, before swaps). */
async function configuredDatabase(): Promise<DatabaseConfig> {
  return resolveConfig((await clusterDatabaseUrl()) ?? process.env.DATABASE_URL);
}

/** The configuration getRepo() opens: the configured database, with the live file of a swapped SQLite database. */
export async function effectiveDatabaseConfig(): Promise<DatabaseConfig> {
  return withLiveSqliteFile(await configuredDatabase());
}

async function openRepo(config: DatabaseConfig): Promise<Repository> {
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
  /** Serializes swapDatabase / reopenDatabase. */
  __ompUiRepoSwap?: Promise<unknown>;
  /** SQLite files of replaced repositories that are still open (closed after the grace delay). */
  __ompUiRetiredDbFiles?: Set<string>;
};

/** Installs `pending` as the singleton; a failed initialization is forgotten so the next call retries. */
function installRepo(pending: Promise<Repository>): Promise<Repository> {
  globalForRepo.__ompUiRepo = pending;
  pending.catch(() => {
    if (globalForRepo.__ompUiRepo === pending) globalForRepo.__ompUiRepo = undefined;
  });
  return pending;
}

/** Process-wide repository singleton; concurrent first calls share one initialization. */
export function getRepo(): Promise<Repository> {
  return globalForRepo.__ompUiRepo ?? installRepo(effectiveDatabaseConfig().then(openRepo));
}

// ---------------------------------------------------------------------------------------------
// Swapping the database while the server runs (cluster replicas)
//
// A replaced repository is not closed at once: requests (and event streams) that already hold it
// keep using it for RETIRED_REPO_GRACE_MS. Two SQLite connections must never share a path, though:
// the -wal/-shm files belong to the path, so opening a new file under the old one's name would mix
// the old connection's WAL into it. Each snapshot therefore becomes a new generation file next to
// the configured one, `<db>.gen-<id>`, named by the pointer file `<db>.live`. describeDatabase(),
// effectiveDatabaseConfig() and later restarts follow the pointer; the configured file and older
// generations are deleted once no open repository uses them.

/** How long a replaced repository stays open for the requests that still hold it. */
const RETIRED_REPO_GRACE_MS = 30_000;
/** Suffix of a generation file after the configured file's name. */
const GENERATION_SUFFIX = /^\.gen-[a-z0-9]+$/;

function livePointerFile(file: string): string {
  return `${file}.live`;
}

/** The generation file `<file>.live` names (when it exists), else `file`. */
function liveSqliteFile(file: string): string {
  if (file === ":memory:") return file;
  let name: string;
  try {
    name = readFileSync(livePointerFile(file), "utf8").trim();
  } catch {
    return file; // Never swapped: the configured file is the database.
  }
  const base = path.basename(file);
  if (!name.startsWith(base) || !GENERATION_SUFFIX.test(name.slice(base.length))) return file;
  const live = path.join(path.dirname(file), name);
  return existsSync(live) ? live : file;
}

function withLiveSqliteFile(config: DatabaseConfig): DatabaseConfig {
  return config.driver === "sqlite" ? { driver: "sqlite", file: liveSqliteFile(config.file) } : config;
}

function retiredDbFiles(): Set<string> {
  return (globalForRepo.__ompUiRetiredDbFiles ??= new Set());
}

/** Run swaps one after another. */
function serializedSwap(task: () => Promise<void>): Promise<void> {
  const run = (globalForRepo.__ompUiRepoSwap ?? Promise.resolve()).then(task);
  globalForRepo.__ompUiRepoSwap = run.catch(() => undefined);
  return run;
}

/**
 * Close `previous` after the grace delay; `sqlite` names its file (kept until then) and the
 * configured file whose stale generations are deleted afterwards.
 */
function retireRepo(previous: Promise<Repository> | undefined, sqlite: { file: string; base: string } | null): void {
  if (!previous) return;
  if (sqlite) retiredDbFiles().add(sqlite.file);
  const timer = setTimeout(() => {
    void previous
      .then(
        (repo) => repo.close(),
        () => undefined,
      )
      .catch((err: unknown) => console.error("[db] failed to close a replaced repository", err))
      .then(async () => {
        if (!sqlite) return;
        retiredDbFiles().delete(sqlite.file);
        await removeStaleSqliteFiles(sqlite.base);
      })
      .catch((err: unknown) => console.error("[db] failed to remove replaced database files", err));
  }, RETIRED_REPO_GRACE_MS);
  timer.unref();
}

/** Delete the configured file and the generations of it that are neither live nor still open (+ -wal/-shm). */
async function removeStaleSqliteFiles(base: string): Promise<void> {
  const live = liveSqliteFile(base);
  if (live === base) return;
  const dir = path.dirname(base);
  const name = path.basename(base);
  const generations = (await fs.readdir(dir).catch(() => [] as string[]))
    .filter((entry) => entry.startsWith(name) && GENERATION_SUFFIX.test(entry.slice(name.length)))
    .map((entry) => path.join(dir, entry));
  const retired = retiredDbFiles();
  for (const file of [base, ...generations]) {
    if (file === live || retired.has(file)) continue;
    await Promise.all(["", "-wal", "-shm"].map((suffix) => fs.rm(`${file}${suffix}`, { force: true })));
  }
}

/**
 * Cluster replicas: make `snapshotFile` (a consistent SQLite snapshot from the primary; moved, not
 * copied) the database. It becomes a new generation file, opened and installed before the previous
 * repository is retired (closed RETIRED_REPO_GRACE_MS later), so requests in flight are not cut off.
 */
export function swapDatabase(snapshotFile: string): Promise<void> {
  return serializedSwap(async () => {
    const configured = await configuredDatabase();
    if (configured.driver !== "sqlite" || configured.file === ":memory:") {
      throw new Error(`Cannot swap in a database snapshot: the database is ${configured.driver}, not a SQLite file`);
    }
    const base = configured.file;
    const current = liveSqliteFile(base);
    const next = `${base}.gen-${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
    await fs.mkdir(path.dirname(base), { recursive: true });
    await moveFile(snapshotFile, next);
    let repo: Repository;
    try {
      repo = await openRepo({ driver: "sqlite", file: next });
    } catch (err) {
      await Promise.all(["", "-wal", "-shm"].map((suffix) => fs.rm(`${next}${suffix}`, { force: true })));
      throw err;
    }
    const pointer = livePointerFile(base);
    const temp = `${pointer}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${path.basename(next)}\n`, { mode: 0o600 });
    await fs.rename(temp, pointer);
    const previous = globalForRepo.__ompUiRepo;
    void installRepo(Promise.resolve(repo));
    retireRepo(previous, { file: current, base });
    await removeStaleSqliteFiles(base);
  });
}

/**
 * Open the database again (e.g. after the cluster's shared database URL changed) and install it;
 * the previous repository is closed RETIRED_REPO_GRACE_MS later. When opening fails, the previous
 * repository stays in place.
 */
export function reopenDatabase(): Promise<void> {
  return serializedSwap(async () => {
    const repo = await openRepo(await effectiveDatabaseConfig());
    const previous = globalForRepo.__ompUiRepo;
    void installRepo(Promise.resolve(repo));
    retireRepo(previous, null);
  });
}

/** rename(), falling back to copy + rename when the two paths are on different filesystems. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    const temp = `${to}.swap-${process.pid}`;
    await fs.copyFile(from, temp);
    await fs.rename(temp, to);
    await fs.rm(from, { force: true });
  }
}
