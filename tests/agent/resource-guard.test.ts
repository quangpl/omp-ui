import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RESOURCE_GUARD_CONFIG,
  ResourceGuard,
  parseResourceGuardConfig,
  readResourceGuardConfig,
  type GuardEvent,
  type GuardSample,
  type ResourceGuardConfig,
} from "@/lib/agent/resource-guard";

const ENV_KEYS = [
  "OMP_UI_MEMORY_HOLD_PCT",
  "OMP_UI_MEMORY_RESUME_PCT",
  "OMP_UI_CPU_HOLD_PCT",
  "OMP_UI_CPU_RESUME_PCT",
  "OMP_UI_CPU_SUSTAIN_SEC",
  "OMP_UI_RESOURCE_RESTART_MIN",
];

describe("parseResourceGuardConfig", () => {
  it("uses the defaults when nothing is set", () => {
    expect(parseResourceGuardConfig({})).toEqual({ config: DEFAULT_RESOURCE_GUARD_CONFIG, warnings: [] });
    expect(DEFAULT_RESOURCE_GUARD_CONFIG).toEqual({
      memoryHoldPct: 75,
      memoryResumePct: 65,
      cpuHoldPct: 75,
      cpuResumePct: 65,
      cpuSustainMs: 30_000,
      restartAfterMs: 0,
    });
  });

  it("takes valid overrides", () => {
    expect(
      parseResourceGuardConfig({
        OMP_UI_MEMORY_HOLD_PCT: "80",
        OMP_UI_MEMORY_RESUME_PCT: "70",
        OMP_UI_CPU_HOLD_PCT: " 90 ",
        OMP_UI_CPU_RESUME_PCT: "50",
        OMP_UI_CPU_SUSTAIN_SEC: "60",
        OMP_UI_RESOURCE_RESTART_MIN: "10",
      }),
    ).toEqual({
      config: {
        memoryHoldPct: 80,
        memoryResumePct: 70,
        cpuHoldPct: 90,
        cpuResumePct: 50,
        cpuSustainMs: 60_000,
        restartAfterMs: 600_000,
      },
      warnings: [],
    });
  });

  it("defaults each resume % to its hold − 10", () => {
    const { config, warnings } = parseResourceGuardConfig({ OMP_UI_MEMORY_HOLD_PCT: "50", OMP_UI_CPU_HOLD_PCT: "85" });
    expect(config).toMatchObject({ memoryHoldPct: 50, memoryResumePct: 40, cpuHoldPct: 85, cpuResumePct: 75 });
    expect(warnings).toEqual([]);
  });

  it("rejects a resume % at or above its hold % with a warning", () => {
    const { config, warnings } = parseResourceGuardConfig({
      OMP_UI_MEMORY_HOLD_PCT: "60",
      OMP_UI_MEMORY_RESUME_PCT: "60",
      OMP_UI_CPU_RESUME_PCT: "90",
    });
    expect(config).toMatchObject({ memoryHoldPct: 60, memoryResumePct: 50, cpuHoldPct: 75, cpuResumePct: 65 });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("OMP_UI_MEMORY_RESUME_PCT");
    expect(warnings[1]).toContain("OMP_UI_CPU_RESUME_PCT");
  });

  it("replaces non-numeric and out-of-range values with the default and warns", () => {
    const { config, warnings } = parseResourceGuardConfig({
      OMP_UI_MEMORY_HOLD_PCT: "abc",
      OMP_UI_CPU_HOLD_PCT: "150",
      OMP_UI_CPU_SUSTAIN_SEC: "2",
      OMP_UI_RESOURCE_RESTART_MIN: "-1",
    });
    expect(config).toEqual(DEFAULT_RESOURCE_GUARD_CONFIG);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain('OMP_UI_MEMORY_HOLD_PCT="abc"');
    expect(warnings[1]).toContain('OMP_UI_CPU_HOLD_PCT="150"');
    expect(warnings.join("\n")).toContain('OMP_UI_CPU_SUSTAIN_SEC="2"');
    expect(warnings.join("\n")).toContain('OMP_UI_RESOURCE_RESTART_MIN="-1"');
  });

  it("requires whole restart minutes and a resume % of at least 1", () => {
    const { config, warnings } = parseResourceGuardConfig({
      OMP_UI_MEMORY_RESUME_PCT: "0",
      OMP_UI_RESOURCE_RESTART_MIN: "1.5",
    });
    expect(config).toEqual(DEFAULT_RESOURCE_GUARD_CONFIG);
    expect(warnings).toEqual([
      'OMP_UI_MEMORY_RESUME_PCT="0" is not a number from 1 to 100 — using 65.',
      'OMP_UI_RESOURCE_RESTART_MIN="1.5" is not a whole number from 0 to 1440 — using 0.',
    ]);
  });

  it("turns a guard off with a hold of 0", () => {
    const { config, warnings } = parseResourceGuardConfig({ OMP_UI_MEMORY_HOLD_PCT: "0", OMP_UI_CPU_HOLD_PCT: "0" });
    expect(config).toMatchObject({ memoryHoldPct: 0, cpuHoldPct: 0 });
    expect(warnings).toEqual([]);
  });
});

describe("readResourceGuardConfig", () => {
  let dir: string;
  let envFile: string;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-resource-guard-"));
    envFile = path.join(dir, ".env");
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prefers a .env value over process.env, which beats the default", () => {
    process.env.OMP_UI_MEMORY_HOLD_PCT = "90";
    process.env.OMP_UI_CPU_HOLD_PCT = "70";
    fs.writeFileSync(envFile, "# guard\nOMP_UI_MEMORY_HOLD_PCT=80\n");
    expect(readResourceGuardConfig(envFile).config).toMatchObject({ memoryHoldPct: 80, cpuHoldPct: 70 });
  });

  it("unquotes values and strips trailing comments", () => {
    fs.writeFileSync(
      envFile,
      ['export OMP_UI_CPU_HOLD_PCT="85"', "OMP_UI_MEMORY_HOLD_PCT='70'", "OMP_UI_CPU_SUSTAIN_SEC=60 # one minute"].join(
        "\n",
      ),
    );
    expect(readResourceGuardConfig(envFile)).toEqual({
      config: {
        ...DEFAULT_RESOURCE_GUARD_CONFIG,
        memoryHoldPct: 70,
        memoryResumePct: 60,
        cpuHoldPct: 85,
        cpuResumePct: 75,
        cpuSustainMs: 60_000,
      },
      warnings: [],
    });
  });

  it("picks up an edited .env on the next call", () => {
    fs.writeFileSync(envFile, "OMP_UI_MEMORY_HOLD_PCT=80\n");
    fs.utimesSync(envFile, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    expect(readResourceGuardConfig(envFile).config.memoryHoldPct).toBe(80);
    fs.writeFileSync(envFile, "OMP_UI_MEMORY_HOLD_PCT=60\n");
    fs.utimesSync(envFile, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    expect(readResourceGuardConfig(envFile).config).toMatchObject({ memoryHoldPct: 60, memoryResumePct: 50 });
  });

  it("falls back to process.env without a .env file", () => {
    process.env.OMP_UI_MEMORY_HOLD_PCT = "55";
    expect(readResourceGuardConfig(envFile).config).toMatchObject({ memoryHoldPct: 55, memoryResumePct: 45 });
  });

  it("lets a key removed from .env take the default, not the copy the CLI made at launch", () => {
    process.env.OMP_UI_MEMORY_HOLD_PCT = "80"; // the CLI's launch-time copy of the .env value
    process.env.OMP_UI_CPU_HOLD_PCT = "70"; // set only in the environment
    fs.writeFileSync(envFile, "OMP_UI_MEMORY_HOLD_PCT=80\n");
    fs.utimesSync(envFile, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    expect(readResourceGuardConfig(envFile).config).toMatchObject({ memoryHoldPct: 80, cpuHoldPct: 70 });

    fs.writeFileSync(envFile, "# OMP_UI_MEMORY_HOLD_PCT=80\n");
    fs.utimesSync(envFile, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    expect(readResourceGuardConfig(envFile)).toEqual({
      config: { ...DEFAULT_RESOURCE_GUARD_CONFIG, cpuHoldPct: 70, cpuResumePct: 60 },
      warnings: [],
    });
  });

  it("does not throw on an unreadable .env: no file values and a warning", () => {
    process.env.OMP_UI_CPU_HOLD_PCT = "70";
    const { config, warnings } = readResourceGuardConfig(dir); // a directory
    expect(config).toEqual({ ...DEFAULT_RESOURCE_GUARD_CONFIG, cpuHoldPct: 70, cpuResumePct: 60 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^cannot read .+: .+ — using the last good thresholds\.$/);
    expect(warnings[0]).toContain(dir);
  });

  it("keeps the last good .env values once the file becomes unreadable", () => {
    fs.writeFileSync(envFile, "OMP_UI_MEMORY_HOLD_PCT=80\n");
    expect(readResourceGuardConfig(envFile).config.memoryHoldPct).toBe(80);
    fs.rmSync(envFile);
    fs.mkdirSync(envFile);
    const { config, warnings } = readResourceGuardConfig(envFile);
    expect(config).toMatchObject({ memoryHoldPct: 80, memoryResumePct: 70 });
    expect(warnings).toEqual([expect.stringContaining(`cannot read ${envFile}: `)]);
  });
});

const T0 = Date.parse("2026-11-15T10:00:00Z");
const STEP_MS = 5_000;
const CONFIG = DEFAULT_RESOURCE_GUARD_CONFIG;

/** A synthetic machine: each sample is STEP_MS after the previous one, at the given busy CPU %. */
function machine() {
  let at = T0 - STEP_MS;
  let idle = 0;
  let total = 0;
  return (memoryPercent: number, cpuBusyPercent: number, stepMs = STEP_MS): GuardSample => {
    at += stepMs;
    total += stepMs;
    idle += stepMs * (1 - cpuBusyPercent / 100);
    return { at, memoryPercent, cpu: { idle, total } };
  };
}

/** Feeds `count` identical samples; returns the last event. */
function feed(
  guard: ResourceGuard,
  sample: () => GuardSample,
  count: number,
  config: ResourceGuardConfig = CONFIG,
): GuardEvent | null {
  let event: GuardEvent | null = null;
  for (let i = 0; i < count; i++) event = guard.update(sample(), config);
  return event;
}

describe("ResourceGuard", () => {
  it("has no reading before the first sample", () => {
    expect(new ResourceGuard().pressure()).toBeNull();
  });

  it("holds on memory at the hold % and resumes only below the resume %", () => {
    const guard = new ResourceGuard();
    const next = machine();
    expect(guard.update(next(74, 0), CONFIG)).toBeNull();
    expect(guard.pressure()).toMatchObject({ holding: [], heldSince: null, cpuPercent: null });

    const hold = guard.update(next(75, 0), CONFIG);
    expect(hold).toMatchObject({ kind: "hold", pressure: { holding: ["memory"], memoryPercent: 75 } });
    expect(guard.pressure()?.heldSince).toBe(new Date(T0 + STEP_MS).toISOString());

    // Hysteresis: below the hold % but not below the resume %, still held.
    expect(guard.update(next(70, 0), CONFIG)).toBeNull();
    expect(guard.pressure()?.holding).toEqual(["memory"]);
    expect(guard.update(next(65, 0), CONFIG)).toBeNull();

    const resume = guard.update(next(64.9, 0), CONFIG);
    expect(resume).toEqual({
      kind: "resume",
      heldMs: 3 * STEP_MS,
      pressure: expect.objectContaining({ holding: [], heldSince: null }),
    });
  });

  it("does not hold on CPU before the sustain window is full, even at 100%", () => {
    const guard = new ResourceGuard();
    const next = machine();
    // Baseline plus 5 steps: 25 s of a 30 s window.
    expect(feed(guard, () => next(10, 100), 6)).toBeNull();
    expect(guard.pressure()).toMatchObject({ holding: [], cpuPercent: 100, cpuWindowSec: 25 });

    const hold = guard.update(next(10, 100), CONFIG);
    expect(hold).toMatchObject({ kind: "hold", pressure: { holding: ["cpu"], cpuPercent: 100, cpuWindowSec: 30 } });
  });

  it("resumes CPU once the window average drops below the resume %", () => {
    const guard = new ResourceGuard();
    const next = machine();
    expect(feed(guard, () => next(10, 100), 7)?.kind).toBe("hold");

    // The window holds six 5 s steps: one idle step → 83%, two → 67% (still ≥ 65%), three → 50%.
    expect(guard.update(next(10, 0), CONFIG)).toBeNull();
    expect(guard.pressure()?.cpuPercent).toBeCloseTo(83.33, 1);
    expect(guard.update(next(10, 0), CONFIG)).toBeNull();
    expect(guard.pressure()).toMatchObject({ holding: ["cpu"], cpuWindowSec: 30 });
    expect(guard.pressure()?.cpuPercent).toBeCloseTo(66.67, 1);

    const resume = guard.update(next(10, 0), CONFIG);
    expect(resume).toMatchObject({ kind: "resume", heldMs: 3 * STEP_MS, pressure: { holding: [], cpuPercent: 50 } });
  });

  it("reports hold, change and resume as the held resources change", () => {
    const guard = new ResourceGuard();
    const next = machine();
    const events: GuardEvent[] = [];
    const record = (memoryPercent: number, cpuBusyPercent: number, count: number) => {
      for (let i = 0; i < count; i++) {
        const event = guard.update(next(memoryPercent, cpuBusyPercent), CONFIG);
        if (event) events.push(event);
      }
    };
    record(80, 100, 7); // memory at once, CPU when the window is full
    record(50, 100, 1); // memory released, CPU still held
    record(50, 0, 6); // CPU released

    expect(events.map((e) => [e.kind, e.pressure.holding])).toEqual([
      ["hold", ["memory"]],
      ["change", ["memory", "cpu"]],
      ["change", ["cpu"]],
      ["resume", []],
    ]);
    // Held from the first sample until the third idle CPU step (sample 10).
    expect(events[3]).toMatchObject({ kind: "resume", heldMs: 10 * STEP_MS });
    expect(events[2].pressure.heldSince).toBe(new Date(T0).toISOString());
  });

  it("flags a pending restart only after restartAfterMs, and never when it is 0", () => {
    const config = { ...CONFIG, restartAfterMs: 60_000 };
    const guard = new ResourceGuard();
    const next = machine();
    expect(guard.update(next(90, 0), config)?.kind).toBe("hold");
    expect(guard.pressure()).toMatchObject({ restartPending: false, restartAfterMin: 1 });
    feed(guard, () => next(90, 0), 11, config); // 55 s held
    expect(guard.pressure()?.restartPending).toBe(false);
    feed(guard, () => next(90, 0), 1, config); // 60 s held
    expect(guard.pressure()?.restartPending).toBe(true);

    const off = new ResourceGuard();
    const other = machine();
    off.update(other(90, 0), CONFIG);
    off.update(other(90, 0, 3_600_000), CONFIG);
    expect(off.pressure()).toMatchObject({ holding: ["memory"], restartPending: false, restartAfterMin: 0 });
  });

  it("flags a pending restart only for memory pressure, timed from the memory hold", () => {
    const config = { ...CONFIG, restartAfterMs: 60_000 };
    const guard = new ResourceGuard();
    const next = machine();
    // CPU held from the 7th sample (full window) for well over a minute: never pending.
    expect(feed(guard, () => next(10, 100), 7, config)?.kind).toBe("hold");
    feed(guard, () => next(10, 100), 20, config);
    expect(guard.pressure()).toMatchObject({ holding: ["cpu"], restartPending: false });
    expect(guard.memoryHeldSince()).toBeNull();

    // Memory joins: pending a minute after the memory hold began, not the CPU hold.
    const change = guard.update(next(90, 100), config);
    expect(change).toMatchObject({ kind: "change", pressure: { holding: ["memory", "cpu"], restartPending: false } });
    expect(guard.memoryHeldSince()).toBe(Date.parse(change?.pressure.sampledAt ?? ""));
    feed(guard, () => next(90, 100), 11, config); // 55 s
    expect(guard.pressure()?.restartPending).toBe(false);
    feed(guard, () => next(90, 100), 1, config); // 60 s
    expect(guard.pressure()?.restartPending).toBe(true);

    // Memory released while CPU still holds: no longer pending.
    expect(guard.update(next(50, 100), config)).toMatchObject({
      kind: "change",
      pressure: { holding: ["cpu"], restartPending: false },
    });
    expect(guard.memoryHeldSince()).toBeNull();
  });

  it("applies a lowered hold % on the next sample", () => {
    const guard = new ResourceGuard();
    const next = machine();
    expect(guard.update(next(50, 0), CONFIG)).toBeNull();
    const lowered = { ...CONFIG, memoryHoldPct: 40, memoryResumePct: 30 };
    expect(guard.update(next(50, 0), lowered)).toMatchObject({
      kind: "hold",
      pressure: { holding: ["memory"], memoryHoldPct: 40, memoryResumePct: 30 },
    });
  });

  it("releases a hold when its guard is turned off", () => {
    const guard = new ResourceGuard();
    const next = machine();
    expect(guard.update(next(90, 0), CONFIG)?.kind).toBe("hold");
    expect(guard.update(next(90, 0), { ...CONFIG, memoryHoldPct: 0 })).toMatchObject({
      kind: "resume",
      heldMs: STEP_MS,
      pressure: { holding: [], memoryHoldPct: 0 },
    });
  });
});
