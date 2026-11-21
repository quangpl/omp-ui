import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, env, freshEnv, setupAdmin, teardown, tempDir } from "./helpers";

import * as boardTasksRoute from "@/app/api/v1/boards/[id]/tasks/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import * as cleanupRoute from "@/app/api/v1/settings/cleanup/route";
import * as settingsRoute from "@/app/api/v1/settings/route";
import { getAgentManager } from "@/lib/agent/manager";
import { nextCleanupAt, runDueCleanup } from "@/lib/cleanup";
import { getRepo } from "@/lib/db";
import {
  DEFAULT_SETTINGS,
  SCHEDULED_CLEANUP_IDS,
  type AppSettings,
  type Board,
  type CleanupStatus,
  type Task,
} from "@/lib/types";

const ORPHAN_ID = "deadbeef-0000-4000-8000-0000000000c1";
const DAY_MS = 24 * 60 * 60_000;

async function status(): Promise<CleanupStatus> {
  const res = await api<CleanupStatus>(cleanupRoute, "GET", "/settings/cleanup");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function patchSettings(body: unknown): Promise<AppSettings> {
  const res = await api<AppSettings>(settingsRoute, "PATCH", "/settings", { body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

function cardFolder(id: string): string {
  return path.join(env().dataDir, "files", "tasks", id);
}

function writeCardFile(id: string): void {
  mkdirSync(cardFolder(id), { recursive: true });
  writeFileSync(path.join(cardFolder(id), "report.txt"), "x".repeat(16 * 1024));
}

afterAll(teardown);

describe("nextCleanupAt", () => {
  const t0 = "2026-01-01T00:00:00.000Z";
  const t1 = "2026-01-05T00:00:00.000Z";

  it("is null when off or never anchored", () => {
    expect(nextCleanupAt("off", t0, t1)).toBeNull();
    expect(nextCleanupAt("weekly", null, null)).toBeNull();
  });

  it("counts one period from the later of the last run and the anchor", () => {
    expect(nextCleanupAt("weekly", null, t0)?.toISOString()).toBe("2026-01-08T00:00:00.000Z");
    expect(nextCleanupAt("weekly", t0, t1)?.toISOString()).toBe("2026-01-12T00:00:00.000Z");
    expect(nextCleanupAt("weekly", t1, t0)?.toISOString()).toBe("2026-01-12T00:00:00.000Z");
    expect(nextCleanupAt("monthly", t0, null)?.toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });
});

describe("/settings/cleanup", () => {
  let task: Task;

  beforeAll(async () => {
    const root = (await freshEnv()).root;
    // Keep the cleanup off the developer's real home folders and Docker daemon.
    process.env.HOME = root;
    process.env.DOCKER_BIN = path.join(root, "no-docker");
    await setupAdmin();
    const board = (
      await api<Board>(boardsRoute, "POST", "/boards", {
        body: { name: "Cleanup", workdir: tempDir("cleanup-project"), autoRun: false },
      })
    ).body;
    task = (
      await api<Task>(boardTasksRoute, "POST", `/boards/${board.id}/tasks`, {
        body: { title: "kept" },
        params: { id: board.id },
      })
    ).body;
  });

  it("is off with the safe targets by default", async () => {
    const s = await status();
    expect(s).toMatchObject({
      schedule: "off",
      targets: DEFAULT_SETTINGS.cleanupTargets,
      lastRunAt: null,
      lastTrigger: null,
      lastResult: null,
      nextRunAt: null,
      running: false,
    });
    expect(s.available.map((t) => t.id)).toEqual([...SCHEDULED_CLEANUP_IDS]);
    expect(s.available.find((t) => t.id === "orphan-card-files")).toMatchObject({
      label: "Files of deleted cards",
      risk: "safe",
    });
  });

  it("PATCH /settings persists the schedule and targets and rejects bad values", async () => {
    const saved = await patchSettings({ cleanupSchedule: "monthly", cleanupTargets: ["database", "drafts", "drafts"] });
    expect(saved).toMatchObject({ cleanupSchedule: "monthly", cleanupTargets: ["drafts", "database"] });
    expect((await api<AppSettings>(settingsRoute, "GET", "/settings")).body).toEqual(saved);

    const empty = await patchSettings({ cleanupTargets: [] });
    expect(empty.cleanupTargets).toEqual([]);

    for (const body of [
      { cleanupSchedule: "daily" },
      { cleanupSchedule: 7 },
      { cleanupTargets: ["docker-images"] },
      { cleanupTargets: ["home"] },
      { cleanupTargets: "drafts" },
    ]) {
      const res = await api(settingsRoute, "PATCH", "/settings", { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await api<AppSettings>(settingsRoute, "GET", "/settings")).body).toEqual(empty);

    await patchSettings({ cleanupSchedule: "off", cleanupTargets: DEFAULT_SETTINGS.cleanupTargets });
    expect((await status()).nextRunAt).toBeNull();
  });

  it("enabling a schedule counts from now instead of running right away", async () => {
    const before = Date.now();
    await patchSettings({ cleanupSchedule: "weekly" });
    const weekly = await status();
    expect(weekly.schedule).toBe("weekly");
    expect(weekly.lastRunAt).toBeNull();
    const next = Date.parse(weekly.nextRunAt!);
    expect(next).toBeGreaterThanOrEqual(before + 7 * DAY_MS);
    expect(next).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS);

    const repo = await getRepo();
    const manager = await getAgentManager();
    expect(await runDueCleanup(repo, manager)).toBe(false);
    expect((await status()).lastRunAt).toBeNull();

    await patchSettings({ cleanupSchedule: "monthly" });
    expect(Date.parse((await status()).nextRunAt!)).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
    await patchSettings({ cleanupSchedule: "weekly" });
  });

  it("POST cleans up now: removes files of deleted cards and keeps a real card's", async () => {
    writeCardFile(task.id);
    writeCardFile(ORPHAN_ID);
    const before = Date.now();
    const res = await api<CleanupStatus>(cleanupRoute, "POST", "/settings/cleanup", {
      body: { ids: ["orphan-card-files", "run-configs"] },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(existsSync(cardFolder(ORPHAN_ID))).toBe(false);
    expect(existsSync(path.join(cardFolder(task.id), "report.txt"))).toBe(true);

    const s = res.body;
    expect(s.lastTrigger).toBe("manual");
    expect(s.running).toBe(false);
    expect(s.lastResult?.results.map((r) => [r.id, r.ok])).toEqual([
      ["orphan-card-files", true],
      ["run-configs", true],
    ]);
    expect(s.lastResult!.freedBytes).toBeGreaterThan(0);
    const lastRun = Date.parse(s.lastRunAt!);
    expect(lastRun).toBeGreaterThanOrEqual(before);
    expect(Date.parse(s.nextRunAt!)).toBe(lastRun + 7 * DAY_MS);
    expect(await status()).toEqual(s);
  });

  it("POST without ids runs the saved targets", async () => {
    await patchSettings({ cleanupTargets: ["orphan-card-files"] });
    writeCardFile(ORPHAN_ID);
    const res = await api<CleanupStatus>(cleanupRoute, "POST", "/settings/cleanup");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.lastResult?.results.map((r) => r.id)).toEqual(["orphan-card-files"]);
    expect(existsSync(cardFolder(ORPHAN_ID))).toBe(false);
  });

  it("runs the scheduled cleanup once it is due", async () => {
    writeCardFile(ORPHAN_ID);
    const repo = await getRepo();
    const manager = await getAgentManager();
    expect(await runDueCleanup(repo, manager)).toBe(false);
    expect(existsSync(cardFolder(ORPHAN_ID))).toBe(true);

    expect(await runDueCleanup(repo, manager, Date.now() + 8 * DAY_MS)).toBe(true);
    expect(existsSync(cardFolder(ORPHAN_ID))).toBe(false);
    expect(existsSync(path.join(cardFolder(task.id), "report.txt"))).toBe(true);
    expect((await status()).lastTrigger).toBe("scheduled");
  });

  it("POST rejects unknown or empty ids and a second cleanup while one runs", async () => {
    for (const body of [{ ids: ["home"] }, { ids: ["docker-images"] }, { ids: [] }, { ids: "drafts" }]) {
      const res = await api(cleanupRoute, "POST", "/settings/cleanup", { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }

    await patchSettings({ cleanupTargets: [] });
    expect((await api(cleanupRoute, "POST", "/settings/cleanup")).status).toBe(400);

    const g = globalThis as unknown as { __ompUiCleanupRunning?: boolean };
    g.__ompUiCleanupRunning = true;
    try {
      expect((await status()).running).toBe(true);
      const busy = await api(cleanupRoute, "POST", "/settings/cleanup", { body: { ids: ["drafts"] } });
      expect(busy.status).toBe(409);
    } finally {
      g.__ompUiCleanupRunning = false;
    }
  });
});
