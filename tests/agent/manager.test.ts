import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getAgentManager } from "@/lib/agent/manager";
import type { OmpRpcProcess, RpcFrame } from "@/lib/agent/rpc";
import type { AgentManager } from "@/lib/agent/types";
import { getRepo } from "@/lib/db";
import type { Repository } from "@/lib/db/types";
import { subscribe } from "@/lib/events";
import { updateAppSettings } from "@/lib/settings";
import type { Board, Comment, Run, RunEvent, ServerEvent, SubagentSnapshot, Task } from "@/lib/types";

const FAKE_OMP = fileURLToPath(new URL("../fixtures/fake-omp.mjs", import.meta.url));
const SUCCESS_SUMMARY = "Fake summary: implemented the task and ran the tests.";
const QUOTA_ERROR = "Fake model error: 429 You have exceeded your quota (usage limit reached)";
/** The todo list the fake's todos_done / todos_steer / todos_feedback scenarios report first. */
const FINISHED_TODOS = ["Write the code: completed", "Add tests: completed", "Update docs: completed"];
/** The item those scenarios add for the feedback. */
const FEEDBACK_TODO = "Address the feedback";

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
  "FAKE_OMP_EXTENSIONS",
  "FAKE_OMP_DISABLED_EXTENSIONS",
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

/** task.updated events published for a task from `events[from]` on, as the published tasks. */
function taskUpdates(taskId: string, from = 0): Task[] {
  return events.slice(from).flatMap((e) => (e.type === "task.updated" && e.task.id === taskId ? [e.task] : []));
}

/** A todo list as "content: status" lines. */
function todoLines(todos: Task["todos"]): string[] {
  return todos.flatMap((phase) => phase.tasks.map((item) => `${item.content}: ${item.status}`));
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

/** An assistant message as omp reports it in message_end / agent_end. */
function assistantMessage(text: string): Record<string, unknown> {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

let injected = 0;

/**
 * Feeds frames to a card run as if its omp process (by pid) had sent them, for omp behaviour the
 * fake does not script, then waits until the run handled them: frames are handled in order, so a
 * trailing `notice` shows up in the run log once the earlier ones were handled, unless one of them
 * ended the run (which then ignores the notice).
 */
async function sendFrames(pid: number, runId: string, ...frames: RpcFrame[]): Promise<void> {
  const proc = [...(globals.__ompUiRpcProcesses ?? [])].find((p) => p.pid === pid);
  if (!proc) throw new Error(`no live omp process ${pid}`);
  const marker = `frames handled (${++injected})`;
  for (const frame of [...frames, { type: "notice", level: "info", message: marker }]) proc.emit("frame", frame);
  await waitFor(async () => {
    if ((await runEvents(runId)).some((e) => e.text === marker)) return true;
    return (await repo.getRun(runId))?.status !== "running";
  }, "the run to handle the injected frames");
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

  it("writes the memory-off overlay into the run config only for cards that ignore memory", async () => {
    process.env.FAKE_OMP_EXTENSIONS = JSON.stringify(["/x/agent/agentmemory", "/x/other"]);
    process.env.FAKE_OMP_DISABLED_EXTENSIONS = JSON.stringify(["skill:foo"]);
    try {
      const manager = await getAgentManager();
      const readConfig = (taskId: string) =>
        JSON.parse(readFileSync(path.join(root, "runtime", `omp-config-${taskId}.yml`), "utf8")) as Record<string, unknown>;

      const off = await repo.createTask({ boardId: board.id, title: "No memory", description: "", status: "todo", ignoreMemory: true });
      await manager.start(off.id);
      await waitDone(off.id);
      const offConfig = readConfig(off.id);
      expect(offConfig.extensions).toEqual(["/x/other"]);
      expect(offConfig.disabledExtensions).toEqual(["skill:foo", "mcp:agentmemory"]);

      const on = await createTask("With memory");
      await manager.start(on.id);
      await waitDone(on.id);
      const onConfig = readConfig(on.id);
      expect(onConfig).not.toHaveProperty("extensions");
      expect(onConfig).not.toHaveProperty("disabledExtensions");
    } finally {
      delete process.env.FAKE_OMP_EXTENSIONS;
      delete process.env.FAKE_OMP_DISABLED_EXTENSIONS;
    }
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
    expect((await runEvents(run.id)).map((e) => e.text)).toContain("Feedback sent to the running agent (steering)");
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

  it("publishes the agent's growing todo list while it works on steered feedback", async () => {
    const task = await createTask("Steer the list", "[fake:todos_steer]");
    const manager = await getAgentManager();
    await manager.start(task.id);
    // The fake reports a list with every item completed, then waits for the steer.
    const listed = await waitFor(
      () => taskUpdates(task.id).find((t) => t.todos.length > 0),
      "the completed todo list to be published",
    );
    expect(todoLines(listed.todos)).toEqual(FINISHED_TODOS);
    expect(listed).toMatchObject({ status: "in_progress", agentState: "running", openCommentCount: 0 });

    const from = events.length;
    const comment = await repo.addComment({ taskId: task.id, author: "user", body: "Also update the README" });
    await manager.onComment(await getTask(task.id), comment);
    const done = await waitDone(task.id);
    await waitIdleManager(manager);
    const run = await latestRun(task.id);
    expect(await repo.listRuns(task.id)).toHaveLength(1);

    const updates = taskUpdates(task.id, from);
    const working = updates.findIndex((t) => todoLines(t.todos).includes(`${FEEDBACK_TODO}: in_progress`));
    const finished = updates.findIndex((t) => todoLines(t.todos).includes(`${FEEDBACK_TODO}: completed`));
    expect(working).toBeGreaterThanOrEqual(0);
    expect(finished).toBeGreaterThan(working);
    expect(todoLines(updates[working]!.todos)).toEqual([...FINISHED_TODOS, `${FEEDBACK_TODO}: in_progress`]);
    expect(todoLines(updates[finished]!.todos)).toEqual([...FINISHED_TODOS, `${FEEDBACK_TODO}: completed`]);
    // The feedback counts as open until the run that addressed it ends.
    for (const t of updates.slice(0, -1)) {
      expect(t).toMatchObject({ status: "in_progress", agentState: "running", openCommentCount: 1 });
    }
    expect(updates.at(-1)).toMatchObject({ status: "done", agentState: "idle", openCommentCount: 0 });

    expect(done).toMatchObject({ status: "done", agentState: "idle", openCommentCount: 0, lastRunId: run.id });
    // The finished items keep their stamps; the feedback item gets its own.
    expect(done.todos).toEqual([
      ...listed.todos,
      {
        name: "Feedback",
        tasks: [
          { content: FEEDBACK_TODO, status: "completed", startedAt: expect.any(String), completedAt: expect.any(String) },
        ],
      },
    ]);
    expect((await repo.listComments(task.id)).find((c) => c.id === comment.id)).toMatchObject({
      resolved: true,
      resolvedByRunId: run.id,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "comment.updated",
        comment: expect.objectContaining({ id: comment.id, resolved: true, resolvedByRunId: run.id }),
      }),
    );
  });

  it("reopens a Done card with a finished todo list on feedback and publishes each step", async () => {
    const task = await createTask("Resume the list", "[fake:todos_done]");
    const manager = await getAgentManager();
    await manager.start(task.id);
    const firstDone = await waitDone(task.id);
    await waitIdleManager(manager);
    const firstRun = await latestRun(task.id);
    expect(todoLines(firstDone.todos)).toEqual(FINISHED_TODOS);
    expect(firstDone.openCommentCount).toBe(0);

    const from = events.length;
    // The resumed run's prompt carries the feedback, and with it the fake's scenario marker.
    const comment = await repo.addComment({
      taskId: task.id,
      author: "user",
      body: "Please rename the button [fake:todos_feedback]",
    });
    await manager.onComment(firstDone, comment);
    const secondDone = await waitTask(
      task.id,
      (t) => t.lastRunId !== firstRun.id && t.status === "done" && t.agentState === "idle",
      "the resumed run to finish",
    );
    await waitIdleManager(manager);
    const secondRun = await latestRun(task.id);
    expect(secondRun.id).not.toBe(firstRun.id);
    expect(secondRun.prompt.startsWith("New feedback on this task:")).toBe(true);

    expect(publishedAgentStates(task.id)).toEqual(["queued", "running", "idle", "queued", "running", "idle"]);
    const updates = taskUpdates(task.id, from);
    // Reopened with the finished list kept and the feedback open, then running the new run.
    expect(updates[0]).toMatchObject({
      status: "in_progress",
      agentState: "queued",
      openCommentCount: 1,
      todos: firstDone.todos,
    });
    expect(updates[1]).toMatchObject({
      status: "in_progress",
      agentState: "running",
      openCommentCount: 1,
      lastRunId: secondRun.id,
    });
    for (const t of updates.slice(0, -1)) expect(t).toMatchObject({ status: "in_progress", openCommentCount: 1 });
    expect(updates.at(-1)).toMatchObject({ status: "done", agentState: "idle", openCommentCount: 0 });
    const working = updates.findIndex((t) => todoLines(t.todos).includes(`${FEEDBACK_TODO}: in_progress`));
    const finished = updates.findIndex((t) => todoLines(t.todos).includes(`${FEEDBACK_TODO}: completed`));
    expect(working).toBeGreaterThan(0);
    expect(finished).toBeGreaterThan(working);

    const runUpdates = events.slice(from).flatMap((e) => (e.type === "run.updated" && e.run.id === secondRun.id ? [e.run] : []));
    expect(runUpdates.map((r) => r.status)).toEqual(["running", "succeeded"]);

    // The agent's latest list: the earlier items with their first run's stamps, plus the feedback item.
    expect(secondDone.todos).toEqual([
      ...firstDone.todos,
      {
        name: "Feedback",
        tasks: [
          { content: FEEDBACK_TODO, status: "completed", startedAt: expect.any(String), completedAt: expect.any(String) },
        ],
      },
    ]);
    const feedbackItem = secondDone.todos.at(-1)!.tasks[0]!;
    expect(Date.parse(feedbackItem.startedAt!)).toBeGreaterThanOrEqual(Date.parse(firstRun.endedAt!));
    expect((await repo.listComments(task.id)).find((c) => c.id === comment.id)).toMatchObject({
      resolved: true,
      resolvedByRunId: secondRun.id,
    });
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

describe("AgentManager omp session events", () => {
  /** Starts a card that works silently ("spend"); returns its omp pid and run id. */
  async function startWorking(title: string): Promise<{ task: Task; manager: AgentManager; pid: number; runId: string }> {
    const task = await createTask(title, "[fake:spend]");
    const manager = await getAgentManager();
    await manager.start(task.id);
    const pid = await waitPromptReceived();
    const runId = (await latestRun(task.id)).id;
    // The fake's one assistant message is in: the run is past its startup.
    await waitFor(async () => (await runEvents(runId)).some((e) => e.text === "Working on it."), "the agent to start working");
    return { task, manager, pid, runId };
  }

  it("keeps a run open for a steer sent as the agent yields until its turn ends and the session settles", async () => {
    const { task, manager, pid, runId } = await startWorking("Steer at the end");
    const comment = await repo.addComment({ taskId: task.id, author: "user", body: "Also update the README" });
    await manager.onComment(await getTask(task.id), comment);
    await waitFor(
      async () => (await runEvents(runId)).some((e) => e.text === "Feedback sent to the running agent (steering)"),
      "the feedback to be steered",
    );
    const steerId = commands("prompt", pid).find((e) => e.command?.message?.includes("Also update the README"))?.command?.id;
    expect(steerId).toBeDefined();

    // The agent yields while the steer is queued: omp answers the run's prompt, then starts a turn for the steer.
    await sendFrames(
      pid,
      runId,
      { type: "agent_end", messages: [assistantMessage("Working on it.")], isTerminal: true, yielded: true },
      { type: "prompt_result", id: `prompt-${runId}`, agentInvoked: true, status: "completed", sessionSettled: false },
    );
    expect(manager.stats().running).toEqual([task.id]);

    await sendFrames(
      pid,
      runId,
      { type: "agent_start" },
      { type: "message_end", message: assistantMessage("Fake summary: updated the README.") },
      { type: "agent_end", messages: [assistantMessage("Fake summary: updated the README.")], isTerminal: true, yielded: true },
    );
    expect(manager.stats().running).toEqual([task.id]);

    // The steer's turn yielded, but a background job may still wake the session.
    await sendFrames(pid, runId, { type: "prompt_result", id: steerId, agentInvoked: true, status: "completed", sessionSettled: false });
    expect(manager.stats().running).toEqual([task.id]);
    expect((await getTask(task.id)).agentState).toBe("running");

    await sendFrames(pid, runId, { type: "session_settled" });
    const done = await waitDone(task.id);
    const run = await latestRun(task.id);
    expect(run).toMatchObject({ id: runId, status: "succeeded", summary: "Fake summary: updated the README." });
    expect(done.lastRunId).toBe(runId);
    expect(await repo.listRuns(task.id)).toHaveLength(1);
    expect((await repo.listComments(task.id)).find((c) => c.id === comment.id)).toMatchObject({
      resolved: true,
      resolvedByRunId: runId,
    });
  });

  it("completes on a terminal agent_end without `yielded` from an older omp, even with a steer pending", async () => {
    const { task, manager, pid, runId } = await startWorking("Old omp");
    const comment = await repo.addComment({ taskId: task.id, author: "user", body: "Also update the README" });
    await manager.onComment(await getTask(task.id), comment);
    await waitFor(
      async () => (await runEvents(runId)).some((e) => e.text === "Feedback sent to the running agent (steering)"),
      "the feedback to be steered",
    );

    await sendFrames(pid, runId, { type: "agent_end", messages: [assistantMessage("Fake summary: done.")] });
    await waitDone(task.id);
    expect(await latestRun(task.id)).toMatchObject({ id: runId, status: "succeeded" });
  });

  it("fails the run when omp reports the main prompt failed without an agent_end (e.g. cost cap)", async () => {
    const { task, pid, runId } = await startWorking("Cost cap");
    await sendFrames(pid, runId, {
      type: "prompt_result",
      id: `prompt-${runId}`,
      agentInvoked: true,
      status: "error",
      error: { message: "cost cap" },
    });
    await waitFor(async () => (await repo.getRun(runId))?.status === "failed", "the run to fail");
    expect(await latestRun(task.id)).toMatchObject({ id: runId, status: "failed", error: "cost cap" });
  });

  it("completes once the session settles after the agent yielded, waiting out background work", async () => {
    const { task, manager, pid, runId } = await startWorking("Background work");
    // Async subagents still run: the agent ends a turn without yielding for good (logged once).
    const waiting = { type: "agent_end", messages: [], isTerminal: false, yielded: false, awaitingAsyncWork: true };
    await sendFrames(pid, runId, waiting, waiting);
    await sendFrames(
      pid,
      runId,
      { type: "agent_start" },
      { type: "agent_end", messages: [assistantMessage("Working on it.")], isTerminal: true, yielded: true },
    );
    expect(manager.stats().running).toEqual([task.id]);
    const texts = (await runEvents(runId)).map((e) => e.text);
    expect(texts.filter((t) => t === "Waiting for background work (subagents, background jobs) before finishing")).toHaveLength(1);

    await sendFrames(pid, runId, { type: "session_settled" });
    await waitDone(task.id);
    expect(await latestRun(task.id)).toMatchObject({ id: runId, status: "succeeded", summary: "Working on it." });
  });

  it("logs each steering message omp delivers from its queue", async () => {
    const { pid, runId } = await startWorking("Show steering");
    const update = (steering: string[]) => ({ type: "queue_update", steering, followUp: [], liveSteered: 0 });
    await sendFrames(
      pid,
      runId,
      update(["Also update\nthe README", "Keep it small"]),
      update(["Keep it small"]),
    );
    const afterFirst = (await runEvents(runId)).map((e) => e.text).filter((t) => t.startsWith("Steering delivered"));
    expect(afterFirst).toEqual(['Steering delivered to the agent: "Also update the README"']);

    await sendFrames(pid, runId, update([]));
    const afterSecond = (await runEvents(runId)).map((e) => e.text).filter((t) => t.startsWith("Steering delivered"));
    expect(afterSecond).toEqual([
      'Steering delivered to the agent: "Also update the README"',
      'Steering delivered to the agent: "Keep it small"',
    ]);
  });

  it("tells the Activity chat when a steered comment is sent and when it reaches the agent", async () => {
    const { task, manager, pid, runId } = await startWorking("Steer state");
    const comment = await repo.addComment({ taskId: task.id, author: "user", body: "Also update the README" });
    await manager.onComment(await getTask(task.id), comment);
    const steerStates = () =>
      events.flatMap((e) => (e.type === "comment.steer" && e.commentId === comment.id ? [e.state] : []));
    await waitFor(() => steerStates().length > 0, "the steer to be sent");
    expect(steerStates()).toEqual(["sent"]);

    const steer = commands("prompt", pid).find((e) => e.command?.message?.startsWith("Also update the README"))?.command;
    const message = steer?.message ?? "";
    // Sent word for word, like typing into omp mid-run (plus the Parallelize permission).
    expect(message.split("\n\n")[0]).toBe("Also update the README");
    const update = (steering: string[]) => ({ type: "queue_update", steering, followUp: [], liveSteered: 0 });
    await sendFrames(pid, runId, update([message]), update([]));
    expect(steerStates()).toEqual(["sent", "delivered"]);

    // The steer's own prompt_result later does not report it twice.
    await sendFrames(pid, runId, { type: "prompt_result", id: steer!.id, agentInvoked: true, status: "completed" });
    expect(steerStates()).toEqual(["sent", "delivered"]);
    expect(events.find((e) => e.type === "comment.steer")).toMatchObject({ taskId: task.id, boardId: board.id });
  });

  it("logs context compactions: start, result, failure and skip", async () => {
    const { pid, runId } = await startWorking("Compact me");
    await sendFrames(
      pid,
      runId,
      { type: "auto_compaction_start", reason: "threshold", action: "snapcompact" },
      {
        type: "auto_compaction_end",
        action: "snapcompact",
        result: {
          summary: "The full summary of the conversation so far.",
          shortSummary: "Kept the plan and the failing test",
          firstKeptEntryId: "entry-9",
          tokensBefore: 123456,
          details: {},
        },
        aborted: false,
        willRetry: false,
      },
      { type: "auto_compaction_start", reason: "overflow" },
      { type: "auto_compaction_end", action: "snapcompact", aborted: false, willRetry: true, errorMessage: "summary model unavailable" },
      { type: "manual_compaction_start" },
      { type: "manual_compaction_end", aborted: false, skipped: true, errorMessage: "Nothing to compact" },
    );
    const log = await runEvents(runId);
    const texts = (kind: RunEvent["kind"]) => log.filter((e) => e.kind === kind).map((e) => e.text);
    const statuses = texts("status");
    for (const line of [
      "Compacting conversation context (threshold, snapcompact)",
      "Context compacted (123,456 tokens before): Kept the plan and the failing test",
      "Compacting conversation context (overflow)",
      "Compacting conversation context (manual)",
      "Context compaction skipped: Nothing to compact",
    ]) {
      expect(statuses).toContain(line);
    }
    expect(texts("error")).toEqual(["Context compaction failed: summary model unavailable; retrying"]);
  });

  it("logs omp's dialogs a card run declines when it does not run in yolo mode", async () => {
    await updateAppSettings(repo, { approvalMode: "write" });
    const task = await createTask("Ask me", "[fake:confirm]");
    const manager = await getAgentManager();
    await manager.start(task.id);
    await waitDone(task.id);

    const run = await latestRun(task.id);
    const errors = (await runEvents(run.id)).filter((e) => e.kind === "error").map((e) => e.text);
    // The confirm and the select are declined; the notify needs no answer.
    expect(errors).toEqual([
      `Declined omp's request "Run?": card runs cannot answer prompts (approval mode write). Use approval mode yolo for unattended tool use.`,
      `Declined omp's request "Pick": card runs cannot answer prompts (approval mode write). Use approval mode yolo for unattended tool use.`,
    ]);
    const responses = readLog().filter((e) => e.kind === "ui_response");
    expect(responses).toHaveLength(2);
  });
});

describe("AgentManager SDLC quality gates", () => {
  it("logs SDLC phases and passed gates of a list that follows the process, and ships the card", async () => {
    const task = await createTask("Follow the process", "[fake:sdlc_flow]");
    const manager = await getAgentManager();
    await manager.start(task.id);
    const done = await waitDone(task.id);
    await waitIdleManager(manager);

    expect(done.status).toBe("done");
    const runs = await repo.listRuns(task.id);
    expect(runs).toHaveLength(1);
    const texts = (await runEvents(runs[0]!.id)).map((e) => e.text);
    for (const line of [
      "▸ SDLC phase 1/3: Analyze",
      "▸ SDLC phase 2/3: Implement",
      "▸ SDLC phase 3/3: Testing",
      "✓ Quality gate passed: Analyze complete",
      "✓ Quality gate passed: Implement complete",
      "✓ Quality gate passed: Testing complete",
    ]) {
      expect(texts).toContain(line);
    }
    expect(texts.filter((t) => t.startsWith("⚠"))).toEqual([]);
    expect(readLog().filter((e) => e.kind === "steer")).toEqual([]);
    expect((await repo.listComments(task.id)).filter((c) => c.author === "user")).toEqual([]);
  });

  it("sends a card whose Testing phase is not complete back once, then ships it with a warning", async () => {
    const task = await createTask("Ship untested", "[fake:sdlc_gate]");
    const manager = await getAgentManager();
    await manager.start(task.id);
    const done = await waitDone(task.id);
    await waitIdleManager(manager);

    expect(done.status).toBe("done");
    const runs = await repo.listRuns(task.id);
    expect(runs).toHaveLength(2);
    const gate = (await repo.listComments(task.id)).filter((c) => c.author === "user");
    expect(gate).toHaveLength(1);
    expect(gate[0]!.body.startsWith("**Quality gate:** Testing is not complete")).toBe(true);
    // The second run addressed it as feedback.
    expect(gate[0]).toMatchObject({ resolved: true, resolvedByRunId: runs[0]!.id });
    expect(commands("prompt")[1]?.command?.message).toContain("Testing is not complete");

    // listRuns is newest first: the first run sent the card back, the second shipped it.
    const shippedPrefix = "⚠ Shipped without passing the release gate: Testing is not complete";
    const [second, first] = await Promise.all(runs.map(async (r) => (await runEvents(r.id)).map((e) => e.text)));
    expect(first!.some((t) => t.startsWith(shippedPrefix))).toBe(false);
    expect(second!.filter((t) => t.startsWith(shippedPrefix))).toHaveLength(1);
  });

  it("steers an agent that starts Testing before Implement is complete back into the process", async () => {
    const task = await createTask("Skip the tests", "[fake:sdlc_skip]");
    const manager = await getAgentManager();
    await manager.start(task.id);
    const pid = await waitPromptReceived();
    const steer = await waitFor(
      () => readLog().find((e) => e.kind === "steer" && e.pid === pid),
      "the quality-gate steer",
    );
    expect(steer.message).toContain("Quality gate (SDLC): Testing started before Implement was complete");
    expect(steer).toMatchObject({ via: "prompt", streamingBehavior: "steer" });

    // Testing is still incomplete when it succeeds: the release gate sends it back once before it ships.
    await waitDone(task.id);
    await waitIdleManager(manager);
    const runs = await repo.listRuns(task.id);
    const first = runs.at(-1)!;
    expect((await runEvents(first.id)).map((e) => e.text)).toContain(
      "⚠ Quality gate: Testing started before Implement was complete",
    );
    // Each violation is steered once.
    expect(readLog().filter((e) => e.kind === "steer" && e.message?.startsWith("Quality gate (SDLC)"))).toHaveLength(1);
  });

  it("reports a running card's SDLC progress in the queue snapshot", async () => {
    const task = await createTask("Hold in implementation", "[fake:sdlc_hold]");
    const manager = await getAgentManager();
    await manager.start(task.id);
    const entry = await waitFor(async () => {
      const running = (await manager.queueSnapshot()).running.find((e) => e.taskId === task.id);
      return running?.sdlc ? running : null;
    }, "the SDLC progress in the queue snapshot");
    expect(entry.sdlc).toMatchObject({ current: "implement", canonical: true, violations: [] });

    const stopped = await manager.stop(task.id);
    expect(stopped).toMatchObject({ status: "in_progress", agentState: "idle" });
    expect(readLog().filter((e) => e.kind === "steer")).toEqual([]);
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

  it("runs a scheduler's cards on the scheduler's model, over the board's", async () => {
    board = (await repo.updateBoard(board.id, { model: "fake/board" }))!;
    const scheduler = await repo.createScheduler({
      boardId: board.id,
      name: "Nightly",
      prompt: "Run it",
      cron: "0 0 1 1 *",
      timezone: "UTC",
      model: "fake/scheduled",
    });
    const task = await repo.createTask({ boardId: board.id, title: "From scheduler", schedulerId: scheduler.id });
    const manager = await getAgentManager();

    await manager.start(task.id);
    await waitDone(task.id);

    const [spawned] = argvEntries();
    expect(flagValues(spawned?.argv, "--model")).toEqual(["fake/scheduled"]);
  });

  it("leaves the model to omp when the board and settings set none, and never reads the roles", async () => {
    process.env.FAKE_OMP_MODEL_ROLES = JSON.stringify({ smol: "fake/fast:low", slow: "fake/deep:xhigh" });
    const manager = await getAgentManager();
    const pinned = await createTask("Debug the deadlock");
    await manager.start(pinned.id);
    await waitDone(pinned.id);

    board = (await repo.updateBoard(board.id, { model: null }))!;
    await updateAppSettings(repo, { defaultModel: "" });
    const unpinned = await createTask("Debug the deadlock again");
    await manager.start(unpinned.id);
    await waitDone(unpinned.id);

    const spawned = argvEntries();
    expect(spawned.map((e) => flagValues(e.argv, "--model"))).toEqual([["fake/model-1"], []]);
    expect(spawned.flatMap((e) => flagValues(e.argv, "--thinking"))).toEqual([]);
    expect(readLog().filter((e) => e.kind === "config")).toEqual([]);
    const texts = (await runEvents((await latestRun(unpinned.id)).id)).map((e) => e.text);
    expect(texts).toContain(`Starting agent in ${workdir}`);
  });
});

describe("AgentManager collaboration and workspaces", () => {
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

  it("runs queued cards side by side: no card waits for another", async () => {
    await updateAppSettings(repo, { maxConcurrentAgents: 2 });
    const first = await createTask("First");
    const second = await createTask("Second");
    const manager = await getAgentManager();

    await manager.start(first.id);
    await manager.start(second.id);

    // Both agents run at once: starting a card never waits for another card's agent.
    await waitFor(() => argvEntries().length === 2, "both agents to be spawned");
    expect((await manager.queueSnapshot()).queued).toEqual([]);
    await waitDone(first.id);
    await waitDone(second.id);
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
  it("plans a burst of queued cards once: highest priority first, no card held back", async () => {
    await updateAppSettings(repo, { maxConcurrentAgents: 1 });
    const a = await createTask("Build the settings page", "Uses the settings API.");
    const b = await createTask("Fix the footer typo");
    const c = await createTask("Add the settings API", "[fake:slow]");
    process.env.FAKE_OMP_PLAN = JSON.stringify({
      order: [c.id, a.id, b.id],
      cards: [
        { id: c.id, reason: "Lands before the page that uses it." },
        { id: a.id, reason: "Waits on the settings API." },
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
    const planned = await manager.queueSnapshot();
    expect(planned.planning).toEqual([]);
    expect(planned.queued).toEqual([
      expect.objectContaining({ taskId: a.id, planning: false, planNote: "Waits on the settings API." }),
      expect.objectContaining({ taskId: b.id, planning: false, planNote: null }),
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
