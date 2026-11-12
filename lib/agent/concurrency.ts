// How many card agents run at once. An explicit setting is used as is; `auto` derives the limit
// from the machine: one agent per logical core, and only as many new agents as free memory holds.
import { availableParallelism, freemem, totalmem } from "node:os";
import type { AppSettings, ConcurrencyInfo } from "@/lib/types";

/** Rough memory one card agent needs (omp plus the builds, tests and browsers it runs). */
export const AGENT_MEMORY_BYTES = 600 * 1024 ** 2;
/** Upper bound of the automatic limit. */
export const AUTO_MAX_AGENTS = 32;
/** How often the automatic limit is re-sampled while cards wait in the queue. */
export const CONCURRENCY_SAMPLE_MS = 30_000;
/** Memory left to the system and the server itself: 10% of the total, at most 2 GB. */
const RESERVE_FRACTION = 0.1;
const RESERVE_MAX_BYTES = 2 * 1024 ** 3;

export interface MachineResources {
  cpus: number;
  freeMemoryBytes: number;
  totalMemoryBytes: number;
}

/** Cores and memory available to this process (container limits included). */
export function readMachineResources(): MachineResources {
  const constrained = process.constrainedMemory();
  const total = constrained > 0 ? Math.min(totalmem(), constrained) : totalmem();
  const free = process.availableMemory();
  return {
    cpus: availableParallelism(),
    freeMemoryBytes: Math.max(0, Math.min(Number.isFinite(free) && free > 0 ? free : freemem(), total)),
    totalMemoryBytes: total,
  };
}

/**
 * The limit in effect. `running` agents already hold their memory, so the memory bound is them
 * plus the agents the free memory (beyond the reserve) can still hold; a low-memory machine thus
 * stops starting new agents without stopping running ones.
 */
export function resolveConcurrency(
  setting: AppSettings["maxConcurrentAgents"],
  running: number,
  resources: MachineResources = readMachineResources(),
): ConcurrencyInfo {
  const { cpus, freeMemoryBytes, totalMemoryBytes } = resources;
  const base = { cpus, freeMemoryBytes, totalMemoryBytes };
  if (setting !== "auto") {
    return { ...base, mode: "manual", limit: setting, boundBy: null, reason: `Manual: ${setting} parallel` };
  }
  const reserve = Math.min(RESERVE_MAX_BYTES, totalMemoryBytes * RESERVE_FRACTION);
  const byMemory = running + Math.floor(Math.max(0, freeMemoryBytes - reserve) / AGENT_MEMORY_BYTES);
  const candidates: [NonNullable<ConcurrencyInfo["boundBy"]>, number][] = [
    ["cpu", cpus],
    ["memory", byMemory],
    ["max", AUTO_MAX_AGENTS],
  ];
  const [boundBy, bound] = candidates.reduce((min, next) => (next[1] < min[1] ? next : min));
  const limit = Math.max(1, bound);
  const memoryNote = boundBy === "memory" ? ", limited by memory" : "";
  return {
    ...base,
    mode: "auto",
    limit,
    boundBy,
    reason: `Auto: ${limit} parallel (${cpus} cores, ${formatGb(freeMemoryBytes)} GB free${memoryNote})`,
  };
}

function formatGb(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 10 ? String(Math.round(gb)) : gb.toFixed(1).replace(/\.0$/, "");
}
