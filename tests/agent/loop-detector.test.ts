import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { LoopDetector, type LoopDetection } from "@/lib/agent/loop-detector";
import { getAgentManager } from "@/lib/agent/manager";
import type { OmpRpcProcess } from "@/lib/agent/rpc";
import type { AgentManager } from "@/lib/agent/types";
import { getRepo } from "@/lib/db";
import type { Repository } from "@/lib/db/types";
import { updateAppSettings } from "@/lib/settings";
import type { Board, Task } from "@/lib/types";

const text = (value: string) => ({ content: [{ type: "text", text: value }] });

/** Feeds one complete call (start + end) to the detector; returns what the end reported. */
function call(
  detector: LoopDetector,
  id: string,
  toolName: string,
  args: Record<string, unknown>,
  result: unknown = text("ok"),
  isError = false,
): LoopDetection | null {
  detector.start(id, toolName, args);
  return detector.end(id, isError, result);
}

/** One complete tool call: name, args, result and whether it failed. */
type ToolCall = [toolName: string, args: Record<string, unknown>, result?: unknown, isError?: boolean];

/** Feeds the calls in order; returns every detection with the index of the call that raised it. */
function feed(
  detector: LoopDetector,
  calls: ToolCall[],
): Array<{ index: number; detection: LoopDetection }> {
  return calls.flatMap(([toolName, args, result, isError], index) => {
    const detection = call(detector, `c${index}`, toolName, args, result, isError);
    return detection ? [{ index, detection }] : [];
  });
}

describe("LoopDetector", () => {
  it("flags the same call repeated 4 times with the same result", () => {
    const detector = new LoopDetector();
    const read = (): ToolCall => ["read", { path: "src/a.ts" }, text("export const a = 1;")];
    const hits = feed(detector, Array.from({ length: 4 }, read));
    expect(hits).toEqual([
      { index: 3, detection: { pattern: "repeat", summary: "read src/a.ts repeated 4 times with the same result" } },
    ]);
  });

  it("ignores volatile intent fields and key order when comparing calls", () => {
    const detector = new LoopDetector();
    const hits = feed(detector, [
      ["bash", { command: "ls", cwd: "/w", intent: "Listing" }],
      ["bash", { cwd: "/w", command: "ls", intent: "Listing again" }],
      ["bash", { i: "Once more", command: "ls", cwd: "/w" }],
      ["bash", { command: "ls", cwd: "/w" }],
    ]);
    expect(hits.map((h) => h.detection.pattern)).toEqual(["repeat"]);
  });

  it("flags the same call failing with the same error 3 times in a row", () => {
    const detector = new LoopDetector();
    const failing = (): ToolCall => [
      "bash",
      { command: "npm test" },
      text("Error: Cannot find module 'x'"),
      true,
    ];
    const hits = feed(detector, [failing(), failing(), failing()]);
    expect(hits).toEqual([
      {
        index: 2,
        detection: {
          pattern: "error",
          summary: "bash npm test failed 3 times in a row with the same error: Error: Cannot find module 'x'",
        },
      },
    ]);
  });

  it("flags A,B,A,B,A,B alternation", () => {
    const detector = new LoopDetector();
    const a: ToolCall = ["read", { path: "a.ts" }, text("a")];
    const b: ToolCall = ["read", { path: "b.ts" }, text("b")];
    const hits = feed(detector, [a, b, a, b, a, b]);
    expect(hits).toEqual([
      { index: 5, detection: { pattern: "alternate", summary: "alternating between read a.ts and read b.ts 3 times" } },
    ]);
  });

  it("does not flag varied calls, changing results or differing errors", () => {
    const detector = new LoopDetector();
    expect(
      feed(detector, [
        ["read", { path: "a.ts" }],
        ["read", { path: "b.ts" }],
        ["grep", { pattern: "x" }],
        ["read", { path: "a.ts" }],
        ["bash", { command: "npm test" }, text("1 failing"), true],
        ["bash", { command: "npm test" }, text("2 failing"), true],
        ["bash", { command: "npm test" }, text("3 failing"), true],
        // The same call whose result changes each time (e.g. polling a build) makes progress.
        ["bash", { command: "gh run view" }, text("queued")],
        ["bash", { command: "gh run view" }, text("in_progress")],
        ["bash", { command: "gh run view" }, text("in_progress 50%")],
        ["bash", { command: "gh run view" }, text("completed")],
      ]),
    ).toEqual([]);
  });

  it("ignores tools that legitimately repeat, including as xd:// devices", () => {
    const detector = new LoopDetector();
    const calls: ToolCall[] = [];
    for (let n = 0; n < 6; n++) {
      calls.push(["todo", { op: "view" }]);
      calls.push(["task", { tasks: [] }]);
      calls.push(["board_wait_for_cards", { cardIds: ["x"] }]);
      calls.push(["ask_advisor", { question: "Which?" }]);
      calls.push(["ask", { question: "Which?" }]);
      calls.push(["write", { path: "xd://board_wait_for_cards", content: JSON.stringify({ cardIds: ["x"] }) }]);
    }
    expect(feed(detector, calls)).toEqual([]);
  });

  it("does not let ignored tools break a streak", () => {
    const detector = new LoopDetector();
    const hits = feed(detector, [
      ["read", { path: "a.ts" }],
      ["todo", { op: "view" }],
      ["read", { path: "a.ts" }],
      ["read", { path: "a.ts" }],
      ["todo", { op: "view" }],
      ["read", { path: "a.ts" }],
    ]);
    expect(hits.map((h) => h.index)).toEqual([5]);
  });

  it("resets after a detection so the next strike needs a fresh loop", () => {
    const detector = new LoopDetector();
    const read = (): ToolCall => ["read", { path: "a.ts" }];
    const hits = feed(detector, Array.from({ length: 8 }, read));
    expect(hits.map((h) => h.index)).toEqual([3, 7]);
  });

  it("matches outcomes by toolCallId when calls run in parallel", () => {
    const detector = new LoopDetector();
    const detections: Array<LoopDetection | null> = [];
    for (let n = 0; n < 2; n++) {
      detector.start(`a${n}`, "read", { path: "a.ts" });
      detector.start(`b${n}`, "read", { path: "a.ts" });
      detections.push(detector.end(`b${n}`, false, text("same")), detector.end(`a${n}`, false, text("same")));
    }
    // Ends without a matching start are not recorded.
    expect(detector.end("unknown", false, text("same"))).toBeNull();
    expect(detections.filter(Boolean)).toHaveLength(1);
    expect(detections[3]?.pattern).toBe("repeat");
  });
});

// --- Integration with the agent manager and the fake omp -------------------------------------

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
  "OMP_UI_RETRY_BASE_MS",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

interface LogEntry {
  pid: number;
  kind: string;
  message?: string;
  via?: string;
  streamingBehavior?: string;
}

let root: string;
let logFile: string;
let repo: Repository;
let board: Board;

async function waitFor<T>(check: () => T | Promise<T>, description: string, timeoutMs = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    // Polls real processes (the fake omp); there is no event to await across the process boundary.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

function readLog(): LogEntry[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

function waitTask(id: string, predicate: (task: Task) => boolean, description: string): Promise<Task> {
  return waitFor(async () => {
    const task = await repo.getTask(id);
    return task && predicate(task) ? task : null;
  }, description);
}

async function runEventTexts(taskId: string): Promise<string[]> {
  const [run] = await repo.listRuns(taskId);
  if (!run) throw new Error(`no run for task ${taskId}`);
  return (await repo.listRunEvents(run.id, 0, 1000)).map((e) => e.text);
}

describe("AgentManager loop detection", () => {
  beforeAll(() => {
    chmodSync(FAKE_OMP, 0o755);
  });

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "omp-ui-loop-test-")));
    const workdir = path.join(root, "project");
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
    process.env.OMP_UI_RETRY_BASE_MS = "50";
    delete process.env.MAX_AGENTS;
    delete process.env.OMP_EXTRA_ARGS;
    globals.__ompUiRepo = undefined;
    globals.__ompUiAgentManager = undefined;

    repo = await getRepo();
    board = await repo.createBoard({ name: "Test board", workdir, model: "fake/model-1" });
    // Automatic retries are on: a loop must still not be retried.
    await updateAppSettings(repo, { autoRetry: true, maxAutoRetries: 2, persistentRetry: false });
  });

  afterEach(async () => {
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

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("steers a looping agent once, then fails the run without a retry", async () => {
    await updateAppSettings(repo, { loopDetection: true });
    const task = await repo.createTask({ boardId: board.id, title: "Loops", description: "[fake:loop]", status: "todo" });
    const manager = await getAgentManager();
    await manager.start(task.id);

    const failed = await waitTask(task.id, (t) => t.agentState === "error", "the looping run to fail");
    expect(failed.retryAt).toBeNull();
    expect(failed.agentError).toBe(
      "Stopped: the agent kept looping (read src/a.ts repeated 4 times with the same result)",
    );

    const steers = readLog().filter((e) => e.kind === "steer");
    expect(steers).toHaveLength(1);
    expect(steers[0]).toMatchObject({ via: "prompt", streamingBehavior: "steer" });
    expect(steers[0]!.message).toContain("you are repeating yourself (read src/a.ts repeated 4 times with the same result)");

    const texts = await runEventTexts(task.id);
    expect(texts).toContain(
      "Loop detected: read src/a.ts repeated 4 times with the same result. Asked the agent to change approach.",
    );
    // Stopped long before the fake's 40 repetitions would have completed the run.
    expect(texts.filter((t) => t.startsWith("▸ read")).length).toBeLessThan(40);
    expect(readLog().filter((e) => e.kind === "argv")).toHaveLength(1);
  });

  it("leaves a looping agent alone when loop detection is off", async () => {
    const task = await repo.createTask({ boardId: board.id, title: "Loops", description: "[fake:loop]", status: "todo" });
    const manager = await getAgentManager();
    await manager.start(task.id);

    const done = await waitTask(task.id, (t) => t.status === "done" && t.agentState === "idle", "the run to finish");
    expect(done.agentError).toBeNull();
    expect(readLog().filter((e) => e.kind === "steer")).toEqual([]);
    expect((await runEventTexts(task.id)).some((t) => t.startsWith("Loop detected"))).toBe(false);
  });
});
