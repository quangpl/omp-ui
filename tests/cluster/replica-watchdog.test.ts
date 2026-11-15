import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type * as ReplicaModule from "@/lib/cluster/replica";
import type { NodeState } from "@/lib/cluster/types";
import type { AppSettings } from "@/lib/types";

// The real replica runtime (lib/cluster/replica.ts) and its disconnect watchdog, with a primary that
// never answers: every dial is refused. What would touch the outside world (node.json, sockets,
// replication, hosted runs, the omp binary, the machine's resources) is inert. Only setInterval and
// Date are fake: the watchdog's ticks and clock are driven by the test, while the connect loop's
// backoff sleeps (node:timers/promises) stay real; they only pace the failing dials and stopReplica
// aborts them.
const h = vi.hoisted(() => {
  const mocks = {
    state: null as unknown as NodeState,
    settings: {} as Partial<AppSettings>,
    supervised: true,
    dials: 0,
    /** publishClusterStatus throws while set: the connect loop (supervise) rejects on its next failed dial. */
    failPublish: false,
    clusterNotice: vi.fn<(level: string, message: string) => void>(),
    restartWithReason: vi.fn<(reason: string) => void>(),
    updateNodeState: vi.fn((patch: Partial<NodeState>): NodeState => {
      mocks.state = { ...mocks.state, ...patch };
      return mocks.state;
    }),
    dialPeer: vi.fn(async (): Promise<never> => {
      mocks.dials++;
      throw new Error("connect ECONNREFUSED 127.0.0.1:7911");
    }),
  };
  return mocks;
});

vi.mock("@/lib/cluster/node", () => ({
  answerHealRestart: vi.fn(),
  bootInfo: vi.fn(() => ({ bootedAt: new Date().toISOString(), restartReason: null })),
  clusterHttpUrl: vi.fn(() => "http://127.0.0.1:3000"),
  clusterNotice: h.clusterNotice,
  disableCluster: vi.fn(),
  isSupervised: vi.fn(() => h.supervised),
  promoteSelf: vi.fn(),
  publishClusterStatus: vi.fn(() => {
    if (h.failPublish) throw new Error("ENOSPC: no space left on device");
  }),
  readNodeState: vi.fn(() => h.state),
  restartWithReason: h.restartWithReason,
  updateNodeState: h.updateNodeState,
}));
vi.mock("@/lib/cluster/dial", () => ({ dialPeer: h.dialPeer }));
vi.mock("@/lib/settings", async () => {
  const { DEFAULT_SETTINGS } = await vi.importActual<{ DEFAULT_SETTINGS: AppSettings }>("@/lib/types");
  return { getAppSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, ...h.settings })) };
});
vi.mock("@/lib/db", () => ({ getRepo: vi.fn(async () => ({})) }));
vi.mock("@/lib/agent/resource-guard", () => ({
  currentResourcePressure: vi.fn(() => null),
  startResourceGuard: vi.fn(),
}));
vi.mock("@/lib/agent/concurrency", () => ({
  readLoadHold: vi.fn(() => false),
  readMachineResources: vi.fn(() => ({ cpus: 4, totalMemBytes: 8 * 1024 ** 3, freeMemBytes: 4 * 1024 ** 3 })),
  resolveConcurrency: vi.fn(() => 4),
}));
vi.mock("@/lib/cluster/run-host", () => {
  const host = {
    activeCount: vi.fn(() => 0),
    busyPaths: vi.fn(() => new Set<string>()),
    shutdown: vi.fn(),
    detach: vi.fn(),
    states: vi.fn(() => []),
    usage: vi.fn(async () => []),
  };
  return { runHost: vi.fn(() => host) };
});
vi.mock("@/lib/cluster/replication", () => ({
  replicatedSeq: vi.fn(() => 0),
  startReplicationReceiver: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock("@/lib/cluster/omp-runtime", () => ({
  ensureOmpBinary: vi.fn(async () => null),
  localOmpInfo: vi.fn(() => ({ ready: false, version: null, source: null, reason: "not in tests" })),
}));
vi.mock("@/lib/cluster/sync", () => ({
  SyncEndpoint: class SyncEndpoint {
    close() {}
  },
}));
vi.mock("@/lib/files", () => ({ dataDir: vi.fn(() => "/nonexistent/omp-ui-replica-watchdog") }));

/** clusterRestartAfterSeconds 300 and clusterFailoverSeconds 20 (the defaults): the first restart waits 300 s. */
const DEFAULT_WAIT_MS = 300_000;
/** clusterRestartAfterSeconds 60 is raised to clusterFailoverSeconds + 60 s = 80 s. */
const SHORT_WAIT_MS = 80_000;
const WATCHDOG_MS = 5_000;

let replica: typeof ReplicaModule;
let warn: MockInstance<typeof console.warn>;

function replicaState(): NodeState {
  return {
    nodeId: "replica-node",
    name: "replica-1",
    role: "replica",
    term: 1,
    token: "cluster-token",
    port: 7912,
    primary: { nodeId: "primary-node", name: "primary-1", host: "127.0.0.1", port: 7911, httpUrl: "http://127.0.0.1:3000" },
    // Not a member yet: failoverDue stays false, so no election runs.
    members: [],
    preferredPrimaryId: "primary-node",
    joinedAt: "2026-11-15T09:00:00.000Z",
    envJoinId: null,
    secrets: { authSecret: null, databaseUrl: null, credentialsKey: null },
    autoRestarts: 0,
  };
}

function clearReplicaGlobals(): void {
  const store = globalThis as unknown as Record<string, unknown>;
  for (const key of Object.keys(store)) if (key.startsWith("__ompUiReplica")) delete store[key];
}

/** One turn of the real event loop (setImmediate is not faked). */
function turn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/** Let the watchdog's async check (settings read) and the loop's continuations settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await turn();
}

/** Advance the fake clock (watchdog ticks) and let each check finish. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

/** Real wall-clock wait: the connect loop's backoff sleeps (node:timers/promises) are not faked. */
function realDelay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Poll in real time until `check` holds, at most `timeoutMs`; the dials run on the loop's real sleeps. */
async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) return false;
    await realDelay(5);
  }
  return true;
}

function notices(level: string, match: (message: string) => boolean): string[] {
  return h.clusterNotice.mock.calls.filter(([lvl, message]) => lvl === level && match(message)).map(([, message]) => message);
}

beforeEach(async () => {
  clearReplicaGlobals();
  vi.resetModules();
  vi.clearAllMocks();
  h.state = replicaState();
  h.settings = {};
  h.supervised = true;
  h.dials = 0;
  h.failPublish = false;
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-11-15T10:00:00.000Z"));
  // A fresh module per test (not a static import) so no module-level replica state leaks between cases.
  replica = await import("@/lib/cluster/replica");
});

afterEach(async () => {
  h.failPublish = false;
  await replica.stopReplica("test done");
  vi.useRealTimers();
  warn.mockRestore();
  clearReplicaGlobals();
});

describe("replica disconnect watchdog", () => {
  it("restarts a supervised replica once it had no session for the wait", async () => {
    await replica.startReplica();
    await flush();
    expect(h.dials).toBeGreaterThan(0);

    await advance(DEFAULT_WAIT_MS - WATCHDOG_MS);
    expect(h.restartWithReason).not.toHaveBeenCalled();
    expect(h.updateNodeState).not.toHaveBeenCalled();

    await advance(WATCHDOG_MS);
    expect(h.restartWithReason).toHaveBeenCalledTimes(1);
    const [reason] = h.restartWithReason.mock.calls[0];
    expect(reason.startsWith("auto-restart: no connection to the primary primary-1 for")).toBe(true);
    expect(reason).toContain("connect ECONNREFUSED 127.0.0.1:7911");
    expect(h.updateNodeState).toHaveBeenCalledWith({ autoRestarts: 1 });
    expect(notices("warning", (message) => message.startsWith("Restarting this node:"))).toHaveLength(1);
  });

  it("doubles the wait after a restart without a session in between", async () => {
    h.settings = { clusterRestartAfterSeconds: 60 };
    h.state = { ...h.state, autoRestarts: 1 };
    await replica.startReplica();
    await flush();

    await advance(SHORT_WAIT_MS);
    expect(h.restartWithReason).not.toHaveBeenCalled();
    await advance(SHORT_WAIT_MS - WATCHDOG_MS);
    expect(h.restartWithReason).not.toHaveBeenCalled();

    await advance(WATCHDOG_MS);
    expect(h.restartWithReason).toHaveBeenCalledTimes(1);
    expect(h.updateNodeState).toHaveBeenCalledWith({ autoRestarts: 2 });
  });

  it("keeps the disconnect clock when the runtime is replaced (failed promotion, new primary's announce)", async () => {
    await replica.startReplica();
    await flush();
    await advance(200_000);

    // rollBackPromotion, a failed failback handover and onAnnounce replace the runtime like this.
    await replica.stopReplica("promotion failed");
    await replica.startReplica();
    await flush();

    await advance(DEFAULT_WAIT_MS - 200_000 - WATCHDOG_MS);
    expect(h.restartWithReason).not.toHaveBeenCalled();
    await advance(WATCHDOG_MS);
    expect(h.restartWithReason).toHaveBeenCalledTimes(1);
  });

  it("only posts one notice when the node runs without the supervisor", async () => {
    h.supervised = false;
    await replica.startReplica();
    await flush();

    await advance(DEFAULT_WAIT_MS + 6 * WATCHDOG_MS);
    expect(h.restartWithReason).not.toHaveBeenCalled();
    expect(h.updateNodeState).not.toHaveBeenCalled();
    const unsupervised = notices("warning", (message) => message.includes("bin/supervisor.mjs"));
    expect(unsupervised).toHaveLength(1);
    expect(unsupervised[0]).toContain("no connection to the primary primary-1");
  });

  it("does nothing when auto-restart is off", async () => {
    h.settings = { clusterAutoRestart: false };
    await replica.startReplica();
    await flush();

    await advance(DEFAULT_WAIT_MS + 6 * WATCHDOG_MS);
    expect(h.restartWithReason).not.toHaveBeenCalled();
    expect(h.updateNodeState).not.toHaveBeenCalled();
    expect(notices("warning", (message) => message.startsWith("Restarting this node:"))).toHaveLength(0);
    expect(notices("warning", (message) => message.includes("bin/supervisor.mjs"))).toHaveLength(0);
  });

  it("backs off relaunching a connect loop that keeps dying and posts its notice once", async () => {
    await replica.startReplica();
    await flush();
    expect(h.dials).toBe(1);

    // The loop's next failed dial (after its real 1 s backoff) throws in publishClusterStatus: supervise rejects.
    h.failPublish = true;
    expect(await until(() => h.dials >= 2, 3_000)).toBe(true);
    await flush();

    const dialsBefore = h.dials;
    for (let elapsed = 0; elapsed < 60_000; elapsed += WATCHDOG_MS) await advance(WATCHDOG_MS);
    const relaunches = h.dials - dialsBefore;
    // Every relaunch dials once and dies again: one per tick (12) without the backoff; with it the
    // relaunches come 5 s, 10 s, 20 s and 40 s apart (4 in the minute).
    expect(relaunches).toBeGreaterThan(0);
    expect(relaunches).toBeLessThanOrEqual(5);
    expect(notices("warning", (message) => message.includes("connect loop"))).toHaveLength(1);
    expect(notices("error", (message) => message.includes("ENOSPC"))).toHaveLength(1);
  });

  it("reconnects at once on reconnectReplica, and only while the runtime runs", async () => {
    expect(replica.reconnectReplica("restored")).toBe(false);

    await replica.startReplica();
    expect(await until(() => h.dials >= 1, 1_000)).toBe(true);
    // The loop now sleeps its 1 s backoff (real time) after the refused dial.
    await realDelay(50);
    const dialsBefore = h.dials;

    expect(replica.reconnectReplica("restored")).toBe(true);
    expect(await until(() => h.dials > dialsBefore, 300)).toBe(true);

    await replica.stopReplica("stopped");
    expect(replica.reconnectReplica("restored")).toBe(false);
  });
});
