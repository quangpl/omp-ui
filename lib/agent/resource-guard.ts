// Server-only. System-wide memory/CPU guard: while memory in use (instant sample) or host CPU
// (averaged over a sustain window) is at or above its hold %, queued cards are held: the manager
// starts no new runs (resolveConcurrency caps the limit at the running agents; running agents are
// never touched). Each held resource is released once it drops below its resume % (hysteresis).
// Thresholds are OMP_UI_* variables re-read live from `.env`, so editing them needs no restart.
// Hold/resume events go to the System log (server stdout). Optionally, a memory hold that outlasts
// OMP_UI_RESOURCE_RESTART_MIN restarts the server through bin/supervisor.mjs once no agent runs or
// is being prepared and cards are queued (a restart frees memory, not host CPU).
//
// ResourceGuard is the pure state machine (tests feed it synthetic samples); startResourceGuard
// owns the sampling timer, the logging and the graceful restart.
import fs from "node:fs";
import { cpus as listCpus } from "node:os";
import path from "node:path";
import { readMachineResources } from "@/lib/agent/concurrency";
import { flushLogEvents } from "@/lib/server/log-store";
import type { PressureResource, ResourcePressure } from "@/lib/types";

export const RESOURCE_GUARD_SAMPLE_MS = 5_000;
/** Exit code asking bin/supervisor.mjs for an immediate restart (EX_TEMPFAIL). */
export const RESTART_EXIT_CODE = 75;
/** Env var bin/supervisor.mjs sets ("1") on the server it runs. */
export const SUPERVISED_ENV = "OMP_UI_SUPERVISED";

export interface ResourceGuardConfig {
  /** Hold when memory in use is at/above this %; 0 = memory guard off. */
  memoryHoldPct: number;
  /** Release a memory hold once memory in use is below this %. */
  memoryResumePct: number;
  /** Hold when the CPU average over `cpuSustainMs` is at/above this %; 0 = CPU guard off. */
  cpuHoldPct: number;
  /** Release a CPU hold once the CPU average is below this %. */
  cpuResumePct: number;
  /** CPU averaging window. */
  cpuSustainMs: number;
  /** Graceful restart after holding this long; 0 = never. */
  restartAfterMs: number;
}

export const DEFAULT_RESOURCE_GUARD_CONFIG: ResourceGuardConfig = {
  memoryHoldPct: 75,
  memoryResumePct: 65,
  cpuHoldPct: 75,
  cpuResumePct: 65,
  cpuSustainMs: 30_000,
  restartAfterMs: 0,
};

const ENV_KEYS = [
  "OMP_UI_MEMORY_HOLD_PCT",
  "OMP_UI_MEMORY_RESUME_PCT",
  "OMP_UI_CPU_HOLD_PCT",
  "OMP_UI_CPU_RESUME_PCT",
  "OMP_UI_CPU_SUSTAIN_SEC",
  "OMP_UI_RESOURCE_RESTART_MIN",
] as const;

/**
 * The guard's config from OMP_UI_* variables. Unset or empty values take the default; invalid
 * ones (non-numeric, out of range, fractional restart minutes, a resume % below 1 or not below its
 * hold %) take the default and add a warning naming the value.
 */
export function parseResourceGuardConfig(env: Record<string, string | undefined>): {
  config: ResourceGuardConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const number = (key: (typeof ENV_KEYS)[number], fallback: number, min: number, max: number, whole = false): number => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= min && value <= max && (!whole || Number.isInteger(value))) return value;
    warnings.push(`${key}="${raw}" is not a ${whole ? "whole number" : "number"} from ${min} to ${max} — using ${fallback}.`);
    return fallback;
  };
  // A resume % of 0 could never release.
  const resume = (key: (typeof ENV_KEYS)[number], holdKey: string, hold: number): number => {
    const fallback = defaultResumePct(hold);
    const value = number(key, fallback, 1, 100);
    if (hold === 0 || value < hold) return value;
    warnings.push(`${key}=${value} must be below ${holdKey} (${hold}) — using ${fallback}.`);
    return fallback;
  };
  const defaults = DEFAULT_RESOURCE_GUARD_CONFIG;
  const memoryHoldPct = number("OMP_UI_MEMORY_HOLD_PCT", defaults.memoryHoldPct, 0, 100);
  const cpuHoldPct = number("OMP_UI_CPU_HOLD_PCT", defaults.cpuHoldPct, 0, 100);
  return {
    config: {
      memoryHoldPct,
      memoryResumePct: resume("OMP_UI_MEMORY_RESUME_PCT", "OMP_UI_MEMORY_HOLD_PCT", memoryHoldPct),
      cpuHoldPct,
      cpuResumePct: resume("OMP_UI_CPU_RESUME_PCT", "OMP_UI_CPU_HOLD_PCT", cpuHoldPct),
      cpuSustainMs: number("OMP_UI_CPU_SUSTAIN_SEC", defaults.cpuSustainMs / 1000, 5, 3600) * 1000,
      restartAfterMs: number("OMP_UI_RESOURCE_RESTART_MIN", defaults.restartAfterMs / 60_000, 0, 1440, true) * 60_000,
    },
    warnings,
  };
}

/** Hold − 10; a hold of 10 % or less resumes at half of it, so it can still release. */
function defaultResumePct(hold: number): number {
  return hold > 10 ? hold - 10 : hold / 2;
}

// The parsed `.env`, re-read only when the file's mtime or size changes.
let envFileCache: { file: string; mtimeMs: number; size: number; values: Record<string, string> } | null = null;
// The keys `file` held at its first successful read with process.env carrying the same value: the
// CLI copied them from `.env` at launch, so once removed from the file they take the default, not
// that stale copy. Recorded again when the path changes.
let bootFileKeys: { file: string; keys: Set<string> } | null = null;

/**
 * The live config: `.env` values win over process.env (as in the CLI's loadConfig, where `.env` is
 * authoritative), which wins over the defaults. Stats the file on every call and re-parses it only
 * when it changed; a missing file means no overrides. A key removed from the file falls back to
 * the default when process.env only holds the CLI's launch-time copy of it. An unreadable file
 * keeps the last good file values and adds a warning. `envFile` defaults to `<cwd>/.env`, but to
 * none under NODE_ENV=test, so test suites see only their process.env.
 */
export function readResourceGuardConfig(
  envFile: string | null = process.env.NODE_ENV === "test" ? null : path.join(process.cwd(), ".env"),
): {
  config: ResourceGuardConfig;
  warnings: string[];
} {
  const read = envFile === null ? null : readEnvFileValues(envFile);
  const fileValues: Record<string, string> = read?.values ?? {};
  const fileKeys = bootFileKeys && bootFileKeys.file === envFile ? bootFileKeys.keys : null;
  const env: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) env[key] = fileValues[key] ?? (fileKeys?.has(key) ? undefined : process.env[key]);
  const result = parseResourceGuardConfig(env);
  if (read?.error) result.warnings.unshift(read.error);
  return result;
}

function readEnvFileValues(file: string): { values: Record<string, string>; error: string | null } {
  let values: Record<string, string>;
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) {
      values = {};
    } else {
      const cached = envFileCache;
      if (cached && cached.file === file && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return { values: cached.values, error: null };
      }
      values = parseEnvText(fs.readFileSync(file, "utf8"));
      envFileCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, values };
    }
  } catch (err) {
    const lastGood = envFileCache && envFileCache.file === file ? envFileCache.values : {};
    const message = err instanceof Error ? err.message : String(err);
    return { values: lastGood, error: `cannot read ${file}: ${message} — using the last good thresholds.` };
  }
  if (!bootFileKeys || bootFileKeys.file !== file) {
    const keys = new Set(Object.keys(values).filter((key) => process.env[key] === values[key]));
    bootFileKeys = { file, keys };
  }
  return { values, error: null };
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const ENV_KEY_SET = new Set<string>(ENV_KEYS);

/** The guard's keys from `.env` text; values unquoted like bin/omp-ui.mjs parseEnvValue. */
function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = ENV_LINE.exec(line);
    if (m && ENV_KEY_SET.has(m[1])) out[m[1]] = unquoteEnvValue(m[2]);
  }
  return out;
}

function unquoteEnvValue(raw: string): string {
  const v = raw.trim();
  const quote = v[0];
  if (quote === "'" || quote === '"') {
    const end = v.indexOf(quote, 1);
    return end === -1 ? v.slice(1) : v.slice(1, end);
  }
  const comment = v.search(/\s#/);
  return (comment === -1 ? v : v.slice(0, comment)).trim();
}

/** Cumulative CPU time summed over all cores (ms); busy % = 1 − Δidle/Δtotal between two readings. */
export interface CpuTimes {
  idle: number;
  total: number;
}

export function readCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const { times } of listCpus()) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/** Memory in use, % of the total available to this process (container limits included). */
export function readMemoryPercent(): number {
  const { freeMemoryBytes, totalMemoryBytes } = readMachineResources();
  return totalMemoryBytes > 0 ? (1 - freeMemoryBytes / totalMemoryBytes) * 100 : 0;
}

export interface GuardSample {
  /** ms epoch */
  at: number;
  memoryPercent: number;
  cpu: CpuTimes;
}

export type GuardEvent =
  /** Holding went from empty to non-empty. */
  | { kind: "hold"; pressure: ResourcePressure }
  /** Still holding; the set of held resources changed. */
  | { kind: "change"; pressure: ResourcePressure }
  /** Holding became empty. */
  | { kind: "resume"; pressure: ResourcePressure; heldMs: number };

/** Slack for the CPU window: timer ticks arrive a little late, so a window this much short is full. */
const WINDOW_SLACK_MS = 1000;

/** Pure state machine: no timers, no I/O, no logging. */
export class ResourceGuard {
  private cpuSamples: { at: number; cpu: CpuTimes }[] = [];
  private memoryHeld = false;
  private cpuHeld = false;
  private heldSince: number | null = null;
  /** When the current memory hold began; only memory pressure leads to a restart. */
  private memorySince: number | null = null;
  private latest: ResourcePressure | null = null;

  /** Feeds one sample under the current config; returns the hold/change/resume it caused, if any. */
  update(sample: GuardSample, config: ResourceGuardConfig): GuardEvent | null {
    const { at, memoryPercent } = sample;
    const samples = this.cpuSamples;
    samples.push({ at, cpu: sample.cpu });
    // Window start: the newest sample at least a sustain window old, else the oldest one.
    const fullBefore = at - config.cpuSustainMs + WINDOW_SLACK_MS;
    let startIndex = 0;
    for (let i = samples.length - 1; i >= 0; i--) {
      if (samples[i].at <= fullBefore) {
        startIndex = i;
        break;
      }
    }
    samples.splice(0, startIndex);
    const start = samples[0];
    const deltaTotal = sample.cpu.total - start.cpu.total;
    const cpuPercent =
      samples.length < 2 || deltaTotal <= 0
        ? null
        : Math.min(100, Math.max(0, (1 - (sample.cpu.idle - start.cpu.idle) / deltaTotal) * 100));
    const windowFull = start.at <= fullBefore;

    const { memoryHoldPct, memoryResumePct, cpuHoldPct, cpuResumePct } = config;
    this.memoryHeld = this.memoryHeld
      ? memoryHoldPct > 0 && memoryPercent >= memoryResumePct
      : memoryHoldPct > 0 && memoryPercent >= memoryHoldPct;
    this.cpuHeld = this.cpuHeld
      ? cpuHoldPct > 0 && !(cpuPercent !== null && cpuPercent < cpuResumePct)
      : cpuHoldPct > 0 && windowFull && cpuPercent !== null && cpuPercent >= cpuHoldPct;

    const holding: PressureResource[] = [];
    if (this.memoryHeld) holding.push("memory");
    if (this.cpuHeld) holding.push("cpu");
    const before = this.latest?.holding ?? [];
    const heldSince = this.heldSince;
    this.heldSince = holding.length ? (heldSince ?? at) : null;
    this.memorySince = this.memoryHeld ? (this.memorySince ?? at) : null;

    const pressure: ResourcePressure = {
      memoryPercent,
      cpuPercent,
      cpuWindowSec: Math.round((at - start.at) / 1000),
      memoryHoldPct,
      memoryResumePct,
      cpuHoldPct,
      cpuResumePct,
      cpuSustainSec: config.cpuSustainMs / 1000,
      holding,
      heldSince: this.heldSince === null ? null : new Date(this.heldSince).toISOString(),
      restartAfterMin: config.restartAfterMs / 60_000,
      restartPending:
        this.memorySince !== null && config.restartAfterMs > 0 && at - this.memorySince >= config.restartAfterMs,
      sampledAt: new Date(at).toISOString(),
    };
    this.latest = pressure;

    if (!before.length) return holding.length ? { kind: "hold", pressure } : null;
    if (!holding.length) return { kind: "resume", pressure, heldMs: at - (heldSince ?? at) };
    const changed = holding.length !== before.length || holding.some((r, i) => r !== before[i]);
    return changed ? { kind: "change", pressure } : null;
  }

  /** The latest reading; null before the first update. */
  pressure(): ResourcePressure | null {
    return this.latest;
  }

  /** When the current memory hold began (ms epoch); null while memory is not held. */
  memoryHeldSince(): number | null {
    return this.memorySince;
  }
}

export interface ResourceGuardHooks {
  /** A hold, change or resume happened: re-evaluate the queue. */
  onChange(): void;
  activeRunCount(): number;
  queuedCount(): number;
  /** Queued cards the card writer is still preparing (in memory only; a restart would lose them). */
  preparingCount(): number;
}

interface GuardRuntime {
  guard: ResourceGuard;
  hooks: ResourceGuardHooks;
  timer: NodeJS.Timeout;
  /** The previous tick's config; null before the first tick. */
  config: ResourceGuardConfig | null;
  /** Config warnings already logged. */
  warned: Set<string>;
  /** Restart notices already logged while the current restart is pending. */
  notices: Set<string>;
  /** The restart is under way (logs flushing); later ticks do nothing. */
  restarting: boolean;
}

// One guard per process; survives dev HMR module reloads.
const g = globalThis as unknown as { __ompUiResourceGuard?: GuardRuntime };

/**
 * Runtime singleton: samples at once, then every RESOURCE_GUARD_SAMPLE_MS (unref'd timer); logs
 * holds and resumes; restarts gracefully. A second call only replaces the hooks.
 */
export function startResourceGuard(hooks: ResourceGuardHooks): void {
  const existing = g.__ompUiResourceGuard;
  if (existing) {
    existing.hooks = hooks;
    return;
  }
  const runtime: GuardRuntime = {
    guard: new ResourceGuard(),
    hooks,
    timer: setInterval(() => tick(runtime), RESOURCE_GUARD_SAMPLE_MS),
    config: null,
    warned: new Set(),
    notices: new Set(),
    restarting: false,
  };
  runtime.timer.unref();
  g.__ompUiResourceGuard = runtime;
  tick(runtime);
}

/** Stops the timer and forgets the state (tests). */
export function stopResourceGuard(): void {
  const runtime = g.__ompUiResourceGuard;
  if (!runtime) return;
  clearInterval(runtime.timer);
  g.__ompUiResourceGuard = undefined;
}

/** The latest reading; null when the guard is not running (or has not sampled yet). */
export function currentResourcePressure(): ResourcePressure | null {
  return g.__ompUiResourceGuard?.guard.pressure() ?? null;
}

/** One sampling round. Synchronous, so ticks never overlap; only the restart awaits the log flush. */
function tick(runtime: GuardRuntime): void {
  if (runtime.restarting) return;
  try {
    const { config: read, warnings } = readResourceGuardConfig();
    // Only bin/supervisor.mjs brings the server back after a restart exit.
    const unsupervised = read.restartAfterMs > 0 && process.env[SUPERVISED_ENV] !== "1";
    if (unsupervised) {
      warnings.push(
        "OMP_UI_RESOURCE_RESTART_MIN is set, but this server does not run under bin/supervisor.mjs — " +
          "graceful restart off.",
      );
    }
    const config = unsupervised ? { ...read, restartAfterMs: 0 } : read;
    for (const warning of warnings) {
      if (runtime.warned.has(warning)) continue;
      runtime.warned.add(warning);
      warn(`Warning: ${warning}`);
    }
    if (runtime.config && JSON.stringify(runtime.config) !== JSON.stringify(config)) {
      info(`Thresholds changed: ${describeConfig(config)}.`);
    }
    runtime.config = config;

    const event = runtime.guard.update(
      { at: Date.now(), memoryPercent: readMemoryPercent(), cpu: readCpuTimes() },
      config,
    );
    if (event) {
      logGuardEvent(event, runtime.hooks);
      runtime.hooks.onChange();
    }
    const pressure = runtime.guard.pressure();
    if (pressure?.restartPending) maybeRestart(runtime, pressure);
    else runtime.notices.clear();
  } catch (err) {
    console.error("[resource-guard] sampling failed:", err);
  }
}

/**
 * Restarts through the supervisor once no agent runs or is being prepared, and only while cards are
 * queued (the restart exists to unblock them); never stops agents.
 */
function maybeRestart(runtime: GuardRuntime, pressure: ResourcePressure): void {
  const at = Date.parse(pressure.sampledAt);
  const minutes = Math.floor((at - (runtime.guard.memoryHeldSince() ?? at)) / 60_000);
  const notice = (key: string, message: string) => {
    if (runtime.notices.has(key)) return;
    runtime.notices.add(key);
    warn(message);
  };
  const running = runtime.hooks.activeRunCount();
  const preparing = runtime.hooks.preparingCount();
  if (running + preparing > 0) {
    notice(
      "busy",
      `Warning: memory pressure for ${minutes} min — graceful restart once no agent runs ` +
        `(${running} running, ${preparing} being prepared; queued cards stay held).`,
    );
    return;
  }
  const queued = runtime.hooks.queuedCount();
  if (queued === 0) {
    notice("idle", `Warning: memory pressure for ${minutes} min, but no card is queued — not restarting.`);
    return;
  }
  warn(
    `Warning: memory pressure for ${minutes} min, no agent running and ${queued} queued — restarting the server.`,
  );
  runtime.restarting = true;
  void flushLogEvents().finally(() => process.exit(RESTART_EXIT_CODE));
}

function logGuardEvent(event: GuardEvent, hooks: ResourceGuardHooks): void {
  const p = event.pressure;
  if (event.kind === "resume") {
    info(
      `Resuming queued cards: ${resourceLine(p, "memory", "<")}, ${resourceLine(p, "cpu", "<")} ` +
        `after ${formatDuration(event.heldMs)} of pressure (${hooks.queuedCount()} queued).`,
    );
    return;
  }
  const held = p.holding.map((resource) => resourceLine(p, resource, "≥")).join(", ");
  if (event.kind === "change") {
    warn(`Warning: resource pressure — still holding queued cards: ${held}.`);
    return;
  }
  warn(
    `Warning: resource pressure — holding queued cards: ${held}. Running agents keep running ` +
      `(${hooks.activeRunCount()} running, ${hooks.queuedCount()} queued).`,
  );
}

/**
 * `memory at 78% (≥ 75%)` against the hold, or `CPU at 40% over 30 s (< 65%)` against the resume %;
 * `memory guard off` / `CPU guard off` for a guard with hold 0.
 */
function resourceLine(p: ResourcePressure, resource: PressureResource, op: "≥" | "<"): string {
  if (resource === "memory") {
    if (p.memoryHoldPct === 0) return "memory guard off";
    return `memory at ${Math.round(p.memoryPercent)}% (${op} ${op === "≥" ? p.memoryHoldPct : p.memoryResumePct}%)`;
  }
  if (p.cpuHoldPct === 0) return "CPU guard off";
  const cpu = p.cpuPercent === null ? "n/a" : `${Math.round(p.cpuPercent)}%`;
  return `CPU at ${cpu} over ${p.cpuWindowSec} s (${op} ${op === "≥" ? p.cpuHoldPct : p.cpuResumePct}%)`;
}

function describeConfig(c: ResourceGuardConfig): string {
  const memory =
    c.memoryHoldPct > 0 ? `memory hold ${c.memoryHoldPct}% / resume ${c.memoryResumePct}%` : "memory guard off";
  const cpu =
    c.cpuHoldPct > 0
      ? `CPU hold ${c.cpuHoldPct}% / resume ${c.cpuResumePct}% over ${c.cpuSustainMs / 1000} s`
      : "CPU guard off";
  const restart = c.restartAfterMs > 0 ? `restart after ${c.restartAfterMs / 60_000} min` : "restart off";
  return `${memory}, ${cpu}, ${restart}`;
}

/** `12s`, `4m 12s`, `1h 5m`. */
function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function info(message: string): void {
  console.log(`[resource-guard ${new Date().toISOString()}] ${message}`);
}

function warn(message: string): void {
  console.warn(`[resource-guard ${new Date().toISOString()}] ${message}`);
}
