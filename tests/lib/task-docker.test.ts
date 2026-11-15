import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { queueTaskDockerCleanup, removeTaskDockerResources } from "@/lib/docker";
import { TASK_DOCKER_LABEL, taskComposeProject } from "@/lib/task-docker";

/**
 * Stand-in `docker` CLI: logs argv (one JSON array per line) and answers listing calls by filter.
 * Card `card-1` owns containers c1, c2 (label) and c2, c3 (compose project), plus n1, v1, image i1
 * (tags app:dev, app:latest; app:latest is still in use) and the untagged image i2.
 * Card `card-2` owns v2 and image i3 (tool:1); its labelled network listing fails.
 */
const FAKE_DOCKER = `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
const out = (s) => process.stdout.write(s + "\\n");
const fail = (message) => {
  process.stderr.write("Error response from daemon: " + message + "\\n");
  process.exit(1);
};
const LABEL = "label=agentman.task=card-1";
const PROJECT = "label=com.docker.compose.project=task-card-1";
const LABEL_2 = "label=agentman.task=card-2";
const PROJECT_2 = "label=com.docker.compose.project=task-card-2";
const TABLE = {
  ps: { [LABEL]: ["c1", "c2"], [PROJECT]: ["c2", "c3"] },
  network: { [LABEL]: ["n1"], [PROJECT]: ["n1"] },
  volume: { [LABEL]: ["v1"], [PROJECT]: ["v1"], [LABEL_2]: ["v2"] },
  images: {
    [LABEL]: ["sha256:i1 app:dev", "sha256:i1 app:latest", "sha256:i2 <none>:<none>"],
    [PROJECT]: ["sha256:i1 app:dev"],
    [PROJECT_2]: ["sha256:i3 tool:1"],
  },
};
const filterAt = args.indexOf("--filter");
if (filterAt >= 0) {
  if (args[0] === "network" && args[filterAt + 1] === LABEL_2) fail("network listing failed");
  const lines = (TABLE[args[0]] || {})[args[filterAt + 1]] || [];
  for (const line of lines) out(line);
  return;
}
if (args[0] === "rmi" && args[1] === "app:latest") fail("conflict: unable to remove repository reference");
`;

let dir: string;
let dockerBin: string;
let dockerLog: string;
const saved = { bin: process.env.DOCKER_BIN, log: process.env.FAKE_DOCKER_LOG };

function dockerCalls(): string[][] {
  if (!existsSync(dockerLog)) return [];
  return readFileSync(dockerLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "omp-ui-task-docker-"));
  dockerBin = path.join(dir, "docker");
  dockerLog = path.join(dir, "docker.log");
  writeFileSync(dockerBin, `#!${process.execPath}\n${FAKE_DOCKER}\n`, { mode: 0o755 });
  process.env.DOCKER_BIN = dockerBin;
  process.env.FAKE_DOCKER_LOG = dockerLog;
});

beforeEach(() => {
  process.env.DOCKER_BIN = dockerBin;
  rmSync(dockerLog, { force: true });
});

afterAll(() => {
  restore("DOCKER_BIN", saved.bin);
  restore("FAKE_DOCKER_LOG", saved.log);
  rmSync(dir, { recursive: true, force: true });
});

describe("removeTaskDockerResources", () => {
  it("removes exactly the card's marked resources once each", async () => {
    const result = await removeTaskDockerResources("card-1");
    expect(result).toEqual({
      containers: 3,
      networks: 1,
      volumes: 1,
      images: 1,
      errors: ["image app:latest: conflict: unable to remove repository reference"],
    });

    const calls = dockerCalls();
    const filters = [`label=${TASK_DOCKER_LABEL}=card-1`, "label=com.docker.compose.project=task-card-1"];
    const listings = calls.filter((args) => args[0] === "ps" || args[0] === "images" || args[1] === "ls");
    expect(listings).toHaveLength(8);
    for (const args of listings) {
      // Every listing is narrowed to one of the two card filters; nothing unfiltered.
      expect(args.filter((arg) => arg === "--filter")).toHaveLength(1);
      expect(filters).toContain(args[args.indexOf("--filter") + 1]);
    }
    expect(listings.map((args) => args.slice(0, -2))).toEqual([
      ["ps", "-aq", "--no-trunc"],
      ["ps", "-aq", "--no-trunc"],
      ["network", "ls", "-q", "--no-trunc"],
      ["network", "ls", "-q", "--no-trunc"],
      ["volume", "ls", "-q"],
      ["volume", "ls", "-q"],
      ["images", "--no-trunc", "--format", "{{.ID}} {{.Repository}}:{{.Tag}}"],
      ["images", "--no-trunc", "--format", "{{.ID}} {{.Repository}}:{{.Tag}}"],
    ]);

    // Containers go first: networks, volumes and images in use by them could not be removed. Images
    // are untagged tag by tag (never -f); the untagged one goes by id.
    expect(calls.filter((args) => !listings.includes(args))).toEqual([
      ["rm", "-f", "-v", "c1"],
      ["rm", "-f", "-v", "c2"],
      ["rm", "-f", "-v", "c3"],
      ["network", "rm", "n1"],
      ["volume", "rm", "v1"],
      ["rmi", "app:dev"],
      ["rmi", "app:latest"],
      ["rmi", "sha256:i2"],
    ]);
  });

  it("records a failed listing after the first call and keeps going", async () => {
    const result = await removeTaskDockerResources("card-2");
    expect(result).toEqual({
      containers: 0,
      networks: 0,
      volumes: 1,
      images: 1,
      errors: ["networks: network listing failed"],
    });
    expect(dockerCalls().filter((args) => !args.includes("--filter"))).toEqual([
      ["volume", "rm", "v2"],
      ["rmi", "tool:1"],
    ]);
  });

  it("filters the compose project by the card id's project name", async () => {
    expect(taskComposeProject("ABC-1")).toBe("task-abc-1");
    const result = await removeTaskDockerResources("ABC-1");
    expect(result).toEqual({ containers: 0, networks: 0, volumes: 0, images: 0, errors: [] });

    const used = new Set(dockerCalls().map((args) => args[args.indexOf("--filter") + 1]));
    expect([...used].sort()).toEqual(["label=agentman.task=ABC-1", "label=com.docker.compose.project=task-abc-1"]);
  });

  it("returns null when docker is not available", async () => {
    process.env.DOCKER_BIN = path.join(dir, "missing-docker");
    expect(await removeTaskDockerResources("card-1")).toBeNull();
  });

  it("returns null without calling docker for an unsafe card id", async () => {
    expect(await removeTaskDockerResources("a b;c")).toBeNull();
    expect(dockerCalls()).toEqual([]);
  });
});

describe("queueTaskDockerCleanup", () => {
  it("runs queued cleanups one card at a time", async () => {
    queueTaskDockerCleanup("card-1");
    queueTaskDockerCleanup("card-2");

    // Polls the fake docker's log: the queue exposes no promise to await. `rmi tool:1` is card-2's last call.
    const deadline = Date.now() + 10_000;
    while (!dockerCalls().some((args) => args[0] === "rmi" && args[1] === "tool:1") && Date.now() < deadline) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 20);
      await promise;
    }

    const calls = dockerCalls();
    const isCard2 = (args: string[]) => args.some((arg) => arg.endsWith("card-2") || arg === "v2" || arg === "tool:1");
    expect(calls).toContainEqual(["rmi", "sha256:i2"]);
    expect(calls).toContainEqual(["rmi", "tool:1"]);
    // Every call of card-1's cleanup comes before the first call of card-2's.
    const firstCard2 = calls.findIndex(isCard2);
    expect(firstCard2).toBeGreaterThan(0);
    expect(calls.slice(firstCard2).every(isCard2)).toBe(true);
  }, 15_000);
});
