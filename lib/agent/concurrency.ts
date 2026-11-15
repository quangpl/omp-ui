// How many card agents run at once. An explicit setting is used as is; `auto` derives the limit
// from the machine: one agent per logical core, and only as many new agents as free memory holds.
// The memory one agent needs is learned (AgentMemoryModel: the 75th percentile of the peak memory
// of recent finished runs, a fixed default until enough runs finished), and agents that just
// started still have that memory committed to them (committedMemoryBytes) until they grow into it,
// so a burst of launches cannot overcommit memory that is free only because they are warming up.
// The optional load guard then holds new runs while the machine is overloaded, and the resource
// guard (lib/agent/resource-guard.ts, memory/CPU %) holds them while it reports pressure.
// subagentConcurrency sizes how many subagents (omp's `task` tool) one card agent may run at once.
import { availableParallelism, cpus as listCpus, freemem, loadavg, totalmem } from "node:os";
import type { AppSettings, ConcurrencyInfo, ResourcePressure } from "@/lib/types";

/** Rough memory one card agent needs (omp plus the builds, tests and browsers it runs). */
export const AGENT_MEMORY_BYTES = 600 * 1024 ** 2;
/** Lower bound of the learned per-agent memory estimate. */
export const MIN_AGENT_MEMORY_BYTES = 256 * 1024 ** 2;
/** Upper bound of the learned per-agent memory estimate. */
export const MAX_AGENT_MEMORY_BYTES = 4 * 1024 ** 3;
/** Rough memory one subagent needs (an omp process without the card's builds and browsers). */
export const SUBAGENT_MEMORY_BYTES = 192 * 1024 ** 2;
/** Subagents per logical core: they mostly wait on the model, so cores are oversubscribed. */
export const SUBAGENTS_PER_CORE = 2;
/** Upper bound of the automatic limit. */
export const AUTO_MAX_AGENTS = 32;
/** How often the automatic limit is re-sampled while cards wait in the queue. */
export const CONCURRENCY_SAMPLE_MS = 30_000;
/** Memory left to the system and the server itself: 10% of the total, at most 2 GB. */
const RESERVE_FRACTION = 0.1;
const RESERVE_MAX_BYTES = 2 * 1024 ** 3;

/** The memory reserve for a machine with `totalMemoryBytes` (0 when unknown). */
function memoryReserve(totalMemoryBytes: number): number {
  return Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0
    ? Math.min(RESERVE_MAX_BYTES, totalMemoryBytes * RESERVE_FRACTION)
    : 0;
}

/**
 * Learns the memory one card agent needs from the peak memory (RSS) of finished runs. Until
 * MIN_SAMPLES runs finished it answers AGENT_MEMORY_BYTES; then the 75th percentile (nearest rank)
 * of the last WINDOW peaks, clamped to [MIN_AGENT_MEMORY_BYTES, MAX_AGENT_MEMORY_BYTES]. The 75th
 * percentile covers the typical run, while one heavy run (a browser or a big build) does not halve
 * the limit as a maximum or a mean would.
 */
export class AgentMemoryModel {
  /** How many recent peaks the estimate is drawn from. */
  static readonly WINDOW = 20;
  /** Peaks needed before the estimate replaces the default. */
  static readonly MIN_SAMPLES = 3;

  private readonly peaks: number[] = [];
  private next = 0;

  /** Records the peak memory of a finished run; non-finite or non-positive readings are ignored. */
  record(peakMemoryBytes: number): void {
    if (!Number.isFinite(peakMemoryBytes) || peakMemoryBytes <= 0) return;
    if (this.peaks.length < AgentMemoryModel.WINDOW) this.peaks.push(peakMemoryBytes);
    else this.peaks[this.next] = peakMemoryBytes;
    this.next = (this.next + 1) % AgentMemoryModel.WINDOW;
  }

  /** The memory to plan per agent, in bytes. */
  estimate(): number {
    const n = this.peaks.length;
    if (n < AgentMemoryModel.MIN_SAMPLES) return AGENT_MEMORY_BYTES;
    const sorted = [...this.peaks].sort((a, b) => a - b);
    const p75 = sorted[Math.ceil(0.75 * n) - 1];
    return Math.min(MAX_AGENT_MEMORY_BYTES, Math.max(MIN_AGENT_MEMORY_BYTES, p75));
  }

  /** Peaks currently held (at most WINDOW). */
  get samples(): number {
    return this.peaks.length;
  }
}

/** The per-agent memory estimate and the memory still committed to warming-up running agents. */
export interface MemoryPlan {
  perAgentBytes: number;
  committedBytes: number;
}

/**
 * Memory promised to running agents beyond what they use yet: Σ max(0, perAgent − current) over
 * their current memory readings; an agent not sampled yet (null) counts the full `perAgentBytes`.
 */
export function committedMemoryBytes(perAgentBytes: number, current: readonly (number | null)[]): number {
  return current.reduce<number>(
    (sum, used) => sum + (used === null ? perAgentBytes : Math.max(0, perAgentBytes - used)),
    0,
  );
}

const DEFAULT_MEMORY_PLAN: MemoryPlan = { perAgentBytes: AGENT_MEMORY_BYTES, committedBytes: 0 };

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

/** A load-guard reading that trips the guard: start no new runs while it holds. */
export interface LoadHold {
  /** 1-minute load average. */
  load: number;
  cores: number;
  /** Load per core, in percent. */
  percent: number;
  /** The threshold (`AppSettings.loadGuardPercent`) it exceeds. */
  threshold: number;
}

/**
 * The hold when the 1-minute load average per core is above `threshold` %, else null. Zero (or
 * unknown) cores never trip it, and neither does Windows, where `os.loadavg()` is always zeros.
 */
export function loadGuardHold(loadAvg1: number, cpuCount: number, threshold: number): LoadHold | null {
  if (!(cpuCount > 0) || !Number.isFinite(loadAvg1)) return null;
  const percent = (loadAvg1 / cpuCount) * 100;
  return percent > threshold ? { load: loadAvg1, cores: cpuCount, percent, threshold } : null;
}

/**
 * Samples the machine for the load guard; null when the guard is off (then the machine is not
 * read at all). Cores are all of the host's, as the load average is host-wide too.
 */
export function readLoadHold(
  settings: Pick<AppSettings, "loadGuard" | "loadGuardPercent">,
  sample: () => { loadAvg1: number; cpuCount: number } = sampleLoad,
): LoadHold | null {
  if (!settings.loadGuard) return null;
  const { loadAvg1, cpuCount } = sample();
  return loadGuardHold(loadAvg1, cpuCount, settings.loadGuardPercent);
}

function sampleLoad(): { loadAvg1: number; cpuCount: number } {
  return { loadAvg1: loadavg()[0], cpuCount: listCpus().length };
}

/**
 * The limit in effect. `running` agents already hold their memory, so the memory bound is them
 * plus the agents the free memory (beyond the reserve and the memory still committed to warming-up
 * agents, see `memory`) can still hold at the per-agent estimate; a low-memory machine thus
 * stops starting new agents without stopping running ones. A holding resource guard (`pressure`,
 * see lib/agent/resource-guard.ts) or a tripped load guard (`hold`, see readLoadHold) is strict:
 * nothing launches, not even into slots lent by runs waiting on cards (`lent`, counted among
 * `running`), so the limit is capped at `running − lent`, in auto and manual mode alike; resource
 * pressure wins when both apply. The latest pressure reading is attached as `pressure` either way.
 */
export function resolveConcurrency(
  setting: AppSettings["maxConcurrentAgents"],
  running: number,
  resources: MachineResources = readMachineResources(),
  hold: LoadHold | null = null,
  pressure: ResourcePressure | null = null,
  lent = 0,
  memory: MemoryPlan = DEFAULT_MEMORY_PLAN,
): ConcurrencyInfo {
  const info: ConcurrencyInfo = { ...resolveLimit(setting, running, resources, memory), pressure: pressure ?? null };
  const capped = Math.max(0, Math.min(info.limit, running - lent));
  if (pressure?.holding.length) {
    return { ...info, limit: capped, boundBy: "resources", reason: resourcePressureReason(pressure) };
  }
  if (!hold) return info;
  return {
    ...info,
    limit: capped,
    boundBy: "load",
    reason:
      `Load guard: holding new runs (load ${hold.load.toFixed(1)} on ${hold.cores} cores = ` +
      `${Math.round(hold.percent)} % > ${hold.threshold} %)`,
  };
}

/** Why the resource guard holds queued cards: each held resource with its reading and resume %. */
export function resourcePressureReason(p: ResourcePressure): string {
  const parts = p.holding.map((resource) =>
    resource === "memory"
      ? `memory at ${Math.round(p.memoryPercent)}% (resumes below ${p.memoryResumePct}%)`
      : `CPU at ${p.cpuPercent === null ? "n/a" : `${Math.round(p.cpuPercent)}%`} over ${p.cpuWindowSec} s ` +
        `(resumes below ${p.cpuResumePct}%)`,
  );
  return `Resource pressure: ${parts.join(", ")} — holding queued cards`;
}

function resolveLimit(
  setting: AppSettings["maxConcurrentAgents"],
  running: number,
  resources: MachineResources,
  memory: MemoryPlan,
): ConcurrencyInfo {
  const { cpus, freeMemoryBytes, totalMemoryBytes } = resources;
  const base = { cpus, freeMemoryBytes, totalMemoryBytes };
  if (setting !== "auto") {
    return { ...base, mode: "manual", limit: setting, boundBy: null, reason: `Manual: ${setting} parallel` };
  }
  const { perAgentBytes, committedBytes } = memory;
  const spare = Math.max(0, freeMemoryBytes - memoryReserve(totalMemoryBytes) - committedBytes);
  const byMemory = running + Math.floor(spare / perAgentBytes);
  const candidates: [Exclude<ConcurrencyInfo["boundBy"], "load" | "resources" | null>, number][] = [
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
    reason:
      `Auto: ${limit} parallel (${cpus} cores, ${formatGb(freeMemoryBytes)} GB free, ` +
      `~${formatGb(perAgentBytes)} GB per agent${memoryNote})`,
    agentMemoryBytes: perAgentBytes,
    committedMemoryBytes: committedBytes,
  };
}

/** Machine readings and the parent's ceiling for subagentConcurrency. */
export interface SubagentBudgetInput {
  /** The configured maximum (`AppSettings.subagentMaxConcurrency`). */
  ceiling: number;
  cpus: number;
  freeMemoryBytes: number;
  totalMemoryBytes: number;
  /** Card agents running now; they share the machine's subagent budget evenly. */
  runningAgents: number;
}

/**
 * How many subagents one card agent may run at once: its even share (among `runningAgents`, at
 * least 1) of SUBAGENTS_PER_CORE per core and of the free memory beyond the reserve at
 * SUBAGENT_MEMORY_BYTES each, capped at `ceiling`, and never below 1 so a saturated machine still
 * lets an agent delegate one task at a time. Non-finite readings count as 0 (`runningAgents` as 1,
 * `ceiling` as 1).
 */
export function subagentConcurrency(input: SubagentBudgetInput): number {
  const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
  const ceiling = Math.max(1, Math.floor(finite(input.ceiling, 1)));
  const share = Math.max(1, finite(input.runningAgents, 1));
  const byCpu = Math.floor((Math.max(0, finite(input.cpus, 0)) * SUBAGENTS_PER_CORE) / share);
  const spare = Math.max(0, finite(input.freeMemoryBytes, 0) - memoryReserve(finite(input.totalMemoryBytes, 0)));
  const byMemory = Math.floor(spare / SUBAGENT_MEMORY_BYTES / share);
  // `ceiling` is at least 1, so this is clamp(min(ceiling, byCpu, byMemory), 1, ceiling).
  return Math.max(1, Math.min(ceiling, byCpu, byMemory));
}

function formatGb(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 10 ? String(Math.round(gb)) : gb.toFixed(1).replace(/\.0$/, "");
}
