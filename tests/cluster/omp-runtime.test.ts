import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildOmpAgentPack,
  ensureOmpBinary,
  ensureOmpCommandOnPath,
  installOmpCommand,
  localOmpCommand,
  localOmpInfo,
  primaryOmpBinary,
} from "@/lib/cluster/omp-runtime";

const ENV_KEYS = ["DATA_DIR", "PI_CODING_AGENT_DIR", "PATH"] as const;

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

describe("omp runtime", () => {
  const saved = new Map<string, string | undefined>();
  let root = "";

  beforeEach(() => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "omp-ui-omp-runtime-")));
    process.env.DATA_DIR = path.join(root, "data");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  describe("buildOmpAgentPack", () => {
    it("copies the agent dir minus node-local state and snapshots sqlite databases", async () => {
      const agent = path.join(root, "agent");
      process.env.PI_CODING_AGENT_DIR = agent;
      mkdirSync(path.join(agent, "skills", "review"), { recursive: true });
      writeFileSync(path.join(agent, "config.yml"), "model: test\n");
      writeFileSync(path.join(agent, "mcp.json"), "{}\n");
      writeFileSync(path.join(agent, "skills", "review", "SKILL.md"), "# Review\n");
      for (const dir of ["sessions", "blobs", "terminal-sessions", "cache", "logs", "predict"]) {
        mkdirSync(path.join(agent, dir));
        writeFileSync(path.join(agent, dir, "data.txt"), "local only");
      }
      writeFileSync(path.join(agent, "history.db"), "history");
      writeFileSync(path.join(agent, "config.yml.pre-upgrade"), "old");
      writeFileSync(path.join(agent, "other.db-shm"), "shm");

      // A WAL-mode database with an open writer: its rows live in agent.db-wal until checkpointed.
      const db = new DatabaseSync(path.join(agent, "agent.db"));
      db.exec("PRAGMA journal_mode = WAL; CREATE TABLE creds (name TEXT); INSERT INTO creds VALUES ('anthropic');");
      try {
        const pack = await buildOmpAgentPack();

        expect(pack).toBe(path.join(root, "data", "cluster", "staging", "omp-agent"));
        expect(statSync(pack).mode & 0o777).toBe(0o700);
        expect(readFileSync(path.join(pack, "config.yml"), "utf8")).toBe("model: test\n");
        expect(existsSync(path.join(pack, "mcp.json"))).toBe(true);
        expect(readFileSync(path.join(pack, "skills", "review", "SKILL.md"), "utf8")).toBe("# Review\n");
        for (const excluded of [
          "sessions",
          "blobs",
          "terminal-sessions",
          "cache",
          "logs",
          "predict",
          "history.db",
          "config.yml.pre-upgrade",
          "other.db-shm",
          "agent.db-wal",
          "agent.db-shm",
        ]) {
          expect(existsSync(path.join(pack, excluded)), excluded).toBe(false);
        }

        const snapshot = new DatabaseSync(path.join(pack, "agent.db"), { readOnly: true });
        try {
          expect(snapshot.prepare("SELECT name FROM creds").all()).toEqual([{ name: "anthropic" }]);
        } finally {
          snapshot.close();
        }
      } finally {
        db.close();
      }
    });
  });

  describe.skipIf(process.platform === "win32")("primaryOmpBinary", () => {
    it("describes an executable given by path or found on PATH", async () => {
      const bin = path.join(root, "bin");
      mkdirSync(bin);
      const file = path.join(bin, "omp-fake");
      writeFileSync(file, '#!/bin/sh\necho "omp 9.9.9"\n');
      chmodSync(file, 0o755);
      const expected = {
        path: file,
        version: "omp 9.9.9",
        sha256: sha256(readFileSync(file)),
        size: statSync(file).size,
        platform: process.platform,
        arch: process.arch,
      };

      expect(await primaryOmpBinary(file)).toEqual(expected);
      process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
      expect(await primaryOmpBinary("omp-fake")).toEqual(expected);
      expect(await primaryOmpBinary("omp-missing-for-sure")).toBeNull();
    });
  });

  describe("ensureOmpBinary", () => {
    const binary = Buffer.from("#!/bin/sh\necho omp 1.2.3\n".repeat(1000));
    let server: Server;
    let baseUrl = "";
    let requests = 0;

    beforeAll(async () => {
      server = createServer((req, res) => {
        if (req.url !== "/api/v1/cluster/runtime/omp") {
          res.writeHead(404).end();
          return;
        }
        requests++;
        res.writeHead(200, { "content-type": "application/gzip" });
        res.end(gzipSync(binary));
      });
      const { promise, resolve } = Promise.withResolvers<void>();
      server.listen(0, "127.0.0.1", resolve);
      await promise;
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    });

    afterAll(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      await promise;
    });

    beforeEach(() => {
      requests = 0;
    });

    it("downloads, verifies and installs the binary once per checksum", async () => {
      const sha = sha256(binary);
      const want = { sha256: sha, version: "1.2.3", size: binary.length };

      const [first, second] = await Promise.all([ensureOmpBinary(baseUrl, want), ensureOmpBinary(baseUrl, want)]);

      expect(first).toBe(path.join(root, "data", "cluster", "bin", `omp-${sha.slice(0, 12)}`));
      expect(second).toBe(first);
      expect(requests).toBe(1);
      expect(readFileSync(first).equals(binary)).toBe(true);
      expect(statSync(first).mode & 0o777).toBe(0o755);
      expect(localOmpInfo()).toEqual({ ready: true, version: "1.2.3", source: "primary", reason: null });

      // Installed already: no new download, also with an unknown size.
      expect(await ensureOmpBinary(baseUrl, { ...want, size: 0 })).toBe(first);
      expect(requests).toBe(1);
    });

    it("rejects a download whose checksum does not match", async () => {
      const wrong = sha256("something else");
      const want = { sha256: wrong, version: "6.6.6", size: 0 };

      await expect(ensureOmpBinary(baseUrl, want)).rejects.toThrow(/checksum mismatch/);

      const bin = path.join(root, "data", "cluster", "bin");
      expect(existsSync(path.join(bin, `omp-${wrong.slice(0, 12)}`))).toBe(false);
      expect(readdirSync(bin)).toEqual([]);
      const info = localOmpInfo();
      expect(info.ready).toBe(false);
      expect(info.reason).toMatch(/checksum mismatch/);
    });

    it.skipIf(process.platform === "win32")("never prunes the binary the omp command points at", async () => {
      const bin = path.join(root, "data", "cluster", "bin");
      mkdirSync(bin, { recursive: true });
      const old = Date.now() / 1000 - 3600;
      for (const [i, name] of ["omp-aaaaaaaaaaaa", "omp-bbbbbbbbbbbb", "omp-cccccccccccc"].entries()) {
        writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
        utimesSync(path.join(bin, name), old + i * 60, old + i * 60);
      }
      symlinkSync("omp-aaaaaaaaaaaa", path.join(bin, "omp"));
      // Relinking fails, so the oldest binary is still the omp command when the old ones are pruned.
      vi.spyOn(fs, "symlink").mockRejectedValue(new Error("no symlinks here"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const sha = sha256(binary);

      await ensureOmpBinary(baseUrl, { sha256: sha, version: "1.2.3", size: binary.length });

      expect(readdirSync(bin).sort()).toEqual(
        ["omp", "omp-aaaaaaaaaaaa", "omp-cccccccccccc", `omp-${sha.slice(0, 12)}`].sort(),
      );
      expect(readlinkSync(path.join(bin, "omp"))).toBe("omp-aaaaaaaaaaaa");
      expect(warn).toHaveBeenCalled();
    });
  });

  describe.skipIf(process.platform === "win32")("the omp command", () => {
    const pathEntries = (): string[] => (process.env.PATH ?? "").split(path.delimiter);

    function fakeBinary(file: string): string {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "#!/bin/sh\necho omp 1.0.0\n", { mode: 0o755 });
      return file;
    }

    it("installOmpCommand points the omp symlink at the binary and puts the bin dir on PATH once", async () => {
      const bin = path.join(root, "data", "cluster", "bin");
      process.env.PATH = "/usr/bin";

      await installOmpCommand(fakeBinary(path.join(bin, "omp-111111111111")));
      expect(readlinkSync(path.join(bin, "omp"))).toBe("omp-111111111111");
      expect(pathEntries()).toEqual([bin, "/usr/bin"]);

      await installOmpCommand(fakeBinary(path.join(bin, "omp-222222222222")));
      expect(readlinkSync(path.join(bin, "omp"))).toBe("omp-222222222222");
      expect(pathEntries()).toEqual([bin, "/usr/bin"]);

      // A binary elsewhere is linked by its absolute path; no temp links are left behind.
      const elsewhere = fakeBinary(path.join(root, "elsewhere", "omp"));
      await installOmpCommand(elsewhere);
      expect(readlinkSync(path.join(bin, "omp"))).toBe(elsewhere);
      expect(readdirSync(bin).sort()).toEqual(["omp", "omp-111111111111", "omp-222222222222"]);
    });

    it("ensureOmpCommandOnPath adds the bin dir only when it holds an omp", () => {
      const bin = path.join(root, "data", "cluster", "bin");
      process.env.PATH = "/usr/bin";

      ensureOmpCommandOnPath();
      expect(pathEntries()).toEqual(["/usr/bin"]);

      fakeBinary(path.join(bin, "omp-111111111111"));
      symlinkSync("omp-111111111111", path.join(bin, "omp"));
      ensureOmpCommandOnPath();
      ensureOmpCommandOnPath();
      expect(pathEntries()).toEqual([bin, "/usr/bin"]);
    });

    it("localOmpCommand maps commands missing here to the node's omp command", () => {
      const bin = path.join(root, "data", "cluster", "bin");
      const tools = path.join(root, "tools");
      const own = fakeBinary(path.join(tools, "omp-own"));
      const notExecutable = path.join(tools, "omp-plain");
      writeFileSync(notExecutable, "data", { mode: 0o644 });
      process.env.PATH = tools;
      const missing = path.join(root, "primary-home", ".local", "bin", "omp");

      // Without a node omp command everything stays as configured.
      expect(localOmpCommand(missing)).toBe(missing);
      expect(localOmpCommand("omp-missing-for-sure")).toBe("omp-missing-for-sure");

      fakeBinary(path.join(bin, "omp-111111111111"));
      symlinkSync("omp-111111111111", path.join(bin, "omp"));
      const command = path.join(bin, "omp");

      expect(localOmpCommand(missing)).toBe(command);
      expect(localOmpCommand("omp-missing-for-sure")).toBe(command);
      expect(localOmpCommand(notExecutable)).toBe(command);
      expect(localOmpCommand(own)).toBe(own);
      expect(localOmpCommand("omp-own")).toBe("omp-own");
    });
  });
});
