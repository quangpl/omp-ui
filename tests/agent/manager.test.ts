import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getAgentManager } from "@/lib/agent/manager";
import type { OmpRpcProcess } from "@/lib/agent/rpc";
import type { AgentManager } from "@/lib/agent/types";
import { getRepo } from "@/lib/db";
import type { Repository } from "@/lib/db/types";
import { subscribe } from "@/lib/events";
import { updateAppSettings } from "@/lib/settings";
import type { Board, Comment, Run, RunEvent, ServerEvent, SubagentSnapshot, Task } from "@/lib/types";

const FAKE_OMP = fileURLToPath(new URL("../fixtures/fake-omp.mjs", import.meta.url));
const SUCCESS_SUMMARY = "Fake summary: implemented the task and ran the tests.";
const QUOTA_ERROR = "Fake model error: 429 You have exceeded your quota (usage limit reached)";

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
  "OMP_UI_RETRY_BASE_MS",
  "OMP_UI_QUOTA_RETRY_BASE_MS",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

interface LogEntry {
  pid: number;
  kind: string;
  argv?: string[];
  cwd?: string;
  command?: { type: string; id?: string; message?: string };
  message?: string;
  /** "steer" entries: set when the message came as a `prompt` with streamingBehavior. */
  via?: string;
  streamingBehavior?: string;
  /** "helper" entries (advisor, queue planner): the prompt a helper worker got. */
  prompt?: string;
}

let root: string;
let workdir: string;
let sessionDir: string;
let logFile: string;
let repo: Repository;
let board: Board;
let events: ServerEvent[];
let unsubscribe: () => void;

// --- helpers ---------------------------------------------------------------------------------

async function waitFor<T>(
  check: () => T | Promise<T>,
  description: string,
  timeoutMs = 15_000,
): Promise<NonNullable<T>> {
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

function readLog(): LogEntry[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

function argvEntries(): LogEntry[] {
  return readLog().filter((e) => e.kind === "argv");
}

function commands(type: string, pid?: number): LogEntry[] {
  return readLog().filter(
    (e) => e.kind === "command" && e.command?.type === type && (pid === undefined || e.pid === pid),
  );
}

/** Every value that follows `flag` in an argv list. */
function flagValues(argv: string[] = [], flag: string): string[] {
  return argv.flatMap((arg, i) => (arg === flag && i + 1 < argv.length ? [argv[i + 1]!] : []));
}

async function createTask(title: string, description = "", status: Task["status"] = "todo"): Promise<Task> {
  return repo.createTask({ boardId: board.id, title, description, status });
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

function waitDone(id: string): Promise<Task> {
  return waitTask(id, (t) => t.status === "done" && t.agentState === "idle", `task ${id} to finish`);
}

async function waitIdleManager(manager: AgentManager): Promise<void> {
  await waitFor(() => {
    const { running, queued } = manager.stats();
    return running.length === 0 && queued.length === 0;
  }, "the agent manager to become idle");
}

/** Waits until the fake received the prompt for this task's run; returns that process' pid. */
async function waitPromptReceived(previousPrompts = 0): Promise<number> {
  const entry = await waitFor(() => commands("prompt")[previousPrompts], "omp to receive the prompt");
  return entry.pid;
}

async function latestRun(taskId: string): Promise<Run> {
  const [run] = await repo.listRuns(taskId);
  if (!run) throw new Error(`no run for task ${taskId}`);
  return run;
}

async function runEvents(runId: string): Promise<RunEvent[]> {
  return repo.listRunEvents(runId, 0, 1000);
}

function agentComments(comments: Comment[]): Comment[] {
  return comments.filter((c) => c.author === "agent");
}

/** task.updated agentState transitions published for a task, consecutive duplicates collapsed. */
function publishedAgentStates(taskId: string): string[] {
  const states: string[] = [];
  for (const e of events) {
    if (e.type !== "task.updated" || e.task.id !== taskId) continue;
    if (states.at(-1) !== e.task.agentState) states.push(e.task.agentState);
  }
  return states;
}

/** "helper" entries of the smart-queue planner. */
function plannerEntries(): LogEntry[] {
  return readLog().filter((e) => e.kind === "helper" && e.prompt?.startsWith("You are the queue planner"));
}

/** Task ids ordered by when their (latest) run started. */
async function runStartOrder(ids: string[]): Promise<string[]> {
  const starts = await Promise.all(ids.map(async (id) => [id, (await latestRun(id)).startedAt] as const));
  return starts.sort((x, y) => x[1].localeCompare(y[1])).map(([id]) => id);
}

// --- setup -----------------------------------------------------------------------------------

beforeAll(() => {
  chmodSync(FAKE_OMP, 0o755);
});

beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "omp-ui-manager-test-")));
  workdir = path.join(root, "project");
  sessionDir = path.join(root, "sessions");
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
  process.env.OMP_UI_RETRY_BASE_MS = "50";
  delete process.env.OMP_UI_QUOTA_RETRY_BASE_MS;
  globals.__ompUiRepo = undefined;
  globals.__ompUiAgentManager = undefined;

  repo = await getRepo();
  board = await repo.createBoard({ name: "Test board", workdir, model: "fake/model-1" });
  // Automatic retries have their own tests; everywhere else a failed run stays failed.
  await updateAppSettings(repo, { autoRetry: false });
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
      await waitIdleManager(manager).catch(() => undefined);
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

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// --- tests -----------------------------------------------------------------------------------

describe("AgentManager run lifecycle", () => {
  it("runs a task from queued to done with summary, resolved feedback, session and events", async () => {
    const task = await createTask("Add a login page", "Use the existing form components.");
    const feedback = await repo.addComment({ taskId: task.id, author: "user", body: "Please add tests" });
    const manager = await getAgentManager();

    const started = await manager.start(task.id);
    expect(started).toMatchObject({ status: "in_progress", agentState: "queued", agentError: null });

    const done = await waitDone(task.id);
    await waitIdleManager(manager);

    const runs = await repo.listRuns(task.id);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run).toMatchObject({ status: "succeeded", summary: SUCCESS_SUMMARY, error: null });
    expect(run.endedAt).not.toBeNull();
    expect(run.prompt).toContain("# Task: Add a login page");
    expect(run.prompt).toContain("1. Please add tests");

    expect(done.lastRunId).toBe(run.id);
    expect(done.agentError).toBeNull();
    expect(done.sessionFile).not.toBeNull();
    expect(path.dirname(path.dirname(done.sessionFile!))).toBe(sessionDir);
    expect(existsSync(done.sessionFile!)).toBe(true);
    expect(done.openCommentCount).toBe(0);

    const comments = await repo.listComments(task.id);
    const resolvedFeedback = comments.find((c) => c.id === feedback.id);
    expect(resolvedFeedback).toMatchObject({ resolved: true, resolvedByRunId: run.id });
    expect(resolvedFeedback?.resolvedAt).not.toBeNull();
    const agent = agentComments(comments);
    expect(agent).toHaveLength(1);
    expect(agent[0]).toMatchObject({ body: SUCCESS_SUMMARY, resolved: true });

    const runLog = await runEvents(run.id);
    const texts = (kind: RunEvent["kind"]) => runLog.filter((e) => e.kind === kind).map((e) => e.text);
    expect(texts("status")).toContain(`Starting agent in ${workdir} (model fake/model-1)`);
    expect(texts("status")).toContain("Prompt sent to agent");
    expect(texts("status").at(-1)).toBe("Agent finished");
    expect(texts("text")).toEqual([SUCCESS_SUMMARY]);
    // The call's intent rides on a second line.
    expect(texts("tool")).toEqual(["▸ bash: npm test\nRunning the tests"]);
    expect(texts("error")).toEqual([]);

    const [spawned, ...others] = argvEntries();
    expect(others).toHaveLength(0);
    expect(spawned?.cwd).toBe(workdir);
    expect(spawned?.argv?.slice(0, 2)).toEqual(["--mode", "rpc"]);
    expect(flagValues(spawned?.argv, "--cwd")).toEqual([workdir]);
    expect(flagValues(spawned?.argv, "--approval-mode")).toEqual(["yolo"]);
    expect(flagValues(spawned?.argv, "--model")).toEqual(["fake/model-1"]);
    expect(flagValues(spawned?.argv, "--resume")).toEqual([]);
    expect(spawned?.argv).toContain("--no-title");
    expect(commands("prompt")[0]?.command?.message).toBe(run.prompt);

    expect(publishedAgentStates(task.id)).toEqual(["queued", "running", "idle"]);
    const lastTaskEvent = events.findLast((e) => e.type === "task.updated");
    expect(lastTaskEvent).toMatchObject({ task: { id: task.id, status: "done", agentState: "idle" } });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "comment.added",
        boardId: board.id,
        comment: expect.objectContaining({ author: "agent", body: SUCCESS_SUMMARY }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "comment.updated",
        comment: expect.objectContaining({ id: feedback.id, resolved: true, resolvedByRunId: run.id }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "run.updated", run: expect.objectContaining({ id: run.id, status: "succeeded" }) }),
    );
    expect(events.some((e) => e.type === "run.event" && e.event.runId === run.id)).toBe(true);
  });

  it("stores the agent's question on the card and clears it when the next run starts", async () => {
    const task = await createTask("Decide paging", "[fake:question]");
    const manager = await getAgentManager();
    await manager.start(task.id);
    const done = await waitDone(task.id);
    await waitIdleManager(manager);
    expect(done.question).toBe("Should pagination default to 20 or 50 items per page?");

    // Starting the next run (e.g. after an answer) clears the question immediately.
    const restarted = await manager.start(task.id);
    expect(restarted.question).toBeNull();
    await waitDone(task.id);
    await waitIdleManager(manager);
  });

  it("keeps the agent's latest todo list on the card after the run", async () => {
    const task = await createTask("Plan the work", "[fake:todos]");
    const manager = await getAgentManager();
    await manager.start(task.id);
    const done = await waitDone(task.id);
    await waitIdleManager(manager);
    expect(done.todos).toEqual([
      {
        name: "Build",
        tasks: [
          { content: "Write the code", status: "completed", startedAt: expect.any(String), completedAt: expect.any(String) },
          { content: "Add tests", status: "in_progress", startedAt: expect.any(String) },
        ],
      },
      {
        name: "Ship",
        tasks: [
          { content: "Update docs", status: "pending" },
          { content: "Old idea", status: "abandoned" },
        ],
      },
    ]);
    // "Write the code" keeps the stamp of the update that first showed it in progress.
    const [written, testing] = done.todos[0]!.tasks;
    expect(Date.parse(written!.startedAt!)).toBeLessThanOrEqual(Date.parse(written!.completedAt!));
    expect(testing!.startedAt).toBe(written!.completedAt);
  });

  it("answers the agent's ask_advisor call with the advisor's decision", async () => {
    const calls = [
      { toolName: "ask_advisor", arguments: { question: "Offset or cursor pagination?", options: ["offset", "cursor"] } },
    ];
    const task = await createTask("Add paging", `[fake:board_tools] <calls>${JSON.stringify(calls)}</calls>`);
    const manager = await getAgentManager();
    await manager.start(task.id);
    await waitDone(task.id);

    const run = await latestRun(task.id);
    const [result] = JSON.parse((run.summary ?? "").replace(/^Tool results: /, "")) as { isError: boolean; text: string }[];
    expect(result).toMatchObject({ isError: false });
    expect(result!.text).toContain("Advisor's decision: Use offset pagination with 20 items per page");
    const [advisor] = readLog().filter((e) => e.kind === "helper");
    expect(flagValues(advisor?.argv, "--tools")).toEqual(["read,grep,glob"]);
    expect(advisor?.cwd).toBe(workdir);
    expect(advisor?.prompt).toContain("Offset or cursor pagination?");
    expect(advisor?.prompt).toContain("Title: Add paging");
    const texts = (await runEvents(run.id)).map((e) => e.text);
    expect(texts).toContain("Agent asked the advisor: Offset or cursor pagination?");
    expect(texts).toContain("Advisor: Use offset pagination with 20 items per page");
  });

  it("lets the advisor answer the run's question and send the agent back to work once", async () => {
    const task = await createTask("Decide paging", "[fake:question] [fake-advisor:answer]");
    const manager = await getAgentManager();
    await manager.start(task.id);
    // Run 1 asks, the advisor answers with a follow-up; run 2 asks again and the guard stops the loop.
    const done = await waitTask(
      task.id,
      (t) => t.status === "done" && t.agentState === "idle" && t.question !== null,
      "the second run to finish",
    );
    await waitIdleManager(manager);

    expect(done.question).toBe("Should pagination default to 20 or 50 items per page?");
    expect(await repo.listRuns(task.id)).toHaveLength(2);
    expect(readLog().filter((e) => e.kind === "helper")).toHaveLength(2);
    const comments = await repo.listComments(task.id);
    const followUp = comments.find((c) => c.author === "user");
    expect(followUp).toMatchObject({ resolved: true });
    expect(followUp?.body).toMatch(/^\*\*Advisor:\*\* Set the default page size to 20/);
    expect(comments.filter((c) => c.body.startsWith("**Advisor** answered"))).toHaveLength(2);
    // The follow-up went to the resumed session as feedback.
    expect(commands("prompt")[1]?.command?.message).toContain("Set the default page size to 20");
  });

  it("leaves the question to the user when the advisor fails", async () => {
    const task = await createTask("Decide paging", "[fake:question] [fake-advisor:fail]");
    const manager = await getAgentManager();
    await manager.start(task.id);
    const done = await waitDone(task.id);
    await waitIdleManager(manager);

    expect(done.question).toBe("Should pagination default to 20 or 50 items per page?");
    expect(await repo.listRuns(task.id)).toHaveLength(1);
    const texts = (await runEvents((await latestRun(task.id)).id)).map((e) => e.text);
    expect(texts.some((t) => t.startsWith("Advisor could not review the questions"))).toBe(true);
  });

  it("closes the omp process after a successful run", async () => {
    const task = await createTask("Close me");
    const manager = await getAgentManager();
    await manager.start(task.id);
    await waitDone(task.id);

    await waitFor(() => readLog().some((e) => e.kind === "stdin_closed"), "omp stdin to be closed");
  });

  it("treats start() on an active task as a no-op and rejects unknown tasks", async () => {
    const task = await createTask("Only once", "[fake:slow]");
    const manager = await getAgentManager();

    await manager.start(task.id);
    await waitPromptReceived();
    const again = await manager.start(task.id);
    expect(again.agentState).toBe("running");
    expect(manager.stats()).toEqual({ running: [task.id], queued: [] });
    expect(argvEntries()).toHaveLength(1);
    expect(await repo.listRuns(task.id)).toHaveLength(1);

    await expect(manager.start("no-such-task")).rejects.toThrow("Task not found");
  });

  it("records a model error: agentState error, card stays in progress, failure comment", async () => {
    const task = await createTask("Break things", "[fake:error]");
    const feedback = await repo.addComment({ taskId: task.id, author: "user", body: "Keep it small" });
    const manager = await getAgentManager();

    await manager.start(task.id);
    const failed = await waitTask(task.id, (t) => t.agentState === "error", "the run to fail");
    await waitIdleManager(manager);

    expect(failed.status).toBe("in_progress");
    expect(failed.agentError).toBe("Fake model error: upstream failed");
    const run = await latestRun(task.id);
    expect(run).toMatchObject({ status: "failed", error: "Fake model error: upstream failed", summary: null });

    const comments = await repo.listComments(task.id);
    expect(agentComments(comments).map((c) => c.body)).toEqual(["Agent failed: Fake model error: upstream failed"]);
    expect(comments.find((c) => c.id === feedback.id)).toMatchObject({ resolved: false, resolvedByRunId: null });

    const errors = (await runEvents(run.id)).filter((e) => e.kind === "error").map((e) => e.text);
    expect(errors).toContain("Model error: Fake model error: upstream failed");
    expect(publishedAgentStates(task.id)).toEqual(["queued", "running", "error"]);
  });

  it("records orchestrated subagents: persisted milestones, live progress, final reports", async () => {
    const task = await createTask("Split the work", "[fake:orchestrate]");
    const manager = await getAgentManager();

    await manager.start(task.id);
    await waitDone(task.id);
    await waitIdleManager(manager);

    const run = await latestRun(task.id);
    const runLog = await runEvents(run.id);
    expect(runLog.filter((e) => e.kind === "tool").map((e) => e.text)).toContain(
      "▸ task: Splitting the work — delegating to 2 subagents (Scout, Builder)",
    );
    const snapshots = runLog.filter((e) => e.kind === "agent").map((e) => JSON.parse(e.text) as SubagentSnapshot);
    const latest = new Map(snapshots.map((s) => [s.id, s]));
    expect(latest.get("Scout")).toMatchObject({
      agent: "scout",
      status: "completed",
      task: "Map the login form code and its tests.",
      output: "Found the form in src/login.tsx; tests live in tests/login.test.ts.",
      toolCount: 6,
    });
    expect(latest.get("Scout")?.currentTool).toBeUndefined();
    expect(latest.get("Builder")).toMatchObject({ agent: "task", status: "failed", error: "Type error in src/login.tsx" });
    // Progress ticks are live-only; the log keeps the milestones (first sighting, status, report).
    expect(snapshots.length).toBeLessThanOrEqual(6);
    const live = events.filter((e) => e.type === "run.agent" && e.runId === run.id);
    expect(live.length).toBeGreaterThan(0);
    expect(live).toContainEqual(
      expect.objectContaining({ agent: expect.objectContaining({ id: "Scout", status: "running", currentTool: expect.any(String) }) }),
    );
  });

  it("marks subagents still working when the run is stopped as aborted", async () => {
    process.env.FAKE_OMP_STEP_MS = "5000";
    try {
      const task = await createTask("Split the work", "[fake:orchestrate]");
      const manager = await getAgentManager();

      await manager.start(task.id);
      const run = await waitFor(async () => {
        const [current] = await repo.listRuns(task.id);
        if (!current) return null;
        const spawned = (await runEvents(current.id)).filter((e) => e.kind === "agent");
        return spawned.length >= 2 ? current : null;
      }, "subagents to be recorded");
      await manager.stop(task.id);
      await waitIdleManager(manager);

      const snapshots = (await runEvents(run.id))
        .filter((e) => e.kind === "agent")
        .map((e) => JSON.parse(e.text) as SubagentSnapshot);
      const latest = new Map(snapshots.map((s) => [s.id, s.status]));
      expect(Object.fromEntries(latest)).toEqual({ Scout: "aborted", Builder: "aborted" });
    } finally {
      delete process.env.FAKE_OMP_STEP_MS;
    }
  });

  it("records a crash as an error and never leaves the task running", async () => {
    const task = await createTask("Crash", "[fake:crash]");
    const manager = await getAgentManager();

    await manager.start(task.id);
    const failed = await waitTask(task.id, (t) => t.agentState === "error", "the crash to be recorded");
    await waitIdleManager(manager);

    expect(failed.status).toBe("in_progress");
    expect(failed.agentError).toMatch(/omp exited unexpectedly \(code 1: fake omp: segmentation fault/);
    const run = await latestRun(task.id);
    expect(run.status).toBe("failed");
    expect(run.error).toBe(failed.agentError);
    expect(run.endedAt).not.toBeNull();
    const comments = await repo.listComments(task.id);
    expect(agentComments(comments).map((c) => c.body)).toEqual([`Agent failed: ${failed.agentError}`]);
    expect((await getTask(task.id)).agentState).toBe("error");
  });

  it("fails with an install hint when the omp binary is missing", async () => {
    const missing = path.join(root, "bin", "omp");
    await updateAppSettings(repo, { ompPath: missing });
    const task = await createTask("No omp");
    const manager = await getAgentManager();

    await manager.start(task.id);
    const failed = await waitTask(task.id, (t) => t.agentState === "error", "the spawn failure");
    await waitIdleManager(manager);

    expect(failed.agentError).toContain(`omp not found at ${missing}`);
    expect(failed.agentError).toContain("Install from https://omp.sh");
    expect((await latestRun(task.id)).status).toBe("failed");
    const comments = await repo.listComments(task.id);
    expect(agentComments(comments)[0]?.body).toBe(`Agent failed: ${failed.agentError}`);
    expect(argvEntries()).toHaveLength(0);
  });

  it("fails when the board directory does not exist", async () => {
    const gone = path.join(root, "gone");
    board = (await repo.updateBoard(board.id, { workdir: gone }))!;
    const task = await createTask("Nowhere");
    const manager = await getAgentManager();

    await manager.start(task.id);
    const failed = await waitTask(task.id, (t) => t.agentState === "error", "the workdir failure");
    expect(failed.agentError).toBe(`Board directory not found: ${gone}`);
    expect(argvEntries()).toHaveLength(0);
  });
});

describe("AgentManager stop and moves", () => {
  it("stop() aborts a running agent and leaves the card in its column, idle", async () => {
    const task = await createTask("Long job", "[fake:slow]");
    const manager = await getAgentManager();
    await manager.start(task.id);
    const pid = await waitPromptReceived();

    const stopped = await manager.stop(task.id);

    expect(stopped).toMatchObject({ id: task.id, status: "in_progress", agentState: "idle", agentError: null });
    const run = await latestRun(task.id);
    expect(run).toMatchObject({ status: "aborted", error: "Stopped by user" });
    expect(run.endedAt).not.toBeNull();
    expect((await runEvents(run.id)).map((e) => e.text)).toContain("Stopped by user");
    expect(manager.stats()).toEqual({ running: [], queued: [] });
    // The abort is written before stop() resolves; the fake logs it asynchronously.
    await waitFor(() => commands("abort", pid).length === 1, "omp to receive abort");
    await waitFor(
      () => readLog().some((e) => e.kind === "stdin_closed" && e.pid === pid),
      "the aborted omp process to be closed",
    );
    expect(agentComments(await repo.listComments(task.id))).toEqual([]);
    expect((await getTask(task.id)).agentState).toBe("idle");
  });

  it("stop() on a queued task removes it from the queue without spawning", async () => {
    await updateAppSettings(repo, { maxConcurrentAgents: 1 });
    const first = await createTask("First", "[fake:slow]");
    const second = await createTask("Second");
    const manager = await getAgentManager();
    await manager.start(first.id);
    await waitPromptReceived();
    await manager.start(second.id);

    const stopped = await manager.stop(second.id);
    expect(stopped).toMatchObject({ agentState: "idle", status: "in_progress" });
    expect(manager.stats().queued).toEqual([]);
    expect(await repo.listRuns(second.id)).toHaveLength(0);
  });

  it("moving a running task to todo stops the agent", async () => {
    const task = await createTask("Move me", "[fake:slow]");
    const manager = await getAgentManager();
    await manager.start(task.id);
    const pid = await waitPromptReceived();

    const moved = (await repo.updateTask(task.id, { status: "todo" }))!;
    await manager.onTaskMoved(moved, "in_progress");

    const after = await getTask(task.id);
    expect(after).toMatchObject({ status: "todo", agentState: "idle" });
    expect((await latestRun(task.id)).status).toBe("aborted");
    await waitFor(() => commands("abort", pid).length === 1, "omp to receive abort");
    expect(manager.stats()).toEqual({ running: [], queued: [] });
  });

  it("moving a task to in_progress starts it only when the board has autoRun", async () => {
    const manager = await getAgentManager();
    const auto = await createTask("Auto");
    const movedAuto = (await repo.updateTask(auto.id, { status: "in_progress" }))!;
    await manager.onTaskMoved(movedAuto, "todo");
    await waitDone(auto.id);
    expect(await repo.listRuns(auto.id)).toHaveLength(1);

    board = (await repo.updateBoard(board.id, { autoRun: false }))!;
    const manual = await createTask("Manual");
    const movedManual = (await repo.updateTask(manual.id, { status: "in_progress" }))!;
    await manager.onTaskMoved(movedManual, "todo");
    expect(manager.stats()).toEqual({ running: [], queued: [] });
    expect(await getTask(manual.id)).toMatchObject({ status: "in_progress", agentState: "idle" });
    expect(await repo.listRuns(manual.id)).toHaveLength(0);
  });

  it("onTaskDeleted kills the running omp process", async () => {
    const task = await createTask("Delete me", "[fake:slow]");
    const manager = await getAgentManager();
    await manager.start(task.id);
    const pid = await waitPromptReceived();

    await manager.onTaskDeleted(task.id);
    expect(manager.stats()).toEqual({ running: [], queued: [] });
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, "the omp process to exit");
  });
});

describe("AgentManager feedback", () => {
  it("steers a comment into a running session and resolves it when the run succeeds", async () => {
    const task = await createTask("Steer me", "[fake:slow]");
    const manager = await getAgentManager();
    await manager.start(task.id);
    const pid = await waitPromptReceived();

    const comment = await repo.addComment({ taskId: task.id, author: "user", body: "Also update the README" });
    await manager.onComment(await getTask(task.id), comment);
    const done = await waitDone(task.id);

    const steers = readLog().filter((e) => e.kind === "steer" && e.pid === pid);
    expect(steers).toHaveLength(1);
    expect(steers[0]?.message).toContain("Also update the README");
    // Sent like CLI input mid-run, so omp applies magic keywords (the RPC `steer` command skips them).
    expect(steers[0]).toMatchObject({ via: "prompt", streamingBehavior: "steer" });

    const run = await latestRun(task.id);
    expect(done.lastRunId).toBe(run.id);
    expect(run.status).toBe("succeeded");
    expect(await repo.listRuns(task.id)).toHaveLength(1);
    const comments = await repo.listComments(task.id);
    expect(comments.find((c) => c.id === comment.id)).toMatchObject({ resolved: true, resolvedByRunId: run.id });
    expect(agentComments(comments).map((c) => c.body)).toEqual([
      "Fake summary: addressed 1 steered message(s).",
    ]);
    expect((await runEvents(run.id)).map((e) => e.text)).toContain("Feedback sent to agent");
  });

  it("reopens a done task on feedback and resumes the same omp session", async () => {
    const task = await createTask("Resume me", "Build the thing");
    const manager = await getAgentManager();
    await manager.start(task.id);
    const firstDone = await waitDone(task.id);
    const firstRun = await latestRun(task.id);
    const sessionFile = firstDone.sessionFile;
    expect(sessionFile).not.toBeNull();

    const comment = await repo.addComment({ taskId: task.id, author: "user", body: "Please rename the button" });
    await manager.onComment(firstDone, comment);
    expect(await getTask(task.id)).toMatchObject({ status: "in_progress" });

    const secondDone = await waitTask(
      task.id,
      (t) => t.lastRunId !== firstRun.id && t.status === "done" && t.agentState === "idle",
      "the resumed run to finish",
    );
    const secondRun = await latestRun(task.id);
    expect(secondDone.lastRunId).toBe(secondRun.id);
    expect(secondDone.sessionFile).toBe(sessionFile);
    expect(secondRun.status).toBe("succeeded");
    expect(secondRun.prompt.startsWith("New feedback on this task:")).toBe(true);
    expect(secondRun.prompt).toContain("1. Please rename the button");
    expect(secondRun.prompt).not.toContain("# Task:");

    const spawned = argvEntries();
    expect(spawned).toHaveLength(2);
    expect(flagValues(spawned[0]?.argv, "--resume")).toEqual([]);
    expect(flagValues(spawned[1]?.argv, "--resume")).toEqual([sessionFile]);
    expect((await runEvents(secondRun.id)).map((e) => e.text)).toContain(
      `Resuming agent session in ${workdir} (model fake/model-1)`,
    );
    const comments = await repo.listComments(task.id);
    expect(comments.find((c) => c.id === comment.id)).toMatchObject({
      resolved: true,
      resolvedByRunId: secondRun.id,
    });
    expect(agentComments(comments)).toHaveLength(2);
  });

  it("ignores feedback on todo tasks and comments by the agent", async () => {
    const manager = await getAgentManager();
    const todo = await createTask("Later");
    const userComment = await repo.addComment({ taskId: todo.id, author: "user", body: "note" });
    await manager.onComment(todo, userComment);

    const done = await createTask("Finished", "", "done");
    const agentComment = await repo.addComment({ taskId: done.id, author: "agent", body: "hi" });
    await manager.onComment(done, agentComment);

    expect(manager.stats()).toEqual({ running: [], queued: [] });
    expect(await getTask(todo.id)).toMatchObject({ status: "todo", agentState: "idle" });
    expect(await getTask(done.id)).toMatchObject({ status: "done", agentState: "idle" });
    expect(await repo.listRuns(todo.id)).toHaveLength(0);
    expect(await repo.listRuns(done.id)).toHaveLength(0);
  });
});

describe("AgentManager scheduling and project folders", () => {
  it("queues a second task until the first finishes when maxConcurrentAgents is 1", async () => {
    await updateAppSettings(repo, { maxConcurrentAgents: 1 });
    const first = await createTask("First", "[fake:slow]");
    const second = await createTask("Second");
    const manager = await getAgentManager();

    await manager.start(first.id);
    const firstPid = await waitPromptReceived();
    const queued = await manager.start(second.id);
    expect(queued).toMatchObject({ status: "in_progress", agentState: "queued" });

    // Negative check: give the scheduler time it would need to launch a second process.
    await sleep(250);
    expect(manager.stats()).toEqual({ running: [first.id], queued: [second.id] });
    expect(argvEntries()).toHaveLength(1);
    expect((await getTask(second.id)).agentState).toBe("queued");

    // Finish the first run (the slow scenario completes after a steer).
    const comment = await repo.addComment({ taskId: first.id, author: "user", body: "wrap up" });
    await manager.onComment(await getTask(first.id), comment);
    await waitDone(first.id);
    await waitDone(second.id);

    const log = readLog();
    const firstSteer = log.findIndex((e) => e.kind === "steer" && e.pid === firstPid);
    const secondSpawn = log.findIndex((e) => e.kind === "argv" && e.pid !== firstPid);
    expect(firstSteer).toBeGreaterThanOrEqual(0);
    expect(secondSpawn).toBeGreaterThan(firstSteer);
    expect(argvEntries()).toHaveLength(2);
  });

  it("passes existing extra folders as --add-dir and skips missing ones", async () => {
    const extra = path.join(root, "backend");
    const missing = path.join(root, "missing-frontend");
    mkdirSync(extra);
    board = (await repo.updateBoard(board.id, { extraFolders: [extra, missing] }))!;
    const task = await createTask("Multi-repo change");
    const manager = await getAgentManager();

    await manager.start(task.id);
    await waitDone(task.id);

    const [spawned] = argvEntries();
    // The card's and the board's shared files folders come after the project folders.
    expect(flagValues(spawned?.argv, "--add-dir")).toEqual([
      extra,
      path.join(root, "files", "tasks", task.id),
      path.join(root, "files", "boards", board.id),
    ]);
    expect(spawned?.argv).not.toContain(missing);
    const run = await latestRun(task.id);
    expect(run.prompt).toContain(`Project folders: primary ${workdir}, plus ${extra}.`);
    expect(run.prompt).not.toContain(missing);
    expect((await runEvents(run.id)).map((e) => e.text)).toContain(`Skipped missing folder ${missing}`);
  });

  it("uses the default model from settings when the board has none", async () => {
    board = (await repo.updateBoard(board.id, { model: null }))!;
    await updateAppSettings(repo, { defaultModel: "fake/default", approvalMode: "write" });
    const task = await createTask("Default model");
    const manager = await getAgentManager();

    await manager.start(task.id);
    await waitDone(task.id);

    const [spawned] = argvEntries();
    expect(flagValues(spawned?.argv, "--model")).toEqual(["fake/default"]);
    expect(flagValues(spawned?.argv, "--approval-mode")).toEqual(["write"]);
  });

  it("auto-selects the omp role that fits each card and logs why", async () => {
    board = (await repo.updateBoard(board.id, { model: null }))!;
    await updateAppSettings(repo, { defaultModel: "fake/default" });
    process.env.FAKE_OMP_MODEL_ROLES = JSON.stringify({ smol: "fake/fast:low", slow: "fake/deep:xhigh" });
    const manager = await getAgentManager();
    const cards = [
      ["Fix the race condition in the job queue", "Workers deadlock under load."],
      ["Fix typo in README", ""],
      ["Add a CSV export button", "Export the visible rows."],
    ] as const;
    const taskIds: string[] = [];
    for (const [title, description] of cards) {
      const task = await createTask(title, description);
      taskIds.push(task.id);
      await manager.start(task.id);
      await waitDone(task.id);
    }

    const spawned = argvEntries();
    expect(spawned.map((e) => flagValues(e.argv, "--model"))).toEqual([["@slow"], ["@smol"], ["fake/default"]]);
    expect(spawned.map((e) => flagValues(e.argv, "--thinking"))).toEqual([[], [], []]);
    const configCalls = readLog().filter((e) => e.kind === "config");
    expect(configCalls.map((e) => [e.argv, e.cwd])).toEqual(
      cards.map(() => [["config", "get", "modelRoles", "--json"], workdir]),
    );
    const texts = (await runEvents((await latestRun(taskIds[0]!)).id)).map((e) => e.text);
    expect(texts).toContain("Model auto-selected: @slow (needs deep reasoning: concurrency → slow role (fake/deep:xhigh))");
    expect(texts).toContain(`Starting agent in ${workdir} (model @slow)`);
  });

  it("falls back to the default model with a fitting thinking level when omp has no matching role", async () => {
    board = (await repo.updateBoard(board.id, { model: null }))!;
    await updateAppSettings(repo, { defaultModel: "fake/default" });
    process.env.FAKE_OMP_MODEL_ROLES = "fail";
    const task = await createTask("Investigate the memory leak in the SSE stream");
    const manager = await getAgentManager();

    await manager.start(task.id);
    await waitDone(task.id);

    const [spawned] = argvEntries();
    expect(flagValues(spawned?.argv, "--model")).toEqual(["fake/default"]);
    expect(flagValues(spawned?.argv, "--thinking")).toEqual(["high"]);
    const texts = (await runEvents((await latestRun(task.id)).id)).map((e) => e.text);
    expect(texts).toContain(`Starting agent in ${workdir} (model fake/default, thinking high)`);
  });

  it("skips auto selection for a board with a pinned model or when it is turned off", async () => {
    process.env.FAKE_OMP_MODEL_ROLES = JSON.stringify({ slow: "fake/deep" });
    const manager = await getAgentManager();
    const pinned = await createTask("Debug the deadlock");
    await manager.start(pinned.id);
    await waitDone(pinned.id);

    board = (await repo.updateBoard(board.id, { model: null }))!;
    await updateAppSettings(repo, { defaultModel: "", autoModel: false });
    const unpinned = await createTask("Debug the deadlock again");
    await manager.start(unpinned.id);
    await waitDone(unpinned.id);

    const spawned = argvEntries();
    expect(spawned.map((e) => flagValues(e.argv, "--model"))).toEqual([["fake/model-1"], []]);
    expect(spawned.flatMap((e) => flagValues(e.argv, "--thinking"))).toEqual([]);
    expect(readLog().filter((e) => e.kind === "config")).toEqual([]);
  });
});

describe("AgentManager collaboration, dependencies and workspaces", () => {
  it("lets an agent delegate a card and wait for it, lending its slot while it waits", async () => {
    await updateAppSettings(repo, { maxConcurrentAgents: 1 });
    const calls = [
      { toolName: "board_create_card", arguments: { title: "Child", description: "[fake:success] do the part" } },
      { toolName: "board_wait_for_cards", arguments: { cardIds: ["$created"], timeoutSeconds: 20 } },
    ];
    const parent = await createTask("Parent", `[fake:board_tools] <calls>${JSON.stringify(calls)}</calls>`);
    const manager = await getAgentManager();

    await manager.start(parent.id);
    await waitDone(parent.id);

    const child = (await repo.listTasks(board.id)).find((t) => t.title === "Child");
    expect(child).toMatchObject({ status: "done", agentState: "idle", createdByTaskId: parent.id });
    const summary = (await latestRun(parent.id)).summary ?? "";
    const results = JSON.parse(summary.replace(/^Tool results: /, "")) as { toolName: string; isError: boolean; text: string }[];
    expect(results.map((r) => [r.toolName, r.isError])).toEqual([
      ["board_create_card", false],
      ["board_wait_for_cards", false],
    ]);
    const waited = JSON.parse(results[1]!.text) as { cards: { id: string; status: string; summary: string }[] };
    expect(waited.cards).toEqual([expect.objectContaining({ id: child!.id, status: "done", summary: SUCCESS_SUMMARY })]);
    const [spawned] = argvEntries();
    expect(commands("set_host_tools", spawned?.pid).length).toBe(1);
  });

  it("keeps a queued card waiting until every card in blockedBy is Done", async () => {
    const blocker = await createTask("Blocker");
    const waiting = await repo.createTask({ boardId: board.id, title: "Waiting", blockedBy: [blocker.id] });
    const manager = await getAgentManager();

    await manager.start(waiting.id);
    await sleep(250);
    expect(argvEntries()).toHaveLength(0);
    expect((await manager.queueSnapshot()).queued).toEqual([
      expect.objectContaining({ taskId: waiting.id, waitingFor: [blocker.id] }),
    ]);

    const done = (await repo.updateTask(blocker.id, { status: "done" }))!;
    await manager.onTaskMoved(done, "todo");
    await waitDone(waiting.id);
    expect(argvEntries()).toHaveLength(1);
  });

  it("runs a card of a worktrees board in its own git worktree and branch", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: workdir, stdio: "pipe" });
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    board = (await repo.updateBoard(board.id, { worktrees: true }))!;
    const task = await createTask("Isolated change");
    const manager = await getAgentManager();

    await manager.start(task.id);
    await waitDone(task.id);

    const target = path.join(root, "workspaces", task.id, path.basename(workdir));
    const [spawned] = argvEntries();
    expect(flagValues(spawned?.argv, "--cwd")).toEqual([target]);
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: target }).toString().trim();
    expect(branch).toMatch(/^omp\/isolated-change-/);
    expect((await latestRun(task.id)).prompt).toContain(`dedicated git worktree on branch \`${branch}\``);
  });
});

describe("AgentManager smart queue", () => {
  it("plans a burst of queued cards once: prerequisites first, inferred dependencies persisted", async () => {
    await updateAppSettings(repo, { maxConcurrentAgents: 1 });
    const a = await createTask("Build the settings page", "Uses the settings API.");
    const b = await createTask("Fix the footer typo");
    const c = await createTask("Add the settings API", "[fake:slow]");
    process.env.FAKE_OMP_PLAN = JSON.stringify({
      order: [c.id, a.id, b.id],
      cards: [
        { id: c.id, waitFor: [], reason: "The settings page needs this API." },
        { id: a.id, waitFor: [c.id], reason: "Waits for the settings API." },
      ],
    });
    const manager = await getAgentManager();
    for (const task of [a, b, c]) await manager.start(task.id);

    // Held while the plan is pending: nothing launches before the planner answered.
    const pending = await manager.queueSnapshot();
    expect(pending.planning).toEqual([{ boardId: board.id, boardName: board.name }]);
    expect(pending.queued.map((e) => [e.taskId, e.planning])).toEqual([
      [a.id, true],
      [b.id, true],
      [c.id, true],
    ]);
    expect(argvEntries()).toHaveLength(0);

    await waitPromptReceived();
    expect(await repo.listRuns(c.id)).toHaveLength(1);
    expect(await repo.listRuns(a.id)).toHaveLength(0);
    expect((await getTask(a.id)).blockedBy).toEqual([c.id]);
    const planned = await manager.queueSnapshot();
    expect(planned.planning).toEqual([]);
    expect(planned.queued).toEqual([
      expect.objectContaining({ taskId: a.id, planning: false, waitingFor: [c.id], planNote: "Waits for the settings API." }),
      expect.objectContaining({ taskId: b.id, planning: false, waitingFor: [], planNote: null }),
    ]);

    // Finish C (the slow scenario completes after a steer); A and B follow in plan order.
    const comment = await repo.addComment({ taskId: c.id, author: "user", body: "wrap up" });
    await manager.onComment(await getTask(c.id), comment);
    await waitDone(c.id);
    await waitDone(a.id);
    await waitDone(b.id);
    expect(await runStartOrder([a.id, b.id, c.id])).toEqual([c.id, a.id, b.id]);
    const [planner] = plannerEntries();
    expect(plannerEntries()).toHaveLength(1);
    for (const task of [a, b, c]) expect(planner?.prompt).toContain(task.id);
  });

  it("runs the cards in queue order when the planner fails", async () => {
    await updateAppSettings(repo, { maxConcurrentAgents: 1 });
    process.env.FAKE_OMP_PLAN = "fail";
    const tasks = [await createTask("First"), await createTask("Second"), await createTask("Third")];
    const manager = await getAgentManager();
    for (const task of tasks) await manager.start(task.id);

    for (const task of tasks) await waitDone(task.id);
    const ids = tasks.map((t) => t.id);
    expect(await runStartOrder(ids)).toEqual(ids);
    expect(plannerEntries()).toHaveLength(1);
    expect((await manager.queueSnapshot()).planning).toEqual([]);
  });

  it("never holds or plans cards when the smart queue is off", async () => {
    await updateAppSettings(repo, { smartQueue: false });
    const tasks = [await createTask("First"), await createTask("Second")];
    const manager = await getAgentManager();
    for (const task of tasks) await manager.start(task.id);

    expect((await manager.queueSnapshot()).planning).toEqual([]);
    for (const task of tasks) await waitDone(task.id);
    expect(readLog().filter((e) => e.kind === "helper")).toEqual([]);
  });
});

describe("AgentManager automatic retries", () => {
  beforeEach(async () => {
    // Bounded retries; persistent retries have their own tests below.
    await updateAppSettings(repo, { autoRetry: true, maxAutoRetries: 2, persistentRetry: false });
  });

  it("retries a failed run in its omp session and resets the count once it succeeds", async () => {
    const task = await createTask("Flaky", "[fake:error]");
    const manager = await getAgentManager();
    await manager.start(task.id);

    const failed = await waitTask(task.id, (t) => t.agentState === "error", "the first failure");
    expect(failed).toMatchObject({ status: "in_progress", autoRetries: 1, agentError: "Fake model error: upstream failed" });
    expect(failed.retryAt).not.toBeNull();
    const firstSession = failed.sessionFile;
    expect(firstSession).toBeTruthy();
    // The cause goes away (as a flaky upstream would): the retry succeeds.
    await repo.updateTask(task.id, { description: "Now it works" });

    const done = await waitDone(task.id);
    expect(done).toMatchObject({ autoRetries: 0, retryAt: null, agentError: null });
    const argv = argvEntries();
    expect(argv).toHaveLength(2);
    expect(flagValues(argv[1]!.argv, "--resume")).toEqual([firstSession]);
    const bodies = agentComments(await repo.listComments(task.id)).map((c) => c.body);
    expect(bodies[0]).toMatch(/^Agent failed: Fake model error: upstream failed\n\nRetrying automatically in 0s \(retry 1 of 2\)\.$/);
  });

  it("stops retrying once the budget is used up; a manual run gets a fresh budget", async () => {
    const task = await createTask("Broken", "[fake:error]");
    const manager = await getAgentManager();
    await manager.start(task.id);

    const exhausted = await waitTask(
      task.id,
      (t) => t.agentState === "error" && t.autoRetries === 2 && t.retryAt === null,
      "the retries to be used up",
    );
    expect(exhausted.status).toBe("in_progress");
    await waitIdleManager(manager);
    expect(argvEntries()).toHaveLength(3);
    const bodies = agentComments(await repo.listComments(task.id)).map((c) => c.body);
    expect(bodies.at(-1)).toContain("Automatic retries are used up; press Run to try again.");

    await manager.start(task.id);
    expect((await getTask(task.id)).autoRetries).toBe(0);
    await waitTask(task.id, (t) => t.agentState === "error" && t.autoRetries === 1, "the fresh budget's first retry");
    await waitTask(task.id, (t) => t.autoRetries === 2 && t.retryAt === null, "the fresh budget to be used up");
    await waitIdleManager(manager);
    expect(argvEntries()).toHaveLength(6);
  });

  it("does not retry a card that was stopped or moved out of In progress", async () => {
    process.env.OMP_UI_RETRY_BASE_MS = "300";
    const stopped = await createTask("Stopped", "[fake:error]");
    const moved = await createTask("Moved", "[fake:error]");
    const manager = await getAgentManager();
    await manager.start(stopped.id);
    await manager.start(moved.id);
    await waitTask(stopped.id, (t) => t.retryAt !== null, "the stopped card's retry to be scheduled");
    const pending = await waitTask(moved.id, (t) => t.retryAt !== null, "the moved card's retry to be scheduled");

    expect(await manager.stop(stopped.id)).toMatchObject({ agentState: "idle", retryAt: null });
    const todo = await repo.updateTask(moved.id, { status: "todo" });
    await manager.onTaskMoved(todo!, pending.status);
    expect((await getTask(moved.id)).retryAt).toBeNull();

    await sleep(600);
    expect(argvEntries()).toHaveLength(2);
    expect(manager.stats()).toEqual({ running: [], queued: [] });
  });

  it("with persistent retries, keeps retrying a quota failure past the budget until it succeeds", async () => {
    await updateAppSettings(repo, { persistentRetry: true, maxAutoRetries: 1 });
    process.env.OMP_UI_QUOTA_RETRY_BASE_MS = "20";
    const task = await createTask("Out of quota", "[fake:quota]");
    const manager = await getAgentManager();
    await manager.start(task.id);

    const waiting = await waitTask(
      task.id,
      (t) => t.agentState === "error" && t.autoRetries >= 3,
      "the third quota retry to be scheduled",
    );
    expect(waiting).toMatchObject({ status: "in_progress", agentError: QUOTA_ERROR });
    expect(waiting.retryAt).not.toBeNull();
    // The quota comes back: the next retry succeeds.
    await repo.updateTask(task.id, { description: "Quota is back" });

    const done = await waitDone(task.id);
    expect(done).toMatchObject({ autoRetries: 0, retryAt: null, agentError: null });
    const failures = agentComments(await repo.listComments(task.id))
      .map((c) => c.body)
      .filter((body) => body.startsWith("Agent failed"));
    expect(failures.slice(0, 3)).toEqual(
      [1, 2, 3].map((n) => `Agent failed: ${QUOTA_ERROR}\n\nWaiting for quota: retrying automatically in 0s (retry ${n}).`),
    );
  });

  it("with persistent retries, keeps retrying any failed run past the budget", async () => {
    await updateAppSettings(repo, { persistentRetry: true, maxAutoRetries: 1 });
    const task = await createTask("Keeps failing", "[fake:error]");
    const manager = await getAgentManager();
    await manager.start(task.id);

    const retrying = await waitTask(
      task.id,
      (t) => t.agentState === "error" && t.autoRetries >= 2 && t.retryAt !== null,
      "a retry beyond the budget to be scheduled",
    );
    expect(retrying.status).toBe("in_progress");
    const bodies = agentComments(await repo.listComments(task.id)).map((c) => c.body);
    expect(bodies).toContain(
      "Agent failed: Fake model error: upstream failed\n\nRetrying automatically in 0s (retry 2).",
    );
    expect(bodies.some((body) => body.includes("used up"))).toBe(false);

    await manager.stop(task.id);
    await waitIdleManager(manager);
    expect((await getTask(task.id)).retryAt).toBeNull();
  });
});

describe("AgentManager boot recovery", () => {
  it("resumes interrupted, queued and failed In progress cards while their retry budget lasts", async () => {
    await updateAppSettings(repo, { autoRetry: true, maxAutoRetries: 2 });
    const running = await createTask("Was running", "", "in_progress");
    await repo.updateTask(running.id, { agentState: "running" });
    const queued = await createTask("Was queued", "", "in_progress");
    await repo.updateTask(queued.id, { agentState: "queued" });
    const failed = await createTask("Had failed", "", "in_progress");
    await repo.updateTask(failed.id, { agentState: "error", agentError: "boom" });
    const exhausted = await createTask("Out of retries", "", "in_progress");
    await repo.updateTask(exhausted.id, { agentState: "error", agentError: "boom", autoRetries: 2 });
    const parked = await createTask("Failed, then moved to To do", "", "todo");
    await repo.updateTask(parked.id, { agentState: "error", agentError: "boom" });
    const run = await repo.createRun({ taskId: running.id, prompt: "old" });

    await getAgentManager();

    expect(await repo.getRun(run.id)).toMatchObject({ status: "aborted" });
    expect(await waitDone(running.id)).toMatchObject({ autoRetries: 0 });
    await waitDone(queued.id);
    await waitDone(failed.id);
    const resumed = agentComments(await repo.listComments(running.id)).map((c) => c.body);
    expect(resumed[0]).toBe("The server restarted while the agent was working: resuming automatically (retry 1 of 2).");
    expect(await getTask(exhausted.id)).toMatchObject({ agentState: "error", agentError: "boom", autoRetries: 2 });
    expect(await getTask(parked.id)).toMatchObject({ agentState: "error", status: "todo" });
    expect(argvEntries()).toHaveLength(3);
  });

  it("reschedules a retry that was pending when the server stopped", async () => {
    await updateAppSettings(repo, { autoRetry: true, maxAutoRetries: 2 });
    const task = await createTask("Retry pending", "", "in_progress");
    const retryAt = new Date(Date.now() + 300).toISOString();
    await repo.updateTask(task.id, { agentState: "error", agentError: "boom", autoRetries: 1, retryAt });

    await getAgentManager();

    expect(await getTask(task.id)).toMatchObject({ agentState: "error", autoRetries: 1, retryAt });
    await waitDone(task.id);
    expect(argvEntries()).toHaveLength(1);
    expect(agentComments(await repo.listComments(task.id))).toHaveLength(1);
  });

  it("with persistent retries, reschedules a pending quota retry but bounds restart interruptions", async () => {
    await updateAppSettings(repo, { autoRetry: true, maxAutoRetries: 2, persistentRetry: true });
    const quota = await createTask("Waiting for quota", "", "in_progress");
    const retryAt = new Date(Date.now() + 300).toISOString();
    await repo.updateTask(quota.id, { agentState: "error", agentError: QUOTA_ERROR, autoRetries: 3, retryAt });
    const running = await createTask("Keeps getting interrupted", "", "in_progress");
    await repo.updateTask(running.id, { agentState: "running", autoRetries: 2 });

    await getAgentManager();

    expect(await getTask(quota.id)).toMatchObject({ agentState: "error", agentError: QUOTA_ERROR, autoRetries: 3, retryAt });
    expect(await getTask(running.id)).toMatchObject({
      agentState: "error",
      agentError: "Interrupted by server restart (automatic retries used up)",
      retryAt: null,
    });
    expect(await waitDone(quota.id)).toMatchObject({ autoRetries: 0 });
    expect(argvEntries()).toHaveLength(1);
    expect(await getTask(running.id)).toMatchObject({ agentState: "error", status: "in_progress" });
  });

  it("with automatic retries off, interrupts started runs and re-queues cards that were waiting", async () => {
    const task = await createTask("Was running", "", "in_progress");
    await repo.updateTask(task.id, { agentState: "running" });
    const queued = await createTask("Was queued", "", "in_progress");
    await repo.updateTask(queued.id, { agentState: "queued" });
    const run = await repo.createRun({ taskId: task.id, prompt: "old" });

    await getAgentManager();

    expect(await getTask(task.id)).toMatchObject({ agentState: "error", agentError: "Interrupted by server restart" });
    expect(await repo.getRun(run.id)).toMatchObject({ status: "aborted" });
    // A card that only waited has done nothing yet: it runs as if the server never stopped.
    await waitDone(queued.id);
    expect(argvEntries()).toHaveLength(1);
    expect(await repo.listRuns(task.id)).toHaveLength(1);
  });
});
