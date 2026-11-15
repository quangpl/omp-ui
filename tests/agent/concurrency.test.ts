import { describe, expect, it } from "vitest";

import {
  AGENT_MEMORY_BYTES,
  AgentMemoryModel,
  committedMemoryBytes,
  loadGuardHold,
  MAX_AGENT_MEMORY_BYTES,
  MIN_AGENT_MEMORY_BYTES,
  readLoadHold,
  resolveConcurrency,
  resourcePressureReason,
  subagentConcurrency,
  type MachineResources,
  type SubagentBudgetInput,
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

const MB = 1024 ** 2;

function model(...peaks: number[]): AgentMemoryModel {
  const m = new AgentMemoryModel();
  for (const peak of peaks) m.record(peak);
  return m;
}

describe("AgentMemoryModel", () => {
  it("answers the default until three runs finished", () => {
    expect(model().estimate()).toBe(AGENT_MEMORY_BYTES);
    expect(model(2 * GB, 2 * GB).estimate()).toBe(AGENT_MEMORY_BYTES);
    expect(model(2 * GB, 2 * GB, 2 * GB).estimate()).toBe(2 * GB);
  });

  it("ignores non-finite and non-positive readings", () => {
    const m = model(Number.NaN, Number.POSITIVE_INFINITY, 0, -GB, GB);
    expect(m.samples).toBe(1);
    expect(m.estimate()).toBe(AGENT_MEMORY_BYTES);
  });

  it("uses the nearest-rank 75th percentile, so one heavy run does not dominate", () => {
    expect(model(4 * GB, 1 * GB, 3 * GB, 2 * GB).estimate()).toBe(3 * GB);
    expect(model(500 * MB, 500 * MB, 500 * MB, 500 * MB, 3 * GB).estimate()).toBe(500 * MB);
  });

  it("clamps the estimate to the bounds", () => {
    expect(model(50 * MB, 60 * MB, 70 * MB).estimate()).toBe(MIN_AGENT_MEMORY_BYTES);
    expect(model(8 * GB, 9 * GB, 10 * GB).estimate()).toBe(MAX_AGENT_MEMORY_BYTES);
  });

  it("keeps only the last WINDOW peaks", () => {
    const m = model(...Array<number>(AgentMemoryModel.WINDOW).fill(3 * GB), ...Array<number>(5).fill(GB));
    expect(m.samples).toBe(AgentMemoryModel.WINDOW);
    // 15 heavy + 5 light peaks: the 75th percentile is still heavy.
    expect(m.estimate()).toBe(3 * GB);
    for (let i = 0; i < 10; i++) m.record(GB);
    // 5 heavy + 15 light: the oldest heavy peaks dropped out of the window.
    expect(m.samples).toBe(AgentMemoryModel.WINDOW);
    expect(m.estimate()).toBe(GB);
  });
});

describe("committedMemoryBytes", () => {
  it("counts unsampled agents in full and only the missing part of growing ones", () => {
    expect(committedMemoryBytes(GB, [null, 256 * MB, 2 * GB])).toBe(GB + 768 * MB);
  });

  it("is zero without running agents or when all outgrew the estimate", () => {
    expect(committedMemoryBytes(GB, [])).toBe(0);
    expect(committedMemoryBytes(GB, [GB, 3 * GB])).toBe(0);
  });
});

describe("resolveConcurrency with a memory plan", () => {
  /** 16 cores, 8 GB free of 10 GB (a 1 GB reserve): memory bounds the automatic limit. */
  const SMALL: MachineResources = { cpus: 16, freeMemoryBytes: 8 * GB, totalMemoryBytes: 10 * GB };

  it("defaults to the fixed estimate and reports it", () => {
    expect(resolveConcurrency("auto", 2, MACHINE)).toMatchObject({
      limit: 8,
      boundBy: "cpu",
      reason: "Auto: 8 parallel (8 cores, 30 GB free, ~0.6 GB per agent)",
      agentMemoryBytes: AGENT_MEMORY_BYTES,
      committedMemoryBytes: 0,
    });
    // 7 GB spare / 600 MB = 11 more agents beside the 2 running.
    expect(resolveConcurrency("auto", 2, SMALL)).toMatchObject({ limit: 13, boundBy: "memory" });
  });

  it("subtracts the memory committed to just-launched runs", () => {
    const plan = { perAgentBytes: GB, committedBytes: committedMemoryBytes(GB, [null, null]) };
    expect(resolveConcurrency("auto", 2, SMALL, null, null, 0, { perAgentBytes: GB, committedBytes: 0 }).limit).toBe(9);
    expect(resolveConcurrency("auto", 2, SMALL, null, null, 0, plan)).toMatchObject({
      limit: 7,
      boundBy: "memory",
      reason: "Auto: 7 parallel (16 cores, 8 GB free, ~1 GB per agent, limited by memory)",
      agentMemoryBytes: GB,
      committedMemoryBytes: 2 * GB,
    });
  });

  it("never drops below the running agents (or 1) when the commitment exceeds free memory", () => {
    const plan = { perAgentBytes: GB, committedBytes: 100 * GB };
    expect(resolveConcurrency("auto", 3, SMALL, null, null, 0, plan)).toMatchObject({ limit: 3, boundBy: "memory" });
    expect(resolveConcurrency("auto", 0, SMALL, null, null, 0, plan).limit).toBe(1);
  });

  it("leaves manual mode alone and reports no memory estimate there", () => {
    const plan = { perAgentBytes: 4 * GB, committedBytes: 6 * GB };
    const manual = resolveConcurrency(6, 2, SMALL, null, null, 0, plan);
    expect(manual).toEqual(resolveConcurrency(6, 2, SMALL));
    expect(manual).toMatchObject({ mode: "manual", limit: 6, reason: "Manual: 6 parallel" });
    expect(manual).not.toHaveProperty("agentMemoryBytes");
    expect(manual).not.toHaveProperty("committedMemoryBytes");
  });

  it("still caps at the running agents minus lent slots under a hold", () => {
    const plan = { perAgentBytes: 300 * MB, committedBytes: 0 };
    expect(resolveConcurrency("auto", 4, SMALL, loadGuardHold(40, 16, 150), null, 1, plan)).toMatchObject({
      limit: 3,
      boundBy: "load",
      agentMemoryBytes: 300 * MB,
    });
    expect(resolveConcurrency("auto", 4, SMALL, null, pressure(["memory"]), 1, plan)).toMatchObject({
      limit: 3,
      boundBy: "resources",
    });
  });
});

describe("subagentConcurrency", () => {
  const ROOMY: SubagentBudgetInput = {
    ceiling: 32,
    cpus: 16,
    freeMemoryBytes: 30 * GB,
    totalMemoryBytes: 32 * GB,
    runningAgents: 1,
  };

  it("is bound by the cores, shared among the running agents", () => {
    expect(subagentConcurrency({ ...ROOMY, cpus: 4 })).toBe(8);
    expect(subagentConcurrency({ ...ROOMY, cpus: 4, runningAgents: 3 })).toBe(2);
  });

  it("is bound by the free memory beyond the reserve", () => {
    // 3 GB free − 1 GB reserve = 2 GB = 10.7 subagents, shared by 2 agents: 5 each.
    const tight = { ...ROOMY, freeMemoryBytes: 3 * GB, totalMemoryBytes: 10 * GB, runningAgents: 2 };
    expect(subagentConcurrency(tight)).toBe(5);
  });

  it("is bound by the ceiling", () => {
    expect(subagentConcurrency({ ...ROOMY, ceiling: 4 })).toBe(4);
    expect(subagentConcurrency({ ...ROOMY, ceiling: 0 })).toBe(1);
  });

  it("allows one subagent on a saturated machine", () => {
    const saturated = { ...ROOMY, cpus: 4, freeMemoryBytes: GB, totalMemoryBytes: 16 * GB, runningAgents: 20 };
    expect(subagentConcurrency(saturated)).toBe(1);
  });

  it("treats no running agents as one", () => {
    expect(subagentConcurrency({ ...ROOMY, cpus: 3, runningAgents: 0 })).toBe(6);
  });

  it("falls back safely on non-finite readings", () => {
    expect(subagentConcurrency({ ...ROOMY, cpus: Number.NaN })).toBe(1);
    expect(subagentConcurrency({ ...ROOMY, freeMemoryBytes: Number.NaN })).toBe(1);
    expect(subagentConcurrency({ ...ROOMY, ceiling: Number.POSITIVE_INFINITY })).toBe(1);
    expect(subagentConcurrency({ ...ROOMY, cpus: 4, runningAgents: Number.NaN })).toBe(8);
    expect(subagentConcurrency({ ...ROOMY, cpus: 4, totalMemoryBytes: Number.NaN })).toBe(8);
  });
});
