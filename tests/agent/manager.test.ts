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
import type { Board, Comment, Run, RunEvent, ServerEvent, Task } from "@/lib/types";

const FAKE_OMP = fileURLToPath(new URL("../fixtures/fake-omp.mjs", import.meta.url));
const SUCCESS_SUMMARY = "Fake summary: implemented the task and ran the tests.";

/** Process-wide singletons the app caches on globalThis (lib/db/index.ts, lib/agent/manager.ts, lib/agent/rpc.ts). */
const globals = globalThis as typeof globalThis & {
  __ompUiRepo?: Promise<Repository>;
  __ompUiAgentManager?: Promise<AgentManager>;
  __ompUiRpcProcesses?: Set<OmpRpcProcess>;
};

const ENV_KEYS = [
  "DATABASE_URL",
  "OMP_PATH",
  "MAX_AGENTS",
  "OMP_EXTRA_ARGS",
  "FAKE_OMP_LOG",
  "FAKE_OMP_SCENARIO",
  "FAKE_OMP_SESSION_DIR",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

interface LogEntry {
  pid: number;
  kind: string;
  argv?: string[];
  cwd?: string;
  command?: { type: string; id?: string; message?: string };
  message?: string;
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
  process.env.OMP_PATH = FAKE_OMP;
  process.env.FAKE_OMP_LOG = logFile;
  process.env.FAKE_OMP_SESSION_DIR = sessionDir;
  process.env.FAKE_OMP_SCENARIO = "success";
  delete process.env.MAX_AGENTS;
  delete process.env.OMP_EXTRA_ARGS;
  globals.__ompUiRepo = undefined;
  globals.__ompUiAgentManager = undefined;

  repo = await getRepo();
  board = await repo.createBoard({ name: "Test board", workdir, model: "fake/model-1" });
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
    expect(texts("tool")).toEqual(["▸ bash: npm test"]);
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
    expect(failed.agentError).toBe("Fake model error: rate limited");
    const run = await latestRun(task.id);
    expect(run).toMatchObject({ status: "failed", error: "Fake model error: rate limited", summary: null });

    const comments = await repo.listComments(task.id);
    expect(agentComments(comments).map((c) => c.body)).toEqual(["Agent failed: Fake model error: rate limited"]);
    expect(comments.find((c) => c.id === feedback.id)).toMatchObject({ resolved: false, resolvedByRunId: null });

    const errors = (await runEvents(run.id)).filter((e) => e.kind === "error").map((e) => e.text);
    expect(errors).toContain("Model error: Fake model error: rate limited");
    expect(publishedAgentStates(task.id)).toEqual(["queued", "running", "error"]);
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
    expect(flagValues(spawned?.argv, "--add-dir")).toEqual([extra]);
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
});

describe("AgentManager boot recovery", () => {
  it("marks runs and tasks left running by a previous server as interrupted", async () => {
    const task = await createTask("Was running", "", "in_progress");
    await repo.updateTask(task.id, { agentState: "running" });
    const queued = await createTask("Was queued", "", "in_progress");
    await repo.updateTask(queued.id, { agentState: "queued" });
    const run = await repo.createRun({ taskId: task.id, prompt: "old" });

    await getAgentManager();

    expect(await getTask(task.id)).toMatchObject({ agentState: "error", agentError: "Interrupted by server restart" });
    expect(await getTask(queued.id)).toMatchObject({ agentState: "error", agentError: "Interrupted by server restart" });
    expect(await repo.getRun(run.id)).toMatchObject({ status: "aborted" });
  });
});
