// Server-only helpers behind `GET /api/v1/stats/system` and `GET /api/v1/stats/ai`.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentResourcePressure } from "@/lib/agent/resource-guard";
import type { AgentManager } from "@/lib/agent/types";
import { childEnv } from "@/lib/child-env";
import type { Repository } from "@/lib/db/types";
import {
  TASK_STATUSES,
  type AiModelUsage,
  type AiProviderQuota,
  type AiQuotaLimit,
  type AiStats,
  type SystemStats,
  type TaskStatus,
} from "@/lib/types";
import { APP_VERSION } from "@/lib/version";

// ---------------------------------------------------------------------------------------------
// System

const CPU_SAMPLE_MS = 200;

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Busy share of all cores over a short window, 0–100. */
async function sampleCpuPercent(): Promise<number> {
  const start = cpuTimes();
  const { promise: elapsed, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, CPU_SAMPLE_MS);
  await elapsed;
  const end = cpuTimes();
  const total = end.total - start.total;
  if (total <= 0) return 0;
  const busy = 1 - (end.idle - start.idle) / total;
  return Math.round(Math.min(1, Math.max(0, busy)) * 1000) / 10;
}

function diskStats(): SystemStats["disk"] {
  const target = path.resolve(process.cwd(), process.env.DATA_DIR?.trim() || ".");
  try {
    const s = fs.statfsSync(target);
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = s.bavail * s.bsize;
    const usedBytes = (s.blocks - s.bfree) * s.bsize;
    return { path: target, totalBytes, usedBytes, freeBytes };
  } catch {
    return null;
  }
}

export async function getSystemStats(repo: Repository, manager: AgentManager): Promise<SystemStats> {
  const [usagePercent, boards] = await Promise.all([sampleCpuPercent(), repo.listBoards()]);

  const tasks = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const board of boards) {
    for (const status of TASK_STATUSES) tasks[status] += board.counts[status] ?? 0;
  }

  const agents = manager.stats();
  const cpus = os.cpus();
  const [l1, l5, l15] = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const mem = process.memoryUsage();

  return {
    generatedAt: new Date().toISOString(),
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      uptimeSec: Math.round(os.uptime()),
      nodeVersion: process.version,
    },
    cpu: {
      model: cpus[0]?.model.trim() ?? "Unknown",
      cores: cpus.length,
      loadAvg: [l1 ?? 0, l5 ?? 0, l15 ?? 0],
      usagePercent,
    },
    memory: { totalBytes: totalMem, usedBytes: totalMem - freeMem, freeBytes: freeMem },
    disk: diskStats(),
    process: {
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
    },
    app: {
      version: APP_VERSION,
      db: repo.driver,
      boards: boards.length,
      tasks,
      agentsRunning: agents.running.length,
      agentsQueued: agents.queued.length,
    },
    resourceGuard: currentResourcePressure(),
  };
}

// ---------------------------------------------------------------------------------------------
// AI quota + usage (via the omp CLI)

const AI_CACHE_TTL_MS = 60_000;
const OMP_TIMEOUT_MS = 30_000;
const OMP_MAX_BUFFER = 16 * 1024 * 1024;

type OmpResult = { ok: true; data: unknown } | { ok: false; error: string };

/** Run `omp <args>` (no shell) and parse the JSON object it prints; never rejects. */
function runOmpJson(ompPath: string, args: string[]): Promise<OmpResult> {
  const { promise, resolve } = Promise.withResolvers<OmpResult>();
  const command = `omp ${args[0]}`;
  execFile(
    ompPath,
    args,
    { timeout: OMP_TIMEOUT_MS, maxBuffer: OMP_MAX_BUFFER, env: childEnv(), windowsHide: true },
    (err, stdout, stderr) => {
      if (err) {
        const code = err.code;
        if (code === "ENOENT") return resolve({ ok: false, error: "omp is not installed" });
        if (code === "EACCES") {
          return resolve({ ok: false, error: "omp could not be started (permission denied)" });
        }
        if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return resolve({ ok: false, error: `${command} returned too much output` });
        }
        if (err.killed) {
          return resolve({ ok: false, error: `${command} took too long to respond` });
        }
        const detail = `${stderr}`.trim().split("\n").at(-1)?.trim();
        return resolve({ ok: false, error: `${command} failed${detail ? `: ${detail}` : ""}` });
      }
      const data = parseJsonObject(`${stdout}`);
      if (data === undefined) {
        return resolve({ ok: false, error: `${command} returned output that could not be read` });
      }
      resolve({ ok: true, data });
    },
  );
  return promise;
}

/** omp may print progress lines before the JSON; try each line that starts with `{`. */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const end = text.lastIndexOf("}");
  if (end < 0) return undefined;
  let start = text.startsWith("{") ? 0 : text.indexOf("\n{");
  while (start >= 0 && start < end) {
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Not the JSON start; keep looking.
    }
    start = text.indexOf("\n{", start + 1);
  }
  return undefined;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Epoch ms (or an ISO string) → ISO string. */
function iso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
}

function mapLimit(raw: unknown, index: number): AiQuotaLimit {
  const limit = obj(raw);
  const window = obj(limit.window);
  const amount = obj(limit.amount);
  const used = num(amount.used);
  const max = num(amount.limit);
  const remainingFraction = num(amount.remainingFraction);
  const usedFraction =
    num(amount.usedFraction) ??
    (used !== null && max !== null && max > 0
      ? used / max
      : remainingFraction !== null
        ? 1 - remainingFraction
        : null);
  return {
    id: str(limit.id) ?? `limit-${index}`,
    label: str(limit.label) ?? str(window.label) ?? "Limit",
    windowLabel: str(window.label),
    resetsAt: iso(window.resetsAt),
    used,
    limit: max,
    usedFraction: usedFraction === null ? null : Math.min(1, Math.max(0, usedFraction)),
    unit: str(amount.unit),
    status: str(limit.status),
  };
}

function mapQuota(data: unknown): AiProviderQuota[] {
  return arr(obj(data).reports).map((raw) => {
    const report = obj(raw);
    const meta = obj(report.metadata);
    return {
      provider: str(report.provider) ?? "unknown",
      account: str(meta.email) ?? str(meta.orgName) ?? str(meta.accountId),
      fetchedAt: iso(report.fetchedAt),
      limits: arr(report.limits).map(mapLimit),
    };
  });
}

function mapUsage(data: unknown): Pick<AiStats["usage"], "totals" | "byModel"> {
  const root = obj(data);
  const overall = obj(root.overall);
  const byModel: AiModelUsage[] = arr(root.byModel).map((raw) => {
    const m = obj(raw);
    return {
      provider: str(m.provider) ?? "unknown",
      model: str(m.model) ?? "unknown",
      requests: num(m.totalRequests) ?? 0,
      inputTokens: num(m.totalInputTokens) ?? 0,
      outputTokens: num(m.totalOutputTokens) ?? 0,
      cacheReadTokens: num(m.totalCacheReadTokens) ?? 0,
      costUsd: num(m.totalCost) ?? 0,
    };
  });
  byModel.sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);
  const totals = root.overall
    ? {
        requests: num(overall.totalRequests) ?? 0,
        failedRequests: num(overall.failedRequests) ?? 0,
        inputTokens: num(overall.totalInputTokens) ?? 0,
        outputTokens: num(overall.totalOutputTokens) ?? 0,
        cacheReadTokens: num(overall.totalCacheReadTokens) ?? 0,
        costUsd: num(overall.totalCost) ?? 0,
        firstAt: iso(overall.firstTimestamp),
        lastAt: iso(overall.lastTimestamp),
      }
    : null;
  return { totals, byModel };
}

async function loadAiStats(ompPath: string): Promise<AiStats> {
  const [usage, stats] = await Promise.all([
    runOmpJson(ompPath, ["usage", "--json"]),
    runOmpJson(ompPath, ["stats", "--json"]),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    quota: usage.ok
      ? { available: true, error: null, providers: mapQuota(usage.data) }
      : { available: false, error: usage.error, providers: [] },
    usage: stats.ok
      ? { available: true, error: null, ...mapUsage(stats.data) }
      : { available: false, error: stats.error, totals: null, byModel: [] },
  };
}

const g = globalThis as unknown as {
  __ompUiAiStats?: { path: string; at: number; value: AiStats };
  __ompUiAiStatsInFlight?: { path: string; promise: Promise<AiStats> };
};

/** Quota + usage from omp, cached for 60s (`refresh` bypasses). Concurrent calls share one run. */
export async function getAiStats(ompPath: string, options: { refresh?: boolean } = {}): Promise<AiStats> {
  const cached = g.__ompUiAiStats;
  if (!options.refresh && cached && cached.path === ompPath && Date.now() - cached.at < AI_CACHE_TTL_MS) {
    return cached.value;
  }
  const inFlight = g.__ompUiAiStatsInFlight;
  if (inFlight && inFlight.path === ompPath) return inFlight.promise;

  const promise = loadAiStats(ompPath)
    .then((value) => {
      g.__ompUiAiStats = { path: ompPath, at: Date.now(), value };
      return value;
    })
    .finally(() => {
      if (g.__ompUiAiStatsInFlight?.promise === promise) g.__ompUiAiStatsInFlight = undefined;
    });
  g.__ompUiAiStatsInFlight = { path: ompPath, promise };
  return promise;
}
