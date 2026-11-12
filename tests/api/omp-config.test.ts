import { accessSync, constants, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, freshEnv, setupAdmin, teardown, tempDir } from "./helpers";

import * as ompConfigRoute from "@/app/api/v1/omp-config/route";
import type { OmpConfigSnapshot } from "@/lib/types";

// These suites drive the real omp CLI (it parses and validates config.yml) against a throwaway
// agent dir (PI_CODING_AGENT_DIR); they are skipped where omp is not installed.
function findOmp(): string | null {
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local", "bin")];
  for (const dir of dirs) {
    const file = path.join(dir, "omp");
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}

const REAL_OMP = findOmp();
// The test helpers know GET/POST/PATCH/DELETE; the handler ignores the request method.
const putRoute = { PATCH: ompConfigRoute.PUT };
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir = "";
let configFile = "";

async function get(): Promise<OmpConfigSnapshot> {
  const res = await api<OmpConfigSnapshot>(ompConfigRoute, "GET", "/omp-config");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

function put(body: unknown) {
  return api<OmpConfigSnapshot & { error?: string }>(putRoute, "PATCH", "/omp-config", { body });
}

afterAll(async () => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  await teardown();
});

describe.skipIf(!REAL_OMP)("/omp-config", () => {
  beforeAll(async () => {
    await freshEnv({ OMP_PATH: REAL_OMP! });
    agentDir = tempDir("omp-agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    configFile = path.join(agentDir, "config.yml");
    await setupAdmin();
  });

  it("requires authentication", async () => {
    expect((await api(ompConfigRoute, "GET", "/omp-config", { token: null })).status).toBe(401);
    expect((await api(putRoute, "PATCH", "/omp-config", { token: null, body: { raw: "" } })).status).toBe(401);
  });

  it("reports a missing config with omp's defaults", async () => {
    const snap = await get();
    expect(snap).toMatchObject({ path: configFile, backupPath: `${configFile}.bak`, format: "yaml", exists: false, raw: "" });
    expect(snap.values.defaultThinkingLevel).toBeNull();
    expect(snap.values["modelRoles.default"]).toBeNull();
    expect(typeof snap.defaults.defaultThinkingLevel).toBe("string");
    expect(snap.schema.find((f) => f.key === "defaultThinkingLevel")?.options?.length).toBeGreaterThan(0);
  });

  it("reads values from the file", async () => {
    writeFileSync(
      configFile,
      "# keep me\nmodelRoles:\n  default: anthropic/claude-opus-5-5:high\n  judge: anthropic/claude-haiku-4-5\nretry:\n  maxRetries: 4\ncustomKey: 1\n",
    );
    const snap = await get();
    expect(snap.exists).toBe(true);
    expect(snap.values).toMatchObject({
      "modelRoles.default": "anthropic/claude-opus-5-5:high",
      "retry.maxRetries": 4,
      defaultThinkingLevel: null,
    });
  });

  it("saves structured values through omp, keeping a backup and unrelated keys", async () => {
    const before = readFileSync(configFile, "utf8");
    const res = await put({
      values: { defaultThinkingLevel: "low", "modelRoles.smol": "anthropic/claude-haiku-4-5", "todo.enabled": false },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.values).toMatchObject({
      defaultThinkingLevel: "low",
      "modelRoles.smol": "anthropic/claude-haiku-4-5",
      "modelRoles.default": "anthropic/claude-opus-5-5:high",
      "todo.enabled": false,
    });
    expect(readFileSync(`${configFile}.bak`, "utf8")).toBe(before);
    const after = readFileSync(configFile, "utf8");
    expect(after).toContain("judge: anthropic/claude-haiku-4-5");
    expect(after).toContain("customKey");
    expect((await get()).values.defaultThinkingLevel).toBe("low");

    const unset = await put({ values: { "modelRoles.smol": null, defaultThinkingLevel: null } });
    expect(unset.status, JSON.stringify(unset.body)).toBe(200);
    expect(unset.body.values["modelRoles.smol"]).toBeNull();
    expect(unset.body.values.defaultThinkingLevel).toBeNull();
    expect(unset.body.values["modelRoles.default"]).toBe("anthropic/claude-opus-5-5:high");
  });

  it("rejects invalid structured values", async () => {
    const before = readFileSync(configFile, "utf8");
    expect((await put({ values: { defaultThinkingLevel: "extreme" } })).status).toBe(400);
    expect((await put({ values: { "retry.maxRetries": -1 } })).status).toBe(400);
    expect((await put({ values: { "modelRoles.default": "two words" } })).status).toBe(400);
    const unknown = await put({ values: { notASetting: 1 } });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain("notASetting");
    expect((await put({ values: {}, raw: "" })).status).toBe(400);
    expect(readFileSync(configFile, "utf8")).toBe(before);
  });

  it("rejects a raw file omp cannot parse, without touching the real one", async () => {
    const before = readFileSync(configFile, "utf8");
    const res = await put({ raw: "a: [unclosed\n  b: :\n" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Invalid config: /);
    const typed = await put({ raw: "retry:\n  maxRetries: lots\n" });
    expect(typed.status).toBe(400);
    expect(typed.body.error).toContain("retry.maxRetries must be a number");
    const badEnum = await put({ raw: "defaultThinkingLevel: extreme\n" });
    expect(badEnum.status).toBe(400);
    expect(badEnum.body.error).toContain("defaultThinkingLevel");
    expect(readFileSync(configFile, "utf8")).toBe(before);
    expect(readdirSync(agentDir).filter((name) => name.includes("broken"))).toEqual([]);
  });

  it("saves a raw file verbatim and refuses a stale version", async () => {
    const snap = await get();
    const raw = "# my settings\ndefaultThinkingLevel: medium # inline\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n";
    const res = await put({ raw, version: snap.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(readFileSync(configFile, "utf8")).toBe(raw);
    expect(readFileSync(`${configFile}.bak`, "utf8")).toBe(snap.raw);
    expect(res.body.values).toMatchObject({ defaultThinkingLevel: "medium", "modelRoles.default": "anthropic/claude-sonnet-4-5" });

    const stale = await put({ raw: "defaultThinkingLevel: low\n", version: snap.version });
    expect(stale.status).toBe(409);
    expect(readFileSync(configFile, "utf8")).toBe(raw);
    expect(existsSync(configFile)).toBe(true);
  });
});
