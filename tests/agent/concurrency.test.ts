import { describe, expect, it } from "vitest";

import {
  loadGuardHold,
  readLoadHold,
  resolveConcurrency,
  resourcePressureReason,
  type MachineResources,
} from "@/lib/agent/concurrency";
import type { PressureResource, ResourcePressure } from "@/lib/types";

const GB = 1024 ** 3;
/** 8 cores and plenty of free memory: an automatic limit of 8, bound by the cores. */
const MACHINE: MachineResources = { cpus: 8, freeMemoryBytes: 30 * GB, totalMemoryBytes: 32 * GB };

describe("loadGuardHold", () => {
  it("holds when the load per core exceeds the threshold", () => {
    expect(loadGuardHold(12.3, 8, 150)).toEqual({ load: 12.3, cores: 8, percent: 153.75, threshold: 150 });
  });

  it("does not hold at or below the threshold", () => {
    expect(loadGuardHold(4, 8, 150)).toBeNull();
    expect(loadGuardHold(12, 8, 150)).toBeNull();
  });

  it("never holds with zero cores or a non-finite load", () => {
    expect(loadGuardHold(100, 0, 150)).toBeNull();
    expect(loadGuardHold(Number.NaN, 8, 150)).toBeNull();
  });

  it("never holds on Windows, where the load average is always zero", () => {
    expect(loadGuardHold(0, 8, 10)).toBeNull();
  });
});

describe("readLoadHold", () => {
  const overloaded = () => ({ loadAvg1: 40, cpuCount: 8 });

  it("does not sample the machine when the guard is off", () => {
    let sampled = false;
    const hold = readLoadHold({ loadGuard: false, loadGuardPercent: 150 }, () => {
      sampled = true;
      return overloaded();
    });
    expect(hold).toBeNull();
    expect(sampled).toBe(false);
  });

  it("samples the machine when the guard is on", () => {
    expect(readLoadHold({ loadGuard: true, loadGuardPercent: 150 }, overloaded)).toMatchObject({ percent: 500 });
    expect(readLoadHold({ loadGuard: true, loadGuardPercent: 600 }, overloaded)).toBeNull();
  });
});

describe("resolveConcurrency with the load guard", () => {
  const hold = loadGuardHold(12.3, 8, 150);

  it("is unchanged without a hold", () => {
    expect(resolveConcurrency("auto", 2, MACHINE)).toEqual(resolveConcurrency("auto", 2, MACHINE, null));
    expect(resolveConcurrency("auto", 2, MACHINE, null)).toMatchObject({ mode: "auto", limit: 8, boundBy: "cpu" });
    expect(resolveConcurrency(4, 2, MACHINE, null)).toMatchObject({ mode: "manual", limit: 4, boundBy: null });
  });

  it("caps an automatic limit at the running agents and says why", () => {
    expect(resolveConcurrency("auto", 3, MACHINE, hold)).toMatchObject({
      mode: "auto",
      limit: 3,
      boundBy: "load",
      reason: "Load guard: holding new runs (load 12.3 on 8 cores = 154 % > 150 %)",
    });
  });

  it("caps a manual limit at the running agents", () => {
    expect(resolveConcurrency(4, 1, MACHINE, hold)).toMatchObject({ mode: "manual", limit: 1, boundBy: "load" });
  });

  it("starts nothing when no agent runs, and keeps a limit already below the running agents", () => {
    expect(resolveConcurrency("auto", 0, MACHINE, hold).limit).toBe(0);
    // More agents run than the limit allows (it was lowered meanwhile): the guard does not raise it.
    expect(resolveConcurrency(2, 5, MACHINE, hold).limit).toBe(2);
  });
});

/** A resource guard reading at the default thresholds (hold 75 %, resume 65 %, 30 s CPU window). */
function pressure(holding: PressureResource[], memoryPercent = 78.4, cpuPercent: number | null = 82): ResourcePressure {
  return {
    memoryPercent,
    cpuPercent,
    cpuWindowSec: 30,
    memoryHoldPct: 75,
    memoryResumePct: 65,
    cpuHoldPct: 75,
    cpuResumePct: 65,
    cpuSustainSec: 30,
    holding,
    heldSince: holding.length ? "2026-11-15T10:00:00.000Z" : null,
    restartAfterMin: 0,
    restartPending: false,
    sampledAt: "2026-11-15T10:00:30.000Z",
  };
}

describe("resolveConcurrency with resource pressure", () => {
  it("caps an automatic limit at the running agents and says why", () => {
    const memory = pressure(["memory"]);
    expect(resolveConcurrency("auto", 3, MACHINE, null, memory)).toEqual({
      ...resolveConcurrency("auto", 3, MACHINE),
      limit: 3,
      boundBy: "resources",
      reason: "Resource pressure: memory at 78% (resumes below 65%) — holding queued cards",
      pressure: memory,
    });
  });

  it("caps a manual limit at the running agents and lists every held resource", () => {
    expect(resolveConcurrency(4, 1, MACHINE, null, pressure(["memory", "cpu"]))).toMatchObject({
      mode: "manual",
      limit: 1,
      boundBy: "resources",
      reason:
        "Resource pressure: memory at 78% (resumes below 65%), CPU at 82% over 30 s (resumes below 65%) — " +
        "holding queued cards",
    });
    expect(resolveConcurrency("auto", 0, MACHINE, null, pressure(["cpu"])).limit).toBe(0);
  });

  it("wins over a load hold", () => {
    const hold = loadGuardHold(12.3, 8, 150);
    expect(resolveConcurrency("auto", 2, MACHINE, hold, pressure(["cpu"]))).toMatchObject({
      limit: 2,
      boundBy: "resources",
      reason: resourcePressureReason(pressure(["cpu"])),
    });
  });

  it("leaves the limit alone when not holding, but attaches the reading", () => {
    const calm = pressure([], 40, 20);
    expect(resolveConcurrency("auto", 2, MACHINE, null, calm)).toEqual({
      ...resolveConcurrency("auto", 2, MACHINE),
      pressure: calm,
    });
    expect(resolveConcurrency("auto", 2, MACHINE, null, calm)).toMatchObject({ limit: 8, boundBy: "cpu" });
  });

  it("sets pressure to null when none is given", () => {
    expect(resolveConcurrency("auto", 2, MACHINE).pressure).toBeNull();
    expect(resolveConcurrency(4, 2, MACHINE, loadGuardHold(12.3, 8, 150)).pressure).toBeNull();
  });

  it("is strict: lent slots of runs waiting on cards do not launch anything under a hold", () => {
    const holding = pressure(["memory"]);
    expect(resolveConcurrency("auto", 4, MACHINE, null, holding, 1)).toMatchObject({ limit: 3, boundBy: "resources" });
    expect(resolveConcurrency("auto", 4, MACHINE, loadGuardHold(12.3, 8, 150), null, 1)).toMatchObject({
      limit: 3,
      boundBy: "load",
    });
    expect(resolveConcurrency("auto", 1, MACHINE, null, holding, 2).limit).toBe(0);
  });

  it("ignores lent slots when not holding", () => {
    expect(resolveConcurrency("auto", 4, MACHINE, null, pressure([], 40, 20), 1)).toEqual(
      resolveConcurrency("auto", 4, MACHINE, null, pressure([], 40, 20)),
    );
    expect(resolveConcurrency(4, 4, MACHINE, null, null, 2)).toMatchObject({ limit: 4, boundBy: null });
  });
});
