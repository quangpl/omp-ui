import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { api, freshEnv, setupAdmin, teardown } from "./helpers";

import * as settingsRoute from "@/app/api/v1/settings/route";
import { getRepo } from "@/lib/db";
import type { AppSettings } from "@/lib/types";

const PRIORITY = [
  { provider: "anthropic", model: "anthropic/claude-sonnet-4-5" },
  { provider: "openai-codex", model: "openai-codex/gpt-5" },
];

async function getSettings(): Promise<AppSettings> {
  const res = await api<AppSettings>(settingsRoute, "GET", "/settings");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

afterAll(teardown);

describe("/settings providerPriority", () => {
  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
  });

  beforeEach(async () => {
    await (await getRepo()).deleteSetting("app_settings");
  });

  it("is off by default and PATCH persists the order", async () => {
    expect((await getSettings()).providerPriority).toEqual([]);
    const res = await api<AppSettings>(settingsRoute, "PATCH", "/settings", { body: { providerPriority: PRIORITY } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await getSettings()).providerPriority).toEqual(PRIORITY);
  });

  it("rejects an invalid list without changing the stored one", async () => {
    await api(settingsRoute, "PATCH", "/settings", { body: { providerPriority: PRIORITY } });
    for (const providerPriority of [
      "anthropic",
      [{ provider: "anthropic", model: "openai/gpt-5" }],
      [PRIORITY[0], PRIORITY[0]],
    ]) {
      const res = await api(settingsRoute, "PATCH", "/settings", { body: { providerPriority } });
      expect(res.status, JSON.stringify(providerPriority)).toBe(400);
    }
    expect((await getSettings()).providerPriority).toEqual(PRIORITY);
  });

  it("an invalid stored list turns the priority off", async () => {
    await (await getRepo()).setSetting("app_settings", JSON.stringify({ providerPriority: [{ provider: "x" }] }));
    expect((await getSettings()).providerPriority).toEqual([]);
  });
});
