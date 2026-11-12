import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, call, env, freshEnv, setupAdmin, teardown, tempDir, writeScript } from "./helpers";

import * as overviewRoute from "@/app/api/v1/docker/route";
import * as composeRoute from "@/app/api/v1/docker/compose/route";
import * as containerRoute from "@/app/api/v1/docker/containers/[id]/route";
import * as containerLogsRoute from "@/app/api/v1/docker/containers/[id]/logs/route";
import * as runRoute from "@/app/api/v1/docker/run/route";
import type { DockerJobEvent, DockerOverview } from "@/lib/docker-types";

/** Stand-in `docker` CLI: logs argv (one JSON array per line) and answers like docker 27. */
const FAKE_DOCKER = `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
const out = (s) => process.stdout.write(s + "\\n");
const cmd = args.join(" ");
if (args[0] === "version") return out("27.1.0");
if (cmd === "compose version --short") return out("v2.29.1");
if (args[0] === "ps") {
  out(JSON.stringify({ ID: "a".repeat(64), Names: "web", Image: "nginx:alpine", State: "running",
    Status: "Up 2 hours (healthy)", Command: '"/docker-entrypoint.sh nginx"', CreatedAt: "2026-01-01",
    Ports: "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 443/tcp", Networks: "bridge", Mounts: "webdata",
    Project: "", Service: "" }));
  out(JSON.stringify({ ID: "b".repeat(64), Names: "shop-db-1", Image: "postgres:17", State: "exited",
    Status: "Exited (0) 3 days ago", Command: '"postgres"', CreatedAt: "2026-01-01", Ports: "",
    Networks: "shop_default", Mounts: "", Project: "shop", Service: "db" }));
  return;
}
if (cmd === "compose ls -a --format json") {
  return out(JSON.stringify([{ Name: "shop", Status: "exited(1)", ConfigFiles: "/srv/shop/compose.yaml" }]));
}
if (args[0] === "images") {
  out(JSON.stringify({ ID: "e5d2edd28b1f", Repository: "nginx", Tag: "alpine", Size: "50MB", CreatedSince: "1 day ago" }));
  return out(JSON.stringify({ ID: "0e900a3364da", Repository: "redis", Tag: "7", Size: "40MB", CreatedSince: "2 days ago" }));
}
if (cmd.startsWith("volume ls")) return out(JSON.stringify({ Name: "webdata", Driver: "local", Mountpoint: "/v/webdata" }));
if (cmd.startsWith("network ls")) return out(JSON.stringify({ ID: "n1", Name: "bridge", Driver: "bridge", Scope: "local" }));
if (args[0] === "run") {
  process.stderr.write("Unable to find image 'redis:7' locally\\n7: Pulling from library/redis\\n");
  return out("c".repeat(64));
}
if (args[0] === "stop" && args[1] === "missing") {
  process.stderr.write("Error response from daemon: No such container: missing\\n");
  process.exit(1);
}
if (args[0] === "logs") {
  out("2026-01-01T00:00:01.000000000Z first");
  out("2026-01-01T00:00:03.000000000Z third");
  process.stderr.write("2026-01-01T00:00:02.000000000Z second (stderr)\\n");
  return;
}
if (args[0] === "compose" && args.includes("config")) {
  const file = args[args.indexOf("-f") + 1];
  if (fs.readFileSync(file, "utf8").includes("INVALID")) {
    process.stderr.write("yaml: line 1: did not find expected key\\n");
    process.exit(15);
  }
  return;
}
if (args[0] === "compose" && args.includes("up")) {
  process.stderr.write(" Container demo-web-1  Started\\n");
  return;
}
`;

let dockerLog: string;

function dockerCalls(): string[][] {
  if (!existsSync(dockerLog)) return [];
  return readFileSync(dockerLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

async function jobEvents(res: Response): Promise<DockerJobEvent[]> {
  return (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DockerJobEvent);
}

beforeAll(async () => {
  await freshEnv();
  dockerLog = path.join(env().root, "docker.log");
  const bin = writeScript(path.join(tempDir("bin"), "docker"), FAKE_DOCKER);
  process.env.DOCKER_BIN = bin;
  process.env.FAKE_DOCKER_LOG = dockerLog;
  await setupAdmin();
});

afterAll(async () => {
  delete process.env.DOCKER_BIN;
  delete process.env.FAKE_DOCKER_LOG;
  await teardown();
});

describe("GET /docker", () => {
  it("requires authentication", async () => {
    const res = await api(overviewRoute, "GET", "/docker", { token: null });
    expect(res.status).toBe(401);
  });

  it("lists containers, compose projects (incl. OMP UI stacks that are down) and resources", async () => {
    const stackDir = path.join(env().dataDir, "compose", "parked");
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(path.join(stackDir, "compose.yaml"), "services: {}\n");

    const res = await api<DockerOverview>(overviewRoute, "GET", "/docker");
    expect(res.status).toBe(200);
    const o = res.body;
    expect(o.available).toBe(true);
    expect(o.version).toBe("27.1.0");
    expect(o.composeVersion).toBe("2.29.1");

    const web = o.containers.find((c) => c.name === "web");
    expect(web).toMatchObject({ id: "a".repeat(12), state: "running", health: "healthy", command: "/docker-entrypoint.sh nginx" });
    expect(web?.ports).toEqual([
      { hostIp: "0.0.0.0", hostPort: 8080, containerPort: 80, protocol: "tcp" },
      { hostIp: "::", hostPort: 8080, containerPort: 80, protocol: "tcp" },
      { hostIp: null, hostPort: null, containerPort: 443, protocol: "tcp" },
    ]);
    expect(o.containers.find((c) => c.name === "shop-db-1")).toMatchObject({ composeProject: "shop", composeService: "db" });

    expect(o.composeProjects).toEqual([
      { name: "parked", status: "down", configFiles: [path.join(stackDir, "compose.yaml")], managed: true, running: 0, total: 0 },
      { name: "shop", status: "exited(1)", configFiles: ["/srv/shop/compose.yaml"], managed: false, running: 0, total: 1 },
    ]);
    expect(o.images.map((i) => [i.repository, i.containers])).toEqual([
      ["nginx", 1],
      ["redis", 0],
    ]);
    expect(o.volumes[0]).toMatchObject({ name: "webdata", usedBy: ["web"] });
    expect(o.networks[0]).toMatchObject({ name: "bridge", builtin: true });
  });

  it("reports a missing docker binary as unavailable instead of failing", async () => {
    const previous = process.env.DOCKER_BIN;
    process.env.DOCKER_BIN = path.join(env().root, "no-such-docker");
    try {
      const res = await api<DockerOverview>(overviewRoute, "GET", "/docker");
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(false);
      expect(res.body.error).toMatch(/not installed/);
    } finally {
      process.env.DOCKER_BIN = previous;
    }
  });
});

describe("POST /docker/run", () => {
  it("passes ports, env, volumes, restart and a quoted command to docker run and streams output", async () => {
    const res = await call(runRoute, "POST", "/docker/run", {
      body: {
        image: "redis:7",
        name: "cache",
        ports: [{ host: "127.0.0.1:6380", container: 6379, protocol: "tcp" }, { host: "", container: 53, protocol: "udp" }],
        env: [{ key: "A", value: "x y" }],
        volumes: [{ source: "cache-data", target: "/data", readonly: false }, { source: "/srv/conf", target: "/conf", readonly: true }],
        command: `redis-server --save "60 1"`,
      },
    });
    expect(res.status).toBe(200);
    const events = await jobEvents(res);
    expect(events.filter((e) => e.type === "log").map((e) => e.type === "log" && e.line)).toContain(
      "7: Pulling from library/redis",
    );
    expect(events.at(-1)).toEqual({ type: "done", ok: true, message: "Container started", id: "c".repeat(12) });
    expect(dockerCalls().find((args) => args[0] === "run")).toEqual([
      "run", "-d", "--name", "cache",
      "-p", "127.0.0.1:6380:6379/tcp", "-p", "53:53/udp",
      "-e", "A=x y",
      "-v", "cache-data:/data", "-v", "/srv/conf:/conf:ro",
      "--restart", "unless-stopped",
      "redis:7", "redis-server", "--save", "60 1",
    ]);
  });

  it.each([
    [{ image: "--privileged" }, /Invalid image/],
    [{ image: "redis", volumes: [{ source: "../etc", target: "/x" }] }, /volume name or an absolute host path/],
    [{ image: "redis", ports: [{ host: "99999", container: 80 }] }, /Invalid host port/],
    [{ image: "redis", env: [{ key: "BAD KEY", value: "1" }] }, /Invalid environment variable/],
  ])("rejects unsafe input %j", async (body, message) => {
    const res = await api<{ error: string }>(runRoute, "POST", "/docker/run", { body });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
  });
});

describe("containers", () => {
  it("surfaces docker's own error message", async () => {
    const res = await api<{ error: string }>(containerRoute, "POST", "/docker/containers/missing", {
      body: { action: "stop" },
      params: { id: "missing" },
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("No such container: missing");
  });

  it("merges stdout and stderr logs in time order", async () => {
    const res = await api<{ logs: string }>(containerLogsRoute, "GET", "/docker/containers/web/logs?tail=50", {
      params: { id: "web" },
    });
    expect(res.status).toBe(200);
    expect(res.body.logs.split("\n").map((line) => line.split(" ").slice(1).join(" "))).toEqual([
      "first",
      "second (stderr)",
      "third",
    ]);
  });
});

describe("POST /docker/compose", () => {
  it("writes the stack under DATA_DIR/compose/<name> and runs up -d", async () => {
    const yaml = "services:\n  web:\n    image: nginx:alpine\n";
    const res = await call(composeRoute, "POST", "/docker/compose", {
      body: { name: "demo", yaml, env: [{ key: "PASSWORD", value: "p@ss word" }] },
    });
    const events = await jobEvents(res);
    expect(events.at(-1)).toMatchObject({ type: "done", ok: true });

    const dir = path.join(env().dataDir, "compose", "demo");
    expect(readFileSync(path.join(dir, "compose.yaml"), "utf8")).toBe(yaml);
    expect(readFileSync(path.join(dir, ".env"), "utf8")).toBe("PASSWORD='p@ss word'\n");
    const up = dockerCalls().find((args) => args[0] === "compose" && args.includes("up"));
    expect(up).toEqual(["compose", "-p", "demo", "-f", path.join(dir, "compose.yaml"), "up", "-d", "--remove-orphans"]);
  });

  it("rejects an invalid file without leaving a half-created stack", async () => {
    const res = await call(composeRoute, "POST", "/docker/compose", { body: { name: "broken", yaml: "INVALID" } });
    const done = (await jobEvents(res)).at(-1);
    expect(done).toMatchObject({ type: "done", ok: false });
    expect(done?.type === "done" && done.message).toMatch(/did not find expected key/);
    expect(existsSync(path.join(env().dataDir, "compose", "broken"))).toBe(false);
  });

  it("refuses to take over a compose project created outside OMP UI", async () => {
    const res = await api<{ error: string }>(composeRoute, "POST", "/docker/compose", {
      body: { name: "shop", yaml: "services: {}\n" },
    });
    expect(res.status).toBe(409);
  });
});
