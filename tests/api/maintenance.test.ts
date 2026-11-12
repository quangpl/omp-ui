import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, env, freshEnv, setupAdmin, teardown, tempDir } from "./helpers";

import * as boardTasksRoute from "@/app/api/v1/boards/[id]/tasks/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import * as maintenanceRoute from "@/app/api/v1/stats/maintenance/route";
import type { Board, MaintenanceReport, MaintenanceResult, Task } from "@/lib/types";

const ORPHAN_ID = "deadbeef-0000-4000-8000-000000000000";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function analyze(): Promise<MaintenanceReport> {
  const res = await api<MaintenanceReport>(maintenanceRoute, "GET", "/stats/maintenance");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function maintain(body: unknown): Promise<MaintenanceResult> {
  const res = await api<MaintenanceResult>(maintenanceRoute, "POST", "/stats/maintenance", { body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

afterAll(teardown);

describe("/stats/maintenance", () => {
  let task: Task;
  const children: number[] = [];

  beforeAll(async () => {
    const root = (await freshEnv()).root;
    // Keep the analysis off the developer's real home folders and Docker daemon.
    process.env.HOME = root;
    process.env.DOCKER_BIN = path.join(root, "no-docker");
    await setupAdmin();
    const boardRes = await api<Board>(boardsRoute, "POST", "/boards", {
      body: { name: "Maint", workdir: tempDir("maint-project"), autoRun: false },
    });
    const board = boardRes.body;
    const taskRes = await api<Task>(boardTasksRoute, "POST", `/boards/${board.id}/tasks`, {
      body: { title: "kept" },
      params: { id: board.id },
    });
    task = taskRes.body;

    const { dataDir } = env();
    for (const id of [task.id, ORPHAN_ID]) {
      mkdirSync(path.join(dataDir, "files", "tasks", id), { recursive: true });
      writeFileSync(path.join(dataDir, "files", "tasks", id, "report.txt"), "x".repeat(64 * 1024));
    }
    mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
    writeFileSync(path.join(dataDir, "runtime", `omp-config-${task.id}.yml`), "x: 1\n");
  });

  afterAll(() => {
    for (const pid of children) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  });

  it("reports cleanable leftovers, protects the server and tags child processes", async () => {
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    children.push(sleeper.pid!);
    const report = await analyze();

    const files = report.storage.cleanup.find((c) => c.id === "orphan-card-files");
    expect(files).toMatchObject({ count: 1, risk: "safe", empty: false });
    expect(files!.bytes).toBeGreaterThanOrEqual(64 * 1024);
    expect(report.storage.cleanup.find((c) => c.id === "run-configs")).toMatchObject({ count: 1, empty: false });
    expect(report.storage.cleanup.find((c) => c.id === "database")).toBeDefined();
    // Docker is unreachable: no Docker items, an explanation instead.
    expect(report.storage.cleanup.some((c) => c.id.startsWith("docker-"))).toBe(false);
    expect(report.storage.dockerError).toBeTruthy();

    if (process.platform === "win32") return;
    const self = report.processes.find((p) => p.pid === process.pid);
    expect(self).toMatchObject({ tag: "server", killable: false });
  });

  it("removes only orphaned data and refuses to end the server", async () => {
    const { dataDir } = env();
    const result = await maintain({ kind: "cleanup", ids: ["orphan-card-files", "run-configs", "database"] });
    expect(result.results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(existsSync(path.join(dataDir, "files", "tasks", ORPHAN_ID))).toBe(false);
    expect(existsSync(path.join(dataDir, "files", "tasks", task.id, "report.txt"))).toBe(true);
    expect(existsSync(path.join(dataDir, "runtime", `omp-config-${task.id}.yml`))).toBe(false);

    const refused = await maintain({ kind: "kill", pids: [process.pid] });
    expect(refused.results[0]).toMatchObject({ ok: false });
    expect(isAlive(process.pid)).toBe(true);
  });

  it.runIf(process.platform === "linux" && spawnSync("bash", ["--version"]).status === 0)(
    "finds an orphaned agent of this DATA_DIR and ends it",
    async () => {
      const config = path.join(env().dataDir, "runtime", `omp-config-${ORPHAN_ID}.yml`);
      // `exec -a omp` names the process omp; bash exits right away, so it is re-parented like a crash leftover.
      const out = spawnSync(
        "bash",
        [
          "-c",
          `exec -a omp ${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)" -- --mode rpc --config ${JSON.stringify(config)} >/dev/null 2>&1 & echo $!`,
        ],
        { encoding: "utf8" },
      );
      const pid = Number(out.stdout.trim());
      expect(pid).toBeGreaterThan(1);
      children.push(pid);

      const report = await analyze();
      const orphan = report.processes.find((p) => p.pid === pid);
      expect(orphan).toMatchObject({ tag: "orphan-agent", taskId: ORPHAN_ID, killable: true });
      expect(report.recommendations.find((r) => r.id === "orphan-agents")?.action).toEqual({ kind: "kill", pids: [pid] });

      const result = await maintain({ kind: "kill", pids: [pid] });
      expect(result.results[0]).toMatchObject({ ok: true });
      expect(isAlive(pid)).toBe(false);
    },
  );

  it("rejects malformed actions", async () => {
    for (const body of [{ kind: "cleanup", ids: ["home"] }, { kind: "kill", pids: [1] }, { kind: "nope" }]) {
      const res = await api(maintenanceRoute, "POST", "/stats/maintenance", { body });
      expect(res.status).toBe(400);
    }
  });
});
