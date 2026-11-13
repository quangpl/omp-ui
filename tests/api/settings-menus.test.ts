import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { api, freshEnv, setupAdmin, teardown } from "./helpers";

import * as settingsRoute from "@/app/api/v1/settings/route";
import { getRepo } from "@/lib/db";
import { DASHBOARD_MENU_IDS, type AppSettings } from "@/lib/types";

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

afterAll(teardown);

describe("/settings visibleDashboardMenus", () => {
  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
  });

  // Every case starts from a fresh install's settings (nothing stored yet).
  beforeEach(async () => {
    await (await getRepo()).deleteSetting("app_settings");
  });

  it("shows every menu on a fresh install", async () => {
    expect((await getSettings()).visibleDashboardMenus).toEqual([...DASHBOARD_MENU_IDS]);
  });

  it("PATCH keeps canonical order without duplicates and persists", async () => {
    const saved = await patchSettings({ visibleDashboardMenus: ["stats", "visualize", "stats"] });
    expect(saved.visibleDashboardMenus).toEqual(["visualize", "stats"]);
    expect((await getSettings()).visibleDashboardMenus).toEqual(["visualize", "stats"]);
  });

  it("an empty list hides every menu instead of resetting to the defaults", async () => {
    const saved = await patchSettings({ visibleDashboardMenus: [] });
    expect(saved.visibleDashboardMenus).toEqual([]);
    expect((await getSettings()).visibleDashboardMenus).toEqual([]);
  });

  it("rejects unknown ids and non-arrays without changing the settings", async () => {
    const before = await patchSettings({ visibleDashboardMenus: ["memory"] });

    for (const body of [{ visibleDashboardMenus: ["projects"] }, { visibleDashboardMenus: "stats" }]) {
      const res = await api(settingsRoute, "PATCH", "/settings", { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await getSettings()).toEqual(before);
  });

  it("settings stored before the field existed show every menu", async () => {
    await (await getRepo()).setSetting("app_settings", JSON.stringify({ ompPath: "omp" }));
    expect((await getSettings()).visibleDashboardMenus).toEqual([...DASHBOARD_MENU_IDS]);
  });
});
