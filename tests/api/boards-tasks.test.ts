import { writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  FAKE_OMP,
  api,
  freshEnv,
  ompLaunches,
  readOmpLog,
  setupAdmin,
  teardown,
  tempDir,
  waitFor,
  writeScript,
} from "./helpers";

import * as boardAccessRoute from "@/app/api/v1/boards/[id]/access/route";
import * as boardRoute from "@/app/api/v1/boards/[id]/route";
import * as boardTasksRoute from "@/app/api/v1/boards/[id]/tasks/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import * as commentRoute from "@/app/api/v1/comments/[id]/route";
import * as healthRoute from "@/app/api/v1/health/route";
import * as runEventsRoute from "@/app/api/v1/runs/[id]/events/route";
import * as settingsRoute from "@/app/api/v1/settings/route";
import * as systemRoute from "@/app/api/v1/system/route";
import * as taskCommentsRoute from "@/app/api/v1/tasks/[id]/comments/route";
import * as taskRoute from "@/app/api/v1/tasks/[id]/route";
import * as taskRunRoute from "@/app/api/v1/tasks/[id]/run/route";
import * as taskRunsRoute from "@/app/api/v1/tasks/[id]/runs/route";
import * as taskStopRoute from "@/app/api/v1/tasks/[id]/stop/route";
import type {
  AppSettings,
  Board,
  BoardWithCounts,
  Comment,
  Run,
  RunEvent,
  Task,
} from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/types";
import { APP_VERSION } from "@/lib/version";
import { getRepo } from "@/lib/db";

/** Settings → Orchestration and Cluster fields at their defaults (covered by settings-orchestration.test.ts and cluster.test.ts). */
const ORCHESTRATION_DEFAULTS = {
  runTimeLimit: DEFAULT_SETTINGS.runTimeLimit,
  runTimeLimitMinutes: DEFAULT_SETTINGS.runTimeLimitMinutes,
  stallWatchdog: DEFAULT_SETTINGS.stallWatchdog,
  stallTimeoutMinutes: DEFAULT_SETTINGS.stallTimeoutMinutes,
  runBudget: DEFAULT_SETTINGS.runBudget,
  runBudgetUsd: DEFAULT_SETTINGS.runBudgetUsd,
  runBudgetTokens: DEFAULT_SETTINGS.runBudgetTokens,
  loopDetection: DEFAULT_SETTINGS.loopDetection,
  gitCheckpoints: DEFAULT_SETTINGS.gitCheckpoints,
  telemetryExport: DEFAULT_SETTINGS.telemetryExport,
  telemetryEndpoint: DEFAULT_SETTINGS.telemetryEndpoint,
  loadGuard: DEFAULT_SETTINGS.loadGuard,
  loadGuardPercent: DEFAULT_SETTINGS.loadGuardPercent,
  subagentLimits: DEFAULT_SETTINGS.subagentLimits,
  subagentMaxConcurrency: DEFAULT_SETTINGS.subagentMaxConcurrency,
  subagentMaxDepth: DEFAULT_SETTINGS.subagentMaxDepth,
  subagentTimeoutMinutes: DEFAULT_SETTINGS.subagentTimeoutMinutes,
  contextCompaction: DEFAULT_SETTINGS.contextCompaction,
  contextCompactPercent: DEFAULT_SETTINGS.contextCompactPercent,
  wrapUpNudge: DEFAULT_SETTINGS.wrapUpNudge,
  wrapUpPercent: DEFAULT_SETTINGS.wrapUpPercent,
  clusterRunLocal: DEFAULT_SETTINGS.clusterRunLocal,
  clusterFailoverSeconds: DEFAULT_SETTINGS.clusterFailoverSeconds,
  clusterAutoHeal: DEFAULT_SETTINGS.clusterAutoHeal,
  clusterHealIntervalSeconds: DEFAULT_SETTINGS.clusterHealIntervalSeconds,
  clusterHealTimeoutSeconds: DEFAULT_SETTINGS.clusterHealTimeoutSeconds,
  clusterHealFailures: DEFAULT_SETTINGS.clusterHealFailures,
  clusterHealOfflineSeconds: DEFAULT_SETTINGS.clusterHealOfflineSeconds,
  clusterHealMaxRestarts: DEFAULT_SETTINGS.clusterHealMaxRestarts,
  clusterAutoRestart: DEFAULT_SETTINGS.clusterAutoRestart,
  clusterRestartAfterSeconds: DEFAULT_SETTINGS.clusterRestartAfterSeconds,
};

interface TaskDetail {
  task: Task;
  comments: Comment[];
  runs: Run[];
}

const MISSING_ID = "00000000-0000-0000-0000-000000000000";
const SUCCESS_SUMMARY = "Fake summary: implemented the task and ran the tests.";
const AGENT_TIMEOUT = 20_000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

async function createBoard(input: Record<string, unknown>): Promise<Board> {
  const res = await api<Board>(boardsRoute, "POST", "/boards", { body: input });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function postBoard(input: Record<string, unknown>) {
  return api<Board & { error?: string }>(boardsRoute, "POST", "/boards", { body: input });
}

async function patchBoard(id: string, body: Record<string, unknown>) {
  return api<Board & { error?: string }>(boardRoute, "PATCH", `/boards/${id}`, { body, params: { id } });
}

async function createTask(boardId: string, input: Record<string, unknown>): Promise<Task> {
  const res = await postTask(boardId, input);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function postTask(boardId: string, input: Record<string, unknown>) {
  return api<Task & { error?: string }>(boardTasksRoute, "POST", `/boards/${boardId}/tasks`, {
    body: input,
    params: { id: boardId },
  });
}

async function listTasks(boardId: string): Promise<Task[]> {
  const res = await api<Task[]>(boardTasksRoute, "GET", `/boards/${boardId}/tasks`, { params: { id: boardId } });
  expect(res.status).toBe(200);
  return res.body;
}

async function detail(id: string): Promise<TaskDetail> {
  const res = await api<TaskDetail>(taskRoute, "GET", `/tasks/${id}`, { params: { id } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function patchTask(id: string, body: Record<string, unknown>) {
  return api<Task & { error?: string }>(taskRoute, "PATCH", `/tasks/${id}`, { body, params: { id } });
}

async function postComment(taskId: string, body: unknown) {
  return api<Comment & { error?: string }>(taskCommentsRoute, "POST", `/tasks/${taskId}/comments`, {
    body: { body },
    params: { id: taskId },
  });
}

async function addComment(taskId: string, body: string): Promise<Comment> {
  const res = await postComment(taskId, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function listRuns(taskId: string): Promise<Run[]> {
  const res = await api<Run[]>(taskRunsRoute, "GET", `/tasks/${taskId}/runs`, { params: { id: taskId } });
  expect(res.status).toBe(200);
  return res.body;
}

async function runEvents(runId: string, query = "") {
  return api<RunEvent[] & { error?: string }>(runEventsRoute, "GET", `/runs/${runId}/events${query}`, {
    params: { id: runId },
  });
}

async function health() {
  return api<{ ok: boolean; version: string; db: string; agents: { running: string[]; queued: string[] } }>(
    healthRoute,
    "GET",
    "/health",
    { token: null },
  );
}

/** Poll GET /tasks/:id until `predicate` holds for the task. */
function waitForTask(id: string, predicate: (task: Task) => boolean): Promise<TaskDetail> {
  return waitFor(async () => {
    const d = await detail(id);
    return predicate(d.task) ? d : null;
  }, AGENT_TIMEOUT);
}

/** Wait until no agent is running or queued (a finished run is released right after its last write). */
function waitIdle(): Promise<boolean> {
  return waitFor(async () => {
    const { running, queued } = (await health()).body.agents;
    return running.length === 0 && queued.length === 0;
  }, AGENT_TIMEOUT);
}

afterAll(teardown);

// ---------------------------------------------------------------------------------------------

describe("boards", () => {
  let projectA: string;
  let projectB: string;
  let projectC: string;

  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    projectA = tempDir("project-a");
    projectB = tempDir("project-b");
    projectC = tempDir("project-c");
  });

  it("creates a board with trimmed name, normalized workdir and defaults", async () => {
    const before = Date.now();
    const board = await createBoard({ name: "  Alpha  ", workdir: `${projectA}/` });
    expect(board).toMatchObject({
      name: "Alpha",
      workdir: projectA,
      extraFolders: [],
      model: null,
      autoRun: true,
    });
    expect(typeof board.id).toBe("string");
    expect(board.id.length).toBeGreaterThan(0);
    expect(board.createdAt).toMatch(ISO);
    expect(Date.parse(board.createdAt)).toBeGreaterThanOrEqual(before - 1000);

    const custom = await createBoard({ name: "Beta", workdir: projectB, model: " sonnet ", autoRun: false });
    expect(custom.model).toBe("sonnet");
    expect(custom.autoRun).toBe(false);

    const blankModel = await createBoard({ name: "Gamma", workdir: projectB, model: "" });
    expect(blankModel.model).toBeNull();

    const fetched = await api<Board>(boardRoute, "GET", `/boards/${custom.id}`, { params: { id: custom.id } });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(custom);
  });

  it("validates the name", async () => {
    expect((await postBoard({ workdir: projectA })).body.error).toBe("name must be a string");
    const blank = await postBoard({ name: "   ", workdir: projectA });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toBe("name is required");
    const long = await postBoard({ name: "x".repeat(101), workdir: projectA });
    expect(long.status).toBe(400);
    expect(long.body.error).toBe("name must be at most 100 characters");
    expect((await postBoard({ name: "x".repeat(100), workdir: projectA })).status).toBe(201);
  });

  it("rejects a missing, relative, nonexistent or non-directory workdir with a message naming it", async () => {
    const missing = await postBoard({ name: "W" });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("Please choose a main project folder.");

    const relative = await postBoard({ name: "W", workdir: "projects/app" });
    expect(relative.status).toBe(400);
    expect(relative.body.error).toContain('full path starting with "/"');
    expect(relative.body.error).toContain("projects/app");

    const ghost = path.join(projectA, "does-not-exist");
    const nonexistent = await postBoard({ name: "W", workdir: ghost });
    expect(nonexistent.status).toBe(400);
    expect(nonexistent.body.error).toContain("doesn't exist");
    expect(nonexistent.body.error).toContain(ghost);

    const file = path.join(projectA, "README.md");
    writeFileSync(file, "hello\n");
    const notDir = await postBoard({ name: "W", workdir: file });
    expect(notDir.status).toBe(400);
    expect(notDir.body.error).toContain(file);
  });

  it("validates extra folders, de-duplicates them and drops the workdir", async () => {
    const notList = await postBoard({ name: "E", workdir: projectA, extraFolders: projectB });
    expect(notList.status).toBe(400);
    expect(notList.body.error).toBe("extraFolders must be a list of folder paths.");

    const tooMany = await postBoard({ name: "E", workdir: projectA, extraFolders: Array(21).fill(projectB) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toContain("at most 20");

    const ghost = path.join(projectB, "nope");
    const bad = await postBoard({ name: "E", workdir: projectA, extraFolders: [projectB, ghost] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("extra folder");
    expect(bad.body.error).toContain(ghost);

    const relative = await postBoard({ name: "E", workdir: projectA, extraFolders: ["backend"] });
    expect(relative.status).toBe(400);
    expect(relative.body.error).toContain("backend");

    const board = await createBoard({
      name: "Multi",
      workdir: projectA,
      extraFolders: [projectB, `${projectB}/`, `  ${projectB}  `, projectA, projectC],
    });
    expect(board.extraFolders).toEqual([projectB, projectC]);
  });

  it("sets a per-repo default branch and rejects folders or branches that aren't part of the project", async () => {
    const notObject = await postBoard({ name: "B", workdir: projectA, defaultBranches: ["main"] });
    expect(notObject.status).toBe(400);
    expect(notObject.body.error).toBe("defaultBranches must be an object of folder → branch.");

    const unknown = await postBoard({ name: "B", workdir: projectA, defaultBranches: { [projectB]: "main" } });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain("can only name the project's folders");

    const badName = await postBoard({ name: "B", workdir: projectA, defaultBranches: { [projectA]: "..bad" } });
    expect(badName.status).toBe(400);
    expect(badName.body.error).toContain("isn't a valid git branch name");

    const board = await createBoard({
      name: "Branches",
      workdir: projectA,
      extraFolders: [projectB],
      defaultBranches: { [projectA]: "develop", [projectB]: " release/1.x " },
    });
    expect(board.defaultBranches).toEqual({ [projectA]: "develop", [projectB]: "release/1.x" });

    // A folder that leaves the project takes its default branch with it.
    const removed = await patchBoard(board.id, { extraFolders: [] });
    expect(removed.body.defaultBranches).toEqual({ [projectA]: "develop" });

    // An empty branch clears that repo's entry.
    const cleared = await patchBoard(board.id, { defaultBranches: { [projectA]: "" } });
    expect(cleared.body.defaultBranches).toEqual({});
    expect(cleared.body.workdir).toBe(projectA);
  });

  it("rejects non-boolean autoRun and non-string model", async () => {
    const autoRun = await postBoard({ name: "A", workdir: projectA, autoRun: "yes" });
    expect(autoRun.status).toBe(400);
    expect(autoRun.body.error).toBe("autoRun must be a boolean");
    const model = await postBoard({ name: "A", workdir: projectA, model: 42 });
    expect(model.status).toBe(400);
    expect(model.body.error).toBe("model must be a string");
  });

  it("lists boards with task counts per status", async () => {
    const board = await createBoard({ name: "Counted", workdir: projectA, autoRun: false });
    await createTask(board.id, { title: "one" });
    await createTask(board.id, { title: "two" });
    await createTask(board.id, { title: "three", status: "in_progress" });
    await createTask(board.id, { title: "four", status: "done" });
    await createTask(board.id, { title: "five", status: "done" });

    const res = await api<BoardWithCounts[]>(boardsRoute, "GET", "/boards");
    expect(res.status).toBe(200);
    const listed = res.body.find((b) => b.id === board.id);
    expect(listed).toBeDefined();
    expect(listed?.counts).toEqual({ todo: 2, in_progress: 1, done: 2 });
    expect(listed?.runningCount).toBe(0);
    expect(listed?.name).toBe("Counted");

    const empty = res.body.find((b) => b.name === "Alpha");
    expect(empty?.counts).toEqual({ todo: 0, in_progress: 0, done: 0 });
  });

  it("returns 404 for unknown boards", async () => {
    for (const method of ["GET", "PATCH", "DELETE"] as const) {
      const res = await api(boardRoute, method, `/boards/${MISSING_ID}`, {
        params: { id: MISSING_ID },
        body: method === "PATCH" ? { name: "x" } : undefined,
      });
      expect(res.status, method).toBe(404);
      expect(res.body).toEqual({ error: "Board not found" });
    }
    const tasks = await api(boardTasksRoute, "GET", `/boards/${MISSING_ID}/tasks`, { params: { id: MISSING_ID } });
    expect(tasks.status).toBe(404);
    const create = await postTask(MISSING_ID, { title: "orphan" });
    expect(create.status).toBe(404);
  });

  it("patches name, model, autoRun and folders", async () => {
    const board = await createBoard({ name: "Patchable", workdir: projectA, extraFolders: [projectB, projectC] });

    const renamed = await patchBoard(board.id, { name: " Renamed ", model: "opus", autoRun: false });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: "Renamed", model: "opus", autoRun: false });
    expect(renamed.body.extraFolders).toEqual([projectB, projectC]);

    // Moving the workdir onto an extra folder removes it from extraFolders.
    const moved = await patchBoard(board.id, { workdir: projectB });
    expect(moved.status).toBe(200);
    expect(moved.body.workdir).toBe(projectB);
    expect(moved.body.extraFolders).toEqual([projectC]);

    // Setting both at once: the workdir is dropped from the given list.
    const both = await patchBoard(board.id, { workdir: projectA, extraFolders: [projectA, projectB, projectB] });
    expect(both.body.workdir).toBe(projectA);
    expect(both.body.extraFolders).toEqual([projectB]);

    const cleared = await patchBoard(board.id, { extraFolders: [], model: null });
    expect(cleared.body.extraFolders).toEqual([]);
    expect(cleared.body.model).toBeNull();

    const invalid = await patchBoard(board.id, { workdir: "relative/dir", name: "Should not apply" });
    expect(invalid.status).toBe(400);
    const unchanged = await patchBoard(board.id, {});
    expect(unchanged.status).toBe(200);
    expect(unchanged.body).toMatchObject({ name: "Renamed", workdir: projectA, extraFolders: [] });

    const blankName = await patchBoard(board.id, { name: "" });
    expect(blankName.status).toBe(400);
    expect(blankName.body.error).toBe("name is required");
  });

  it("pins and unpins a board without bumping its updatedAt", async () => {
    const board = await createBoard({ name: "Pinnable", workdir: projectA });
    expect(board.pinned).toBe(false);

    const pinned = await patchBoard(board.id, { pinned: true });
    expect(pinned.status).toBe(200);
    expect(pinned.body).toMatchObject({ pinned: true, updatedAt: board.updatedAt });
    const listed = await api<BoardWithCounts[]>(boardsRoute, "GET", "/boards");
    expect(listed.body.find((b) => b.id === board.id)?.pinned).toBe(true);

    const unpinned = await patchBoard(board.id, { pinned: false });
    expect(unpinned.body).toMatchObject({ pinned: false, updatedAt: board.updatedAt });

    const invalid = await patchBoard(board.id, { pinned: "yes" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("pinned must be a boolean");
  });

  it("creates and patches the push branch, validating it as a git branch name", async () => {
    const board = await createBoard({ name: "Pushable", workdir: projectA });
    expect(board.pushBranch).toBe("main");
    const release = await createBoard({ name: "Released", workdir: projectA, pushBranch: " release/1.x " });
    expect(release.pushBranch).toBe("release/1.x");

    const invalidCreate = await postBoard({ name: "Bad push branch", workdir: projectA, pushBranch: "a..b" });
    expect(invalidCreate.status).toBe(400);
    expect(invalidCreate.body.error).toBe("pushBranch must be a valid git branch name");
    const listed = await api<BoardWithCounts[]>(boardsRoute, "GET", "/boards");
    expect(listed.body.some((b) => b.name === "Bad push branch")).toBe(false);

    const patched = await patchBoard(board.id, { pushBranch: "develop" });
    expect(patched.status).toBe(200);
    expect(patched.body.pushBranch).toBe("develop");
    const fetched = await api<Board>(boardRoute, "GET", `/boards/${board.id}`, { params: { id: board.id } });
    expect(fetched.body.pushBranch).toBe("develop");

    const cases: [unknown, string][] = [
      ["", "pushBranch is required"],
      [5, "pushBranch must be a string"],
      [null, "pushBranch must be a string"],
      ["--upload-pack=x", "pushBranch must be a valid git branch name"],
      ["a..b", "pushBranch must be a valid git branch name"],
    ];
    for (const [pushBranch, error] of cases) {
      const res = await patchBoard(board.id, { pushBranch });
      expect(res.status, JSON.stringify(pushBranch)).toBe(400);
      expect(res.body.error).toBe(error);
    }
    const unchanged = await api<Board>(boardRoute, "GET", `/boards/${board.id}`, { params: { id: board.id } });
    expect(unchanged.body.pushBranch).toBe("develop");
  });

  it("records opening a board without bumping its updatedAt", async () => {
    const board = await createBoard({ name: "Opened", workdir: projectA });
    expect(board.lastAccessedAt).toBeNull();

    const opened = await api<Board>(boardAccessRoute, "POST", `/boards/${board.id}/access`, { params: { id: board.id } });
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ id: board.id, updatedAt: board.updatedAt });
    expect(opened.body.lastAccessedAt).toMatch(ISO);
    const listed = await api<BoardWithCounts[]>(boardsRoute, "GET", "/boards");
    expect(listed.body.find((b) => b.id === board.id)?.lastAccessedAt).toBe(opened.body.lastAccessedAt);

    const missing = await api(boardAccessRoute, "POST", `/boards/${MISSING_ID}/access`, { params: { id: MISSING_ID } });
    expect(missing.status).toBe(404);
  });

  it("deletes a board and cascades to its tasks and comments", async () => {
    const board = await createBoard({ name: "Doomed", workdir: projectA, autoRun: false });
    const task = await createTask(board.id, { title: "will vanish" });
    const comment = await addComment(task.id, "some feedback");

    const res = await api(boardRoute, "DELETE", `/boards/${board.id}`, { params: { id: board.id } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect((await api(boardRoute, "GET", `/boards/${board.id}`, { params: { id: board.id } })).status).toBe(404);
    expect((await api(taskRoute, "GET", `/tasks/${task.id}`, { params: { id: task.id } })).status).toBe(404);
    const commentPatch = await api(commentRoute, "PATCH", `/comments/${comment.id}`, {
      params: { id: comment.id },
      body: { resolved: true },
    });
    expect(commentPatch.status).toBe(404);
    const list = await api<BoardWithCounts[]>(boardsRoute, "GET", "/boards");
    expect(list.body.some((b) => b.id === board.id)).toBe(false);
    expect((await api(boardRoute, "DELETE", `/boards/${board.id}`, { params: { id: board.id } })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------

describe("tasks and comments", () => {
  let board: Board;

  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    board = await createBoard({ name: "Manual", workdir: tempDir("manual"), autoRun: false });
  });

  it("creates a task with defaults", async () => {
    const task = await createTask(board.id, { title: "  Write docs  " });
    expect(task).toMatchObject({
      boardId: board.id,
      title: "Write docs",
      description: "",
      status: "todo",
      agentState: "idle",
      agentError: null,
      sessionFile: null,
      lastRunId: null,
      commentCount: 0,
      openCommentCount: 0,
    });
    expect(typeof task.position).toBe("number");
    expect(task.createdAt).toMatch(ISO);

    const d = await detail(task.id);
    expect(d).toEqual({ task, comments: [], runs: [] });
  });

  it("validates title, description, status and position", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{}, "title must be a string"],
      [{ title: "   " }, "title is required"],
      [{ title: "x".repeat(201) }, "title must be at most 200 characters"],
      [{ title: "ok", description: 5 }, "description must be a string"],
      [{ title: "ok", description: "d".repeat(20_001) }, "description must be at most 20000 characters"],
      [{ title: "ok", status: "doing" }, "status must be one of: todo, in_progress, done"],
      [{ title: "ok", position: "1" }, "position must be a finite number"],
    ];
    for (const [input, error] of cases) {
      const res = await postTask(board.id, input);
      expect(res.status, JSON.stringify(input).slice(0, 80)).toBe(400);
      expect(res.body.error).toBe(error);
    }

    const maxed = await createTask(board.id, { title: "t".repeat(200), description: "d".repeat(20_000) });
    expect(maxed.title.length).toBe(200);
    expect(maxed.description.length).toBe(20_000);

    const invalidJson = await api(boardTasksRoute, "POST", `/boards/${board.id}/tasks`, {
      rawBody: "{",
      params: { id: board.id },
    });
    expect(invalidJson.status).toBe(400);
  });

  it("orders tasks by status, then position", async () => {
    const ordered = await createBoard({ name: "Ordered", workdir: board.workdir, autoRun: false });
    const a = await createTask(ordered.id, { title: "A" });
    const b = await createTask(ordered.id, { title: "B" });
    expect(b.position).toBeGreaterThan(a.position);
    await createTask(ordered.id, { title: "C", position: a.position - 1 });
    await createTask(ordered.id, { title: "Doing", status: "in_progress", position: -1_000_000 });
    await createTask(ordered.id, { title: "Shipped", status: "done", position: -2_000_000 });

    expect((await listTasks(ordered.id)).map((t) => t.title)).toEqual(["C", "A", "B", "Doing", "Shipped"]);

    const moved = await patchTask(b.id, { position: a.position - 100 });
    expect(moved.status).toBe(200);
    expect((await listTasks(ordered.id)).map((t) => t.title)).toEqual(["B", "C", "A", "Doing", "Shipped"]);

    const fractional = await patchTask(a.id, { position: (moved.body.position + a.position) / 2 + 0.5 });
    expect(fractional.status).toBe(200);
    expect((await listTasks(ordered.id)).map((t) => t.title).slice(0, 3)).toEqual(["B", "A", "C"]);
  });

  it("patches a task and validates the patch", async () => {
    const task = await createTask(board.id, { title: "Patch me" });
    const res = await patchTask(task.id, { title: "Patched", description: "  More detail  " });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: task.id, title: "Patched", description: "More detail", status: "todo" });

    const badStatus = await patchTask(task.id, { status: "archived" });
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.error).toBe("status must be one of: todo, in_progress, done");
    expect((await patchTask(task.id, { title: "" })).status).toBe(400);
    expect((await patchTask(task.id, { title: "y".repeat(201) })).status).toBe(400);
    expect((await patchTask(task.id, { position: Number.NaN })).status).toBe(400);

    const noop = await patchTask(task.id, {});
    expect(noop.status).toBe(200);
    expect(noop.body.title).toBe("Patched");

    const missing = await patchTask(MISSING_ID, { title: "x" });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("Task not found");
  });

  it("clears the agent's question with PATCH question: null and rejects any other value", async () => {
    const task = await createTask(board.id, { title: "Questioned" });
    await (await getRepo()).updateTask(task.id, { question: "Keep the beta label?" });

    const rejected = await patchTask(task.id, { question: "my answer" });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("question can only be cleared (set it to null)");
    const kept = await api<{ task: Task }>(taskRoute, "GET", `/tasks/${task.id}`, { params: { id: task.id } });
    expect(kept.body.task.question).toBe("Keep the beta label?");

    const cleared = await patchTask(task.id, { question: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.question).toBeNull();
  });

  it("moving a card to In progress on a board without autoRun does not start omp", async () => {
    const task = await createTask(board.id, { title: "No auto run" });
    const moved = await patchTask(task.id, { status: "in_progress" });
    expect(moved.status).toBe(200);
    expect(moved.body.status).toBe("in_progress");
    expect(moved.body.agentState).toBe("idle");
    expect((await health()).body.agents).toEqual({ running: [], queued: [] });
    expect(ompLaunches()).toEqual([]);

    const done = await patchTask(task.id, { status: "done" });
    expect(done.body.status).toBe("done");
  });

  it("returns 404 for unknown tasks on every task route", async () => {
    const res = await api(taskRoute, "GET", `/tasks/${MISSING_ID}`, { params: { id: MISSING_ID } });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Task not found" });
    expect((await api(taskRoute, "DELETE", `/tasks/${MISSING_ID}`, { params: { id: MISSING_ID } })).status).toBe(404);
    expect((await api(taskRunRoute, "POST", `/tasks/${MISSING_ID}/run`, { params: { id: MISSING_ID } })).status).toBe(404);
    expect((await api(taskStopRoute, "POST", `/tasks/${MISSING_ID}/stop`, { params: { id: MISSING_ID } })).status).toBe(404);
    expect((await api(taskRunsRoute, "GET", `/tasks/${MISSING_ID}/runs`, { params: { id: MISSING_ID } })).status).toBe(404);
    expect(
      (await api(taskCommentsRoute, "GET", `/tasks/${MISSING_ID}/comments`, { params: { id: MISSING_ID } })).status,
    ).toBe(404);
    expect((await postComment(MISSING_ID, "hello")).status).toBe(404);
  });

  it("adds, lists, resolves and deletes comments", async () => {
    const task = await createTask(board.id, { title: "Discuss" });

    const first = await addComment(task.id, "  First note  ");
    expect(first).toMatchObject({
      taskId: task.id,
      author: "user",
      body: "First note",
      resolved: false,
      resolvedAt: null,
      resolvedByRunId: null,
    });
    expect(first.createdAt).toMatch(ISO);
    const second = await addComment(task.id, "Second note");

    // Feedback on a To do card is stored only: no agent starts.
    const afterComments = await detail(task.id);
    expect(afterComments.task.status).toBe("todo");
    expect(afterComments.task.agentState).toBe("idle");
    expect(afterComments.task.commentCount).toBe(2);
    expect(afterComments.task.openCommentCount).toBe(2);
    expect(afterComments.comments.map((c) => c.id)).toEqual([first.id, second.id]);
    expect(ompLaunches()).toEqual([]);

    const list = await api<Comment[]>(taskCommentsRoute, "GET", `/tasks/${task.id}/comments`, {
      params: { id: task.id },
    });
    expect(list.status).toBe(200);
    expect(list.body.map((c) => c.body)).toEqual(["First note", "Second note"]);

    const resolved = await api<Comment>(commentRoute, "PATCH", `/comments/${first.id}`, {
      params: { id: first.id },
      body: { resolved: true },
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.resolved).toBe(true);
    expect(resolved.body.resolvedAt).toMatch(ISO);
    expect((await detail(task.id)).task.openCommentCount).toBe(1);

    const reopened = await api<Comment>(commentRoute, "PATCH", `/comments/${first.id}`, {
      params: { id: first.id },
      body: { resolved: false },
    });
    expect(reopened.body.resolved).toBe(false);
    expect(reopened.body.resolvedAt).toBeNull();
    expect((await detail(task.id)).task.openCommentCount).toBe(2);

    const badPatch = await api(commentRoute, "PATCH", `/comments/${first.id}`, {
      params: { id: first.id },
      body: { resolved: "yes" },
    });
    expect(badPatch.status).toBe(400);
    expect(badPatch.body).toEqual({ error: "resolved must be a boolean" });

    const deleted = await api(commentRoute, "DELETE", `/comments/${second.id}`, { params: { id: second.id } });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true });
    const afterDelete = await detail(task.id);
    expect(afterDelete.comments.map((c) => c.id)).toEqual([first.id]);
    expect(afterDelete.task.commentCount).toBe(1);

    for (const method of ["PATCH", "DELETE"] as const) {
      const res = await api(commentRoute, method, `/comments/${second.id}`, {
        params: { id: second.id },
        body: method === "PATCH" ? { resolved: true } : undefined,
      });
      expect(res.status, method).toBe(404);
      expect(res.body).toEqual({ error: "Comment not found" });
    }
  });

  it("validates comment bodies", async () => {
    const task = await createTask(board.id, { title: "Validate comments" });
    const empty = await postComment(task.id, "  ");
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("body is required");
    const notString = await postComment(task.id, 12);
    expect(notString.status).toBe(400);
    expect(notString.body.error).toBe("body must be a string");
    const long = await postComment(task.id, "c".repeat(10_001));
    expect(long.status).toBe(400);
    expect(long.body.error).toBe("body must be at most 10000 characters");
    expect((await postComment(task.id, "c".repeat(10_000))).status).toBe(201);
  });

  it("deletes a task together with its comments", async () => {
    const task = await createTask(board.id, { title: "Delete me" });
    const comment = await addComment(task.id, "bye");
    const res = await api(taskRoute, "DELETE", `/tasks/${task.id}`, { params: { id: task.id } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((await api(taskRoute, "GET", `/tasks/${task.id}`, { params: { id: task.id } })).status).toBe(404);
    expect((await listTasks(board.id)).some((t) => t.id === task.id)).toBe(false);
    const patch = await api(commentRoute, "PATCH", `/comments/${comment.id}`, {
      params: { id: comment.id },
      body: { resolved: true },
    });
    expect(patch.status).toBe(404);
  });

  it("bulk-deletes the listed cards of the board only", async () => {
    const bulk = await createBoard({ name: "Bulk", workdir: board.workdir, autoRun: false });
    const doneA = await createTask(bulk.id, { title: "Done A", status: "done" });
    const doneB = await createTask(bulk.id, { title: "Done B", status: "done" });
    const kept = await createTask(bulk.id, { title: "Kept", status: "done" });
    const elsewhere = await createTask(board.id, { title: "Other board", status: "done" });
    const res = await api<{ deleted: string[] }>(boardTasksRoute, "DELETE", `/boards/${bulk.id}/tasks`, {
      params: { id: bulk.id },
      body: { ids: [doneA.id, doneB.id, doneA.id, elsewhere.id, MISSING_ID] },
    });
    expect(res.status).toBe(200);
    expect([...res.body.deleted].sort()).toEqual([doneA.id, doneB.id].sort());
    expect((await listTasks(bulk.id)).map((t) => t.id)).toEqual([kept.id]);
    expect((await listTasks(board.id)).some((t) => t.id === elsewhere.id)).toBe(true);

    for (const ids of [undefined, [], ["  "], "x", [1]]) {
      const bad = await api(boardTasksRoute, "DELETE", `/boards/${bulk.id}/tasks`, {
        params: { id: bulk.id },
        body: { ids },
      });
      expect(bad.status, JSON.stringify(ids)).toBe(400);
    }
  });

  it("answers 404 for run events of an unknown run", async () => {
    const res = await runEvents(MISSING_ID);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Run not found" });
  });
});

// ---------------------------------------------------------------------------------------------

describe("agent flow with the fake omp", () => {
  let workdir: string;
  let extraDir: string;
  let autoBoard: Board;
  let manualBoard: Board;

  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    workdir = tempDir("agent-project");
    extraDir = tempDir("agent-extra");
    autoBoard = await createBoard({ name: "Auto", workdir, extraFolders: [extraDir], model: "sonnet" });
    manualBoard = await createBoard({ name: "Manual", workdir, autoRun: false });
  });

  beforeEach(async () => {
    await waitIdle();
  });

  it(
    "moving a card to In progress runs the agent, posts its summary, resolves feedback and moves it to Done",
    async () => {
      const task = await createTask(autoBoard.id, { title: "Implement login", description: "Use the session API" });
      const feedback = await addComment(task.id, "Use bcrypt for hashing");
      const launchesBefore = ompLaunches().length;

      const moved = await patchTask(task.id, { status: "in_progress" });
      expect(moved.status).toBe(200);
      expect(moved.body.status).toBe("in_progress");
      expect(["queued", "running"]).toContain(moved.body.agentState);

      const done = await waitForTask(task.id, (t) => t.status === "done" && t.agentState === "idle");
      expect(done.task.agentError).toBeNull();
      expect(done.task.openCommentCount).toBe(0);
      expect(done.task.sessionFile).toEqual(expect.any(String));

      const resolvedFeedback = done.comments.find((c) => c.id === feedback.id);
      const agentComments = done.comments.filter((c) => c.author === "agent");
      expect(agentComments.map((c) => c.body)).toEqual([SUCCESS_SUMMARY]);
      expect(agentComments[0].resolved).toBe(true);

      const runs = await listRuns(task.id);
      expect(runs).toHaveLength(1);
      const [run] = runs;
      expect(done.runs).toEqual(runs);
      expect(done.task.lastRunId).toBe(run.id);
      expect(run).toMatchObject({ taskId: task.id, status: "succeeded", summary: SUCCESS_SUMMARY, error: null });
      expect(run.endedAt).toMatch(ISO);
      expect(run.prompt).toContain("Implement login");
      expect(run.prompt).toContain("Use the session API");
      expect(run.prompt).toContain("Use bcrypt for hashing");
      expect(resolvedFeedback).toMatchObject({ resolved: true, resolvedByRunId: run.id });

      // omp was started in the board folder with the board's options.
      const launches = ompLaunches().slice(launchesBefore);
      expect(launches).toHaveLength(1);
      const argv = launches[0];
      expect(argv.slice(0, 2)).toEqual(["--mode", "rpc"]);
      expect(argv[argv.indexOf("--cwd") + 1]).toBe(workdir);
      expect(argv[argv.indexOf("--add-dir") + 1]).toBe(extraDir);
      expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
      expect(argv[argv.indexOf("--approval-mode") + 1]).toBe("yolo");
      expect(argv).not.toContain("--resume");

      // Run log, paged with ?after= and ?limit=.
      const events = await runEvents(run.id);
      expect(events.status).toBe(200);
      const log = events.body;
      expect(log.length).toBeGreaterThanOrEqual(4);
      for (let i = 1; i < log.length; i++) expect(log[i].seq).toBeGreaterThan(log[i - 1].seq);
      expect(log.every((e) => e.runId === run.id && e.taskId === task.id)).toBe(true);
      const texts = log.map((e) => `${e.kind}:${e.text}`);
      expect(texts).toContain("status:Prompt sent to agent");
      expect(texts).toContain("tool:▸ bash: npm test\nRunning the tests");
      expect(texts).toContain(`text:${SUCCESS_SUMMARY}`);
      expect(texts.at(-1)).toBe("status:Agent finished");

      const after = await runEvents(run.id, `?after=${log[1].seq}`);
      expect(after.body.map((e) => e.seq)).toEqual(log.slice(2).map((e) => e.seq));
      const limited = await runEvents(run.id, "?limit=2");
      expect(limited.body.map((e) => e.seq)).toEqual(log.slice(0, 2).map((e) => e.seq));
      const page = await runEvents(run.id, `?after=${log[0].seq}&limit=1`);
      expect(page.body.map((e) => e.seq)).toEqual([log[1].seq]);
      expect((await runEvents(run.id, `?after=${log.at(-1)?.seq}`)).body).toEqual([]);

      for (const query of ["?after=-1", "?after=abc", "?limit=0", "?limit=1001", "?limit=2.5"]) {
        const bad = await runEvents(run.id, query);
        expect(bad.status, query).toBe(400);
        expect(typeof bad.body.error).toBe("string");
      }

      await waitIdle();
    },
    60_000,
  );

  it(
    "a comment on a Done card reopens it and resumes the same omp session",
    async () => {
      const task = await createTask(autoBoard.id, { title: "Add logout", status: "in_progress" });
      const first = await waitForTask(task.id, (t) => t.status === "done" && t.agentState === "idle");
      const sessionFile = first.task.sessionFile;
      expect(sessionFile).toEqual(expect.any(String));
      await waitIdle();
      const launchesBefore = ompLaunches().length;

      const comment = await addComment(task.id, "Also clear the remember-me cookie");
      const reopened = await detail(task.id);
      expect(reopened.task.status).toBe("in_progress");

      const done = await waitForTask(task.id, (t) => t.status === "done" && t.agentState === "idle");
      expect(done.comments.find((c) => c.id === comment.id)?.resolved).toBe(true);
      expect(done.comments.filter((c) => c.author === "agent")).toHaveLength(2);

      const runs = await listRuns(task.id);
      expect(runs).toHaveLength(2);
      expect(runs.every((r) => r.status === "succeeded")).toBe(true);
      const latest = runs.find((r) => r.id === done.task.lastRunId);
      expect(latest?.prompt).toContain("Also clear the remember-me cookie");
      expect(done.comments.find((c) => c.id === comment.id)?.resolvedByRunId).toBe(latest?.id);

      const launches = ompLaunches().slice(launchesBefore);
      expect(launches).toHaveLength(1);
      expect(launches[0][launches[0].indexOf("--resume") + 1]).toBe(sessionFile);
    },
    60_000,
  );

  it(
    "a failing agent leaves the card In progress with agentState error and an explanation",
    async () => {
      const created = await createTask(autoBoard.id, { title: "Flaky model [fake:error]", status: "in_progress" });
      expect(created.status).toBe("in_progress");
      expect(["queued", "running", "error"]).toContain(created.agentState);

      // The failure comment is written right after the error state.
      const failed = await waitForTask(created.id, (t) => t.agentState === "error" && t.commentCount === 1);
      expect(failed.task.status).toBe("in_progress");
      expect(failed.task.agentError).toBe("Fake model error: upstream failed");
      const agentComments = failed.comments.filter((c) => c.author === "agent");
      // Retried automatically in its omp session after 15 s (retries are on by default).
      expect(agentComments.map((c) => c.body)).toEqual([
        "Agent failed: Fake model error: upstream failed\n\nRetrying automatically in 15s (retry 1).",
      ]);
      expect(failed.task.autoRetries).toBe(1);
      expect(Date.parse(failed.task.retryAt ?? "")).toBeGreaterThan(Date.now());

      const runs = await listRuns(created.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "failed", error: "Fake model error: upstream failed", summary: null });
      const events = (await runEvents(runs[0].id)).body;
      expect(events.some((e) => e.kind === "error" && e.text.includes("Fake model error"))).toBe(true);

      // Stop on an idle errored card clears the error state.
      await waitIdle();
      const stopped = await api<Task>(taskStopRoute, "POST", `/tasks/${created.id}/stop`, {
        params: { id: created.id },
      });
      expect(stopped.status).toBe(200);
      expect(stopped.body.agentState).toBe("idle");
      expect(stopped.body.agentError).toBeNull();
      // …and cancels the pending automatic retry.
      expect(stopped.body.retryAt).toBeNull();
      expect(stopped.body.status).toBe("in_progress");
    },
    60_000,
  );

  it(
    "an omp crash is reported as an agent error",
    async () => {
      const created = await createTask(autoBoard.id, { title: "Crashy [fake:crash]", status: "in_progress" });
      const failed = await waitForTask(created.id, (t) => t.agentState === "error");
      expect(failed.task.status).toBe("in_progress");
      expect(failed.task.agentError).toContain("segmentation fault");
      expect((await listRuns(created.id))[0].status).toBe("failed");
      // Cancel its automatic retry so it does not run during later tests.
      await api(taskStopRoute, "POST", `/tasks/${created.id}/stop`, { params: { id: created.id } });
    },
    60_000,
  );

  it(
    "POST /run starts the agent on a manual board and POST /stop aborts it",
    async () => {
      const task = await createTask(manualBoard.id, { title: "Long job [fake:slow]" });
      expect(task.status).toBe("todo");

      const started = await api<Task>(taskRunRoute, "POST", `/tasks/${task.id}/run`, { params: { id: task.id } });
      expect(started.status).toBe(200);
      expect(started.body.status).toBe("in_progress");
      expect(["queued", "running"]).toContain(started.body.agentState);

      await waitForTask(task.id, (t) => t.agentState === "running");
      const run = await waitFor(async () => {
        const [latest] = await listRuns(task.id);
        if (!latest) return null;
        const events = (await runEvents(latest.id)).body;
        return events.some((e) => e.text === "Prompt sent to agent") ? latest : null;
      }, AGENT_TIMEOUT);
      expect((await health()).body.agents.running).toEqual([task.id]);

      // Starting again while running is a no-op.
      const again = await api<Task>(taskRunRoute, "POST", `/tasks/${task.id}/run`, { params: { id: task.id } });
      expect(again.body.agentState).toBe("running");
      expect(await listRuns(task.id)).toHaveLength(1);

      const stopped = await api<Task>(taskStopRoute, "POST", `/tasks/${task.id}/stop`, { params: { id: task.id } });
      expect(stopped.status).toBe(200);
      expect(stopped.body.agentState).toBe("idle");
      expect(stopped.body.status).toBe("in_progress");

      const runs = await listRuns(task.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ id: run.id, status: "aborted", error: "Stopped by user" });
      expect(runs[0].endedAt).toMatch(ISO);
      expect((await health()).body.agents).toEqual({ running: [], queued: [] });

      // Stop again: nothing to stop, card unchanged.
      const idle = await api<Task>(taskStopRoute, "POST", `/tasks/${task.id}/stop`, { params: { id: task.id } });
      expect(idle.status).toBe(200);
      expect(idle.body).toMatchObject({ agentState: "idle", status: "in_progress" });
    },
    60_000,
  );

  it(
    "a comment while the agent is running is steered into the live session",
    async () => {
      const task = await createTask(manualBoard.id, { title: "Steerable [fake:slow]" });
      await api(taskRunRoute, "POST", `/tasks/${task.id}/run`, { params: { id: task.id } });
      await waitForTask(task.id, (t) => t.agentState === "running");

      const comment = await addComment(task.id, "Please also add tests");
      const done = await waitForTask(task.id, (t) => t.status === "done" && t.agentState === "idle");

      expect(done.comments.find((c) => c.id === comment.id)?.resolved).toBe(true);
      expect(done.comments.filter((c) => c.author === "agent").map((c) => c.body)).toEqual([
        "Fake summary: addressed 1 steered message(s).",
      ]);
      expect(await listRuns(task.id)).toHaveLength(1);
      const steers = readOmpLog().filter((e) => e.kind === "steer");
      expect(steers.some((e) => e.message?.includes("Please also add tests"))).toBe(true);
    },
    60_000,
  );

  it(
    "moving a running card back to To do stops the agent",
    async () => {
      const task = await createTask(manualBoard.id, { title: "Changed my mind [fake:slow]" });
      await api(taskRunRoute, "POST", `/tasks/${task.id}/run`, { params: { id: task.id } });
      await waitForTask(task.id, (t) => t.agentState === "running");

      const moved = await patchTask(task.id, { status: "todo" });
      expect(moved.status).toBe(200);
      expect(moved.body).toMatchObject({ status: "todo", agentState: "idle" });
      expect((await listRuns(task.id))[0].status).toBe("aborted");
      expect((await health()).body.agents.running).not.toContain(task.id);
    },
    60_000,
  );

  it(
    "queues runs beyond maxConcurrentAgents and starts them when a slot frees",
    async () => {
      const limit = await api<AppSettings>(settingsRoute, "PATCH", "/settings", { body: { maxConcurrentAgents: 1 } });
      expect(limit.body.maxConcurrentAgents).toBe(1);
      try {
        const first = await createTask(manualBoard.id, { title: "First slot [fake:slow]" });
        const second = await createTask(manualBoard.id, { title: "Second slot [fake:slow]" });
        await api(taskRunRoute, "POST", `/tasks/${first.id}/run`, { params: { id: first.id } });
        await waitForTask(first.id, (t) => t.agentState === "running");
        const queued = await api<Task>(taskRunRoute, "POST", `/tasks/${second.id}/run`, { params: { id: second.id } });
        expect(queued.body.agentState).toBe("queued");
        expect((await health()).body.agents).toEqual({ running: [first.id], queued: [second.id] });

        await api(taskStopRoute, "POST", `/tasks/${first.id}/stop`, { params: { id: first.id } });
        await waitForTask(second.id, (t) => t.agentState === "running");
        await api(taskStopRoute, "POST", `/tasks/${second.id}/stop`, { params: { id: second.id } });
      } finally {
        await api(settingsRoute, "PATCH", "/settings", { body: { maxConcurrentAgents: "auto" } });
      }
    },
    60_000,
  );

  it(
    "deleting a board stops its running agents",
    async () => {
      const doomed = await createBoard({ name: "Doomed", workdir, autoRun: false });
      const task = await createTask(doomed.id, { title: "Doomed run [fake:slow]" });
      await api(taskRunRoute, "POST", `/tasks/${task.id}/run`, { params: { id: task.id } });
      await waitForTask(task.id, (t) => t.agentState === "running");
      expect((await health()).body.agents.running).toContain(task.id);

      const res = await api(boardRoute, "DELETE", `/boards/${doomed.id}`, { params: { id: doomed.id } });
      expect(res.status).toBe(200);
      expect((await health()).body.agents).toEqual({ running: [], queued: [] });
      expect((await api(taskRoute, "GET", `/tasks/${task.id}`, { params: { id: task.id } })).status).toBe(404);
    },
    60_000,
  );

  it(
    "deleting a running task stops its agent",
    async () => {
      const task = await createTask(manualBoard.id, { title: "Delete while running [fake:slow]" });
      await api(taskRunRoute, "POST", `/tasks/${task.id}/run`, { params: { id: task.id } });
      await waitForTask(task.id, (t) => t.agentState === "running");

      const res = await api(taskRoute, "DELETE", `/tasks/${task.id}`, { params: { id: task.id } });
      expect(res.status).toBe(200);
      expect((await health()).body.agents.running).not.toContain(task.id);
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------------------------

describe("settings, health and system", () => {
  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
  });

  it("GET /health needs no auth and reports version, db and agents", async () => {
    const res = await health();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      version: APP_VERSION,
      db: "sqlite",
      agents: { running: [], queued: [] },
    });
  });

  it("GET /settings returns defaults with OMP_PATH applied", async () => {
    const res = await api<AppSettings>(settingsRoute, "GET", "/settings");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      maxConcurrentAgents: "auto",
      ompPath: FAKE_OMP,
      approvalMode: "yolo",
      defaultModel: "",
      smartQueue: true,
      browser: "headless",
      useSystemPrompt: true,
      providerPriority: [],
      autoRetry: true,
      persistentRetry: true,
      maxAutoRetries: 5,
      cleanupSchedule: "off",
      cleanupTargets: DEFAULT_SETTINGS.cleanupTargets,
      taskCompletionNotifications: false,
      visibleDashboardMenus: DEFAULT_SETTINGS.visibleDashboardMenus,
      primaryColor: DEFAULT_SETTINGS.primaryColor,
      telegramBotToken: "",
      discordBotToken: "",
      ...ORCHESTRATION_DEFAULTS,
    });
  });

  it("PATCH /settings rejects invalid values with 400 and leaves settings unchanged", async () => {
    const before = (await api<AppSettings>(settingsRoute, "GET", "/settings")).body;
    const cases: [Record<string, unknown>, string][] = [
      [{ maxConcurrentAgents: 0 }, 'maxConcurrentAgents must be "auto" or an integer between 1 and 16'],
      [{ maxConcurrentAgents: 17 }, 'maxConcurrentAgents must be "auto" or an integer between 1 and 16'],
      [{ maxConcurrentAgents: 2.5 }, 'maxConcurrentAgents must be "auto" or an integer between 1 and 16'],
      [{ maxConcurrentAgents: "3" }, 'maxConcurrentAgents must be "auto" or an integer between 1 and 16'],
      [{ maxConcurrentAgents: "Auto!" }, 'maxConcurrentAgents must be "auto" or an integer between 1 and 16'],
      [{ approvalMode: "bogus" }, "approvalMode must be one of: yolo, write, always-ask"],
      [{ ompPath: "   " }, "ompPath must be a non-empty string"],
      [{ ompPath: 7 }, "ompPath must be a non-empty string"],
      [{ defaultModel: "m".repeat(201) }, "defaultModel must be a string of at most 200 characters"],
      [{ smartQueue: 1 }, "smartQueue must be a boolean"],
      [{ autoRetry: "on" }, "autoRetry must be a boolean"],
      [{ persistentRetry: "on" }, "persistentRetry must be a boolean"],
      [{ taskCompletionNotifications: "on" }, "taskCompletionNotifications must be a boolean"],
      [{ maxAutoRetries: 21 }, "maxAutoRetries must be an integer between 0 and 20"],
      [{ maxAutoRetries: -1 }, "maxAutoRetries must be an integer between 0 and 20"],
      [{ maxAutoRetries: 1.5 }, "maxAutoRetries must be an integer between 0 and 20"],
      [{ maxConcurrentAgents: 3, approvalMode: "nope" }, "approvalMode must be one of: yolo, write, always-ask"],
    ];
    for (const [body, error] of cases) {
      const res = await api(settingsRoute, "PATCH", "/settings", { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toEqual({ error });
    }
    expect((await api<AppSettings>(settingsRoute, "GET", "/settings")).body).toEqual(before);
  });

  it("PATCH /settings trims and persists values, merging partial patches", async () => {
    const res = await api<AppSettings>(settingsRoute, "PATCH", "/settings", {
      body: { maxConcurrentAgents: 16, approvalMode: "write", defaultModel: "  sonnet  ", ompPath: "  /opt/omp/bin/omp  " },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      maxConcurrentAgents: 16,
      ompPath: "/opt/omp/bin/omp",
      approvalMode: "write",
      defaultModel: "sonnet",
      smartQueue: true,
      browser: "headless",
      useSystemPrompt: true,
      providerPriority: [],
      autoRetry: true,
      persistentRetry: true,
      maxAutoRetries: 5,
      cleanupSchedule: "off",
      cleanupTargets: DEFAULT_SETTINGS.cleanupTargets,
      taskCompletionNotifications: false,
      visibleDashboardMenus: DEFAULT_SETTINGS.visibleDashboardMenus,
      primaryColor: DEFAULT_SETTINGS.primaryColor,
      telegramBotToken: "",
      discordBotToken: "",
      ...ORCHESTRATION_DEFAULTS,
    });

    const partial = await api<AppSettings>(settingsRoute, "PATCH", "/settings", {
      body: {
        maxConcurrentAgents: 1,
        approvalMode: "always-ask",
        defaultModel: "",
        smartQueue: false,
        browser: "off",
        autoRetry: false,
        persistentRetry: false,
        maxAutoRetries: 0,
        taskCompletionNotifications: true,
      },
    });
    expect(partial.body).toEqual({
      maxConcurrentAgents: 1,
      ompPath: "/opt/omp/bin/omp",
      approvalMode: "always-ask",
      defaultModel: "",
      smartQueue: false,
      browser: "off",
      useSystemPrompt: true,
      providerPriority: [],
      autoRetry: false,
      persistentRetry: false,
      maxAutoRetries: 0,
      cleanupSchedule: "off",
      cleanupTargets: DEFAULT_SETTINGS.cleanupTargets,
      taskCompletionNotifications: true,
      visibleDashboardMenus: DEFAULT_SETTINGS.visibleDashboardMenus,
      primaryColor: DEFAULT_SETTINGS.primaryColor,
      telegramBotToken: "",
      discordBotToken: "",
      ...ORCHESTRATION_DEFAULTS,
    });
    expect((await api<AppSettings>(settingsRoute, "GET", "/settings")).body).toEqual(partial.body);
    expect((await api<AppSettings>(settingsRoute, "PATCH", "/settings", { body: {} })).body).toEqual(partial.body);

    // Restore for the other tests in this suite.
    await api(settingsRoute, "PATCH", "/settings", {
      body: {
        maxConcurrentAgents: "auto",
        approvalMode: "yolo",
        ompPath: FAKE_OMP,
        smartQueue: true,
        browser: "headless",
        autoRetry: true,
        persistentRetry: true,
        maxAutoRetries: 5,
        taskCompletionNotifications: false,
      },
    });
  });

  it("GET /system reports the configured omp path, whether it is installed and its version", async () => {
    const stub = writeScript(
      path.join(tempDir("bin"), "omp-version-stub"),
      'if (process.argv[2] === "--version") console.log("omp/9.8.7 linux-x64");',
    );
    await api(settingsRoute, "PATCH", "/settings", { body: { ompPath: stub } });
    const installed = await api(systemRoute, "GET", "/system");
    expect(installed.status).toBe(200);
    expect(installed.body).toEqual({
      version: APP_VERSION,
      db: "sqlite",
      omp: { path: stub, installed: true, version: "9.8.7" },
    });

    const missing = path.join(tempDir("bin"), "no-such-omp");
    await api(settingsRoute, "PATCH", "/settings", { body: { ompPath: missing } });
    const notInstalled = await api(systemRoute, "GET", "/system");
    expect(notInstalled.status).toBe(200);
    expect(notInstalled.body.omp).toEqual({ path: missing, installed: false, version: null });

    await api(settingsRoute, "PATCH", "/settings", { body: { ompPath: FAKE_OMP } });
  });
});
