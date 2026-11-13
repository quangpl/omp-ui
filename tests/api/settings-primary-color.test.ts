import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { api, freshEnv, setupAdmin, teardown } from "./helpers";

import * as settingsRoute from "@/app/api/v1/settings/route";
import { getRepo } from "@/lib/db";
import type { AppSettings } from "@/lib/types";

async function getSettings(): Promise<AppSettings> {
  const res = await api<AppSettings>(settingsRoute, "GET", "/settings");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

afterAll(teardown);

describe("/settings primaryColor", () => {
  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
  });

  // Every case starts from a fresh install's settings (nothing stored yet).
  beforeEach(async () => {
    await (await getRepo()).deleteSetting("app_settings");
  });

  it("defaults to jade", async () => {
    expect((await getSettings()).primaryColor).toBe("jade");
  });

  it("PATCH persists a preset", async () => {
    const res = await api<AppSettings>(settingsRoute, "PATCH", "/settings", { body: { primaryColor: "violet" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.primaryColor).toBe("violet");
    expect((await getSettings()).primaryColor).toBe("violet");
  });

  it("rejects unknown presets without changing the stored one", async () => {
    await api(settingsRoute, "PATCH", "/settings", { body: { primaryColor: "teal" } });
    for (const primaryColor of ["chartreuse", 3, null]) {
      const res = await api(settingsRoute, "PATCH", "/settings", { body: { primaryColor } });
      expect(res.status, JSON.stringify(primaryColor)).toBe(400);
    }
    expect((await getSettings()).primaryColor).toBe("teal");
  });

  it("an invalid stored value falls back to the default", async () => {
    await (await getRepo()).setSetting("app_settings", JSON.stringify({ primaryColor: "neon" }));
    expect((await getSettings()).primaryColor).toBe("jade");
  });
});
