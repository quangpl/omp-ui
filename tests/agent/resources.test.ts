import { describe, expect, it } from "vitest";

import { nextResources, parseProcStat, treeTotals, type ProcessSample } from "@/lib/agent/resources";
import type { AgentResources } from "@/lib/types";

/** A `/proc/<pid>/stat` line: utime/stime/cutime/cstime and rss (pages) at their real field positions. */
function statLine(pid: number, comm: string, ppid: number, cpu: [number, number, number, number], rss: number): string {
  const rest = ["S", String(ppid), ...Array<string>(9).fill("0"), ...cpu.map(String)];
  rest.push(...Array<string>(21 - rest.length).fill("0"), String(rss), "18446744073709551615", "1", "1");
  return `${pid} (${comm}) ${rest.join(" ")}\n`;
}

function proc(pid: number, ppid: number, rssBytes: number, cpuSeconds: number): ProcessSample {
  return { pid, ppid, rssBytes, cpuSeconds };
}

describe("parseProcStat", () => {
  it("reads pid, ppid, CPU ticks and RSS pages", () => {
    const sample = parseProcStat(statLine(42, "omp", 7, [150, 50, 30, 20], 1000), 100, 4096);
    expect(sample).toEqual({ pid: 42, ppid: 7, rssBytes: 1000 * 4096, cpuSeconds: 2.5 });
  });

  it("splits after the last ')' when the command name has spaces and parentheses", () => {
    const sample = parseProcStat(statLine(9, "my (weird) cmd) x", 3, [100, 100, 0, 0], 10), 100, 4096);
    expect(sample).toEqual({ pid: 9, ppid: 3, rssBytes: 40960, cpuSeconds: 2 });
  });

  it("returns null for malformed input", () => {
    expect(parseProcStat("", 100, 4096)).toBeNull();
    expect(parseProcStat("garbage without parens", 100, 4096)).toBeNull();
    expect(parseProcStat("12 (omp) S 1 2 3", 100, 4096)).toBeNull();
    expect(parseProcStat(statLine(12, "omp", 1, [1, 1, 1, 1], 5).replace(/^12/, "x"), 100, 4096)).toBeNull();
  });
});

describe("treeTotals", () => {
  const list = [
    proc(1, 0, 100, 1),
    proc(10, 1, 1_000, 2),
    proc(11, 10, 2_000, 3),
    proc(12, 11, 4_000, 4),
    proc(13, 10, 8_000, 5),
    proc(20, 1, 16_000, 6),
    proc(21, 20, 32_000, 7),
  ];

  it("sums each root with all its descendants and excludes unrelated processes", () => {
    const totals = treeTotals(list, [10, 20]);
    expect(totals.get(10)).toEqual({ memoryBytes: 15_000, cpuSeconds: 14 });
    expect(totals.get(20)).toEqual({ memoryBytes: 48_000, cpuSeconds: 13 });
  });

  it("leaves roots missing from the list out of the result", () => {
    const totals = treeTotals(list, [10, 99]);
    expect(totals.has(99)).toBe(false);
    expect(totals.size).toBe(1);
  });

  it("does not hang on a ppid cycle", () => {
    const cyclic = [proc(5, 6, 10, 1), proc(6, 5, 20, 2), proc(7, 6, 40, 3)];
    expect(treeTotals(cyclic, [5]).get(5)).toEqual({ memoryBytes: 70, cpuSeconds: 6 });
  });
});

describe("nextResources", () => {
  const startedAt = Date.parse("2026-01-01T00:00:00.000Z");

  it("rates the first sample from the process start at zero CPU", () => {
    const first = nextResources(null, 0, { memoryBytes: 500, cpuSeconds: 5 }, startedAt + 10_000, startedAt);
    expect(first).toEqual({
      memoryBytes: 500,
      peakMemoryBytes: 500,
      cpuPercent: 50,
      cpuSeconds: 5,
      sampledAt: "2026-01-01T00:00:10.000Z",
    });
  });

  it("rates later samples from the previous one and keeps the peak when memory drops", () => {
    const previous: AgentResources = {
      memoryBytes: 900,
      peakMemoryBytes: 1_200,
      cpuPercent: 10,
      cpuSeconds: 5,
      sampledAt: "2026-01-01T00:00:10.000Z",
    };
    const next = nextResources(previous, 5, { memoryBytes: 300, cpuSeconds: 15 }, startedAt + 15_000, startedAt);
    expect(next.cpuPercent).toBe(200);
    expect(next.memoryBytes).toBe(300);
    expect(next.peakMemoryBytes).toBe(1_200);
    expect(next.cpuSeconds).toBe(15);
  });

  it("rounds the rate to one decimal", () => {
    const next = nextResources(null, 0, { memoryBytes: 1, cpuSeconds: 1 }, startedAt + 3_000, startedAt);
    expect(next.cpuPercent).toBe(33.3);
  });

  it("clamps a shrinking CPU total to 0 and reads 0 without elapsed time", () => {
    const previous = nextResources(null, 0, { memoryBytes: 100, cpuSeconds: 10 }, startedAt + 5_000, startedAt);
    expect(nextResources(previous, 10, { memoryBytes: 100, cpuSeconds: 4 }, startedAt + 10_000, startedAt).cpuPercent).toBe(0);
    expect(nextResources(previous, 10, { memoryBytes: 100, cpuSeconds: 20 }, startedAt + 5_000, startedAt).cpuPercent).toBe(0);
  });

  it("never loses CPU time when a process leaves the tree, and counts growth from the lower total", () => {
    const first = nextResources(null, 0, { memoryBytes: 100, cpuSeconds: 10 }, startedAt + 5_000, startedAt);
    // A background job holding 8 s of CPU was re-parented away: the raw total drops to 4.
    const second = nextResources(first, 10, { memoryBytes: 100, cpuSeconds: 4 }, startedAt + 10_000, startedAt);
    expect(second.cpuSeconds).toBe(10);
    // The next 5 s use 2.5 s of CPU on top of the remaining 4.
    const third = nextResources(second, 4, { memoryBytes: 100, cpuSeconds: 6.5 }, startedAt + 15_000, startedAt);
    expect(third.cpuSeconds).toBe(12.5);
    expect(third.cpuPercent).toBe(50);
  });
});
