import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
import type { Board, ServerEvent, Task } from "@/lib/types";

const FAKE_OMP = fileURLToPath(new URL("../fixtures/fake-omp.mjs", import.meta.url));
/** Must match STREAM_WORDS / STREAM_THINKING in tests/fixtures/fake-omp.mjs. */
const STREAM_TEXT =
  "Streamed summary: I updated the login form, added validation, wrote tests, and verified everything passes.";
const STREAM_THINKING = "Planning the change. Checking the tests first.";
const RAW_TEXT_DELTAS = 15;
const THROTTLE_MS = 120;
/** Timer/clock jitter allowance when checking the throttle window. */
const JITTER_MS = 20;

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

interface Received {
  event: ServerEvent;
  at: number;
}

let root: string;
let repo: Repository;
let board: Board;
let received: Received[];
let unsubscribe: () => void;

/** Polls real state: a real omp subprocess is involved, so fake timers cannot drive it. */
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
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

async function waitIdleManager(manager: AgentManager): Promise<void> {
  await waitFor(() => {
    const { running, queued } = manager.stats();
    return running.length === 0 && queued.length === 0;
  }, "the agent manager to become idle");
}

function waitDone(id: string): Promise<Task> {
  return waitFor(async () => {
    const task = await repo.getTask(id);
    return task && task.status === "done" && task.agentState === "idle" ? task : null;
  }, `task ${id} to finish`);
}

beforeAll(() => {
  chmodSync(FAKE_OMP, 0o755);
});

beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "omp-ui-live-delta-test-")));
  const workdir = path.join(root, "project");
  const sessionDir = path.join(root, "sessions");
  mkdirSync(workdir);
  mkdirSync(sessionDir);

  process.env.DATABASE_URL = `sqlite:${path.join(root, "omp-ui.db")}`;
  process.env.OMP_PATH = FAKE_OMP;
  process.env.FAKE_OMP_LOG = path.join(root, "fake-omp.log");
  process.env.FAKE_OMP_SESSION_DIR = sessionDir;
  process.env.FAKE_OMP_SCENARIO = "stream";
  delete process.env.MAX_AGENTS;
  delete process.env.OMP_EXTRA_ARGS;
  globals.__ompUiRepo = undefined;
  globals.__ompUiAgentManager = undefined;

  repo = await getRepo();
  board = await repo.createBoard({ name: "Live board", workdir });
  received = [];
  unsubscribe = subscribe((event) => received.push({ event, at: Date.now() }));
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

/** Every ≥THROTTLE_MS apart except the final flush, which may follow the last trailing publish. */
function expectThrottled(deltas: Received[]): void {
  for (let i = 1; i < deltas.length - 1; i++) {
    expect(deltas[i]!.at - deltas[i - 1]!.at).toBeGreaterThanOrEqual(THROTTLE_MS - JITTER_MS);
  }
}

describe("live run.delta streaming", () => {
  it("publishes throttled, growing deltas that the persisted run.event supersedes", async () => {
    const task = await repo.createTask({ boardId: board.id, title: "Stream the answer" });
    const manager = await getAgentManager();
    await manager.start(task.id);
    await waitDone(task.id);
    await waitIdleManager(manager);

    const [run] = await repo.listRuns(task.id);
    expect(run).toMatchObject({ status: "succeeded", summary: STREAM_TEXT });

    const forRun = received.filter(({ event }) => {
      if (event.type === "run.delta") return event.runId === run!.id;
      if (event.type === "run.event") return event.event.runId === run!.id;
      if (event.type === "run.updated") return event.run.id === run!.id;
      return false;
    });
    const deltasOf = (kind: "text" | "thinking") =>
      forRun.filter(({ event }) => event.type === "run.delta" && event.kind === kind);
    const deltaText = ({ event }: Received) => (event.type === "run.delta" ? event.text : "");
    const persistedIndex = (kind: "text" | "thinking") =>
      forRun.findIndex(({ event }) => event.type === "run.event" && event.event.kind === kind);

    // Text: several live deltas, each growing the previous one, all before the persisted event.
    const textDeltas = deltasOf("text");
    expect(textDeltas.length).toBeGreaterThanOrEqual(3);
    expect(textDeltas.length).toBeLessThan(RAW_TEXT_DELTAS);
    for (const delta of textDeltas) {
      expect(delta.event).toMatchObject({ taskId: task.id, boardId: board.id, runId: run!.id });
    }
    for (let i = 1; i < textDeltas.length; i++) {
      const previous = deltaText(textDeltas[i - 1]!);
      const current = deltaText(textDeltas[i]!);
      expect(current.startsWith(previous)).toBe(true);
      expect(current.length).toBeGreaterThan(previous.length);
    }
    expectThrottled(textDeltas);

    const persistedText = persistedIndex("text");
    expect(persistedText).toBeGreaterThan(-1);
    expect(forRun.indexOf(textDeltas.at(-1)!)).toBeLessThan(persistedText);
    const persisted = forRun[persistedText]!.event;
    expect(persisted.type === "run.event" && persisted.event.text).toBe(STREAM_TEXT);
    expect(deltaText(textDeltas.at(-1)!)).toBe(STREAM_TEXT);

    // Thinking streams live too and ends at the persisted thinking text.
    const thinkingDeltas = deltasOf("thinking");
    expect(thinkingDeltas.length).toBeGreaterThanOrEqual(1);
    expect(deltaText(thinkingDeltas.at(-1)!)).toBe(STREAM_THINKING);
    expect(forRun.indexOf(thinkingDeltas.at(-1)!)).toBeLessThan(persistedIndex("thinking"));
    expectThrottled(thinkingDeltas);

    // Nothing live after the run is over.
    const succeededAt = forRun.findIndex(
      ({ event }) => event.type === "run.updated" && event.run.status === "succeeded",
    );
    expect(succeededAt).toBeGreaterThan(-1);
    expect(forRun.slice(succeededAt).some(({ event }) => event.type === "run.delta")).toBe(false);

    // Deltas are never persisted.
    const stored = await repo.listRunEvents(run!.id, 0, 1000);
    expect(stored.filter((e) => e.kind === "text").map((e) => e.text)).toEqual([STREAM_TEXT]);
  });
});
