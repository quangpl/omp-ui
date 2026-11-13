import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, freshEnv, setupAdmin, teardown, tempDir, waitFor } from "./helpers";

import * as boardTasksRoute from "@/app/api/v1/boards/[id]/tasks/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import * as checkpointsRoute from "@/app/api/v1/tasks/[id]/checkpoints/route";
import * as restoreRoute from "@/app/api/v1/tasks/[id]/checkpoints/restore/route";
import * as taskRoute from "@/app/api/v1/tasks/[id]/route";
import * as taskRunRoute from "@/app/api/v1/tasks/[id]/run/route";
import * as taskStopRoute from "@/app/api/v1/tasks/[id]/stop/route";
import type { CheckpointRestoreResult, TaskCheckpointList } from "@/lib/api-client";
import { getRepo } from "@/lib/db";
import {
  createCheckpoint,
  listCheckpoints,
  MAX_CHECKPOINTS_PER_TASK,
  restoreCheckpoint,
} from "@/lib/server/checkpoints";
import { updateAppSettings } from "@/lib/settings";
import type { Board, Comment, Run, Task } from "@/lib/types";

const TASK_ID = "11111111-2222-3333-4444-555555555555";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  ).trim();
}

/** A repo with one commit (README.md, src/app.ts, .gitignore ignoring *.log and build/). */
function makeRepo(name: string): string {
  const work = tempDir(path.join("projects", name));
  git(work, "init", "-b", "main");
  writeFileSync(path.join(work, "README.md"), `# ${name}\n`);
  mkdirSync(path.join(work, "src"), { recursive: true });
  writeFileSync(path.join(work, "src", "app.ts"), "export const a = 1;\n");
  writeFileSync(path.join(work, ".gitignore"), "*.log\nbuild/\n");
  git(work, "add", "-A");
  git(work, "commit", "-m", "Initial commit");
  return work;
}

function refs(folder: string, taskId: string): string[] {
  const out = git(folder, "for-each-ref", "--format=%(refname)", `refs/agentman/checkpoints/${taskId}/`);
  return out ? out.split("\n") : [];
}

function read(folder: string, file: string): string {
  return readFileSync(path.join(folder, file), "utf8");
}

afterAll(teardown);

describe("git checkpoints (lib/server/checkpoints)", () => {
  beforeAll(async () => {
    await freshEnv();
  });

  it("snapshots tracked, untracked and staged changes without touching the index or working tree", async () => {
    const work = makeRepo("snap");
    writeFileSync(path.join(work, "README.md"), "# changed\n");
    writeFileSync(path.join(work, "new.txt"), "untracked\n");
    writeFileSync(path.join(work, "staged.txt"), "staged\n");
    git(work, "add", "staged.txt");
    writeFileSync(path.join(work, "debug.log"), "ignored\n");
    const statusBefore = git(work, "status", "--porcelain", "--ignored");
    const indexBefore = git(work, "ls-files", "--stage");
    const head = git(work, "rev-parse", "HEAD");

    const checkpoint = await createCheckpoint(work, { taskId: TASK_ID, runId: "run-1", label: "Before run" });

    expect(checkpoint).toMatchObject({ folder: work, runId: "run-1", label: "Before run", filesChanged: 3 });
    expect(git(work, "status", "--porcelain", "--ignored")).toBe(statusBefore);
    expect(git(work, "ls-files", "--stage")).toBe(indexBefore);
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
    expect(git(work, "rev-parse", `${checkpoint!.sha}^`)).toBe(head);
    const files = git(work, "ls-tree", "-r", "--name-only", checkpoint!.sha).split("\n");
    expect(files).toEqual(expect.arrayContaining(["README.md", "new.txt", "staged.txt", "src/app.ts"]));
    expect(files).not.toContain("debug.log");
    expect(git(work, "show", `${checkpoint!.sha}:README.md`)).toBe("# changed");
    expect(refs(work, TASK_ID)).toEqual([`refs/agentman/checkpoints/${TASK_ID}/${checkpoint!.id}`]);

    expect(await listCheckpoints([work], TASK_ID)).toEqual([checkpoint]);
    expect(await listCheckpoints([work], "another-task")).toEqual([]);
  });

  it("returns null for a folder outside any git work tree", async () => {
    const plain = tempDir("plain");
    writeFileSync(path.join(plain, "notes.txt"), "hi\n");
    expect(await createCheckpoint(plain, { taskId: TASK_ID, runId: null, label: "Before run" })).toBeNull();
    expect(await listCheckpoints([plain, path.join(plain, "missing")], TASK_ID)).toEqual([]);
  });

  it("restores modified and deleted files, removes new ones, keeps ignored files, and can be undone", async () => {
    const work = makeRepo("restore");
    writeFileSync(path.join(work, "keep-untracked.txt"), "untracked at checkpoint\n");
    const checkpoint = await createCheckpoint(work, { taskId: TASK_ID, runId: "run-1", label: "Before run" });
    const indexBefore = git(work, "ls-files", "--stage");

    // The "agent" edits, adds, deletes; ignored build output appears too.
    writeFileSync(path.join(work, "README.md"), "# wrecked\n");
    rmSync(path.join(work, "src", "app.ts"));
    rmSync(path.join(work, "keep-untracked.txt"));
    mkdirSync(path.join(work, "src", "generated", "deep"), { recursive: true });
    writeFileSync(path.join(work, "src", "generated", "deep", "new.ts"), "new\n");
    writeFileSync(path.join(work, "added.txt"), "added\n");
    mkdirSync(path.join(work, "build"), { recursive: true });
    writeFileSync(path.join(work, "build", "out.js"), "built\n");
    writeFileSync(path.join(work, "run.log"), "log\n");

    const result = await restoreCheckpoint(work, TASK_ID, checkpoint!.id);

    expect(result).not.toBeNull();
    expect(result!.restored.sort()).toEqual(["README.md", "keep-untracked.txt", "src/app.ts"]);
    expect(result!.removed.sort()).toEqual(["added.txt", "src/generated/deep/new.ts"]);
    expect(read(work, "README.md")).toBe("# restore\n");
    expect(read(work, "src/app.ts")).toBe("export const a = 1;\n");
    expect(read(work, "keep-untracked.txt")).toBe("untracked at checkpoint\n");
    expect(existsSync(path.join(work, "added.txt"))).toBe(false);
    expect(existsSync(path.join(work, "src", "generated"))).toBe(false);
    expect(read(work, "build/out.js")).toBe("built\n");
    expect(read(work, "run.log")).toBe("log\n");
    expect(git(work, "ls-files", "--stage")).toBe(indexBefore);

    const listed = await listCheckpoints([work], TASK_ID);
    expect(listed[0]).toMatchObject({ id: result!.undo.id, label: "Before restore", runId: null });
    expect(git(work, "show", `${result!.undo.sha}:README.md`)).toBe("# wrecked");

    // Restoring the "Before restore" checkpoint brings the wrecked state back.
    const undone = await restoreCheckpoint(work, TASK_ID, result!.undo.id);
    expect(undone).not.toBeNull();
    expect(read(work, "README.md")).toBe("# wrecked\n");
    expect(read(work, "added.txt")).toBe("added\n");
    expect(existsSync(path.join(work, "src", "app.ts"))).toBe(false);

    expect(await restoreCheckpoint(work, TASK_ID, "does-not-exist")).toBeNull();
    expect(await restoreCheckpoint(work, TASK_ID, "../../heads/main")).toBeNull();
  });

  it(`keeps only the newest ${MAX_CHECKPOINTS_PER_TASK} checkpoints per task and repository`, async () => {
    const work = makeRepo("prune");
    const other = "99999999-2222-3333-4444-555555555555";
    await createCheckpoint(work, { taskId: other, runId: null, label: "Other card" });
    const created = [];
    for (let i = 0; i < MAX_CHECKPOINTS_PER_TASK + 3; i++) {
      writeFileSync(path.join(work, "counter.txt"), `${i}\n`);
      created.push(await createCheckpoint(work, { taskId: TASK_ID, runId: `run-${i}`, label: `Run ${i}` }));
    }
    const listed = await listCheckpoints([work], TASK_ID);
    expect(listed).toHaveLength(MAX_CHECKPOINTS_PER_TASK);
    expect(listed.map((c) => c.label)).toEqual(created.slice(3).reverse().map((c) => c!.label));
    expect(refs(work, TASK_ID)).toHaveLength(MAX_CHECKPOINTS_PER_TASK);
    expect(refs(work, other)).toHaveLength(1);
  });
});

describe("checkpoint routes and run hook", () => {
  let work: string;
  let board: Board;

  async function createTask(title: string): Promise<Task> {
    const res = await api<Task>(boardTasksRoute, "POST", `/boards/${board.id}/tasks`, {
      body: { title },
      params: { id: board.id },
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function taskDetail(id: string) {
    return (await api<{ task: Task; comments: Comment[]; runs: Run[] }>(taskRoute, "GET", `/tasks/${id}`, { params: { id } }))
      .body;
  }

  async function list(id: string) {
    return api<TaskCheckpointList>(checkpointsRoute, "GET", `/tasks/${id}/checkpoints`, { params: { id } });
  }

  async function restore(id: string, body: Record<string, unknown>) {
    return api<CheckpointRestoreResult & { error?: string }>(restoreRoute, "POST", `/tasks/${id}/checkpoints/restore`, {
      body,
      params: { id },
    });
  }

  async function runToEnd(task: Task): Promise<Task> {
    const started = await api<Task>(taskRunRoute, "POST", `/tasks/${task.id}/run`, { params: { id: task.id } });
    expect(started.status).toBe(200);
    return waitFor(async () => {
      const { task: fresh } = await taskDetail(task.id);
      return fresh.lastRunId && fresh.agentState !== "running" && fresh.agentState !== "queued" ? fresh : null;
    }, 20_000);
  }

  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    work = makeRepo("app");
    const res = await api<Board>(boardsRoute, "POST", "/boards", {
      body: { name: "Checkpoints", workdir: work, autoRun: false },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    board = res.body;
  });

  it("takes no checkpoint at run start while the setting is off", async () => {
    const task = await createTask("Plain run");
    await runToEnd(task);
    expect(refs(work, task.id)).toEqual([]);
    expect((await list(task.id)).body).toEqual({ checkpoints: [], enabled: false });
  });

  it("with gitCheckpoints on, a run start snapshots the folder and logs it; restore rolls back", async () => {
    await updateAppSettings(await getRepo(), { gitCheckpoints: true });
    writeFileSync(path.join(work, "README.md"), "# before the run\n");
    const task = await createTask("Checkpointed run");
    const done = await runToEnd(task);

    const listed = (await list(task.id)).body;
    expect(listed.enabled).toBe(true);
    expect(listed.checkpoints).toHaveLength(1);
    expect(listed.checkpoints[0]).toMatchObject({ folder: work, runId: done.lastRunId, label: "Before run" });
    const events = await (await getRepo()).listRunEvents(done.lastRunId!);
    expect(events.some((e) => e.kind === "status" && e.text === "Checkpoint saved (1 folder)")).toBe(true);

    writeFileSync(path.join(work, "README.md"), "# after the run\n");
    writeFileSync(path.join(work, "extra.txt"), "agent output\n");

    expect((await restore(task.id, { id: listed.checkpoints[0]!.id, folder: tempDir("elsewhere") })).status).toBe(400);
    expect((await restore(task.id, { id: "nope", folder: work })).status).toBe(404);

    const res = await restore(task.id, { id: listed.checkpoints[0]!.id, folder: work });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ restored: 1, removed: 1, undo: { label: "Before restore" } });
    expect(read(work, "README.md")).toBe("# before the run\n");
    expect(existsSync(path.join(work, "extra.txt"))).toBe(false);
    const { comments } = await taskDetail(task.id);
    expect(comments.some((c) => c.author === "agent" && c.body.startsWith("**Rolled back files**"))).toBe(true);

    // Restoring still works after the setting is turned off; the list keeps showing checkpoints.
    await updateAppSettings(await getRepo(), { gitCheckpoints: false });
    const after = (await list(task.id)).body;
    expect(after.enabled).toBe(false);
    expect(after.checkpoints.map((c) => c.label)).toEqual(["Before restore", "Before run"]);
    expect((await restore(task.id, { id: after.checkpoints[0]!.id, folder: work })).status).toBe(200);
    expect(read(work, "README.md")).toBe("# after the run\n");
  });

  it("refuses to restore while the card's agent is running", async () => {
    const task = await createTask("Busy agent [fake:slow]");
    const checkpoint = await createCheckpoint(work, { taskId: task.id, runId: null, label: "Manual" });
    await api<Task>(taskRunRoute, "POST", `/tasks/${task.id}/run`, { params: { id: task.id } });
    await waitFor(async () => (await taskDetail(task.id)).task.agentState === "running", 20_000);

    const res = await restore(task.id, { id: checkpoint!.id, folder: work });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Stop the agent before restoring a checkpoint.");

    await api<Task>(taskStopRoute, "POST", `/tasks/${task.id}/stop`, { params: { id: task.id } });
  });
});
