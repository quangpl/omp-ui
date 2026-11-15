import { beforeEach, describe, expect, it, vi } from "vitest";

import { HealMonitor, type HealConfig, type HealHost, type HealNode, type HealNotice } from "@/lib/cluster/heal";
import { HEAL_STABLE_MS, type HealAckMsg, type HealRestartMsg, type HealStatusMsg } from "@/lib/cluster/types";

const T0 = Date.parse("2026-11-15T10:00:00.000Z");
const BOOT = "2026-11-15T09:00:00.000Z";
const BOOT2 = "2026-11-15T10:05:00.000Z";
const SUPERVISOR_MISSING = "this node runs without bin/supervisor.mjs, so it would not come back; restart it by hand";

function status(ok = true, problem: string | null = null, bootedAt = BOOT): HealStatusMsg {
  return { t: "heal.status", ok, problem, bootedAt, supervised: true };
}

function ack(outcome: HealAckMsg["outcome"], error: string | null = null, bootedAt = BOOT): HealAckMsg {
  return { t: "heal.ack", outcome, error, bootedAt };
}

/** A channel request that got no reply (lib/cluster/protocol.ts wording). */
function noReply(type: string): Error {
  return new Error(`No reply to ${type} from a within 10000 ms`);
}

/** The primary as the monitor sees it: nodes, a settable clock and recorders for every host call. */
class FakeCluster {
  now = T0;
  config: HealConfig = {
    enabled: true,
    intervalMs: 15_000,
    timeoutMs: 10_000,
    failures: 3,
    offlineGraceMs: 30_000,
    maxRestarts: 3,
  };
  nodes: HealNode[] = [];
  /** Online nodes that stopped sending node.status. */
  silent = new Set<string>();
  checks: string[] = [];
  restarts: Array<{ nodeId: string; msg: HealRestartMsg; timeoutMs: number }> = [];
  notices: HealNotice[] = [];
  changes = 0;
  check: (nodeId: string) => Promise<HealStatusMsg> = async () => status();
  restart: (nodeId: string, msg: HealRestartMsg) => Promise<HealAckMsg> = async () => ack("restarting");
  readonly host: HealHost = {
    nodes: () => this.nodes.map((node) => ({ ...node })),
    config: async () => ({ ...this.config }),
    check: (nodeId) => {
      this.checks.push(nodeId);
      return this.check(nodeId);
    },
    restart: (nodeId, msg, timeoutMs) => {
      this.restarts.push({ nodeId, msg, timeoutMs });
      return this.restart(nodeId, msg);
    },
    notice: (level, message) => {
      this.notices.push({ level, message });
    },
    changed: () => {
      this.changes++;
    },
    term: () => 7,
    now: () => this.now,
  };
  readonly monitor = new HealMonitor(this.host);

  constructor(config: Partial<HealConfig> = {}) {
    Object.assign(this.config, config);
  }

  addOnline(nodeId: string): void {
    this.nodes.push({
      nodeId,
      name: nodeId,
      address: `${nodeId}.lan:7790`,
      online: true,
      offlineSince: null,
      lastStatusAt: this.now,
      capable: true,
    });
  }

  addOffline(nodeId: string): void {
    this.nodes.push({
      nodeId,
      name: nodeId,
      address: `${nodeId}.lan:7790`,
      online: false,
      offlineSince: this.now,
      lastStatusAt: this.now,
      capable: true,
    });
  }

  /** Move the clock; online nodes that are not silent sent a node.status meanwhile. */
  advance(ms: number): void {
    this.now += ms;
    for (const node of this.nodes) if (node.online && !this.silent.has(node.nodeId)) node.lastStatusAt = this.now;
  }

  /** One auto-healing round `ms` after the previous one. */
  async round(ms = this.config.intervalMs): Promise<void> {
    this.advance(ms);
    await this.monitor.tick();
  }

  async rounds(count: number): Promise<void> {
    for (let i = 0; i < count; i++) await this.round();
  }

  health(nodeId = "a") {
    return this.monitor.health(nodeId);
  }

  iso(ms: number): string {
    return new Date(ms).toISOString();
  }
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("HealMonitor: online nodes", () => {
  it("asks for exactly one restart after N failed checks in a row, with the term and the node's boot time", async () => {
    const f = new FakeCluster();
    f.addOnline("a");
    expect(f.monitor.onRegister("a", { at: BOOT, reason: null })).toBeNull();
    f.check = async () => {
      throw noReply("heal.check");
    };

    await f.rounds(2);
    expect(f.restarts).toEqual([]);
    expect(f.health()).toMatchObject({ state: "failing", failures: 2, problem: "no answer within 10 s" });

    await f.round();
    expect(f.checks).toEqual(["a", "a", "a"]);
    expect(f.restarts).toEqual([
      {
        nodeId: "a",
        msg: {
          t: "heal.restart",
          reason: "3 failed health checks in a row (no answer within 10 s)",
          term: 7,
          bootedAt: BOOT,
        },
        timeoutMs: 10_000,
      },
    ]);
    expect(f.notices).toEqual([
      { level: "warning", message: "Node a failed a health check: no answer within 10 s" },
      {
        level: "warning",
        message: "Node a is unhealthy (3 failed health checks in a row (no answer within 10 s)): restarting it (attempt 1 of 3)",
      },
    ]);
    expect(f.health()).toMatchObject({ state: "restarting", restarts: 1, lastRestartAt: f.iso(f.now) });
    expect(f.changes).toBeGreaterThan(0);

    // Still connected while it goes down: no further check or request before the next attempt is due.
    await f.round();
    expect(f.checks).toHaveLength(3);
    expect(f.restarts).toHaveLength(1);
  });

  it("starts counting again after a passing check", async () => {
    const f = new FakeCluster();
    f.addOnline("a");
    const replies = [false, false, true, false, false];
    f.check = async () => (replies.shift() ? status() : status(false, "database: SQLITE_BUSY"));

    await f.rounds(5);
    expect(f.restarts).toEqual([]);
    expect(f.health()).toMatchObject({ state: "failing", failures: 2, problem: "database: SQLITE_BUSY" });
    expect(f.notices).toEqual([
      { level: "warning", message: "Node a failed a health check: database: SQLITE_BUSY" },
      { level: "info", message: "Node a is healthy again" },
      { level: "warning", message: "Node a failed a health check: database: SQLITE_BUSY" },
    ]);
  });

  it("fails a node whose node.status reports stopped, even when it answers the check", async () => {
    const f = new FakeCluster();
    f.addOnline("a");
    f.silent.add("a");

    await f.round();
    expect(f.health()).toMatchObject({ state: "ok", failures: 0 });

    await f.round();
    expect(f.health()).toMatchObject({ state: "failing", failures: 1, problem: "no status report for 30 s" });
    expect(f.notices).toEqual([{ level: "warning", message: "Node a failed a health check: no status report for 30 s" }]);
  });

  it("targets the process the latest heal.status named and only logs an 'already' answer", async () => {
    const f = new FakeCluster();
    f.addOnline("a");
    f.check = async () => status(false, "database: disk I/O error", BOOT2);
    f.restart = async () => ack("already", null, "2026-11-15T10:06:00.000Z");

    await f.rounds(3);
    expect(f.restarts.map((r) => r.msg)).toEqual([
      {
        t: "heal.restart",
        reason: "3 failed health checks in a row (database: disk I/O error)",
        term: 7,
        bootedAt: BOOT2,
      },
    ]);
    expect(f.notices).toEqual([{ level: "warning", message: "Node a failed a health check: database: disk I/O error" }]);
    expect(f.health().state).toBe("restarting");
  });

  it("reports a restart request an online node did not answer", async () => {
    const f = new FakeCluster({ failures: 1 });
    f.addOnline("a");
    f.monitor.onRegister("a", { at: BOOT, reason: null });
    f.check = async () => status(false, "database: locked");
    f.restart = async () => {
      throw noReply("heal.restart");
    };

    await f.round();
    expect(f.restarts).toHaveLength(1);
    expect(f.notices).toEqual([
      { level: "warning", message: "Node a failed a health check: database: locked" },
      {
        level: "warning",
        message: "Node a did not answer the restart request (attempt 1 of 3; next try in 30 s): no answer within 10 s",
      },
    ]);
    expect(f.health()).toMatchObject({
      state: "failing",
      problem: "no answer to the restart request: no answer within 10 s",
      nextAttemptAt: f.iso(f.now + 30_000),
    });

    // It acted on the request although the ack never arrived.
    expect(f.monitor.onRegister("a", { at: BOOT2, reason: "restart requested" })).toEqual({
      level: "info",
      message: "Node a is back online after an automatic restart",
    });
  });
});

describe("HealMonitor: offline nodes", () => {
  it("restarts an offline node once the grace period is over, not before", async () => {
    const f = new FakeCluster();
    f.addOffline("a");

    await f.round();
    expect(f.restarts).toEqual([]);
    expect(f.health()).toMatchObject({ state: "offline", nextAttemptAt: f.iso(T0 + 30_000) });

    await f.round();
    expect(f.restarts.map((r) => r.msg)).toEqual([
      { t: "heal.restart", reason: "offline for 30 s", term: 7, bootedAt: null },
    ]);
    expect(f.notices).toEqual([
      { level: "warning", message: "Node a is unhealthy (offline for 30 s): restarting it (attempt 1 of 3)" },
    ]);
    expect(f.health()).toMatchObject({ state: "restarting", restarts: 1 });

    await f.round();
    expect(f.restarts).toHaveLength(1);
  });

  it("backs off doubling the grace (capped) while the node is unreachable, with one notice per streak", async () => {
    const f = new FakeCluster({ maxRestarts: 10 });
    f.addOffline("a");
    const attemptsAt: number[] = [];
    f.restart = async () => {
      attemptsAt.push(f.now);
      throw new Error("connect ECONNREFUSED 10.0.0.2:7790");
    };

    while (attemptsAt.length < 8) await f.round();
    const gaps = attemptsAt.map((at, i) => (at - (i === 0 ? T0 : attemptsAt[i - 1])) / 1000);
    expect(gaps).toEqual([30, 30, 60, 120, 240, 480, 900, 900]);
    expect(f.notices).toEqual([
      {
        level: "warning",
        message:
          "Node a has been offline for 30 s and does not answer at a.lan:7790: it cannot be restarted from here " +
          "(attempt 1 of 10; next try in 30 s)",
      },
    ]);
    expect(f.health()).toMatchObject({
      state: "offline",
      restarts: 8,
      problem: "unreachable: connect ECONNREFUSED 10.0.0.2:7790",
      nextAttemptAt: f.iso(f.now + 900_000),
    });
  });

  it("pauses after maxRestarts attempts in a row with one error notice", async () => {
    const f = new FakeCluster();
    f.addOffline("a");

    while (f.now < T0 + 3_600_000) await f.round();
    expect(f.restarts).toHaveLength(3);
    const errors = f.notices.filter((n) => n.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/^Auto-healing paused for node a after 3 restart attempts in a row \(/);
    expect(errors[0].message).toContain("healthy for 10 min or the auto-healing settings change");
    expect(f.health()).toMatchObject({ state: "paused", restarts: 3, nextAttemptAt: null });
  });

  it("resumes a paused node when the auto-healing settings change", async () => {
    const f = new FakeCluster();
    f.addOffline("a");
    f.restart = async () => ack("refused", SUPERVISOR_MISSING);

    await f.rounds(3);
    expect(f.restarts).toHaveLength(1);
    expect(f.health().state).toBe("paused");

    f.config.maxRestarts = 4;
    f.restart = async () => ack("restarting");
    await f.round();
    expect(f.restarts).toHaveLength(2);
    expect(f.restarts[1].msg.reason).toBe("offline for 60 s");
    expect(f.health()).toMatchObject({ state: "restarting", restarts: 1 });
  });
});

describe("HealMonitor: pauses", () => {
  it("pauses on a refused restart and resumes after HEAL_STABLE_MS of passing checks", async () => {
    const f = new FakeCluster({ failures: 1 });
    f.addOnline("a");
    f.check = async () => status(false, "database: locked");
    f.restart = async () => ack("refused", SUPERVISOR_MISSING);

    await f.round();
    expect(f.restarts).toHaveLength(1);
    expect(f.health()).toMatchObject({ state: "paused", problem: SUPERVISOR_MISSING, nextAttemptAt: null });
    expect(f.notices).toContainEqual({ level: "warning", message: `Could not restart node a: ${SUPERVISOR_MISSING}` });

    await f.rounds(3);
    expect(f.restarts).toHaveLength(1);

    f.check = async () => status();
    const stableRounds = HEAL_STABLE_MS / f.config.intervalMs;
    await f.rounds(stableRounds);
    expect(f.health()).toMatchObject({ state: "paused", failures: 0 });

    await f.round();
    expect(f.health()).toMatchObject({ state: "ok", restarts: 0, problem: null });

    f.check = async () => status(false, "database: locked");
    f.restart = async () => ack("restarting");
    await f.round();
    expect(f.restarts).toHaveLength(2);
  });

  it("does nothing while turned off and reports every node as off", async () => {
    const f = new FakeCluster({ enabled: false });
    f.addOnline("a");
    f.addOffline("b");
    f.check = async () => status(false, "database: locked");

    await f.rounds(10);
    expect(f.checks).toEqual([]);
    expect(f.restarts).toEqual([]);
    expect(f.notices).toEqual([]);
    expect(f.health("a")).toMatchObject({ state: "off", failures: 0, nextAttemptAt: null });
    expect(f.health("b")).toMatchObject({ state: "off", nextAttemptAt: null });
  });

  it("leaves nodes running a version without auto-healing alone", async () => {
    const f = new FakeCluster({ failures: 1 });
    f.addOnline("a");
    f.addOffline("b");
    for (const node of f.nodes) node.capable = false;
    f.silent.add("a");
    f.check = async () => status(false, "database: locked");

    await f.rounds(20);
    expect(f.checks).toEqual([]);
    expect(f.restarts).toEqual([]);
    expect(f.notices).toEqual([]);
  });
});

describe("HealMonitor.onRegister", () => {
  it("announces a node back from a requested restart and resets its failures, keeping the restart count", async () => {
    const f = new FakeCluster({ failures: 1 });
    f.addOnline("a");
    f.monitor.onRegister("a", { at: BOOT, reason: null });
    f.check = async () => status(false, "database: locked");

    await f.round();
    expect(f.health().state).toBe("restarting");

    expect(f.monitor.onRegister("a", { at: BOOT2, reason: "restart requested" })).toEqual({
      level: "info",
      message: "Node a is back online after an automatic restart",
    });
    expect(f.health()).toMatchObject({ state: "ok", failures: 0, restarts: 1, problem: null, nextAttemptAt: null });
  });

  it("warns when the node was restarted on its machine", () => {
    const f = new FakeCluster();
    f.addOnline("a");
    expect(f.monitor.onRegister("a", { at: BOOT, reason: null })).toBeNull();
    expect(f.monitor.onRegister("a", { at: BOOT2, reason: "crashed (signal SIGKILL, up 5 s)" })).toEqual({
      level: "warning",
      message: "Node a was restarted on its machine (crashed (signal SIGKILL, up 5 s)) and is back online",
    });
  });

  it("keeps the usual notice for a restart that was requested elsewhere or a plain reconnect", () => {
    const f = new FakeCluster();
    f.addOnline("a");
    expect(f.monitor.onRegister("a", { at: BOOT, reason: null })).toBeNull();
    expect(f.monitor.onRegister("a", { at: BOOT2, reason: "restart requested" })).toBeNull();
    expect(f.monitor.onRegister("a", { at: BOOT2, reason: "restart requested" })).toBeNull();
    expect(f.monitor.onRegister("a", undefined)).toBeNull();
  });

  it("does not take a reconnect of the process it asked to restart for the restart", async () => {
    const f = new FakeCluster({ failures: 1 });
    f.addOnline("a");
    f.monitor.onRegister("a", { at: BOOT, reason: "restart requested" });
    f.check = async () => status(false, "database: locked");
    f.restart = async () => {
      throw noReply("heal.restart");
    };

    await f.round();
    expect(f.restarts[0].msg.bootedAt).toBe(BOOT);
    expect(f.monitor.onRegister("a", { at: BOOT, reason: "restart requested" })).toBeNull();
  });
});
