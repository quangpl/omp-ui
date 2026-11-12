import path from "node:path";

import type { DbDriver, Repository } from "@/lib/db/types";

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
  const config = resolveConfig();
  if (config.driver === "sqlite") return { driver: "sqlite", target: config.file };
  return { driver: config.driver, target: redactCredentials(config.url) };
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
  try {
    await repo.init();
  } catch (err) {
    await repo.close().catch((closeErr: unknown) => {
      console.error("[db] failed to close repository after init error", closeErr);
    });
    throw err;
  }
  return repo;
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
