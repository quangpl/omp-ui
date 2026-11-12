import { writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, env, freshEnv, setupAdmin, teardown } from "./helpers";

import * as restartRoute from "@/app/api/v1/system/restart/route";
import type { RestartStatus } from "@/lib/types";

// The CLI's pid file names the supervisor, i.e. this process's parent. A successful POST would run
// the real `omp-ui restart --rebuild` on this repo: never point the pid file at process.ppid while posting.

async function status(): Promise<RestartStatus> {
  const res = await api<RestartStatus>(restartRoute, "GET", "/system/restart");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

afterAll(teardown);

describe("/system/restart", () => {
  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
  });

  it("requires authentication", async () => {
    expect((await api(restartRoute, "GET", "/system/restart", { token: null })).status).toBe(401);
    expect((await api(restartRoute, "POST", "/system/restart", { token: null })).status).toBe(401);
  });

  it("is unavailable, and POST refuses, when the CLI did not start this server", async () => {
    // e.g. Docker or `node server.js`: no pid file, or one naming another process.
    writeFileSync(path.join(env().dataDir, "omp-ui.pid"), `${process.ppid + 1}\n`);
    const st = await status();
    expect(st).toMatchObject({ available: false, mode: null, restarting: false, running: 0 });
    expect(st.reason).toContain("not started by the omp-ui CLI");

    const res = await api<{ error: string }>(restartRoute, "POST", "/system/restart");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(st.reason);
    expect((await status()).restarting).toBe(false);
  });

  it("reports how the CLI manages this server", async () => {
    const pidFile = path.join(env().dataDir, "omp-ui.pid");
    writeFileSync(pidFile, `${process.ppid}\n`);
    expect(await status()).toMatchObject({ available: true, mode: "cli", reason: null });
    writeFileSync(pidFile, `${process.ppid}\npm2\n`);
    expect(await status()).toMatchObject({ available: true, mode: "pm2", reason: null });
    writeFileSync(pidFile, `${process.ppid}\nfg\n`);
    expect(await status()).toMatchObject({ available: false, mode: null });
    writeFileSync(pidFile, "");
  });

  it("reports the last restart's output without colors, and a build that fell back", async () => {
    const log = path.join(env().dataDir, "restart.log");
    writeFileSync(log, "=== restart requested ===\n\x1b[32m✓ built\x1b[0m\n✓ Server is up\n");
    expect(await status()).toMatchObject({
      log: "=== restart requested ===\n✓ built\n✓ Server is up",
      buildFailed: false,
    });

    writeFileSync(
      log,
      "\x1b[31m✗\x1b[0m Build failed (exit 1).\n\x1b[33m!\x1b[0m Build failed — starting the previous build\n",
    );
    expect((await status()).buildFailed).toBe(true);
  });
});
