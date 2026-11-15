// Memory and CPU of a card's agent: its omp process plus every process it started, sampled from
// the OS process table (Linux /proc, `ps` on macOS/BSD). Server-only.
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

import type { AgentResources } from "@/lib/types";

/** `getconf` answers instantly; anything slower is a broken system, fall back to the defaults. */
const GETCONF_TIMEOUT_MS = 2_000;
const PS_TIMEOUT_MS = 5_000;

/** One process of the OS process table. */
export interface ProcessSample {
  pid: number;
  ppid: number;
  rssBytes: number;
  /** CPU time (user+system) of the process and its reaped children, seconds. */
  cpuSeconds: number;
}

/** Totals of one process tree. */
interface TreeTotals {
  memoryBytes: number;
  cpuSeconds: number;
}

let clockTicks: number | null = null;
let pageBytes: number | null = null;

function run(command: string, args: string[], timeout: number): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  try {
    execFile(command, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : String(stdout)),
    );
  } catch {
    resolve(null);
  }
  return promise;
}

/** `getconf <name>` as a positive integer, or `fallback`. */
async function getconf(name: string, fallback: number): Promise<number> {
  const out = await run("getconf", [name], GETCONF_TIMEOUT_MS);
  const value = out === null ? Number.NaN : Number.parseInt(out, 10);
  return value > 0 ? value : fallback;
}

/**
 * Split a `/proc/<pid>/stat` line. The command name sits in parentheses and may itself contain
 * spaces and `)`, so the fields are split after the LAST `)`; `fields[0]` is the state (stat
 * field 3), `fields[1]` the ppid and so on. Null when the line has no `pid (comm)` head.
 */
export function procStatFields(text: string): { pid: number; comm: string; fields: string[] } | null {
  const open = text.indexOf(" (");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, comm: text.slice(open + 2, close), fields: text.slice(close + 2).trim().split(/\s+/) };
}

/**
 * Parse `/proc/<pid>/stat` (see `procStatFields`): ppid at 1, utime/stime/cutime/cstime at 11–14
 * and rss (pages) at 21. Null on malformed input.
 */
export function parseProcStat(text: string, ticksPerSecond: number, pageSize: number): ProcessSample | null {
  const stat = procStatFields(text);
  if (!stat || stat.fields.length < 22) return null;
  const rest = stat.fields;
  const ppid = Number(rest[1]);
  const ticks = [rest[11], rest[12], rest[13], rest[14]].map(Number);
  const rss = Number(rest[21]);
  if (!Number.isInteger(ppid) || ppid < 0) return null;
  if (ticks.some((t) => !Number.isFinite(t)) || !Number.isFinite(rss)) return null;
  return {
    pid: stat.pid,
    ppid,
    rssBytes: Math.max(0, rss) * pageSize,
    cpuSeconds: ticks.reduce((sum, t) => sum + t, 0) / ticksPerSecond,
  };
}

/** USER_HZ: `getconf CLK_TCK` (cached), 100 when unavailable — the value on practically every Linux. */
export async function clockTicksPerSecond(): Promise<number> {
  clockTicks ??= await getconf("CLK_TCK", 100);
  return clockTicks;
}

/** `ps` cumulative CPU time `[[dd-]hh:]mm:ss[.cc]` in seconds; NaN when malformed. */
function parsePsTime(text: string): number {
  const dash = text.indexOf("-");
  const days = dash >= 0 ? Number(text.slice(0, dash)) : 0;
  const parts = text.slice(dash + 1).split(":").map(Number);
  if (parts.length < 2 || parts.length > 3) return Number.NaN;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return days * 86_400 + seconds;
}

async function listLinux(): Promise<ProcessSample[]> {
  const ticks = await clockTicksPerSecond();
  pageBytes ??= await getconf("PAGESIZE", 4096);
  const page = pageBytes;
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const samples = await Promise.all(
    pids.map(async (pid) => {
      try {
        return parseProcStat(await readFile(`/proc/${pid}/stat`, "utf8"), ticks, page);
      } catch {
        // Exited since the directory was listed.
        return null;
      }
    }),
  );
  return samples.filter((sample): sample is ProcessSample => sample !== null);
}

/**
 * `ps` fallback (macOS/BSD). `-S` folds the CPU time of exited children into their parent, like
 * cutime/cstime on Linux; without it a finished child's CPU would vanish from the tree.
 */
async function listPs(): Promise<ProcessSample[] | null> {
  const out = await run("ps", ["-axS", "-o", "pid=,ppid=,rss=,time="], PS_TIMEOUT_MS);
  if (out === null) return null;
  const list: ProcessSample[] = [];
  for (const line of out.split("\n")) {
    const [pid, ppid, rssKib, time] = line.trim().split(/\s+/);
    if (!pid || !ppid || !rssKib || !time) continue;
    const sample = { pid: Number(pid), ppid: Number(ppid), rssBytes: Number(rssKib) * 1024, cpuSeconds: parsePsTime(time) };
    if (Object.values(sample).every(Number.isFinite)) list.push(sample);
  }
  return list;
}

/** Every process of the machine; null where unsupported (Windows) or on any failure. Never throws. */
export async function listProcesses(): Promise<ProcessSample[] | null> {
  try {
    if (process.platform === "linux") return await listLinux();
    if (process.platform === "win32") return null;
    return await listPs();
  } catch {
    return null;
  }
}

/**
 * Memory and CPU of each root's process tree (the root plus all its descendants). Roots missing
 * from `list` (exited) are missing from the result. A ppid cycle cannot loop: each pid counts once.
 */
export function treeTotals(list: readonly ProcessSample[], roots: readonly number[]): Map<number, TreeTotals> {
  const byPid = new Map<number, ProcessSample>();
  const children = new Map<number, ProcessSample[]>();
  for (const sample of list) {
    byPid.set(sample.pid, sample);
    const siblings = children.get(sample.ppid);
    if (siblings) siblings.push(sample);
    else children.set(sample.ppid, [sample]);
  }
  const totals = new Map<number, TreeTotals>();
  for (const root of roots) {
    const top = byPid.get(root);
    if (!top) continue;
    const total: TreeTotals = { memoryBytes: 0, cpuSeconds: 0 };
    const visited = new Set<number>([root]);
    const stack = [top];
    for (let sample = stack.pop(); sample; sample = stack.pop()) {
      total.memoryBytes += sample.rssBytes;
      total.cpuSeconds += sample.cpuSeconds;
      for (const child of children.get(sample.pid) ?? []) {
        if (visited.has(child.pid)) continue;
        visited.add(child.pid);
        stack.push(child);
      }
    }
    totals.set(root, total);
  }
  return totals;
}

/**
 * The run's next sample. `previousTreeCpu` is the tree's raw CPU total at the previous sample (0
 * before the first: the process starts at zero CPU at `startedAt`, ms epoch). Only growth since
 * then counts, toward both the rate and the run's CPU time: a process that leaves the tree (a
 * background job re-parented away, a child exited unreaped) takes its CPU out of the raw total,
 * which reads as 0, never as negative or as CPU time lost.
 */
export function nextResources(
  previous: AgentResources | null,
  previousTreeCpu: number,
  totals: TreeTotals,
  at: number,
  startedAt: number,
): AgentResources {
  const previousAt = previous ? Date.parse(previous.sampledAt) : startedAt;
  const wallSeconds = (at - previousAt) / 1000;
  const used = Math.max(0, totals.cpuSeconds - previousTreeCpu);
  return {
    memoryBytes: totals.memoryBytes,
    peakMemoryBytes: Math.max(previous?.peakMemoryBytes ?? 0, totals.memoryBytes),
    cpuPercent: wallSeconds > 0 ? Math.round((used / wallSeconds) * 1000) / 10 : 0,
    // CPU clocks tick in hundredths of a second; rounding keeps float sums from drifting.
    cpuSeconds: Math.round(((previous?.cpuSeconds ?? 0) + used) * 100) / 100,
    sampledAt: new Date(at).toISOString(),
  };
}
