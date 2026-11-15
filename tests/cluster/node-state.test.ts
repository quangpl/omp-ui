import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// node.ts drives the cluster runtimes; this suite covers its state file and boot decisions, so keep those inert.
const { dialPeer } = vi.hoisted(() => ({ dialPeer: vi.fn() }));
vi.mock("@/lib/agent/manager", () => ({ holdNewRuns: vi.fn() }));
vi.mock("@/lib/cluster/dial", () => ({ dialPeer }));
vi.mock("@/lib/cluster/primary", () => ({
  isPrimaryActive: vi.fn(() => false),
  primaryNodeStatuses: vi.fn(() => []),
  startPrimary: vi.fn(),
  stopPrimary: vi.fn(),
}));
vi.mock("@/lib/cluster/replica", () => ({
  replicaConnection: vi.fn(() => null),
  replicaNodeStatuses: vi.fn(() => []),
  startReplica: vi.fn(),
  stopReplica: vi.fn(),
}));
vi.mock("@/lib/cluster/replication", () => ({ replicatedSeq: vi.fn(() => 0), resetReplicatedSeq: vi.fn() }));
vi.mock("@/lib/cluster/protocol", () => ({
  ClusterAuthError: class ClusterAuthError extends Error {},
  // Booting a clustered role must not open sockets: the listener fails (a notice) and boot goes on.
  listenChannels: vi.fn(() => Promise.reject(new Error("no cluster listener in tests"))),
}));
vi.mock("@/lib/cluster/sync", () => ({}));
vi.mock("@/lib/cluster/promote", () => ({ useReplicatedOmpAgentDir: vi.fn() }));
vi.mock("@/lib/db", () => ({
  describeDatabase: vi.fn(() => ({ driver: "sqlite", target: ":memory:" })),
  getRepo: vi.fn(async () => ({})),
}));
vi.mock("@/lib/settings", () => ({
  getAppSettings: vi.fn(async () => ({ clusterRunLocal: true })),
  setOmpPathResolver: vi.fn(),
}));

import { holdNewRuns } from "@/lib/agent/manager";
import { clusterRole, readNodeState, startCluster, updateNodeState } from "@/lib/cluster/node";
import { startPrimary } from "@/lib/cluster/primary";
import { startReplica } from "@/lib/cluster/replica";
import { resetReplicatedSeq } from "@/lib/cluster/replication";
import { CLUSTER_PROTOCOL_VERSION, DEFAULT_CLUSTER_PORT, type MemberInfo, type WireMessage } from "@/lib/cluster/types";

const savedDataDir = process.env.DATA_DIR;
const savedPort = process.env.OMP_UI_CLUSTER_PORT;
const JOIN_ENV = ["OMP_UI_CLUSTER_JOIN", "OMP_UI_CLUSTER_TOKEN", "OMP_UI_CLUSTER_JOIN_ID"] as const;
const savedJoinEnv = new Map(JOIN_ENV.map((key) => [key, process.env[key]]));
const g = globalThis as unknown as {
  __ompUiClusterStart?: Promise<void>;
  __ompUiClusterEnvJoin?: NodeJS.Timeout;
  __ompUiClusterPublish?: NodeJS.Timeout;
};
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
  for (const [key, value] of savedJoinEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
      envJoinId: null,
      secrets: { authSecret: null, databaseUrl: null, credentialsKey: null },
      autoRestarts: 0,
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

  it("defaults a missing envJoinId to null", () => {
    fs.mkdirSync(path.dirname(nodeFile()), { recursive: true });
    fs.writeFileSync(nodeFile(), JSON.stringify({ nodeId: "node-1", role: "standalone" }));

    expect(readNodeState()).toMatchObject({ nodeId: "node-1", envJoinId: null });
  });

  it.each([
    ["missing", undefined],
    ["negative", -1],
    ["fractional", 2.5],
    ["a string", "3"],
  ])("reads autoRestarts as 0 when it is %s", (_label, autoRestarts) => {
    fs.mkdirSync(path.dirname(nodeFile()), { recursive: true });
    fs.writeFileSync(nodeFile(), JSON.stringify({ nodeId: "node-1", role: "replica", autoRestarts }));

    expect(readNodeState()).toMatchObject({ nodeId: "node-1", role: "replica", autoRestarts: 0 });
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

  it("keeps envJoinId across updates and reloads", () => {
    updateNodeState({ envJoinId: "run-1" });
    updateNodeState({ term: 4 });

    expect(reloadFromDisk()).toMatchObject({ term: 4, envJoinId: "run-1" });
  });

  it("keeps autoRestarts across reloads", () => {
    updateNodeState({ autoRestarts: 2 });
    updateNodeState({ term: 5 });

    expect(reloadFromDisk()).toMatchObject({ term: 5, autoRestarts: 2 });
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

describe("joining from the environment at boot", () => {
  const url = "http://127.0.0.1:9";

  /** Boot cluster mode afresh; the (failing) join is answered by a stubbed fetch. */
  async function boot() {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    g.__ompUiClusterStart = undefined;
    await startCluster();
    return fetch;
  }

  beforeEach(() => {
    process.env.OMP_UI_CLUSTER_JOIN = url;
    process.env.OMP_UI_CLUSTER_TOKEN = "omc_test";
  });

  afterEach(() => {
    clearTimeout(g.__ompUiClusterEnvJoin);
    clearTimeout(g.__ompUiClusterPublish);
    g.__ompUiClusterEnvJoin = undefined;
    g.__ompUiClusterPublish = undefined;
    g.__ompUiClusterStart = undefined;
    dialPeer.mockReset();
    vi.clearAllMocks();
  });

  it("joins (and keeps retrying) while the join id differs from the consumed one", async () => {
    process.env.OMP_UI_CLUSTER_JOIN_ID = "run-2";
    updateNodeState({ envJoinId: "run-1" });

    const fetch = await boot();

    expect(fetch).toHaveBeenCalledWith(`${url}/api/v1/cluster/info`, expect.anything());
    expect(g.__ompUiClusterEnvJoin).toBeDefined();
    expect(readNodeState()).toMatchObject({ role: "standalone", envJoinId: "run-1" });
  });

  it("does not join again once the join id was consumed", async () => {
    process.env.OMP_UI_CLUSTER_JOIN_ID = "run-2";
    updateNodeState({ envJoinId: "run-2" });

    const fetch = await boot();

    expect(fetch).not.toHaveBeenCalled();
    expect(g.__ompUiClusterEnvJoin).toBeUndefined();
  });

  it("without a join id only joins from a node.json created on this boot", async () => {
    delete process.env.OMP_UI_CLUSTER_JOIN_ID;
    fs.mkdirSync(path.dirname(nodeFile()), { recursive: true });
    fs.writeFileSync(nodeFile(), JSON.stringify({ nodeId: "node-1", role: "standalone" }));

    const fetch = await boot();

    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["primary", "replica"] as const)(
    "attempts the join on a %s when the join script ran again (new join id) and keeps its role meanwhile",
    async (role) => {
      process.env.OMP_UI_CLUSTER_JOIN_ID = "run-2";
      updateNodeState({ role, token: "omc_old", term: 4, envJoinId: "run-1" });

      const fetch = await boot();

      expect(fetch).toHaveBeenCalledWith(`${url}/api/v1/cluster/info`, expect.anything());
      expect(g.__ompUiClusterEnvJoin).toBeDefined();
      expect(readNodeState()).toMatchObject({ role, envJoinId: "run-1" });
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`keeps running as a ${role} meanwhile`));
      expect(role === "primary" ? startPrimary : startReplica).toHaveBeenCalled();
    },
  );

  it("does not re-join on a primary's restart once the join id was consumed", async () => {
    process.env.OMP_UI_CLUSTER_JOIN_ID = "run-2";
    updateNodeState({ role: "primary", token: "omc_old", term: 4, envJoinId: "run-2" });

    const fetch = await boot();

    expect(fetch).not.toHaveBeenCalled();
    expect(g.__ompUiClusterEnvJoin).toBeUndefined();
    expect(readNodeState().role).toBe("primary");
    expect(startPrimary).toHaveBeenCalled();
  });

  it("turns a primary into a replica of the environment's primary when the join works", async () => {
    process.env.OMP_UI_CLUSTER_JOIN_ID = "run-2";
    updateNodeState({ role: "primary", token: "omc_old", term: 4, envJoinId: "run-1" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ protocol: CLUSTER_PROTOCOL_VERSION, port: 7700 }));
    const reply = { t: "test.reply", nodeId: "node-p", name: "p", role: "primary", term: 2, version: "test" };
    dialPeer.mockResolvedValue({ channel: { latencyMs: 1, request: async () => reply, close: () => {} } });
    g.__ompUiClusterStart = undefined;

    await startCluster();

    expect(readNodeState()).toMatchObject({
      role: "replica",
      token: "omc_test",
      term: 4,
      envJoinId: "run-2",
      primary: { nodeId: "node-p", name: "p", host: "127.0.0.1", port: 7700, httpUrl: url },
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("(this node was a primary before)"));
    expect(resetReplicatedSeq).toHaveBeenCalled();
    expect(holdNewRuns).not.toHaveBeenCalled();
    expect(startPrimary).not.toHaveBeenCalled();
    expect(startReplica).toHaveBeenCalled();
    expect(g.__ompUiClusterEnvJoin).toBeUndefined();
  });
});

describe("boot fencing of a primary", () => {
  const other: MemberInfo = {
    nodeId: "node-b",
    name: "b",
    host: "10.0.0.2",
    port: DEFAULT_CLUSTER_PORT,
    httpUrl: "http://10.0.0.2:3000",
    role: "primary",
    joinedAt: "2026-01-01T00:00:00.000Z",
    replSeq: 0,
    online: false,
  };

  beforeEach(() => {
    for (const key of JOIN_ENV) delete process.env[key];
  });

  afterEach(() => {
    clearTimeout(g.__ompUiClusterPublish);
    g.__ompUiClusterPublish = undefined;
    g.__ompUiClusterStart = undefined;
    dialPeer.mockReset();
    vi.clearAllMocks();
  });

  it("tells a reachable lower-term primary to step down after starting", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    updateNodeState({ role: "primary", token: "omc_test", term: 5, members: [other] });
    const sent: WireMessage[] = [];
    const reply = { t: "probe.reply", nodeId: "node-b", name: "b", role: "primary", term: 3, primary: null, replSeq: 0 };
    dialPeer.mockImplementation(async () => ({
      channel: {
        request: async (msg: WireMessage) => {
          sent.push(msg);
          return reply;
        },
        close: () => {},
      },
    }));
    g.__ompUiClusterStart = undefined;

    await startCluster();

    expect(sent).toEqual([{ t: "probe" }, expect.objectContaining({ t: "announce", term: 5 })]);
    expect(vi.mocked(startPrimary).mock.invocationCallOrder[0]).toBeLessThan(dialPeer.mock.invocationCallOrder[1]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("b is also a primary (term 3 < 5)"));
    expect(readNodeState().role).toBe("primary");
  });
});
