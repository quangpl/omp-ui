// bin/supervisor.mjs end to end against a tiny fake server (no app build needed): health-probe
// failures force a restart, a server ignoring SIGTERM is SIGKILLed, OMP_UI_HEALTH_FAILURES=0 never
// restarts, SIGTERM to the supervisor lets the server shut down gracefully (persist its state), and
// a restarted server learns why from OMP_UI_RESTART_REASON — for a requested restart (exit 75) the
// reason the server itself wrote to OMP_UI_RESTART_REASON_FILE (in the supervisor's private temp dir).
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
//   healthy        — answers {"ok":true}
//   flaky          — answers once, then 500 {"ok":false,"error":"db down"}
//   stubborn       — answers once, then hangs every probe and ignores SIGTERM (only SIGKILL stops it)
//   restart        — answers once, then writes FAKE_RESTART_REASON to $OMP_UI_RESTART_REASON_FILE and
//                    exits 75 (a requested restart, like the replica's disconnect watchdog)
//   restart-silent — answers once, then exits 75 without writing a reason
// On SIGTERM a well-behaved instance "drains" for 200 ms, writes $FAKE_DIR/sigterm-<pid>, exits 0.
// Every instance writes its OMP_UI_RESTART_REASON (JSON, null when unset) to $FAKE_DIR/reason-<pid>
// and its OMP_UI_RESTART_REASON_FILE (JSON, null when unset) to $FAKE_DIR/reason-file-<pid>.
const FAKE_SERVER = `
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const dir = process.env.FAKE_DIR;
const mode = process.env.FAKE_MODE ?? "healthy";
const pidsFile = path.join(dir, "pids");
fs.appendFileSync(pidsFile, process.pid + "\\n");
const first = fs.readFileSync(pidsFile, "utf8").trim().split("\\n").length === 1;
fs.writeFileSync(path.join(dir, "reason-" + process.pid), JSON.stringify(process.env.OMP_UI_RESTART_REASON ?? null));
fs.writeFileSync(path.join(dir, "reason-file-" + process.pid), JSON.stringify(process.env.OMP_UI_RESTART_REASON_FILE ?? null));
const sick = first && (mode === "flaky" || mode === "stubborn");
const restarting = first && (mode === "restart" || mode === "restart-silent");
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
  if (restarting && answered === 1) {
    if (mode === "restart") fs.writeFileSync(process.env.OMP_UI_RESTART_REASON_FILE, process.env.FAKE_RESTART_REASON);
    // Exit once the answer is flushed, so the supervisor has seen this instance healthy first.
    res.once("finish", () => process.exit(75));
  }
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

type FakeMode = "healthy" | "flaky" | "stubborn" | "restart" | "restart-silent";

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

/** The OMP_UI_RESTART_REASON instance `pid` started with (null: unset); undefined before it wrote it. */
function restartReason(r: Run, pid: number): string | null | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(r.dir, `reason-${pid}`), "utf8")) as string | null;
  } catch {
    return undefined;
  }
}

/** The OMP_UI_RESTART_REASON_FILE instance `pid` started with (null: unset); undefined before it wrote it. */
function reasonFile(r: Run, pid: number): string | null | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(r.dir, `reason-file-${pid}`), "utf8")) as string | null;
  } catch {
    return undefined;
  }
}

/**
 * Stop the supervisor like a service manager would (SIGTERM, so its exit handler removes its private
 * temp dir), SIGKILLing its group if it does not exit in time.
 */
async function stopSupervisor(r: Run): Promise<void> {
  if (!r.sup.pid || r.sup.exitCode !== null || r.sup.signalCode !== null) return;
  try {
    process.kill(r.sup.pid, "SIGTERM");
  } catch {
    // already gone
  }
  await Promise.race([r.exited, sleep(STOP_TIMEOUT_MS + 2_000)]);
  if (r.sup.exitCode === null && r.sup.signalCode === null) {
    killGroup(r.sup.pid);
    await Promise.race([r.exited, sleep(2_000)]);
  }
}

afterEach(async () => {
  const r = run;
  run = null;
  if (!r) return;
  await stopSupervisor(r);
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

  it.runIf(IS_LINUX)(
    "tells the restarted server why it was restarted (OMP_UI_RESTART_REASON), the first one nothing",
    async () => {
      // A stale value in the supervisor's own environment must not reach the first server.
      const r = await startSupervisor("healthy", { OMP_UI_RESTART_REASON: "stale" });
      await waitUntil(() => r.output().includes("server is healthy ("), 8_000, 50);
      const [first] = fakePids(r);
      expect(restartReason(r, first)).toBeNull();

      process.kill(first, "SIGKILL");
      await waitUntil(() => fakePids(r).length >= 2 && count(r.output(), "server is healthy (") >= 2, 8_000, 50);

      const [, second] = fakePids(r);
      expect(r.output()).toContain("server exited unexpectedly (signal SIGKILL");
      expect(restartReason(r, second)).toMatch(/^crashed \(signal SIGKILL, up \d+ s\)$/);
      expect(isAlive(second)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it.runIf(IS_LINUX)(
    "passes the reason a server wrote to OMP_UI_RESTART_REASON_FILE to the next one on exit 75",
    async () => {
      // Written over two lines with extra spaces and a terminal escape: the supervisor hands it on
      // as one tidy line without control characters.
      const r = await startSupervisor("restart", {
        FAKE_RESTART_REASON: "auto-restart: \u001b[31mno connection\u001b[0m to the primary p1\n  for 5 min\n",
      });
      const reason = "auto-restart: [31mno connection [0m to the primary p1 for 5 min";
      await waitUntil(() => fakePids(r).length >= 2 && count(r.output(), "server is healthy (") >= 2, 8_000, 50);

      const [first, second] = fakePids(r);
      const file = reasonFile(r, first);
      expect(typeof file).toBe("string");
      expect(reasonFile(r, second)).toBe(file);
      // A fresh private dir (mkdtemp, 0700) in the OS temp dir, not a predictable shared-/tmp name.
      const dir = path.dirname(file!);
      expect(path.basename(file!)).toBe("restart-reason.txt");
      expect(path.dirname(dir)).toBe(os.tmpdir());
      expect(path.basename(dir)).toMatch(/^omp-ui-supervisor-.+/);
      expect(dir).not.toBe(r.dir);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(restartReason(r, first)).toBeNull();
      expect(restartReason(r, second)).toBe(reason);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control characters are gone
      expect(restartReason(r, second)).not.toMatch(/[\u0000-\u001f\u007f]/);
      const out = r.output();
      expect(out).toContain(`server exited with code 75 (restart requested: ${reason}) — restarting it`);
      expect(out).not.toContain("\u001b");
      expect(out).not.toContain("exited unexpectedly");
      // Read and deleted when the first server exited, so it cannot leak into a later restart.
      expect(fs.existsSync(file!)).toBe(false);
      expect(isAlive(second)).toBe(true);

      // The supervisor removes its private dir when it exits.
      await stopSupervisor(r);
      expect(fs.existsSync(dir)).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it.runIf(IS_LINUX)(
    "falls back to \"restart requested\" when a server exits 75 without a reason file",
    async () => {
      const r = await startSupervisor("restart-silent");
      await waitUntil(() => fakePids(r).length >= 2 && count(r.output(), "server is healthy (") >= 2, 8_000, 50);

      const [, second] = fakePids(r);
      expect(restartReason(r, second)).toBe("restart requested");
      expect(r.output()).toContain("server exited with code 75 (restart requested) — restarting it");
      expect(isAlive(second)).toBe(true);
    },
    TEST_TIMEOUT,
  );
});
