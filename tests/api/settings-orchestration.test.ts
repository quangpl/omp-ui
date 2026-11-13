import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { api, freshEnv, setupAdmin, teardown } from "./helpers";

import * as settingsRoute from "@/app/api/v1/settings/route";
import { getRepo } from "@/lib/db";
import { DEFAULT_SETTINGS, type AppSettings } from "@/lib/types";

async function getSettings(): Promise<AppSettings> {
  const res = await api<AppSettings>(settingsRoute, "GET", "/settings");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function patchSettings(body: unknown): Promise<AppSettings> {
  const res = await api<AppSettings>(settingsRoute, "PATCH", "/settings", { body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

const ENABLED = {
  runTimeLimit: true,
  runTimeLimitMinutes: 30,
  stallWatchdog: true,
  stallTimeoutMinutes: 5,
  runBudget: true,
  runBudgetUsd: 2.5,
  runBudgetTokens: 2_000_000,
  loopDetection: true,
  gitCheckpoints: true,
  telemetryExport: true,
  telemetryEndpoint: "http://localhost:4318/v1/traces",
  loadGuard: true,
  loadGuardPercent: 200,
} satisfies Partial<AppSettings>;

afterAll(teardown);

describe("/settings orchestration fields", () => {
  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
  });

  beforeEach(async () => {
    await (await getRepo()).deleteSetting("app_settings");
  });

  it("every orchestration feature is off on a fresh install and for settings stored before it existed", async () => {
    const fresh = await getSettings();
    for (const key of ["runTimeLimit", "stallWatchdog", "runBudget", "loopDetection", "gitCheckpoints", "telemetryExport", "loadGuard"] as const) {
      expect(fresh[key], key).toBe(false);
    }
    await (await getRepo()).setSetting("app_settings", JSON.stringify({ ompPath: "omp", autoRetry: false }));
    const legacy = await getSettings();
    expect(legacy.runTimeLimitMinutes).toBe(DEFAULT_SETTINGS.runTimeLimitMinutes);
    expect(legacy.loadGuard).toBe(false);
  });

  it("PATCH persists every toggle and value in the database, and turning them off sticks", async () => {
    expect(await patchSettings(ENABLED)).toMatchObject(ENABLED);
    // The stored row, as a server restart would read it.
    const stored = JSON.parse((await (await getRepo()).getSetting("app_settings")) ?? "{}") as AppSettings;
    expect(stored).toMatchObject(ENABLED);
    expect(await getSettings()).toMatchObject(ENABLED);

    const off = { runTimeLimit: false, stallWatchdog: false, runBudget: false, loopDetection: false, gitCheckpoints: false, telemetryExport: false, loadGuard: false };
    expect(await patchSettings(off)).toMatchObject({ ...ENABLED, ...off });
  });

  it("rejects out-of-range numbers, non-booleans and non-http endpoints without changing anything", async () => {
    const before = await patchSettings({ runTimeLimitMinutes: 60 });
    for (const body of [
      { runTimeLimitMinutes: 1 },
      { runTimeLimitMinutes: 30.5 },
      { stallTimeoutMinutes: 10_000 },
      { runBudgetUsd: -1 },
      { runBudgetTokens: "100" },
      { loadGuardPercent: 5 },
      { loopDetection: "yes" },
      { telemetryEndpoint: "ftp://collector" },
    ]) {
      const res = await api(settingsRoute, "PATCH", "/settings", { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await getSettings()).toEqual(before);
  });

  it("clamps stored values that are out of range", async () => {
    await (await getRepo()).setSetting(
      "app_settings",
      JSON.stringify({ runTimeLimitMinutes: 0, stallTimeoutMinutes: 99_999, runBudgetUsd: 1.239, loadGuardPercent: "x" }),
    );
    const s = await getSettings();
    expect(s.runTimeLimitMinutes).toBe(5);
    expect(s.stallTimeoutMinutes).toBe(240);
    expect(s.runBudgetUsd).toBe(1.24);
    expect(s.loadGuardPercent).toBe(DEFAULT_SETTINGS.loadGuardPercent);
  });
});
