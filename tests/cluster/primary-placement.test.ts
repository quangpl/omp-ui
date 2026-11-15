import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HealMonitor } from "@/lib/cluster/heal";
import type { AppSettings, NodeOmpInfo, NodeResources } from "@/lib/types";

// A real primary runtime (lib/cluster/primary.ts) with replicas on in-memory channels. What would
// touch the outside world is inert: no agent manager, database, replication rounds, omp binary,
// sockets or replica runtime.
const { manager, settings } = vi.hoisted(() => ({
  manager: { refreshQueue: vi.fn() },
  settings: { current: null as unknown as AppSettings },
}));
vi.mock("@/lib/agent/manager", () => ({ getAgentManager: vi.fn(async () => manager) }));
vi.mock("@/lib/cluster/dial", () => ({ dialPeer: vi.fn() }));
vi.mock("@/lib/cluster/omp-runtime", () => ({ primaryOmpBinary: vi.fn(async () => null) }));
vi.mock("@/lib/cluster/replication", () => ({
  replicatedSeq: vi.fn(() => 0),
  resetReplicatedSeq: vi.fn(),
  startReplicationTo: vi.fn(() => ({ stop: vi.fn(), seq: () => 0, flush: async () => 0 })),
}));
vi.mock("@/lib/cluster/replica", () => ({
  replicaConnection: vi.fn(() => null),
  replicaNodeStatuses: vi.fn(() => []),
  startReplica: vi.fn(),
  stopReplica: vi.fn(),
}));
vi.mock("@/lib/cluster/protocol", () => ({
  ClusterAuthError: class ClusterAuthError extends Error {},
  listenChannels: vi.fn(() => Promise.reject(new Error("no cluster listener in tests"))),
}));
vi.mock("@/lib/cluster/promote", () => ({ useReplicatedOmpAgentDir: vi.fn() }));
vi.mock("@/lib/db", () => ({
  describeDatabase: vi.fn(() => ({ driver: "sqlite", target: ":memory:" })),
  getRepo: vi.fn(async () => ({})),
}));
vi.mock("@/lib/settings", () => ({
  getAppSettings: vi.fn(async () => settings.current),
  setOmpPathResolver: vi.fn(),
}));

import { updateNodeState } from "@/lib/cluster/node";
import {
  acceptMember,
  clusterCapacity,
  placeRun,
  primaryNodeStatuses,
  startPrimary,
  stopPrimary,
  type RunPlacement,
} from "@/lib/cluster/primary";
import {
  HEAL_STATUS_STALE_MS,
  type HealStatusMsg,
  type NodeHold,
  type NodeStatusMsg,
  type RegisterMsg,
} from "@/lib/cluster/types";
import { DEFAULT_SETTINGS } from "@/lib/types";
import { FakeChannel } from "./fake-channel";

const LOCAL_LIMIT = 4;
const GIB = 1024 ** 3;
const BOOT_AT = "2026-11-15T09:00:00.000Z";
const OMP_READY: NodeOmpInfo = { ready: true, version: "1.0.0", source: "local", reason: null };

const savedDataDir = process.env.DATA_DIR;
const g = globalThis as unknown as {
  __ompUiClusterPublish?: NodeJS.Timeout;
  __ompUiClusterPrimary?: { heal: HealMonitor | null };
};
let dir: string;
let replicas: Replica[] = [];

/** A registered replica: `server` is the primary's end of its member channel, `client` the node's. */
interface Replica {
  nodeId: string;
  server: FakeChannel;
  client: FakeChannel;
}

/** A replica machine: 4 cores, idle, a quarter of its memory in use unless `freeShare` says otherwise. */
function machine(freeShare = 0.75): NodeResources {
  return {
    hostname: "replica",
    platform: "linux",
    arch: "x64",
    cpus: 4,
    loadAvg1: 0,
    totalMemoryBytes: 16 * GIB,
    freeMemoryBytes: Math.round(16 * GIB * freeShare),
    sampledAt: new Date().toISOString(),
  };
}

/** Connect a replica with 2 slots and register it; `healed` = it carries `boot`, so it is health-checked. */
async function join(nodeId: string, healed = false): Promise<Replica> {
  const server = new FakeChannel({ nodeId, name: nodeId });
  const client = new FakeChannel({ nodeId: "primary", name: "primary" });
  server.other = client;
  client.other = server;
  const replica = { nodeId, server, client };
  replicas.push(replica);
  acceptMember(server);
  const register: RegisterMsg = {
    t: "register",
    nodeId,
    name: nodeId,
    version: "test",
    httpPort: 3000,
    port: 7790,
    paths: { dataDir: `/srv/${nodeId}/data`, mirrorRoot: `/srv/${nodeId}/mirror`, ompAgentDir: `/srv/${nodeId}/omp` },
    resources: machine(),
    slots: 2,
    omp: OMP_READY,
    replSeq: 0,
    knownTerm: 1,
    knownPrimary: null,
    runs: [],
    ...(healed ? { boot: { at: BOOT_AT, reason: null } } : {}),
  };
  const welcome = await client.request(register);
  expect(welcome.t).toBe("welcome");
  return replica;
}

/** Three replicas, replica-a … replica-c, 2 slots each. */
async function joinThree(healed = false): Promise<Replica[]> {
  return [await join("replica-a", healed), await join("replica-b", healed), await join("replica-c", healed)];
}

/**
 * The replica sends a node.status (2 slots) and it is handled; `holding` null = an older node that
 * does not report its holds. FakeChannel delivers on setImmediate, in order: the next one runs after it.
 */
async function report(replica: Replica, holding: NodeHold[] | null, resources = machine()): Promise<void> {
  const msg: NodeStatusMsg = { t: "node.status", resources, slots: 2, omp: OMP_READY, replSeq: 0, runs: {} };
  if (holding) msg.holding = holding;
  replica.client.send(msg);
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

/**
 * Place `count` cards as the manager's pump does: the primary has LOCAL_LIMIT slots, one fewer
 * free after each card it takes. `overflow` = every card fills a slot lent by board_wait_for_cards.
 * Returns where each went: a replica's nodeId, "primary" or null.
 */
function placeCards(
  count: number,
  options: { runLocal?: boolean; localHeld?: boolean; overflow?: boolean } = {},
): Array<string | null> {
  let localFree = LOCAL_LIMIT;
  const placed: Array<string | null> = [];
  for (let i = 0; i < count; i++) {
    const placement: RunPlacement | null = placeRun({
      taskId: `task-${i}`,
      localFree,
      localLimit: LOCAL_LIMIT,
      runLocal: options.runLocal ?? true,
      localHeld: options.localHeld ?? false,
      overflow: options.overflow ?? false,
      preferNodeId: null,
    });
    if (placement?.local) localFree--;
    placed.push(placement === null ? null : placement.local ? "primary" : placement.nodeId);
  }
  return placed;
}

function health(nodeId: string) {
  return primaryNodeStatuses().find((n) => n.nodeId === nodeId)?.health ?? null;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-primary-placement-"));
  process.env.DATA_DIR = dir;
  settings.current = { ...DEFAULT_SETTINGS, clusterAutoHeal: false };
  manager.refreshQueue.mockClear();
  // Joins, notices and health-check failures are logged; keep the output quiet.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  updateNodeState({ role: "primary", token: "omc_test", term: 1 });
  await startPrimary();
});

afterEach(async () => {
  await stopPrimary("test over");
  for (const replica of replicas) replica.client.close("test over");
  replicas = [];
  clearTimeout(g.__ompUiClusterPublish);
  g.__ompUiClusterPublish = undefined;
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
  process.env.DATA_DIR = savedDataDir;
});

describe("replica-first placement on the primary", () => {
  it("fills healthy replicas before the primary", async () => {
    await joinThree();

    expect(clusterCapacity(LOCAL_LIMIT, true)).toEqual({
      limit: 10,
      info: { localLimit: LOCAL_LIMIT, nodes: 3, remoteSlots: 6 },
    });
    const placed = placeCards(10);

    expect(placed.slice(0, 6).sort()).toEqual([
      "replica-a",
      "replica-a",
      "replica-b",
      "replica-b",
      "replica-c",
      "replica-c",
    ]);
    expect(placed.slice(6)).toEqual(["primary", "primary", "primary", "primary"]);
    expect(clusterCapacity(LOCAL_LIMIT, true).limit).toBe(10);
  });

  it("goes past the primary's own limit only for an overflow run", async () => {
    await joinThree();
    // Every replica slot and the primary's own LOCAL_LIMIT are taken.
    expect(placeCards(10).filter((p) => p === "primary")).toHaveLength(LOCAL_LIMIT);
    const extra = (overflow: boolean) =>
      placeRun({
        taskId: "task-extra",
        localFree: 0,
        localLimit: LOCAL_LIMIT,
        runLocal: true,
        localHeld: false,
        overflow,
        preferNodeId: null,
      });

    // The pump's count and placeRun's disagree (no lent slot): the card stays queued.
    expect(extra(false)).toBeNull();
    // A slot lent by board_wait_for_cards: the primary takes it beyond its own limit.
    expect(extra(true)).toMatchObject({ local: true });
  });

  it("skips a replica whose status went stale", async () => {
    const [a, b, c] = await joinThree();
    // replica-b stops reporting: past HEAL_STATUS_STALE_MS only replica-a and replica-c reported again.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + HEAL_STATUS_STALE_MS + 1_000);
    await report(a, []);
    await report(c, []);

    expect(placeCards(6)).toEqual(["replica-a", "replica-c", "replica-a", "replica-c", "primary", "primary"]);
    expect(clusterCapacity(LOCAL_LIMIT, true)).toEqual({
      limit: 8,
      info: { localLimit: LOCAL_LIMIT, nodes: 2, remoteSlots: 4 },
    });

    manager.refreshQueue.mockClear();
    await report(b, []);
    // Its status was stale: reporting again makes it available, so the manager pumps its queue now.
    expect(manager.refreshQueue).toHaveBeenCalled();
    expect(placeCards(1)).toEqual(["replica-b"]);
  });

  it("skips a replica that reports a guard holding and resumes it once released", async () => {
    const [, b] = await joinThree();
    // Its slots stay at 2: the hold alone keeps it out, not a full slot count.
    await report(b, ["memory"]);

    expect(placeCards(6)).toEqual(["replica-a", "replica-c", "replica-a", "replica-c", "primary", "primary"]);
    expect(clusterCapacity(LOCAL_LIMIT, true).info.nodes).toBe(2);

    manager.refreshQueue.mockClear();
    await report(b, []);
    // Capacity grew: the manager is told to pump its queue now.
    expect(manager.refreshQueue).toHaveBeenCalled();
    expect(placeCards(1)).toEqual(["replica-b"]);
  });

  it("falls back to an older replica's reported memory use", async () => {
    const [, b] = await joinThree();
    // No `holding` in its status (an older node): 90% of its memory in use is past the primary's
    // own memory hold (the guard does not run in this suite, so its default 75% applies).
    await report(b, null, machine(0.1));

    expect(placeCards(6)).toEqual(["replica-a", "replica-c", "replica-a", "replica-c", "primary", "primary"]);

    await report(b, null, machine(0.5));
    expect(placeCards(1)).toEqual(["replica-b"]);
  });

  it("returns null when nothing can safely take a run", async () => {
    const all = await joinThree();
    for (const replica of all) await report(replica, ["cpu"]);

    // The primary runs cards but its own guard holds it, and every replica is held.
    expect(placeCards(1, { runLocal: true, localHeld: true })).toEqual([null]);
    // The primary does not run cards and no replica is available.
    expect(placeCards(1, { runLocal: false })).toEqual([null]);
    // Nothing was reserved for the cards that stay queued.
    expect(clusterCapacity(LOCAL_LIMIT, true)).toEqual({
      limit: LOCAL_LIMIT,
      info: { localLimit: LOCAL_LIMIT, nodes: 0, remoteSlots: 0 },
    });
    // Not held, the primary takes it.
    expect(placeCards(1, { runLocal: true, localHeld: false })).toEqual(["primary"]);
  });

  it("skips a replica failing its health checks", async () => {
    settings.current = { ...settings.current, clusterAutoHeal: true };
    const all = await joinThree(true);
    for (const replica of all) {
      replica.client.on("heal.check", (msg) => {
        const sick = replica.nodeId === "replica-b";
        const reply: HealStatusMsg = {
          t: "heal.status",
          ok: !sick,
          problem: sick ? "disk full" : null,
          bootedAt: BOOT_AT,
          supervised: true,
        };
        replica.client.reply(msg, reply);
      });
    }

    // Run an auto-healing round now rather than waiting for its interval (default failures 3: no restart yet).
    manager.refreshQueue.mockClear();
    await g.__ompUiClusterPrimary?.heal?.tick();
    await vi.waitFor(() => expect(health("replica-b")).toMatchObject({ state: "failing", failures: 1 }));
    // The heal state changed: the primary re-pumps the manager's queue (it does so on every change).
    await vi.waitFor(() => expect(manager.refreshQueue).toHaveBeenCalled());
    expect(health("replica-a")?.state).toBe("ok");

    expect(placeCards(6)).toEqual(["replica-a", "replica-c", "replica-a", "replica-c", "primary", "primary"]);
    expect(clusterCapacity(LOCAL_LIMIT, true).info.nodes).toBe(2);
  });
});
