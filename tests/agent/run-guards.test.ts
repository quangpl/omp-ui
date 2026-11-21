import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getAgentManager } from "@/lib/agent/manager";
import type { OmpRpcProcess } from "@/lib/agent/rpc";
import {
  evaluateBudget,
  evaluateRunGuards,
  evaluateWrapUp,
  guardsEnabled,
  sessionUsage,
  totalUsage,
  wrapUpSteerMessage,
  type RunGuardState,
} from "@/lib/agent/run-guards";
import type { AgentManager } from "@/lib/agent/types";
import { getRepo } from "@/lib/db";
import type { Repository } from "@/lib/db/types";
import { subscribe } from "@/lib/events";
import { updateAppSettings } from "@/lib/settings";
import { DEFAULT_SETTINGS, type AppSettings, type Board, type Run, type ServerEvent, type Task } from "@/lib/types";

const FAKE_OMP = fileURLToPath(new URL("../fixtures/fake-omp.mjs", import.meta.url));

/** Process-wide singletons the app caches on globalThis (lib/db/index.ts, lib/agent/manager.ts, lib/agent/rpc.ts). */
const globals = globalThis as typeof globalThis & {
  __ompUiRepo?: Promise<Repository>;
  __ompUiAgentManager?: Promise<AgentManager>;
  __ompUiRpcProcesses?: Set<OmpRpcProcess>;
};

const ENV_KEYS = [
  "DATABASE_URL",
  "DATA_DIR",
  "OMP_PATH",
  "MAX_AGENTS",
  "OMP_EXTRA_ARGS",
  "FAKE_OMP_LOG",
  "FAKE_OMP_SCENARIO",
  "FAKE_OMP_SESSION_DIR",
  "FAKE_OMP_MODEL_ROLES",
  "FAKE_OMP_PLAN",
  "FAKE_OMP_COST_PER_MESSAGE",
  "OMP_UI_RETRY_BASE_MS",
  "OMP_UI_QUOTA_RETRY_BASE_MS",
  "OMP_UI_GUARD_TICK_MS",
  "OMP_UI_GUARD_MINUTE_MS",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// --- evaluateRunGuards (pure) ------------------------------------------------------------------

const MINUTE = 60_000;
const T0 = 1_000_000_000;

function guardSettings(patch: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

function guardState(patch: Partial<RunGuardState> = {}): RunGuardState {
  return { launchedAt: T0, lastActivityAt: T0, waitingOnHost: false, costUsd: 0, tokens: 0, ...patch };
}

describe("evaluateRunGuards", () => {
  beforeEach(() => {
    delete process.env.OMP_UI_GUARD_MINUTE_MS;
  });

  it("does nothing while every guard is off, however long, silent or costly the run", () => {
    const settings = guardSettings();
    expect(guardsEnabled(settings)).toBe(false);
    const state = guardState({ costUsd: 1_000, tokens: 1e9 });
    expect(evaluateRunGuards(state, settings, T0 + 10_000 * MINUTE)).toBeNull();
  });

  it("stops a run past its time limit without a retry, only after the limit", () => {
    const settings = guardSettings({ runTimeLimit: true, runTimeLimitMinutes: 120 });
    expect(guardsEnabled(settings)).toBe(true);
    // Activity keeps flowing: only the wall clock counts.
    const at = (ms: number) => evaluateRunGuards(guardState({ lastActivityAt: T0 + ms }), settings, T0 + ms);
    expect(at(120 * MINUTE)).toBeNull();
    expect(at(120 * MINUTE + 1)).toEqual({
      kind: "time-limit",
      message: "Run time limit reached (120 min); stopped without an automatic retry.",
      retry: false,
    });
  });

  it("fails a silent run with a retry after the stall timeout, only after it", () => {
    const settings = guardSettings({ stallWatchdog: true, stallTimeoutMinutes: 20 });
    const state = guardState({ lastActivityAt: T0 + 5 * MINUTE });
    expect(evaluateRunGuards(state, settings, T0 + 25 * MINUTE)).toBeNull();
    expect(evaluateRunGuards(state, settings, T0 + 25 * MINUTE + 1)).toEqual({
      kind: "stall",
      message: "No activity from the agent for 20 min (stall watchdog)",
      retry: true,
    });
  });

  it("exempts a run waiting on a board tool from the stall watchdog", () => {
    const settings = guardSettings({ stallWatchdog: true, stallTimeoutMinutes: 20 });
    expect(evaluateRunGuards(guardState({ waitingOnHost: true }), settings, T0 + 600 * MINUTE)).toBeNull();
  });

  it("stops a run over its USD or token budget without a retry; 0 means no cap", () => {
    const usd = guardSettings({ runBudget: true, runBudgetUsd: 5, runBudgetTokens: 0 });
    expect(evaluateRunGuards(guardState({ costUsd: 5, tokens: 1e9 }), usd, T0)).toBeNull();
    expect(evaluateRunGuards(guardState({ costUsd: 5.123 }), usd, T0)).toEqual({
      kind: "budget",
      message: "Run budget exceeded: $5.12 of $5.00; stopped without an automatic retry.",
      retry: false,
    });

    const tokens = guardSettings({ runBudget: true, runBudgetUsd: 0, runBudgetTokens: 1_000_000 });
    expect(evaluateRunGuards(guardState({ costUsd: 1_000, tokens: 1_000_000 }), tokens, T0)).toBeNull();
    expect(evaluateRunGuards(guardState({ tokens: 1_234_567 }), tokens, T0)?.message).toBe(
      "Run budget exceeded: 1,234,567 of 1,000,000 tokens; stopped without an automatic retry.",
    );

    // The toggle gates both caps.
    expect(evaluateBudget({ costUsd: 50, tokens: 5e6 }, { ...tokens, runBudget: false, runBudgetUsd: 5 })).toBeNull();
  });

  it("prefers the guards without a retry over the stall watchdog", () => {
    const settings = guardSettings({
      stallWatchdog: true,
      stallTimeoutMinutes: 2,
      runBudget: true,
      runBudgetUsd: 1,
      runTimeLimit: true,
      runTimeLimitMinutes: 5,
    });
    const state = guardState({ costUsd: 2 });
    expect(evaluateRunGuards(state, settings, T0 + 3 * MINUTE)?.kind).toBe("budget");
    expect(evaluateRunGuards(state, settings, T0 + 6 * MINUTE)?.kind).toBe("time-limit");
    expect(evaluateRunGuards(guardState(), settings, T0 + 3 * MINUTE)?.kind).toBe("stall");
  });

  it("scales minutes by OMP_UI_GUARD_MINUTE_MS", () => {
    process.env.OMP_UI_GUARD_MINUTE_MS = "10";
    const settings = guardSettings({ runTimeLimit: true, runTimeLimitMinutes: 5 });
    expect(evaluateRunGuards(guardState(), settings, T0 + 50)).toBeNull();
    expect(evaluateRunGuards(guardState(), settings, T0 + 51)?.kind).toBe("time-limit");
  });
});

describe("evaluateWrapUp", () => {
  beforeEach(() => {
    delete process.env.OMP_UI_GUARD_MINUTE_MS;
  });

  it("stays quiet while the nudge is off or neither the time limit nor the budget is on", () => {
    const limits = { runTimeLimit: true, runTimeLimitMinutes: 10, runBudget: true, runBudgetUsd: 1, runBudgetTokens: 100 };
    const nearly = guardState({ costUsd: 0.99, tokens: 99 });
    expect(evaluateWrapUp(nearly, guardSettings({ ...limits, wrapUpNudge: false }), T0 + 9.9 * MINUTE)).toBeNull();
    // The stall watchdog alone has no limit to wrap up before.
    const stallOnly = guardSettings({ wrapUpNudge: true, stallWatchdog: true, stallTimeoutMinutes: 1 });
    expect(evaluateWrapUp(nearly, stallOnly, T0 + 9.9 * MINUTE)).toBeNull();
  });

  it("nudges from the threshold of the time limit (scaled by OMP_UI_GUARD_MINUTE_MS), even during a board-tool wait", () => {
    process.env.OMP_UI_GUARD_MINUTE_MS = "10";
    const settings = guardSettings({ wrapUpNudge: true, wrapUpPercent: 80, runTimeLimit: true, runTimeLimitMinutes: 120 });
    // 120 settings-minutes = 1,200 ms; 80 % = 960 ms.
    expect(evaluateWrapUp(guardState(), settings, T0 + 959)).toBeNull();
    expect(evaluateWrapUp(guardState({ waitingOnHost: true }), settings, T0 + 960)).toEqual({
      guard: "time",
      percent: 80,
      detail: "96 of 120 min",
    });
    expect(evaluateWrapUp(guardState(), settings, T0 + 1_100)?.percent).toBe(91);
  });

  it("measures the budget by the larger of the USD and token fractions", () => {
    const settings = guardSettings({
      wrapUpNudge: true,
      wrapUpPercent: 80,
      runBudget: true,
      runBudgetUsd: 5,
      runBudgetTokens: 500_000,
    });
    expect(evaluateWrapUp(guardState({ costUsd: 4.1, tokens: 100_000 }), settings, T0)).toEqual({
      guard: "budget",
      percent: 82,
      detail: "$4.10 of $5.00",
    });
    expect(evaluateWrapUp(guardState({ costUsd: 4.1, tokens: 450_000 }), settings, T0)).toEqual({
      guard: "budget",
      percent: 90,
      detail: "450,000 of 500,000 tokens",
    });
    expect(evaluateWrapUp(guardState({ costUsd: 3.9, tokens: 390_000 }), settings, T0)).toBeNull();
    // 0.57 * 100 is 56.99… in floating point; the threshold and the shown percent still read 57.
    const exact = guardSettings({ wrapUpNudge: true, wrapUpPercent: 57, runBudget: true, runBudgetUsd: 1, runBudgetTokens: 0 });
    expect(evaluateWrapUp(guardState({ costUsd: 0.57 }), exact, T0)?.percent).toBe(57);
  });

  it("picks the guard further along when both the time limit and the budget are on", () => {
    const settings = guardSettings({
      wrapUpNudge: true,
      wrapUpPercent: 50,
      runTimeLimit: true,
      runTimeLimitMinutes: 100,
      runBudget: true,
      runBudgetUsd: 10,
      runBudgetTokens: 0,
    });
    expect(evaluateWrapUp(guardState({ costUsd: 6 }), settings, T0 + 70 * MINUTE)?.guard).toBe("time");
    expect(evaluateWrapUp(guardState({ costUsd: 8 }), settings, T0 + 70 * MINUTE)?.guard).toBe("budget");
  });

  it("leaves a run at or past the limit to the hard guard", () => {
    const settings = guardSettings({
      wrapUpNudge: true,
      wrapUpPercent: 80,
      runTimeLimit: true,
      runTimeLimitMinutes: 10,
      runBudget: true,
      runBudgetUsd: 5,
      runBudgetTokens: 0,
    });
    expect(evaluateWrapUp(guardState(), settings, T0 + 10 * MINUTE)).toBeNull();
    expect(evaluateWrapUp(guardState({ costUsd: 6 }), settings, T0 + 9 * MINUTE)).toBeNull();
  });

  it("ignores zero budget caps", () => {
    const settings = guardSettings({ wrapUpNudge: true, wrapUpPercent: 80, runBudget: true, runBudgetUsd: 0, runBudgetTokens: 0 });
    expect(evaluateWrapUp(guardState({ costUsd: 1_000, tokens: 1e9 }), settings, T0)).toBeNull();
    const tokensOnly = { ...settings, runBudgetTokens: 1_000 };
    expect(evaluateWrapUp(guardState({ costUsd: 1_000, tokens: 850 }), tokensOnly, T0)).toEqual({
      guard: "budget",
      percent: 85,
      detail: "850 of 1,000 tokens",
    });
  });

  it("tells the agent how much it used and to wrap up with its Report", () => {
    const time = wrapUpSteerMessage({ guard: "time", percent: 85, detail: "102 of 120 min" });
    expect(time).toContain("85% of your run time limit (102 of 120 min)");
    expect(time).toMatch(/do not start new work/);
    expect(time).toMatch(/Report/);
    expect(wrapUpSteerMessage({ guard: "budget", percent: 90, detail: "$4.50 of $5.00" })).toContain(
      "90% of your run budget ($4.50 of $5.00)",
    );
  });
});

describe("run usage", () => {
  it("reads the session spend from get_session_stats and adds the subagents'", () => {
    expect(sessionUsage({ cost: 1.5, tokens: { total: 2_000 }, contextUsage: { tokens: 10 } })).toEqual({
      costUsd: 1.5,
      tokens: 2_000,
    });
    expect(sessionUsage({ contextUsage: { tokens: 10 } })).toBeNull();
    expect(sessionUsage(undefined)).toBeNull();
    const subagents = [
      { id: "a", agent: "task", status: "running", cost: 0.25, tokens: 300 },
      { id: "b", agent: "scout", status: "completed" },
    ] as const;
    expect(totalUsage({ costUsd: 1.5, tokens: 2_000 }, subagents)).toEqual({ costUsd: 1.75, tokens: 2_300 });
  });
});

// --- through the manager (fake omp) ------------------------------------------------------------

describe("run guards through the agent manager", () => {
  let root: string;
  let workdir: string;
  let logFile: string;
  let repo: Repository;
  let board: Board;
  let events: ServerEvent[];
  let unsubscribe: () => void;

  async function waitFor<T>(check: () => T | Promise<T>, description: string, timeoutMs = 15_000): Promise<NonNullable<T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value) return value as NonNullable<T>;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
      await sleep(20);
    }
  }

  function sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  }

  /** Card-run processes the fake started (helpers excluded). */
  function spawnedRuns(): number {
    if (!existsSync(logFile)) return 0;
    return readFileSync(logFile, "utf8")
      .split("\n")
      .filter((line) => line.includes('"kind":"argv"')).length;
  }

  interface LogEntry {
    kind: string;
    argv?: string[];
    message?: string;
    via?: string;
    streamingBehavior?: string;
    command?: { type: string; message?: string; streamingBehavior?: string };
  }

  function logEntries(): LogEntry[] {
    if (!existsSync(logFile)) return [];
    return readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogEntry);
  }

  /** Every `prompt` command card runs got, steers included. */
  function promptsReceived(): number {
    return logEntries().filter((e) => e.kind === "command" && e.command?.type === "prompt").length;
  }

  /** The `--config` overlay each card run was started with, in spawn order. */
  function runConfigs(): Record<string, unknown>[] {
    return logEntries()
      .filter((e) => e.kind === "argv")
      .map((e) => {
        const argv = e.argv ?? [];
        const index = argv.indexOf("--config");
        expect(index).toBeGreaterThanOrEqual(0);
        return JSON.parse(readFileSync(argv[index + 1]!, "utf8")) as Record<string, unknown>;
      });
  }

  async function getTask(id: string): Promise<Task> {
    const task = await repo.getTask(id);
    if (!task) throw new Error(`task ${id} not found`);
    return task;
  }

  function waitTask(id: string, predicate: (task: Task) => boolean, description: string): Promise<Task> {
    return waitFor(async () => {
      const task = await getTask(id);
      return predicate(task) ? task : null;
    }, description);
  }

  async function runs(taskId: string): Promise<Run[]> {
    return repo.listRuns(taskId);
  }

  /** Starts a card whose prompt picks the fake's scenario; resolves once omp got the prompt. */
  async function startCard(title: string, scenario: string): Promise<{ task: Task; manager: AgentManager }> {
    const task = await repo.createTask({ boardId: board.id, title, description: `[fake:${scenario}]`, status: "todo" });
    const manager = await getAgentManager();
    const before = promptsReceived();
    await manager.start(task.id);
    await waitFor(() => promptsReceived() > before, "omp to receive the prompt");
    return { task, manager };
  }

  beforeAll(() => {
    chmodSync(FAKE_OMP, 0o755);
  });

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "omp-ui-run-guards-test-")));
    workdir = path.join(root, "project");
    const sessionDir = path.join(root, "sessions");
    logFile = path.join(root, "fake-omp.log");
    mkdirSync(workdir);
    mkdirSync(sessionDir);

    process.env.DATABASE_URL = `sqlite:${path.join(root, "omp-ui.db")}`;
    process.env.DATA_DIR = root;
    process.env.OMP_PATH = FAKE_OMP;
    process.env.FAKE_OMP_LOG = logFile;
    process.env.FAKE_OMP_SESSION_DIR = sessionDir;
    process.env.FAKE_OMP_SCENARIO = "success";
    delete process.env.MAX_AGENTS;
    delete process.env.OMP_EXTRA_ARGS;
    delete process.env.FAKE_OMP_MODEL_ROLES;
    delete process.env.FAKE_OMP_PLAN;
    delete process.env.FAKE_OMP_COST_PER_MESSAGE;
    delete process.env.OMP_UI_QUOTA_RETRY_BASE_MS;
    process.env.OMP_UI_RETRY_BASE_MS = "50";
    // A settings minute is 20 ms (time limit ≥ 5 min = 100 ms, stall ≥ 2 min = 40 ms); tick every 20 ms.
    process.env.OMP_UI_GUARD_MINUTE_MS = "20";
    process.env.OMP_UI_GUARD_TICK_MS = "20";
    globals.__ompUiRepo = undefined;
    globals.__ompUiAgentManager = undefined;

    repo = await getRepo();
    board = await repo.createBoard({ name: "Test board", workdir, model: "fake/model-1" });
    await updateAppSettings(repo, { autoRetry: true, maxAutoRetries: 2, persistentRetry: false });
    events = [];
    unsubscribe = subscribe((event) => events.push(event));
  });

  afterEach(async () => {
    unsubscribe();
    const pendingManager = globals.__ompUiAgentManager;
    if (pendingManager) {
      const manager = await pendingManager.catch(() => null);
      if (manager) {
        const { running, queued } = manager.stats();
        await Promise.all([...running, ...queued].map((id) => manager.stop(id).catch(() => null)));
        await waitFor(() => {
          const stats = manager.stats();
          return stats.running.length === 0 && stats.queued.length === 0;
        }, "the agent manager to become idle").catch(() => undefined);
      }
    }
    const live = [...(globals.__ompUiRpcProcesses ?? [])];
    for (const proc of live) proc.kill("SIGKILL");
    await Promise.all(live.map((proc) => proc.waitExit()));
    await repo.close();
    globals.__ompUiRepo = undefined;
    globals.__ompUiAgentManager = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("stops a run at its time limit without an automatic retry", async () => {
    await updateAppSettings(repo, { runTimeLimit: true, runTimeLimitMinutes: 5 });
    const { task } = await startCard("Endless", "slow");

    const failed = await waitTask(task.id, (t) => t.agentState === "error", "the time limit to stop the run");
    const message = "Run time limit reached (5 min); stopped without an automatic retry.";
    expect(failed).toMatchObject({ agentError: message, retryAt: null, autoRetries: 0 });
    const [run] = await runs(task.id);
    expect(run).toMatchObject({ status: "failed", error: message });
    // Real delay: proves an absence (no retry run spawned) against real omp subprocesses.
    await sleep(200);
    expect(spawnedRuns()).toBe(1);
  });

  it("leaves runs alone while the guards are off, and applies a guard turned on mid-run", async () => {
    process.env.FAKE_OMP_COST_PER_MESSAGE = "100";
    const { task, manager } = await startCard("Long and costly", "spend");

    // Far past every limit (5-min time limit = 100 ms, 2-min stall = 40 ms, $5 budget).
    // Real delay: the guards must stay idle while real time passes far beyond every limit.
    await sleep(400);
    expect(await getTask(task.id)).toMatchObject({ agentState: "running", agentError: null });
    expect(manager.stats().running).toEqual([task.id]);

    await updateAppSettings(repo, { runTimeLimit: true, runTimeLimitMinutes: 5 });
    const failed = await waitTask(task.id, (t) => t.agentState === "error", "the time limit turned on to stop the run");
    expect(failed.agentError).toBe("Run time limit reached (5 min); stopped without an automatic retry.");
    expect(failed.retryAt).toBeNull();
  });

  it("fails a silent run with the stall watchdog and retries it automatically", async () => {
    await updateAppSettings(repo, { stallWatchdog: true, stallTimeoutMinutes: 2, maxAutoRetries: 1 });
    const { task } = await startCard("Hangs", "slow");

    const message = "No activity from the agent for 2 min (stall watchdog)";
    // The retry stalls as well; with one retry allowed the card then stays failed.
    const final = await waitTask(
      task.id,
      (t) => t.agentState === "error" && t.autoRetries === 1 && t.retryAt === null && spawnedRuns() === 2,
      "the retried run to stall as well",
    );
    expect(final.agentError).toBe(message);
    const scheduled = events.some(
      (e) => e.type === "task.updated" && e.task.id === task.id && e.task.agentState === "error" && e.task.retryAt !== null,
    );
    expect(scheduled).toBe(true);
    const all = await runs(task.id);
    expect(all).toHaveLength(2);
    expect(all.map((r) => [r.status, r.error])).toEqual([
      ["failed", message],
      ["failed", message],
    ]);
  });

  it("stops a run over its USD budget as soon as omp reports the spend, without a retry", async () => {
    // A slow tick: the budget check right after the assistant message must catch it.
    process.env.OMP_UI_GUARD_TICK_MS = "600000";
    process.env.FAKE_OMP_COST_PER_MESSAGE = "7.5";
    await updateAppSettings(repo, { runBudget: true, runBudgetUsd: 5, runBudgetTokens: 0 });
    const { task } = await startCard("Spendy", "spend");

    const failed = await waitTask(task.id, (t) => t.agentState === "error", "the budget to stop the run");
    const message = "Run budget exceeded: $7.50 of $5.00; stopped without an automatic retry.";
    expect(failed).toMatchObject({ agentError: message, retryAt: null, autoRetries: 0 });
    const [run] = await runs(task.id);
    expect(run).toMatchObject({ status: "failed", error: message });
    // Real delay: proves an absence (no retry run spawned) against real omp subprocesses.
    await sleep(200);
    expect(spawnedRuns()).toBe(1);
  });

  it("stops a run over its token budget", async () => {
    await updateAppSettings(repo, { runBudget: true, runBudgetUsd: 0, runBudgetTokens: 500 });
    const { task } = await startCard("Wordy", "spend");

    const failed = await waitTask(task.id, (t) => t.agentState === "error", "the token budget to stop the run");
    expect(failed.agentError).toBe("Run budget exceeded: 1,000 of 500 tokens; stopped without an automatic retry.");
    expect(failed.retryAt).toBeNull();
  });

  it("nudges the agent to wrap up exactly once before the time limit stops the run", async () => {
    // 20-min limit = 400 ms, nudge at 50 % = 200 ms: ~10 supervisor ticks fall between the two.
    await updateAppSettings(repo, { runTimeLimit: true, runTimeLimitMinutes: 20, wrapUpNudge: true, wrapUpPercent: 50 });
    // "spend" keeps working after a steer ("slow" would complete on it).
    const { task } = await startCard("Long", "spend");

    const failed = await waitTask(task.id, (t) => t.agentState === "error", "the time limit to stop the run");
    expect(failed.agentError).toBe("Run time limit reached (20 min); stopped without an automatic retry.");
    const steers = logEntries().filter((e) => e.kind === "steer");
    expect(steers).toHaveLength(1);
    expect(steers[0]).toMatchObject({ via: "prompt", streamingBehavior: "steer" });
    expect(steers[0]!.message).toContain("of your run time limit");
    expect(steers[0]!.message).toContain("Wrap up now");
    // The run's prompt plus the one nudge.
    expect(promptsReceived()).toBe(2);
  });

  it("passes the orchestration limits to omp in the run's config overlay", async () => {
    await updateAppSettings(repo, {
      subagentLimits: true,
      subagentMaxDepth: 2,
      contextCompaction: true,
      contextCompactPercent: 60,
    });
    await startCard("Limited", "success");
    await updateAppSettings(repo, { subagentLimits: false, contextCompaction: false });
    await startCard("Plain", "success");

    const [limited, plain] = runConfigs();
    expect(limited).toMatchObject({
      task: { maxConcurrency: expect.any(Number), maxRecursionDepth: 2 },
      compaction: { thresholdPercent: 60 },
    });
    expect(Object.keys(plain!)).toEqual(["browser"]);
    const { screenshotDir: _plainDir, ...plainBrowser } = plain!.browser as Record<string, unknown>;
    const { screenshotDir: _limitedDir, ...limitedBrowser } = limited!.browser as Record<string, unknown>;
    expect(plainBrowser).toEqual(limitedBrowser);
  });
});
