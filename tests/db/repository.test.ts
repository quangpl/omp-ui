import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MongoClient } from "mongodb";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MongoRepository } from "@/lib/db/mongo";
import { PostgresRepository } from "@/lib/db/postgres";
import { SqliteRepository } from "@/lib/db/sqlite";
import type { Repository } from "@/lib/db/types";

import { runRepositoryContract } from "./repository.contract";

const MONGO_URL = process.env.TEST_MONGODB_URL;
const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

/** Short random identifier usable as a mongo database or postgres schema name suffix. */
function uniqueSuffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 16);
}

// --------------------------------------------------------------------- sqlite
// One temp directory (database file + WAL/SHM side files) per test.

const sqliteDirs = new Map<Repository, string>();

runRepositoryContract(
  "sqlite",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ui-repo-"));
    const repo = new SqliteRepository(path.join(dir, "nested", "omp-ui.db"));
    await repo.init();
    sqliteDirs.set(repo, dir);
    return repo;
  },
  async (repo) => {
    await repo.close();
    const dir = sqliteDirs.get(repo);
    sqliteDirs.delete(repo);
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  },
);

describe("sqlite migration", () => {
  it("adds missing columns to an existing database with defaults for old rows", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ui-migrate-"));
    const file = path.join(dir, "omp-ui.db");
    try {
      // Schema as it was before extra folders, dependencies, agent messages and users.
      const old = new DatabaseSync(file);
      old.exec(`
        CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, workdir TEXT NOT NULL, model TEXT,
          auto_run INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo', position REAL NOT NULL,
          agent_state TEXT NOT NULL DEFAULT 'idle', agent_error TEXT, session_file TEXT, last_run_id TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE comments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL,
          resolved INTEGER NOT NULL DEFAULT 0, resolved_at TEXT, resolved_by_run_id TEXT, created_at TEXT NOT NULL);
        INSERT INTO boards VALUES ('b1', 'Old', '/work/old', NULL, 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
        INSERT INTO tasks (id, board_id, title, position, created_at, updated_at)
          VALUES ('t1', 'b1', 'Old task', 1024, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
        INSERT INTO comments (id, task_id, author, body, created_at)
          VALUES ('c1', 't1', 'user', 'old comment', '2025-01-01T00:00:00.000Z');
      `);
      old.close();

      const repo = new SqliteRepository(file);
      await repo.init();
      try {
        expect(await repo.getBoard("b1")).toMatchObject({
          extraFolders: [],
          pushBranch: "main",
          defaultBranches: {},
          userId: null,
        });
        expect(await repo.getTask("t1")).toMatchObject({ createdByTaskId: null, userId: null });
        expect(await repo.getComment("c1")).toMatchObject({ fromTaskId: null, userId: null });

        // The users table and the user_id columns exist: boot can hand the legacy rows to the first admin.
        const admin = await repo.createUser({ username: "admin", passwordHash: "scrypt$admin", role: "admin" });
        expect(await repo.listUsers()).toEqual([admin]);
        expect(await repo.reassignUserData(null, admin.id)).toBe(1);
        expect((await repo.listBoards(admin.id)).map((b) => b.id)).toEqual(["b1"]);
        expect(await repo.getTask("t1")).toMatchObject({ userId: admin.id });
        expect(await repo.getComment("c1")).toMatchObject({ userId: admin.id });
      } finally {
        await repo.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// -------------------------------------------------------------------- mongodb
// One database per test, dropped afterwards.

describe.skipIf(!MONGO_URL)("mongodb driver", () => {
  let admin: MongoClient;
  const dbNames = new Map<Repository, string>();

  beforeAll(async () => {
    admin = new MongoClient(MONGO_URL!);
    await admin.connect();
  });

  afterAll(async () => {
    await admin?.close();
  });

  runRepositoryContract(
    "mongodb",
    async () => {
      const dbName = `omp_ui_test_${uniqueSuffix()}`;
      const repo = new MongoRepository(MONGO_URL!, dbName);
      await repo.init();
      dbNames.set(repo, dbName);
      return repo;
    },
    async (repo) => {
      await repo.close();
      const dbName = dbNames.get(repo);
      dbNames.delete(repo);
      if (dbName) await admin.db(dbName).dropDatabase();
    },
  );
});

// ------------------------------------------------------------------- postgres
// One schema per test (selected through the connection's search_path), dropped afterwards.

describe.skipIf(!POSTGRES_URL)("postgres driver", () => {
  let admin: pg.Pool;
  const schemas = new Map<Repository, string>();

  beforeAll(() => {
    admin = new pg.Pool({ connectionString: POSTGRES_URL!, max: 1 });
  });

  afterAll(async () => {
    await admin?.end();
  });

  runRepositoryContract(
    "postgres",
    async () => {
      const schema = `omp_ui_test_${uniqueSuffix()}`;
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const url = new URL(POSTGRES_URL!);
      url.searchParams.set("options", `-c search_path=${schema}`);
      const repo = new PostgresRepository(url.toString());
      await repo.init();
      schemas.set(repo, schema);
      return repo;
    },
    async (repo) => {
      await repo.close();
      const schema = schemas.get(repo);
      schemas.delete(repo);
      if (schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    },
  );
});
