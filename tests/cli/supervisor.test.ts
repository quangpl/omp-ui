// bin/supervisor.mjs end to end against a tiny fake server (no app build needed): health-probe
// failures force a restart, a server ignoring SIGTERM is SIGKILLed, OMP_UI_HEALTH_FAILURES=0 never
// restarts, and SIGTERM to the supervisor lets the server shut down gracefully (persist its state).
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SUPERVISOR_SOURCE, freePort, isAlive, sleep, waitUntil } from "./helpers";

const IS_LINUX = process.platform === "linux";
const TEST_TIMEOUT = 15_000;
const STOP_TIMEOUT_MS = 1_000;

// Fake AgentMan server. Every instance appends its pid to $FAKE_DIR/pids. FAKE_MODE applies to the
// first instance only (later ones are always healthy):
//   healthy  — answers {"ok":true}
//   flaky    — answers once, then 500 {"ok":false,"error":"db down"}
//   stubborn — answers once, then hangs every probe and ignores SIGTERM (only SIGKILL stops it)
// On SIGTERM a well-behaved instance "drains" for 200 ms, writes $FAKE_DIR/sigterm-<pid>, exits 0.
const FAKE_SERVER = `
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const dir = process.env.FAKE_DIR;
const mode = process.env.FAKE_MODE ?? "healthy";
const pidsFile = path.join(dir, "pids");
fs.appendFileSync(pidsFile, process.pid + "\\n");
const first = fs.readFileSync(pidsFile, "utf8").trim().split("\\n").length === 1;
const sick = first && mode !== "healthy";
let answered = 0;

const server = http.createServer((req, res) => {
  if (req.url !== "/api/v1/health") {
    res.writeHead(404).end();
    return;
  }
  if (sick && answered > 0) {
    if (mode === "stubborn") return; // never answer
    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "db down" }));
    return;
  }
  answered++;
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
});
server.listen(Number(process.env.PORT), process.env.HOST);

process.on("SIGTERM", () => {
  if (sick && mode === "stubborn") return;
  setTimeout(() => {
    fs.writeFileSync(path.join(dir, "sigterm-" + process.pid), "flushed\\n");
    process.exit(0);
  }, 200);
});
`;

type FakeMode = "healthy" | "flaky" | "stubborn";

interface Run {
  sup: ChildProcess;
  dir: string;
  script: string;
  port: number;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

let run: Run | null = null;

async function startSupervisor(mode: FakeMode, env: Record<string, string> = {}): Promise<Run> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-supervisor-"));
  const script = path.join(dir, "fake-server.mjs");
  fs.writeFileSync(script, FAKE_SERVER);
  const port = await freePort();
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    OMP_UI_HEALTH_INTERVAL_MS: "200",
    OMP_UI_HEALTH_TIMEOUT_MS: "300",
    OMP_UI_HEALTH_FAILURES: "2",
    OMP_UI_HEALTH_GRACE_MS: "1000",
    OMP_UI_STOP_TIMEOUT_MS: String(STOP_TIMEOUT_MS),
    AGENTMEMORY_ENABLED: "false",
    FAKE_DIR: dir,
    FAKE_MODE: mode,
    ...env,
  };
  delete childEnv.OMP_UI_HEALTH_URL;
  const sup = spawn(process.execPath, [SUPERVISOR_SOURCE, process.execPath, script], {
    cwd: dir,
    env: childEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  sup.stdout?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  sup.stderr?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  const { promise: exited, resolve } = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  sup.once("exit", (code, signal) => resolve({ code, signal }));
  run = { sup, dir, script, port, output: () => output, exited };
  return run;
}

/** Pids of every fake server instance started so far, in start order. */
function fakePids(r: Run): number[] {
  try {
    return fs
      .readFileSync(path.join(r.dir, "pids"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Still a live instance of this run's fake server (guards against pid reuse on Linux). */
function isFake(pid: number, script: string): boolean {
  if (!IS_LINUX) return isAlive(pid);
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(script);
  } catch {
    return false;
  }
}

function killGroup(pid: number): void {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // already gone / not a group leader
    }
  }
}

function marker(r: Run, pid: number): string | null {
  try {
    return fs.readFileSync(path.join(r.dir, `sigterm-${pid}`), "utf8");
  } catch {
    return null;
  }
}

afterEach(async () => {
  const r = run;
  run = null;
  if (!r) return;
  if (r.sup.pid && r.sup.exitCode === null && r.sup.signalCode === null) {
    killGroup(r.sup.pid);
    await Promise.race([r.exited, sleep(2_000)]);
  }
  // Fake servers lead their own process groups (the supervisor spawns them detached).
  for (const pid of fakePids(r)) if (isFake(pid, r.script)) killGroup(pid);
  fs.rmSync(r.dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("bin/supervisor.mjs", () => {
  it(
    "force-restarts a server whose health checks keep failing",
    async () => {
      const r = await startSupervisor("flaky");
      await waitUntil(() => r.output().includes("server is unhealthy — force restarting it"), 8_000, 50);
      await waitUntil(() => fakePids(r).length >= 2 && count(r.output(), "server is healthy (") >= 2, 8_000, 50);

      const out = r.output();
      const failed = out.indexOf("health check failed (1/2): HTTP 500: db down");
      expect(failed).toBeGreaterThan(-1);
      expect(out).toContain("health check failed (2/2): HTTP 500: db down");
      expect(out.indexOf("server is healthy (")).toBeLessThan(failed);
      expect(failed).toBeLessThan(out.indexOf("server is unhealthy — force restarting it"));
      expect(out.indexOf("server is unhealthy — force restarting it")).toBeLessThan(
        out.lastIndexOf("server is healthy ("),
      );
      expect(out).not.toContain("did not exit within");

      const [first, second] = fakePids(r);
      expect(second).not.toBe(first);
      await waitUntil(() => !isAlive(first), 2_000, 50);
      // The unhealthy server got SIGTERM first and could shut down gracefully.
      expect(marker(r, first)).toBe("flushed\n");
      expect(isAlive(second)).toBe(true);
      const res = await fetch(`http://127.0.0.1:${r.port}/api/v1/health`);
      expect(await res.json()).toEqual({ ok: true });
    },
    TEST_TIMEOUT,
  );

  it.runIf(IS_LINUX)(
    "SIGKILLs a server that ignores SIGTERM after OMP_UI_STOP_TIMEOUT_MS and starts a new one",
    async () => {
      const r = await startSupervisor("stubborn");
      await waitUntil(() => r.output().includes("server is unhealthy — force restarting it"), 8_000, 50);
      const forcedAt = Date.now();
      await waitUntil(() => r.output().includes(`did not exit within ${STOP_TIMEOUT_MS} ms — killing it`), 4_000, 50);
      expect(Date.now() - forcedAt).toBeGreaterThanOrEqual(STOP_TIMEOUT_MS - 200);
      await waitUntil(() => fakePids(r).length >= 2 && count(r.output(), "server is healthy (") >= 2, 8_000, 50);

      const out = r.output();
      expect(out).toContain("health check failed (1/2): no answer within 300 ms");
      expect(out).toContain("server exited unexpectedly (signal SIGKILL");

      const [first, second] = fakePids(r);
      expect(isAlive(first)).toBe(false);
      expect(marker(r, first)).toBeNull();
      expect(isAlive(second)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "never force-restarts with OMP_UI_HEALTH_FAILURES=0",
    async () => {
      const r = await startSupervisor("flaky", { OMP_UI_HEALTH_FAILURES: "0" });
      await waitUntil(() => r.output().includes("health check failed (1/∞): HTTP 500: db down"), 8_000, 50);
      // Real supervisor subprocess: proving the absence of a restart needs real elapsed time
      // (≈7 failed probes at 200 ms), which fake timers in this process cannot drive.
      await sleep(1_500);

      const out = r.output();
      expect(count(out, "health check failed (")).toBeGreaterThanOrEqual(3);
      expect(out).not.toContain("force restarting");
      expect(out).not.toContain("exited unexpectedly");
      const pids = fakePids(r);
      expect(pids).toHaveLength(1);
      expect(isAlive(pids[0])).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it.runIf(IS_LINUX)(
    "SIGTERM stops the server gracefully, then exits 0",
    async () => {
      const r = await startSupervisor("healthy");
      await waitUntil(() => r.output().includes("server is healthy ("), 8_000, 50);
      const [pid] = fakePids(r);

      process.kill(r.sup.pid!, "SIGTERM");
      const { code, signal } = await r.exited;

      expect(signal).toBeNull();
      expect(code).toBe(0);
      const out = r.output();
      expect(out).toContain("SIGTERM received — stopping the server");
      expect(out).toContain("server stopped");
      expect(out).not.toContain("did not exit within");
      expect(out).not.toContain("exited unexpectedly");
      // The server got SIGTERM and finished its drain/flush before the supervisor exited.
      expect(marker(r, pid)).toBe("flushed\n");
      expect(isAlive(pid)).toBe(false);
      expect(fakePids(r)).toEqual([pid]);
    },
    TEST_TIMEOUT,
  );
});
