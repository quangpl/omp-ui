import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MongoClient } from "mongodb";
import pg from "pg";
import { afterAll, beforeAll, describe } from "vitest";

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
