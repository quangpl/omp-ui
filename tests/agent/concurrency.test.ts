import { describe, expect, it } from "vitest";

import { loadGuardHold, readLoadHold, resolveConcurrency, type MachineResources } from "@/lib/agent/concurrency";

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
