import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// node.ts drives the cluster runtimes; this suite only covers its state file, so keep those inert.
vi.mock("@/lib/agent/manager", () => ({}));
vi.mock("@/lib/cluster/primary", () => ({}));
vi.mock("@/lib/cluster/replica", () => ({}));
vi.mock("@/lib/cluster/replication", () => ({}));
vi.mock("@/lib/cluster/protocol", () => ({}));
vi.mock("@/lib/cluster/sync", () => ({}));
vi.mock("@/lib/cluster/promote", () => ({}));

import { clusterRole, readNodeState, updateNodeState } from "@/lib/cluster/node";
import { DEFAULT_CLUSTER_PORT } from "@/lib/cluster/types";

const savedDataDir = process.env.DATA_DIR;
const savedPort = process.env.OMP_UI_CLUSTER_PORT;
let dir: string;

function nodeFile(dataDir = dir): string {
  return path.join(dataDir, "cluster", "node.json");
}

/** Read the state from disk again: the cache is per DATA_DIR, so visit another one and come back. */
function reloadFromDisk() {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-node-other-"));
  process.env.DATA_DIR = other;
  readNodeState();
  process.env.DATA_DIR = dir;
  fs.rmSync(other, { recursive: true, force: true });
  return readNodeState();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-node-state-"));
  process.env.DATA_DIR = dir;
  delete process.env.OMP_UI_CLUSTER_PORT;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
  process.env.DATA_DIR = savedDataDir;
  if (savedPort === undefined) delete process.env.OMP_UI_CLUSTER_PORT;
  else process.env.OMP_UI_CLUSTER_PORT = savedPort;
});

describe("readNodeState", () => {
  it("creates standalone defaults in a private file", () => {
    const state = readNodeState();

    expect(state).toMatchObject({
      role: "standalone",
      term: 0,
      token: null,
      name: os.hostname(),
      port: DEFAULT_CLUSTER_PORT,
      primary: null,
      members: [],
      preferredPrimaryId: null,
      joinedAt: null,
      secrets: { authSecret: null, databaseUrl: null, credentialsKey: null },
    });
    expect(state.nodeId).toMatch(/\S/);
    expect(JSON.parse(fs.readFileSync(nodeFile(), "utf8"))).toEqual(state);
    if (process.platform !== "win32") {
      expect(fs.statSync(nodeFile()).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(nodeFile())).mode & 0o777).toBe(0o700);
    }
  });

  it("keeps a stable nodeId across reads and reloads", () => {
    const first = readNodeState();
    expect(readNodeState().nodeId).toBe(first.nodeId);
    expect(reloadFromDisk().nodeId).toBe(first.nodeId);
  });

  it("uses OMP_UI_CLUSTER_PORT for the port", () => {
    process.env.OMP_UI_CLUSTER_PORT = "7999";
    expect(readNodeState().port).toBe(7999);
  });

  it("falls back to defaults when the file is corrupt and keeps a copy", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fs.mkdirSync(path.dirname(nodeFile()), { recursive: true });
    fs.writeFileSync(nodeFile(), "{ not json");

    const state = readNodeState();

    expect(state.role).toBe("standalone");
    expect(state.term).toBe(0);
    expect(fs.readFileSync(`${nodeFile()}.corrupt`, "utf8")).toBe("{ not json");
    expect(JSON.parse(fs.readFileSync(nodeFile(), "utf8")).nodeId).toBe(state.nodeId);
    expect(error).toHaveBeenCalled();
  });

  it("treats a file without a nodeId as corrupt", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fs.mkdirSync(path.dirname(nodeFile()), { recursive: true });
    fs.writeFileSync(nodeFile(), JSON.stringify({ role: "primary", term: 4 }));

    expect(readNodeState()).toMatchObject({ role: "standalone", term: 0 });
    expect(fs.existsSync(`${nodeFile()}.corrupt`)).toBe(true);
  });
});

describe("updateNodeState", () => {
  it("merges the patch and persists it", () => {
    const before = readNodeState();

    const after = updateNodeState({ role: "primary", token: "omc_test", term: 3, preferredPrimaryId: before.nodeId });

    expect(after).toEqual({ ...before, role: "primary", token: "omc_test", term: 3, preferredPrimaryId: before.nodeId });
    expect(readNodeState()).toEqual(after);
    expect(reloadFromDisk()).toEqual(after);
    if (process.platform !== "win32") expect(fs.statSync(nodeFile()).mode & 0o777).toBe(0o600);
  });

  it("keeps earlier fields when later patches touch others", () => {
    updateNodeState({ term: 2 });
    updateNodeState({ joinedAt: "2026-01-01T00:00:00.000Z" });

    expect(reloadFromDisk()).toMatchObject({ term: 2, joinedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("leaves no temp files behind", () => {
    updateNodeState({ term: 1 });
    expect(fs.readdirSync(path.dirname(nodeFile()))).toEqual(["node.json"]);
  });
});

describe("clusterRole", () => {
  it("reflects updates", () => {
    expect(clusterRole()).toBe("standalone");
    updateNodeState({ role: "replica" });
    expect(clusterRole()).toBe("replica");
    updateNodeState({ role: "standalone" });
    expect(clusterRole()).toBe("standalone");
  });
});
