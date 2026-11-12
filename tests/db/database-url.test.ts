import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeDatabase } from "@/lib/db/index";

// describeDatabase() re-reads the environment on every call (only getRepo() caches a
// repository on globalThis), so per-test env changes are enough for isolation.
const ENV_KEYS = ["DATABASE_URL", "DATA_DIR", "MONGODB_DB"] as const;

describe("describeDatabase", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  describe("sqlite", () => {
    it("defaults to ./data/omp-ui.db under the working directory", () => {
      expect(describeDatabase()).toEqual({
        driver: "sqlite",
        target: path.resolve(process.cwd(), "data", "omp-ui.db"),
      });
    });

    it("treats a blank DATABASE_URL as unset", () => {
      process.env.DATABASE_URL = "   ";
      expect(describeDatabase()).toEqual({
        driver: "sqlite",
        target: path.resolve(process.cwd(), "data", "omp-ui.db"),
      });
    });

    it("places the default file in DATA_DIR (absolute or relative)", () => {
      process.env.DATA_DIR = "/var/lib/omp-ui";
      expect(describeDatabase()).toEqual({ driver: "sqlite", target: "/var/lib/omp-ui/omp-ui.db" });

      process.env.DATA_DIR = "state/dir";
      expect(describeDatabase()).toEqual({
        driver: "sqlite",
        target: path.resolve(process.cwd(), "state/dir", "omp-ui.db"),
      });
    });

    it("accepts sqlite: and file: prefixes with relative paths", () => {
      process.env.DATABASE_URL = "sqlite:./db/app.db";
      expect(describeDatabase()).toEqual({
        driver: "sqlite",
        target: path.resolve(process.cwd(), "db/app.db"),
      });

      process.env.DATABASE_URL = "file:other.db";
      expect(describeDatabase()).toEqual({
        driver: "sqlite",
        target: path.resolve(process.cwd(), "other.db"),
      });
    });

    it("accepts sqlite: and file: prefixes with absolute paths", () => {
      process.env.DATABASE_URL = "sqlite:/srv/omp.db";
      expect(describeDatabase()).toEqual({ driver: "sqlite", target: "/srv/omp.db" });

      process.env.DATABASE_URL = "file:/srv/omp.db";
      expect(describeDatabase()).toEqual({ driver: "sqlite", target: "/srv/omp.db" });
    });

    it("accepts URL-style sqlite:/// and file:// forms", () => {
      process.env.DATABASE_URL = "sqlite:///srv/abs.db";
      expect(describeDatabase()).toEqual({ driver: "sqlite", target: "/srv/abs.db" });

      process.env.DATABASE_URL = "file://rel/dir/x.db";
      expect(describeDatabase()).toEqual({
        driver: "sqlite",
        target: path.resolve(process.cwd(), "rel/dir/x.db"),
      });
    });

    it("matches the prefix case-insensitively", () => {
      process.env.DATABASE_URL = "SQLite:/srv/upper.db";
      expect(describeDatabase()).toEqual({ driver: "sqlite", target: "/srv/upper.db" });
    });

    it("supports an in-memory database", () => {
      process.env.DATABASE_URL = "sqlite::memory:";
      expect(describeDatabase()).toEqual({ driver: "sqlite", target: ":memory:" });
    });

    it("treats a bare path as a sqlite file", () => {
      process.env.DATABASE_URL = "/tmp/bare.db";
      expect(describeDatabase()).toEqual({ driver: "sqlite", target: "/tmp/bare.db" });

      process.env.DATABASE_URL = "bare-relative.db";
      expect(describeDatabase()).toEqual({
        driver: "sqlite",
        target: path.resolve(process.cwd(), "bare-relative.db"),
      });
    });

    it("ignores DATA_DIR when DATABASE_URL names a file", () => {
      process.env.DATA_DIR = "/should/not/be/used";
      process.env.DATABASE_URL = "sqlite:/srv/explicit.db";
      expect(describeDatabase()).toEqual({ driver: "sqlite", target: "/srv/explicit.db" });
    });

    it("rejects a prefix without a path", () => {
      process.env.DATABASE_URL = "sqlite:";
      expect(() => describeDatabase()).toThrow(/SQLite file path/);

      process.env.DATABASE_URL = "file://";
      expect(() => describeDatabase()).toThrow(/SQLite file path/);
    });
  });

  describe("mongodb", () => {
    it("redacts credentials and keeps host, database and options", () => {
      process.env.DATABASE_URL = "mongodb://admin:s3cret@db.example.com:27017/omp?authSource=admin";
      const result = describeDatabase();
      expect(result).toEqual({
        driver: "mongodb",
        target: "mongodb://***@db.example.com:27017/omp?authSource=admin",
      });
      expect(result.target).not.toContain("s3cret");
      expect(result.target).not.toContain("admin:");
    });

    it("handles mongodb+srv URLs and case-insensitive schemes", () => {
      process.env.DATABASE_URL = "mongodb+srv://user:pw@cluster0.example.net/app";
      expect(describeDatabase()).toEqual({
        driver: "mongodb",
        target: "mongodb+srv://***@cluster0.example.net/app",
      });

      process.env.DATABASE_URL = "MONGODB://u:p@host/x";
      expect(describeDatabase()).toEqual({ driver: "mongodb", target: "MONGODB://***@host/x" });
    });

    it("leaves URLs without credentials unchanged", () => {
      process.env.DATABASE_URL = "mongodb://127.0.0.1:27017";
      process.env.MONGODB_DB = "custom";
      expect(describeDatabase()).toEqual({ driver: "mongodb", target: "mongodb://127.0.0.1:27017" });
    });

    it("trims surrounding whitespace", () => {
      process.env.DATABASE_URL = "  mongodb://u:p@host:1/db  ";
      expect(describeDatabase()).toEqual({ driver: "mongodb", target: "mongodb://***@host:1/db" });
    });
  });

  describe("postgres", () => {
    it("redacts credentials for postgres:// and postgresql:// URLs", () => {
      process.env.DATABASE_URL = "postgres://omp:topsecret@127.0.0.1:5432/omp_ui?sslmode=disable";
      const result = describeDatabase();
      expect(result).toEqual({
        driver: "postgres",
        target: "postgres://***@127.0.0.1:5432/omp_ui?sslmode=disable",
      });
      expect(result.target).not.toContain("topsecret");

      process.env.DATABASE_URL = "postgresql://omp:pw@pg.internal/omp_ui";
      expect(describeDatabase()).toEqual({ driver: "postgres", target: "postgresql://***@pg.internal/omp_ui" });
    });

    it("redacts a password that itself contains '@'", () => {
      process.env.DATABASE_URL = "postgres://omp:p@ss@word@db.host:5432/omp_ui";
      const result = describeDatabase();
      expect(result).toEqual({ driver: "postgres", target: "postgres://***@db.host:5432/omp_ui" });
      expect(result.target).not.toContain("ss@word");
    });

    it("redacts a user-only credential", () => {
      process.env.DATABASE_URL = "postgres://omp@localhost/omp_ui";
      expect(describeDatabase()).toEqual({ driver: "postgres", target: "postgres://***@localhost/omp_ui" });
    });

    it("leaves URLs without credentials unchanged", () => {
      process.env.DATABASE_URL = "postgres://localhost:5432/omp_ui";
      expect(describeDatabase()).toEqual({ driver: "postgres", target: "postgres://localhost:5432/omp_ui" });
    });

    it("does not treat an '@' in the query string as credentials", () => {
      process.env.DATABASE_URL = "postgres://localhost/omp_ui?application_name=a@b";
      expect(describeDatabase()).toEqual({
        driver: "postgres",
        target: "postgres://localhost/omp_ui?application_name=a@b",
      });
    });
  });
});
