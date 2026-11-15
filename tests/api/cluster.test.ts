import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_PASSWORD, api, createUser, freshEnv, loginAs, setupAdmin, teardown } from "./helpers";

import * as setupRoute from "@/app/api/v1/auth/setup/route";
import * as clusterRoute from "@/app/api/v1/cluster/route";
import * as disableRoute from "@/app/api/v1/cluster/disable/route";
import * as enableRoute from "@/app/api/v1/cluster/enable/route";
import * as infoRoute from "@/app/api/v1/cluster/info/route";
import * as joinRoute from "@/app/api/v1/cluster/join/route";
import * as testRoute from "@/app/api/v1/cluster/test/route";
import * as tokenRoute from "@/app/api/v1/cluster/token/route";
import * as settingsRoute from "@/app/api/v1/settings/route";
import { updateNodeState } from "@/lib/cluster/node";
import { CLUSTER_PROTOCOL_VERSION } from "@/lib/cluster/types";
import type { AppSettings, ClusterInfo, ClusterJoinInfo, ClusterStatus } from "@/lib/types";

// The cluster channel really listens while the server is primary: a random high port keeps
// parallel suites (and a cluster running on this machine) out of the way.
const CLUSTER_PORT = 20_000 + Math.floor(Math.random() * 20_000);

/** Whether `name` is a command on PATH. */
function hasCommand(name: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let userToken: string;

async function status(): Promise<ClusterStatus> {
  const res = await api<ClusterStatus>(clusterRoute, "GET", "/cluster");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

beforeAll(async () => {
  await freshEnv({ OMP_UI_CLUSTER_PORT: String(CLUSTER_PORT) });
  await setupAdmin();
  await createUser({ username: "bob", password: "bob-password-123" });
  userToken = await loginAs("bob", "bob-password-123");
});

afterAll(async () => {
  // Closes the cluster listener if a failed test left the server primary.
  if ((await status()).role !== "standalone") await api(disableRoute, "POST", "/cluster/disable");
  await teardown();
});

describe("/cluster", () => {
  it("is standalone by default, readable by every signed-in user", async () => {
    const body = await status();
    expect(body.role).toBe("standalone");
    expect(body.nodes).toEqual([]);
    const asUser = await api<ClusterStatus>(clusterRoute, "GET", "/cluster", { token: userToken });
    expect(asUser.status).toBe(200);
    expect(asUser.body.role).toBe("standalone");
    expect((await api(clusterRoute, "GET", "/cluster", { token: null })).status).toBe(401);
  });

  it("has no join token while standalone", async () => {
    expect((await api(tokenRoute, "GET", "/cluster/token")).status).toBe(409);
  });

  it("only admins may enable cluster mode", async () => {
    const res = await api(enableRoute, "POST", "/cluster/enable", { token: userToken });
    expect(res.status).toBe(403);
    expect((await status()).role).toBe("standalone");
  });

  it("serves the public join script with this server's URL and no token", async () => {
    const res = await api<string>(joinRoute, "GET", "/cluster/join", { token: null });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-shellscript");
    expect(res.body.startsWith("#!/bin/sh")).toBe(true);
    expect(res.body).toContain("PRIMARY_URL='http://localhost'");
    expect(res.body).toContain(`PRIMARY_NODE_VERSION='${process.versions.node}'`);
    expect(res.body).not.toContain("omc_");

    const proxied = await api<string>(joinRoute, "GET", "/cluster/join", {
      token: null,
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "omp.example.com" },
    });
    expect(proxied.body).toContain("PRIMARY_URL='https://omp.example.com'");

    // A host that is not a plain host[:port] never reaches the script.
    const hostile = await api<string>(joinRoute, "GET", "/cluster/join", {
      token: null,
      headers: { "x-forwarded-host": "evil.example.com';reboot;'" },
    });
    expect(hostile.body).toContain("PRIMARY_URL='http://localhost'");
    expect(hostile.body).not.toContain("reboot");

    // POSIX sh, as run by `| sh` on the new machine (dash where it exists: Debian/Ubuntu's sh).
    for (const shell of ["sh", "dash"]) {
      if (shell === "dash" && !hasCommand("dash")) continue;
      expect(() => execFileSync(shell, ["-n"], { input: res.body, stdio: ["pipe", "pipe", "pipe"] })).not.toThrow();
    }
    // A new join id per run (the server joins again), and the run waits until the node has joined.
    expect(res.body).toContain('echo "OMP_UI_CLUSTER_JOIN_ID=$join_id"');
    expect(res.body).toContain("/api/v1/cluster/info");
    expect(res.body).toContain('if [ "$role" = replica ]; then return 0; fi');
  });

  it("refuses to build the join script for a request whose own host is not a plain host[:port]", async () => {
    // vinext builds req.url from the raw Host header, and URL parsing keeps ' ; ` in host names.
    const res = await joinRoute.GET(new Request("http://evil.example.com';reboot;`id`/api/v1/cluster/join"));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("reboot");
  });

  it("answers the public info route", async () => {
    const res = await api<ClusterInfo>(infoRoute, "GET", "/cluster/info", { token: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      protocol: CLUSTER_PROTOCOL_VERSION,
      role: "standalone",
      port: CLUSTER_PORT,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    });
    expect(typeof res.body.version).toBe("string");
    expect(typeof res.body.omp.available).toBe("boolean");
    expect("sha256" in res.body.omp).toBe(true);
    expect(res.body.omp.sha256 === null || /^[0-9a-f]{64}$/.test(res.body.omp.sha256)).toBe(true);
    expect(res.body.omp.sha256 === null).toBe(!res.body.omp.available);
  });

  it("validates the target of a connection test", async () => {
    for (const body of [
      {},
      { url: "ftp://primary:3000", token: "omc_x" },
      { url: "not a url", token: "omc_x" },
      { url: `http://primary/${"a".repeat(2048)}`, token: "omc_x" },
      { url: "http://primary:3000", token: "x".repeat(201) },
      { url: "http://primary:3000", token: 42 },
    ]) {
      const res = await api(testRoute, "POST", "/cluster/test", { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const res = await api(testRoute, "POST", "/cluster/test", {
      token: userToken,
      body: { url: "http://primary:3000", token: "omc_x" },
    });
    expect(res.status).toBe(403);
  });

  it("validates the join target before changing anything", async () => {
    const res = await api(joinRoute, "POST", "/cluster/join", { body: { url: "http://primary:3000", token: "" } });
    expect(res.status).toBe(400);
    expect((await status()).role).toBe("standalone");
  });

  it("an admin makes this server the primary and gets the join command", async () => {
    const res = await api<ClusterStatus>(enableRoute, "POST", "/cluster/enable");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.role).toBe("primary");
    expect(res.body.port).toBe(CLUSTER_PORT);
    expect((await status()).role).toBe("primary");

    const join = await api<ClusterJoinInfo>(tokenRoute, "GET", "/cluster/token");
    expect(join.status, JSON.stringify(join.body)).toBe(200);
    expect(join.body.token).toMatch(/^omc_/);
    expect(join.body.url).toBe("http://localhost");
    expect(join.body.joinCommand).toBe(
      `curl -fsSL http://localhost/api/v1/cluster/join | sh -s -- ${join.body.token}`,
    );
    expect((await api(tokenRoute, "GET", "/cluster/token", { token: userToken })).status).toBe(403);

    const info = await api<ClusterInfo>(infoRoute, "GET", "/cluster/info", { token: null });
    expect(info.body.role).toBe("primary");

    const rotated = await api<ClusterJoinInfo>(tokenRoute, "POST", "/cluster/token");
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    expect(rotated.body.token).not.toBe(join.body.token);
    expect(rotated.body.joinCommand).toContain(rotated.body.token);
    expect((await api<ClusterJoinInfo>(tokenRoute, "GET", "/cluster/token")).body.token).toBe(rotated.body.token);
  });

  it("PATCH /settings validates the cluster settings", async () => {
    const before = (await api<AppSettings>(settingsRoute, "GET", "/settings")).body;
    for (const body of [
      { clusterFailoverSeconds: 4 },
      { clusterFailoverSeconds: 601 },
      { clusterFailoverSeconds: 10.5 },
      { clusterFailoverSeconds: "20" },
      { clusterRunLocal: "yes" },
    ]) {
      const res = await api(settingsRoute, "PATCH", "/settings", { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await api<AppSettings>(settingsRoute, "GET", "/settings")).body).toEqual(before);

    const res = await api<AppSettings>(settingsRoute, "PATCH", "/settings", {
      body: { clusterFailoverSeconds: 45, clusterRunLocal: false },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ clusterFailoverSeconds: 45, clusterRunLocal: false });
    expect((await status()).runLocal).toBe(false);
  });

  it("disable returns to standalone", async () => {
    expect((await api(disableRoute, "POST", "/cluster/disable", { token: userToken })).status).toBe(403);
    const res = await api<ClusterStatus>(disableRoute, "POST", "/cluster/disable");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.role).toBe("standalone");
    expect((await status()).role).toBe("standalone");
    expect((await api(tokenRoute, "GET", "/cluster/token")).status).toBe(409);
  });

  it("a replica refuses writes except sign-in/out and its own cluster membership", async () => {
    updateNodeState({
      role: "replica",
      primary: { nodeId: "p1", name: "primary-host", host: "10.0.0.1", port: 7790, httpUrl: "http://10.0.0.1:3000" },
    });
    try {
      // A freshly joined node's database may still be empty: setup must not create an admin there.
      const setup = await api<{ error: string }>(setupRoute, "POST", "/auth/setup", {
        token: null,
        body: { password: "another-password-123" },
      });
      expect(setup.status).toBe(409);
      expect(setup.body.error).toContain("replica of primary-host (http://10.0.0.1:3000)");

      const patch = await api(settingsRoute, "PATCH", "/settings", { body: { clusterRunLocal: true } });
      expect(patch.status).toBe(409);

      // Reads, sign-in and the cluster routes still work.
      expect((await api(settingsRoute, "GET", "/settings")).status).toBe(200);
      expect(await loginAs("admin", ADMIN_PASSWORD)).toBeTruthy();
      const test = await api(testRoute, "POST", "/cluster/test", { body: { url: "ftp://x", token: "" } });
      expect(test.status).toBe(400);
    } finally {
      updateNodeState({ role: "standalone", primary: null });
    }
    expect((await api(settingsRoute, "PATCH", "/settings", { body: { clusterRunLocal: true } })).status).toBe(200);
  });
});
