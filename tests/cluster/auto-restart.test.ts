import { describe, expect, it } from "vitest";

import {
  autoRestartConfigFrom,
  autoRestartWaitMs,
  BACKOFF_MAX_MS,
  decideAutoRestart,
  FAILOVER_GRACE_MS,
  type AutoRestartConfig,
  type AutoRestartInput,
} from "@/lib/cluster/auto-restart";
import { DEFAULT_SETTINGS } from "@/lib/types";

/** Watchdog settings: 5 min after a 20 s failover unless a test overrides them. */
function config(overrides: Partial<typeof DEFAULT_SETTINGS> = {}): AutoRestartConfig {
  return autoRestartConfigFrom({
    ...DEFAULT_SETTINGS,
    clusterAutoRestart: true,
    clusterRestartAfterSeconds: 300,
    clusterFailoverSeconds: 20,
    ...overrides,
  });
}

const NOW = Date.parse("2026-11-15T12:00:00.000Z");

/** One watchdog check of a supervised replica that has been unlinked for `downMs`. */
function input(downMs: number, overrides: Partial<AutoRestartInput> = {}): AutoRestartInput {
  return {
    config: config(),
    connected: false,
    unlinkedSince: NOW - downMs,
    now: NOW,
    restarts: 0,
    supervised: true,
    primary: "primary-1",
    error: "connect ECONNREFUSED 10.0.0.1:7790",
    ...overrides,
  };
}

describe("autoRestartWaitMs", () => {
  it("waits clusterRestartAfterSeconds when it exceeds the failover time plus the grace", () => {
    expect(autoRestartWaitMs(config(), 0)).toBe(300_000);
  });

  it("raises a shorter setting to the failover time plus the grace", () => {
    const short = config({ clusterRestartAfterSeconds: 60, clusterFailoverSeconds: 120 });
    expect(autoRestartWaitMs(short, 0)).toBe(120_000 + FAILOVER_GRACE_MS);
  });

  it("doubles the wait for every restart in a row", () => {
    expect(autoRestartWaitMs(config(), 1)).toBe(600_000);
    expect(autoRestartWaitMs(config(), 2)).toBe(1_200_000);
    expect(autoRestartWaitMs(config(), 3)).toBe(2_400_000);
  });

  it("caps the doubling at one hour", () => {
    expect(autoRestartWaitMs(config(), 4)).toBe(BACKOFF_MAX_MS);
    expect(autoRestartWaitMs(config(), 50)).toBe(BACKOFF_MAX_MS);
  });

  it("keeps a base wait longer than one hour without doubling it", () => {
    const long = config({ clusterRestartAfterSeconds: 7_200 });
    expect(autoRestartWaitMs(long, 0)).toBe(7_200_000);
    expect(autoRestartWaitMs(long, 3)).toBe(7_200_000);
  });
});

describe("decideAutoRestart", () => {
  it("waits when the watchdog is disabled", () => {
    const disabled = config({ clusterAutoRestart: false });
    expect(decideAutoRestart(input(10 * 3_600_000, { config: disabled }))).toEqual({ action: "wait" });
  });

  it("waits while a session with the primary is up", () => {
    expect(decideAutoRestart(input(10 * 3_600_000, { connected: true }))).toEqual({ action: "wait" });
  });

  it("waits until the link has been down for the wait", () => {
    expect(decideAutoRestart(input(299_000))).toEqual({ action: "wait" });
    expect(decideAutoRestart(input(300_000, { restarts: 1 }))).toEqual({ action: "wait" });
  });

  it("restarts a supervised node once due, naming the primary, the time and the last error", () => {
    expect(decideAutoRestart(input(300_000))).toEqual({
      action: "restart",
      reason: "no connection to the primary primary-1 for 5 min (last error: connect ECONNREFUSED 10.0.0.1:7790)",
    });
  });

  it("leaves the last error out when there is none", () => {
    expect(decideAutoRestart(input(300_000, { error: null }))).toEqual({
      action: "restart",
      reason: "no connection to the primary primary-1 for 5 min",
    });
  });

  it("reports short outages in seconds", () => {
    const short = config({ clusterRestartAfterSeconds: 60, clusterFailoverSeconds: 30 });
    const decision = decideAutoRestart(input(90_000, { config: short, error: null }));
    expect(decision).toEqual({ action: "restart", reason: "no connection to the primary primary-1 for 90 s" });
  });

  it("only gives a notice when the supervisor would not bring the node back", () => {
    expect(decideAutoRestart(input(300_000, { supervised: false }))).toEqual({
      action: "notice",
      reason: "no connection to the primary primary-1 for 5 min (last error: connect ECONNREFUSED 10.0.0.1:7790)",
    });
  });

  it("says 'a primary' when the node knows none", () => {
    const decision = decideAutoRestart(input(300_000, { primary: null, error: null }));
    expect(decision).toEqual({ action: "restart", reason: "no connection to a primary for 5 min" });
  });
});
