// Server-only maintenance behind `GET|POST /api/v1/stats/maintenance`: analyze what uses CPU,
// memory and disk, then free it. Processes come from /proc on Linux (two samples, so CPU is the
// current rate) or `ps` elsewhere. Storage cleanup only touches AgentMan's own data under DATA_DIR
// and Docker's prune commands; other big folders (omp sessions, tool caches) are reported, never
// deleted.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import v8 from "node:v8";
import vm from "node:vm";
import { liveOmpPids } from "@/lib/agent/rpc";
import { closeIdleWorkers, idleWorkerPids } from "@/lib/agent/rpc-pool";
import type { AgentManager } from "@/lib/agent/types";
import { describeDatabase } from "@/lib/db";
import type { Repository } from "@/lib/db/types";
import { type DockerReclaimable, dockerReclaimable, parseDockerSize, prune } from "@/lib/docker";
import type { PruneKind } from "@/lib/docker-types";
import { dataDir } from "@/lib/files";
import { getSystemStats } from "@/lib/stats";
import type {
  CleanupId,
  CleanupItem,
  MaintenanceAction,
  MaintenanceRecommendation,
  MaintenanceReport,
  MaintenanceResult,
  MaintenanceStepResult,
  ProcessInfo,
  ProcessTag,
  StorageUsage,
  Task,
} from "@/lib/types";
import { removeWorkspace } from "@/lib/workspaces";

const CPU_SAMPLE_MS = 500;
const DU_TIMEOUT_MS = 20_000;
const TOP_PROCESSES = 10;
const MAX_AGENT_PROCESSES = 40;
const COMMAND_MAX = 300;
const KILL_GRACE_MS = 3000;
/** Draft request folders older than this are leftovers. */
const DRAFT_MAX_AGE_MS = 60 * 60_000;
/** Diff summaries not read for this long are dropped (they regenerate on demand). */
const DIFF_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const ID_RE = /^[A-Za-z0-9_-]+$/;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function run(command: string, args: string[], timeout: number): Promise<{ ok: boolean; stdout: string }> {
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; stdout: string }>();
  execFile(command, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
    resolve({ ok: !err, stdout: String(stdout) }),
  );
  return promise;
}

// ---------------------------------------------------------------------------------------------
// Processes

interface RawProcess {
  pid: number;
  ppid: number;
  uid: number | null;
  user: string;
  name: string;
  command: string;
  cpuPercent: number;
  rssBytes: number;
  elapsedSec: number | null;
}

type ProcessScan = { ok: true; list: RawProcess[] } | { ok: false; error: string };

let clockTicks: number | null = null;

/** USER_HZ: `getconf CLK_TCK`, 100 on practically every Linux. */
async function ticksPerSecond(): Promise<number> {
  if (clockTicks === null) {
    const out = await run("getconf", ["CLK_TCK"], 2000);
    clockTicks = Number.parseInt(out.stdout, 10) || 100;
  }
  return clockTicks;
}

function userNames(): Map<number, string> {
  const names = new Map<number, string>();
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const [name, , uid] = line.split(":");
      if (name && uid) names.set(Number(uid), name);
    }
  } catch {
    // No passwd file (containers without one): uids stay numeric.
  }
  return names;
}

/** `/proc/<pid>/stat` fields after the `(comm)`: [state, ppid, …]; utime/stime are fields 14/15, starttime 22. */
function parseStat(text: string): { comm: string; ppid: number; ticks: number; start: number } | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < 0) return null;
  const rest = text.slice(close + 2).split(" ");
  return {
    comm: text.slice(open + 1, close),
    ppid: Number(rest[1]),
    ticks: Number(rest[11]) + Number(rest[12]),
    start: Number(rest[19]),
  };
}

async function readProcTicks(pids: string[]): Promise<Map<string, number>> {
  const ticks = new Map<string, number>();
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const stat = parseStat(await fs.readFile(`/proc/${pid}/stat`, "utf8"));
        if (stat) ticks.set(pid, stat.ticks);
      } catch {
        // Exited between the samples.
      }
    }),
  );
  return ticks;
}

async function scanLinux(sample: boolean): Promise<RawProcess[]> {
  const pids = (await fs.readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const hz = await ticksPerSecond();
  const first = sample ? await readProcTicks(pids) : null;
  const startedAt = performance.now();
  if (sample) await sleep(CPU_SAMPLE_MS);
  const names = userNames();
  const uptime = Number.parseFloat((await fs.readFile("/proc/uptime", "utf8")).split(" ")[0] ?? "0");
  const seconds = (performance.now() - startedAt) / 1000;
  const list: RawProcess[] = [];
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const [statText, status, cmdline] = await Promise.all([
          fs.readFile(`/proc/${pid}/stat`, "utf8"),
          fs.readFile(`/proc/${pid}/status`, "utf8"),
          fs.readFile(`/proc/${pid}/cmdline`, "utf8"),
        ]);
        const stat = parseStat(statText);
        if (!stat) return;
        const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? Number.NaN);
        const rssKb = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
        const before = first?.get(pid);
        const command = cmdline.replaceAll("\0", " ").trim();
        list.push({
          pid: Number(pid),
          ppid: stat.ppid,
          uid: Number.isFinite(uid) ? uid : null,
          user: Number.isFinite(uid) ? (names.get(uid) ?? String(uid)) : "?",
          name: path.basename(command.split(" ")[0] || "") || stat.comm,
          command: command || `[${stat.comm}]`,
          cpuPercent:
            before === undefined || seconds <= 0
              ? 0
              : Math.round(((stat.ticks - before) / hz / seconds) * 1000) / 10,
          rssBytes: rssKb * 1024,
          elapsedSec: Math.max(0, Math.round(uptime - stat.start / hz)),
        });
      } catch {
        // Exited while reading, or not readable.
      }
    }),
  );
  return list;
}

/** `[[dd-]hh:]mm:ss` → seconds. */
function parseEtime(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** macOS / BSD: `ps` (its %cpu is a short decaying average, close enough to "now"). */
async function scanPs(): Promise<RawProcess[]> {
  const out = await run("ps", ["-axo", "pid=,ppid=,uid=,user=,%cpu=,rss=,etime=,args="], 10_000);
  if (!out.ok) throw new Error("ps failed");
  const list: RawProcess[] = [];
  for (const line of out.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const command = m[8]!.trim();
    list.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      uid: Number(m[3]),
      user: m[4]!,
      name: path.basename(command.split(" ")[0] || "?"),
      command,
      cpuPercent: Number(m[5]),
      rssBytes: Number(m[6]) * 1024,
      elapsedSec: parseEtime(m[7]!),
    });
  }
  return list;
}

async function scanProcesses(sample: boolean): Promise<ProcessScan> {
  if (process.platform === "win32") return { ok: false, error: "Process analysis is not supported on Windows." };
  try {
    const list = process.platform === "linux" ? await scanLinux(sample) : await scanPs();
    return list.length > 0 ? { ok: true, list } : { ok: false, error: "No processes visible to the server." };
  } catch (err) {
    return { ok: false, error: `Could not list processes: ${errorText(err)}` };
  }
}

interface Classified extends RawProcess {
  tag: ProcessTag;
  taskId: string | null;
  killable: boolean;
}

function isOmp(p: RawProcess): boolean {
  return p.name === "omp" || p.name === "omp.exe";
}

/** Card id from `--config <DATA_DIR>/runtime/omp-config-<id>.yml` (this DATA_DIR only). */
function configTaskId(command: string, runtimeDir: string): string | null {
  if (!command.includes(runtimeDir)) return null;
  return /omp-config-([A-Za-z0-9_-]+)\.yml/.exec(command)?.[1] ?? null;
}

const INIT_NAMES: Record<string, true> = { systemd: true, init: true, launchd: true, tini: true, "dumb-init": true };

/** Tag every process; see ProcessTag. */
function classify(list: RawProcess[]): Classified[] {
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const myUid = process.getuid?.() ?? null;
  const runtimeDir = path.join(dataDir(), "runtime");
  const tracked = liveOmpPids();

  // This server and its ancestors (supervisor, pm2, the shell that started it) are off limits.
  const protectedPids = new Set<number>();
  for (let p = byPid.get(process.pid); p && p.pid > 1 && !protectedPids.has(p.pid); p = byPid.get(p.ppid)) {
    protectedPids.add(p.pid);
  }
  protectedPids.add(process.pid);

  /** Nearest omp ancestor (an agent, or omp's worker daemon that runs agents' commands), if any. */
  const ompAncestor = (p: RawProcess): RawProcess | null => {
    const seen = new Set<number>();
    for (let a = byPid.get(p.ppid); a && a.pid > 1 && !seen.has(a.pid); a = byPid.get(a.ppid)) {
      if (isOmp(a)) return a;
      seen.add(a.pid);
    }
    return null;
  };

  return list.map((p) => {
    let tag: ProcessTag;
    let taskId: string | null = null;
    if (protectedPids.has(p.pid)) {
      tag = "server";
    } else if (tracked.has(p.pid)) {
      taskId = configTaskId(p.command, runtimeDir);
      tag = taskId ? "card-agent" : "helper";
    } else if (isOmp(p) && p.command.includes("--mode rpc") && configTaskId(p.command, runtimeDir)) {
      // An agent of this DATA_DIR this server does not run. Its parent died (re-parented to init)
      // when the server that started it crashed; a live parent means another AgentMan instance.
      const parent = byPid.get(p.ppid);
      taskId = configTaskId(p.command, runtimeDir);
      tag = !parent || p.ppid <= 1 || INIT_NAMES[parent.name] === true ? "orphan-agent" : "omp";
    } else {
      const ancestor = ompAncestor(p);
      if (ancestor) {
        tag = "agent-spawned";
        taskId = configTaskId(ancestor.command, runtimeDir);
      } else if (isOmp(p)) {
        tag = "omp";
      } else {
        tag = myUid === null || p.uid === myUid ? "user" : "system";
      }
    }
    const mine = myUid === null || p.uid === myUid;
    const killable = mine && p.pid > 1 && tag !== "server" && tag !== "card-agent" && tag !== "system";
    return { ...p, tag, taskId, killable };
  });
}

const AGENT_TAGS: Partial<Record<ProcessTag, true>> = { "card-agent": true, helper: true, "orphan-agent": true, "agent-spawned": true };

/** Top CPU and memory users plus every agent-related process, largest first. */
function selectProcesses(all: Classified[]): Classified[] {
  const picked = new Map<number, Classified>();
  for (const p of [...all].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, TOP_PROCESSES)) picked.set(p.pid, p);
  for (const p of [...all].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, TOP_PROCESSES)) picked.set(p.pid, p);
  const agents = all.filter((p) => AGENT_TAGS[p.tag] === true).sort((a, b) => b.rssBytes - a.rssBytes);
  for (const p of agents.slice(0, MAX_AGENT_PROCESSES)) picked.set(p.pid, p);
  return [...picked.values()].sort((a, b) => b.rssBytes - a.rssBytes);
}

async function withTitles(list: Classified[], repo: Repository): Promise<ProcessInfo[]> {
  const ids = [...new Set(list.flatMap((p) => (p.taskId ? [p.taskId] : [])))];
  const tasks = new Map<string, Task>();
  await Promise.all(
    ids.map(async (id) => {
      const task = await repo.getTask(id).catch(() => null);
      if (task) tasks.set(id, task);
    }),
  );
  return list.map((p) => ({
    pid: p.pid,
    ppid: p.ppid,
    user: p.user,
    name: p.name,
    command: p.command.length > COMMAND_MAX ? `${p.command.slice(0, COMMAND_MAX)}…` : p.command,
    cpuPercent: p.cpuPercent,
    rssBytes: p.rssBytes,
    elapsedSec: p.elapsedSec,
    tag: p.tag,
    taskId: p.taskId,
    taskTitle: (p.taskId && tasks.get(p.taskId)?.title) ?? null,
    taskBoardId: (p.taskId && tasks.get(p.taskId)?.boardId) ?? null,
    killable: p.killable,
  }));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** End each killable process and its killable descendants: SIGTERM, then SIGKILL after a grace period. */
async function killProcesses(pids: number[]): Promise<MaintenanceStepResult[]> {
  const scan = await scanProcesses(false);
  if (!scan.ok) return pids.map((pid) => ({ id: `kill:${pid}`, ok: false, message: scan.error, freedBytes: null }));
  const all = classify(scan.list);
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const children = new Map<number, Classified[]>();
  for (const p of all) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);

  const results: MaintenanceStepResult[] = [];
  for (const pid of pids) {
    const target = byPid.get(pid);
    if (!target) {
      results.push({ id: `kill:${pid}`, ok: true, message: `Process ${pid} has already exited.`, freedBytes: 0 });
      continue;
    }
    if (!target.killable) {
      const why =
        target.tag === "server"
          ? "it runs AgentMan itself"
          : target.tag === "card-agent"
            ? "it is a running card's agent — stop the card instead"
            : "it belongs to another user";
      results.push({ id: `kill:${pid}`, ok: false, message: `Can't end ${target.name} (${pid}): ${why}.`, freedBytes: null });
      continue;
    }
    const tree: Classified[] = [];
    const stack = [target];
    while (stack.length > 0) {
      const p = stack.pop()!;
      if (!p.killable || tree.includes(p)) continue;
      tree.push(p);
      stack.push(...(children.get(p.pid) ?? []));
    }
    // Children first, so a parent that respawns them does not get the chance.
    for (const p of [...tree].reverse()) {
      try {
        process.kill(p.pid, "SIGTERM");
      } catch {
        // Already gone or not permitted; checked below.
      }
    }
    const deadline = Date.now() + KILL_GRACE_MS;
    while (Date.now() < deadline && tree.some((p) => isAlive(p.pid))) {
      await sleep(100);
    }
    let forced = 0;
    for (const p of tree) {
      if (!isAlive(p.pid)) continue;
      try {
        process.kill(p.pid, "SIGKILL");
        forced++;
      } catch {
        // Not permitted.
      }
    }
    await sleep(100);
    const survivors = tree.filter((p) => isAlive(p.pid));
    const ended = tree.filter((p) => !survivors.includes(p));
    const freed = ended.reduce((sum, p) => sum + p.rssBytes, 0);
    const extra = ended.length - 1;
    results.push({
      id: `kill:${pid}`,
      ok: survivors.length === 0,
      message:
        survivors.length === 0
          ? `Ended ${target.name} (${pid})${extra > 0 ? ` and ${extra} child process${extra === 1 ? "" : "es"}` : ""}${forced > 0 ? " (forced)" : ""}.`
          : `Could not end ${survivors.map((p) => `${p.name} (${p.pid})`).join(", ")}.`,
      freedBytes: freed,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// Memory

function swapInfo(): { total: number; used: number } | null {
  try {
    const text = readFileSync("/proc/meminfo", "utf8");
    const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0) * 1024;
    const total = kb("SwapTotal");
    return { total, used: total - kb("SwapFree") };
  } catch {
    return null;
  }
}

function collectGarbage(): boolean {
  try {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as (() => void) | undefined;
    gc?.();
    return typeof gc === "function";
  } catch {
    return false;
  }
}

/** Close idle omp helper workers (they respawn on demand) and run a full V8 garbage collection. */
async function releaseMemory(): Promise<MaintenanceStepResult> {
  const idlePids = idleWorkerPids();
  const scan = idlePids.length > 0 ? await scanProcesses(false) : null;
  const helperRss = scan?.ok
    ? scan.list.filter((p) => idlePids.includes(p.pid)).reduce((sum, p) => sum + p.rssBytes, 0)
    : 0;
  const closed = closeIdleWorkers();
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline && idlePids.some(isAlive)) {
    await sleep(100);
  }
  const before = process.memoryUsage().rss;
  const collected = collectGarbage();
  const after = process.memoryUsage().rss;
  const freed = helperRss + Math.max(0, before - after);
  const parts = [
    closed > 0 ? `closed ${closed} idle helper agent${closed === 1 ? "" : "s"}` : "no idle helper agents to close",
    collected ? "ran garbage collection" : "garbage collection unavailable",
  ];
  return { id: "release-memory", ok: true, message: `${parts.join(", ")}.`.replace(/^./, (c) => c.toUpperCase()), freedBytes: freed };
}

// ---------------------------------------------------------------------------------------------
// Storage

/** Disk usage of each path (`du -sk`, so what deleting it frees); null when it can't be measured. */
async function diskUsage(paths: string[]): Promise<Map<string, number | null>> {
  const sizes = new Map<string, number | null>(paths.map((p) => [p, null]));
  if (paths.length === 0) return sizes;
  if (process.platform !== "win32") {
    // `du` exits non-zero when one path is unreadable but still prints the others.
    const { promise, resolve } = Promise.withResolvers<string>();
    execFile("du", ["-sk", "--", ...paths], { timeout: DU_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) =>
      resolve(String(stdout)),
    );
    for (const line of (await promise).split("\n")) {
      const tab = line.indexOf("\t");
      if (tab > 0) sizes.set(line.slice(tab + 1), Number(line.slice(0, tab)) * 1024);
    }
    return sizes;
  }
  await Promise.all(paths.map(async (p) => sizes.set(p, await walkSize(p))));
  return sizes;
}

async function walkSize(p: string): Promise<number | null> {
  try {
    const stat = await fs.lstat(p);
    if (!stat.isDirectory()) return stat.size;
    let total = 0;
    for (const entry of await fs.readdir(p)) total += (await walkSize(path.join(p, entry))) ?? 0;
    return total;
  } catch {
    return null;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function mtimeMs(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return Date.now();
  }
}

interface Scan {
  /** What the cleanup removes (absolute paths), or nothing for Docker / the database. */
  paths: string[];
  count: number;
  bytes: number | null;
  /** shipped-workspaces: the cards whose worktrees go. */
  tasks?: Task[];
}

interface Context {
  repo: Repository;
  manager: AgentManager;
  docker: () => Promise<DockerReclaimable>;
}

interface Target {
  id: CleanupId;
  label: string;
  description: string;
  risk: CleanupItem["risk"];
  scan(ctx: Context): Promise<Scan | null>;
  /** Remove what `scan` found; returns a message and the bytes freed. */
  clean(ctx: Context, scan: Scan): Promise<{ message: string; freedBytes: number | null }>;
}

async function sizedScan(paths: string[]): Promise<Scan> {
  const sizes = await diskUsage(paths);
  let bytes = 0;
  for (const size of sizes.values()) bytes += size ?? 0;
  return { paths, count: paths.length, bytes };
}

async function removePaths(scan: Scan, noun: string): Promise<{ message: string; freedBytes: number }> {
  let removed = 0;
  for (const p of scan.paths) {
    try {
      await fs.rm(p, { recursive: true, force: true });
      removed++;
    } catch (err) {
      console.error(`[maintenance] could not remove ${p}:`, err);
    }
  }
  const freed = removed === scan.paths.length ? (scan.bytes ?? 0) : 0;
  return { message: `Removed ${removed} ${noun}${removed === 1 ? "" : "s"}.`, freedBytes: freed };
}

/** Sub-folders of DATA_DIR/<sub> whose id has no matching row. */
async function orphanFolders(sub: string[], exists: (id: string) => Promise<boolean>): Promise<string[]> {
  const root = path.join(dataDir(), ...sub);
  const orphans: string[] = [];
  for (const id of await listDir(root)) {
    if (ID_RE.test(id) && !(await exists(id))) orphans.push(path.join(root, id));
  }
  return orphans;
}

/** Remove a deleted card's worktree folder and drop its registration in the source repository. */
async function removeOrphanWorktree(root: string): Promise<void> {
  const sources = new Set<string>();
  for (const name of await listDir(root)) {
    try {
      // A worktree's `.git` file: "gitdir: <source>/.git/worktrees/<name>".
      const gitdir = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(path.join(root, name, ".git"), "utf8"))?.[1]?.trim();
      const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
      if (gitdir?.includes(marker)) sources.add(gitdir.slice(0, gitdir.indexOf(marker)));
    } catch {
      // Not a worktree.
    }
  }
  await fs.rm(root, { recursive: true, force: true });
  for (const source of sources) await run("git", ["-C", source, "worktree", "prune"], 30_000);
}

function dockerTarget(
  kind: PruneKind,
  label: string,
  description: string,
  risk: CleanupItem["risk"],
): Target {
  return {
    id: `docker-${kind}`,
    label,
    description,
    risk,
    async scan(ctx) {
      const docker = await ctx.docker();
      if (!docker.ok) return null;
      const { bytes, count } = docker.kinds[kind];
      return { paths: [], count, bytes };
    },
    async clean() {
      const message = await prune(kind);
      const reclaimed = /^Reclaimed (.+)$/.exec(message)?.[1];
      return { message, freedBytes: reclaimed ? parseDockerSize(reclaimed) : 0 };
    },
  };
}

function dbFiles(): string[] {
  const db = describeDatabase();
  if (db.driver !== "sqlite" || db.target === ":memory:") return [];
  return [db.target, `${db.target}-wal`, `${db.target}-shm`];
}

async function fileBytes(files: string[]): Promise<number> {
  let total = 0;
  for (const file of files) {
    try {
      total += (await fs.stat(file)).size;
    } catch {
      // Not there (no WAL yet).
    }
  }
  return total;
}

const TARGETS: Target[] = [
  {
    id: "orphan-card-files",
    label: "Files of deleted cards",
    description: "Shared-file folders of cards that no longer exist.",
    risk: "safe",
    async scan(ctx) {
      return sizedScan(await orphanFolders(["files", "tasks"], async (id) => (await ctx.repo.getTask(id)) !== null));
    },
    clean: (_ctx, scan) => removePaths(scan, "folder"),
  },
  {
    id: "orphan-board-files",
    label: "Files of deleted projects",
    description: "Shared-file folders of projects that no longer exist.",
    risk: "safe",
    async scan(ctx) {
      return sizedScan(await orphanFolders(["files", "boards"], async (id) => (await ctx.repo.getBoard(id)) !== null));
    },
    clean: (_ctx, scan) => removePaths(scan, "folder"),
  },
  {
    id: "orphan-workspaces",
    label: "Worktrees of deleted cards",
    description: "Git worktrees of deleted cards; their source repos are pruned too.",
    risk: "safe",
    async scan(ctx) {
      return sizedScan(await orphanFolders(["workspaces"], async (id) => (await ctx.repo.getTask(id)) !== null));
    },
    async clean(_ctx, scan) {
      for (const root of scan.paths) await removeOrphanWorktree(root);
      return { message: `Removed ${scan.count} worktree folder${scan.count === 1 ? "" : "s"}.`, freedBytes: scan.bytes };
    },
  },
  {
    id: "shipped-workspaces",
    label: "Worktrees of shipped cards",
    description: "Worktrees and branches of pushed Done cards. Rerunning a card starts a fresh worktree from the base branch.",
    risk: "review",
    async scan(ctx) {
      const tasks: Task[] = [];
      for (const id of await listDir(path.join(dataDir(), "workspaces"))) {
        if (!ID_RE.test(id)) continue;
        const task = await ctx.repo.getTask(id);
        if (task && task.status === "done" && task.pushedAt && (task.agentState === "idle" || task.agentState === "error")) {
          tasks.push(task);
        }
      }
      const scan = await sizedScan(tasks.map((t) => path.join(dataDir(), "workspaces", t.id)));
      return { ...scan, tasks };
    },
    async clean(ctx, scan) {
      const problems: string[] = [];
      for (const task of scan.tasks ?? []) {
        problems.push(...(await removeWorkspace(await ctx.repo.getBoard(task.boardId), task)));
      }
      const removed = scan.count;
      return {
        message: problems.length
          ? `Removed with problems: ${problems.slice(0, 3).join("; ")}`
          : `Removed the worktrees of ${removed} card${removed === 1 ? "" : "s"}.`,
        freedBytes: problems.length ? null : scan.bytes,
      };
    },
  },
  {
    id: "run-configs",
    label: "Old run configs",
    description: "omp config files of cards that aren't running; each run writes a new one.",
    risk: "safe",
    async scan(ctx) {
      const { running, queued } = ctx.manager.stats();
      const active = new Set([...running, ...queued]);
      const dir = path.join(dataDir(), "runtime");
      const files = (await listDir(dir)).filter((name) => {
        const id = /^omp-config-([A-Za-z0-9_-]+)\.yml$/.exec(name)?.[1];
        return id !== undefined && !active.has(id);
      });
      return sizedScan(files.map((name) => path.join(dir, name)));
    },
    clean: (_ctx, scan) => removePaths(scan, "file"),
  },
  {
    id: "drafts",
    label: "Leftover card drafts",
    description: "Card writer temp folders older than an hour.",
    risk: "safe",
    async scan() {
      const dir = path.join(dataDir(), "runtime", "drafts");
      const old: string[] = [];
      for (const name of await listDir(dir)) {
        const p = path.join(dir, name);
        if (Date.now() - (await mtimeMs(p)) > DRAFT_MAX_AGE_MS) old.push(p);
      }
      return sizedScan(old);
    },
    clean: (_ctx, scan) => removePaths(scan, "folder"),
  },
  {
    id: "diff-cache",
    label: "Old change summaries",
    description: "Changes-tab summaries unused for 7 days; regenerated on demand.",
    risk: "safe",
    async scan() {
      const dir = path.join(dataDir(), "runtime", "diff-summaries");
      const old: string[] = [];
      for (const name of await listDir(dir)) {
        const p = path.join(dir, name);
        if (name.endsWith(".json") && Date.now() - (await mtimeMs(p)) > DIFF_CACHE_MAX_AGE_MS) old.push(p);
      }
      return { paths: old, count: old.length, bytes: await fileBytes(old) };
    },
    clean: (_ctx, scan) => removePaths(scan, "file"),
  },
  {
    id: "rotated-logs",
    label: "Rotated logs",
    description: "Old server and tunnel logs (*.log.1). Current logs are kept.",
    risk: "safe",
    async scan() {
      const dir = dataDir();
      const files = (await listDir(dir)).filter((name) => /\.log\.\d+$/.test(name)).map((name) => path.join(dir, name));
      return { paths: files, count: files.length, bytes: await fileBytes(files) };
    },
    clean: (_ctx, scan) => removePaths(scan, "file"),
  },
  {
    id: "database",
    label: "Compact the database",
    description: "Checkpoint the SQLite WAL and VACUUM to return free pages to disk.",
    risk: "safe",
    async scan(ctx) {
      if (!ctx.repo.compact || !ctx.repo.compactableBytes || dbFiles().length === 0) return null;
      const bytes = await ctx.repo.compactableBytes();
      return { paths: [], count: bytes > 0 ? 1 : 0, bytes };
    },
    async clean(ctx) {
      const files = dbFiles();
      const before = await fileBytes(files);
      await ctx.repo.compact!();
      const freed = Math.max(0, before - (await fileBytes(files)));
      return { message: "Compacted the database.", freedBytes: freed };
    },
  },
  dockerTarget("images", "Docker: dangling images", "Untagged image layers no container uses.", "safe"),
  dockerTarget("builder", "Docker: build cache", "Cached build layers; later builds may take longer.", "safe"),
  dockerTarget("networks", "Docker: unused networks", "Custom networks no container is connected to.", "safe"),
  dockerTarget(
    "containers",
    "Docker: stopped containers",
    "Every stopped container, including ones you may want to restart.",
    "review",
  ),
  dockerTarget(
    "volumes",
    "Docker: unused anonymous volumes",
    "Anonymous volumes no container uses. Their data is deleted permanently.",
    "review",
  ),
];

function memo<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => (promise ??= load());
}

function context(repo: Repository, manager: AgentManager): Context {
  return { repo, manager, docker: memo(dockerReclaimable) };
}

async function otherUsage(): Promise<StorageUsage[]> {
  const home = os.homedir();
  const data = dataDir();
  const entries: Omit<StorageUsage, "bytes">[] = [
    { label: "Card worktrees", path: path.join(data, "workspaces"), note: "All dedicated worktrees, in use or not." },
    { label: "Shared files", path: path.join(data, "files"), note: "Card and project files (delete them on the card)." },
    {
      label: "omp sessions",
      path: path.join(home, ".omp", "agent", "sessions"),
      note: "Card runs resume these; manage them with omp.",
    },
    { label: "omp runtime", path: path.join(home, ".omp", "run"), note: "omp daemons and browser profiles." },
    { label: "omp logs", path: path.join(home, ".omp", "logs"), note: "Managed by omp." },
    { label: "User caches", path: path.join(home, ".cache"), note: "Package manager and tool caches (e.g. pnpm store prune)." },
  ];
  const present = [];
  for (const entry of entries) if (await fs.stat(entry.path).catch(() => null)) present.push(entry);
  const sizes = await diskUsage(present.map((e) => e.path));
  return present.map((e) => ({ ...e, bytes: sizes.get(e.path) ?? null }));
}

// ---------------------------------------------------------------------------------------------
// Report

function bytesText(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function recommend(report: Omit<MaintenanceReport, "recommendations">): MaintenanceRecommendation[] {
  const out: MaintenanceRecommendation[] = [];
  const { cpu, memory, storage, processes } = report;

  const orphans = processes.filter((p) => p.tag === "orphan-agent" && p.killable);
  if (orphans.length > 0) {
    const rss = orphans.reduce((sum, p) => sum + p.rssBytes, 0);
    out.push({
      id: "orphan-agents",
      area: "memory",
      severity: "warning",
      title: `${orphans.length} orphaned agent${orphans.length === 1 ? "" : "s"} still running`,
      detail: `omp agents left by an earlier server hold ${bytesText(rss)} of memory and do no work.`,
      action: { kind: "kill", pids: orphans.map((p) => p.pid) },
      actionLabel: "End them",
    });
  }

  const busy = Math.max(cpu.usagePercent, (cpu.loadAvg[0] / Math.max(1, cpu.cores)) * 100);
  if (busy >= 85) {
    const top = [...processes].sort((a, b) => b.cpuPercent - a.cpuPercent)[0];
    out.push({
      id: "cpu-busy",
      area: "cpu",
      severity: busy >= 95 ? "critical" : "warning",
      title: "CPU is saturated",
      detail: top
        ? `${top.name} (${top.pid}) uses ${top.cpuPercent.toFixed(0)}% of a core. Agents slow down until load drops.`
        : "Agents slow down until load drops.",
      action: null,
      actionLabel: null,
    });
  }

  const spawned = processes.filter((p) => p.tag === "agent-spawned" && p.killable && (p.elapsedSec ?? 0) >= 3600);
  const spawnedRss = spawned.reduce((sum, p) => sum + p.rssBytes, 0);
  if (spawned.length > 0 && spawnedRss >= 200 * 1024 * 1024) {
    out.push({
      id: "agent-spawned",
      area: "memory",
      severity: "info",
      title: `Processes started by agents use ${bytesText(spawnedRss)}`,
      detail: `${spawned.length} process${spawned.length === 1 ? "" : "es"} (dev servers, browsers…) running for over an hour. End the ones you don't need.`,
      action: null,
      actionLabel: null,
    });
  }

  const memUsed = memory.totalBytes > 0 ? 1 - memory.availableBytes / memory.totalBytes : 0;
  if (memUsed >= 0.85) {
    out.push({
      id: "memory-high",
      area: "memory",
      severity: memUsed >= 0.95 ? "critical" : "warning",
      title: `Memory is ${Math.round(memUsed * 100)}% used`,
      detail: "Close idle helper agents and end unneeded processes below.",
      action: memory.idleHelpers.count > 0 ? { kind: "release-memory" } : null,
      actionLabel: memory.idleHelpers.count > 0 ? "Free server memory" : null,
    });
  } else if (memory.idleHelpers.count > 0 && memory.idleHelpers.rssBytes >= 256 * 1024 * 1024) {
    out.push({
      id: "idle-helpers",
      area: "memory",
      severity: "info",
      title: `${memory.idleHelpers.count} idle helper agent${memory.idleHelpers.count === 1 ? "" : "s"} hold ${bytesText(memory.idleHelpers.rssBytes)}`,
      detail: "Kept warm for fast card writing and advice; they restart on demand.",
      action: { kind: "release-memory" },
      actionLabel: "Free server memory",
    });
  }

  const disk = storage.disk;
  const diskUsed = disk && disk.totalBytes > 0 ? disk.usedBytes / disk.totalBytes : 0;
  const safeIds = storage.cleanup.filter((c) => c.risk === "safe" && !c.empty).map((c) => c.id);
  if (diskUsed >= 0.85) {
    out.push({
      id: "disk-full",
      area: "storage",
      severity: diskUsed >= 0.95 ? "critical" : "warning",
      title: `Disk is ${Math.round(diskUsed * 100)}% full`,
      detail:
        storage.safeBytes > 0
          ? `Safe cleanup frees about ${bytesText(storage.safeBytes)}. Also review the larger folders below.`
          : "Little to clean in AgentMan's data. Review the larger folders below.",
      action: safeIds.length > 0 ? { kind: "cleanup", ids: safeIds } : null,
      actionLabel: safeIds.length > 0 ? "Clean up safe items" : null,
    });
  } else if (storage.safeBytes >= 50 * 1024 * 1024) {
    out.push({
      id: "reclaimable",
      area: "storage",
      severity: "info",
      title: `${bytesText(storage.safeBytes)} can be freed safely`,
      detail: "Leftovers and caches AgentMan and Docker no longer need.",
      action: { kind: "cleanup", ids: safeIds },
      actionLabel: "Clean up safe items",
    });
  }

  const rank = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Full analysis: processes (sampled ~0.5 s), memory, AgentMan storage, Docker and recommendations. */
export async function analyzeSystem(repo: Repository, manager: AgentManager): Promise<MaintenanceReport> {
  const started = Date.now();
  const ctx = context(repo, manager);
  const [system, scan, scans, other, dataSize, docker] = await Promise.all([
    getSystemStats(repo, manager),
    scanProcesses(true),
    Promise.all(TARGETS.map(async (t) => [t, await t.scan(ctx).catch(() => null)] as const)),
    otherUsage(),
    diskUsage([dataDir()]),
    ctx.docker(),
  ]);

  const all = scan.ok ? classify(scan.list) : [];
  const processes = await withTitles(selectProcesses(all), repo);
  const idlePids = new Set(idleWorkerPids());
  const idleRss = all.filter((p) => idlePids.has(p.pid)).reduce((sum, p) => sum + p.rssBytes, 0);

  const cleanup: CleanupItem[] = scans.flatMap(([t, s]) =>
    s
      ? [
          {
            id: t.id,
            label: t.label,
            description: t.description,
            bytes: s.bytes,
            count: s.count,
            risk: t.risk,
            empty: s.count === 0 && !s.bytes,
          },
        ]
      : [],
  );
  const safeBytes = cleanup.reduce((sum, c) => sum + (c.risk === "safe" && !c.empty ? (c.bytes ?? 0) : 0), 0);
  const mem = process.memoryUsage();
  const swap = swapInfo();

  const report: Omit<MaintenanceReport, "recommendations"> = {
    generatedAt: new Date().toISOString(),
    durationMs: 0,
    processError: scan.ok ? null : scan.error,
    processes,
    cpu: { cores: system.cpu.cores, usagePercent: system.cpu.usagePercent, loadAvg: system.cpu.loadAvg },
    memory: {
      totalBytes: system.memory.totalBytes,
      availableBytes: system.memory.freeBytes,
      swapTotalBytes: swap?.total ?? null,
      swapUsedBytes: swap?.used ?? null,
      server: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
      },
      idleHelpers: { count: idlePids.size, rssBytes: idleRss },
    },
    storage: {
      disk: system.disk,
      dataDir: dataDir(),
      dataBytes: dataSize.get(dataDir()) ?? null,
      cleanup,
      safeBytes,
      other,
      dockerError: docker.ok ? null : docker.error,
    },
  };
  return { ...report, durationMs: Date.now() - started, recommendations: recommend(report) };
}

/** Run one maintenance action; every step reports its own outcome (a failed step never stops the others). */
export async function runMaintenance(
  action: MaintenanceAction,
  repo: Repository,
  manager: AgentManager,
): Promise<MaintenanceResult> {
  let results: MaintenanceStepResult[];
  if (action.kind === "kill") {
    results = await killProcesses(action.pids);
  } else if (action.kind === "release-memory") {
    results = [await releaseMemory()];
  } else if (action.kind === "stop-card") {
    const task = await manager.stop(action.taskId);
    results = [
      {
        id: `stop-card:${action.taskId}`,
        ok: task !== null,
        message: task ? `Stopped "${task.title}".` : "Card not found.",
        freedBytes: null,
      },
    ];
  } else {
    const ctx = context(repo, manager);
    results = [];
    for (const id of action.ids) {
      const target = TARGETS.find((t) => t.id === id)!;
      try {
        const scan = await target.scan(ctx);
        if (!scan) {
          results.push({ id, ok: false, message: `${target.label}: not available here.`, freedBytes: null });
        } else if (scan.count === 0 && !scan.bytes) {
          results.push({ id, ok: true, message: `${target.label}: nothing to clean.`, freedBytes: 0 });
        } else {
          const done = await target.clean(ctx, scan);
          results.push({ id, ok: true, message: `${target.label}: ${done.message}`, freedBytes: done.freedBytes });
        }
      } catch (err) {
        results.push({ id, ok: false, message: `${target.label}: ${errorText(err)}`, freedBytes: null });
      }
    }
  }
  return { results, freedBytes: results.reduce((sum, r) => sum + (r.freedBytes ?? 0), 0) };
}
