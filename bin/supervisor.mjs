#!/usr/bin/env node
// Self-healing supervisor for the AgentMan server:
//   node bin/supervisor.mjs <command> [args…]        e.g. node bin/supervisor.mjs node server.js
//
// - Restarts the server whenever it exits unexpectedly (crash, OOM kill, force restart below),
//   backing off 1 s, 2 s, 4 s … 30 s while it keeps dying within a minute of starting.
// - Probes GET /api/v1/health. After OMP_UI_HEALTH_FAILURES failed probes in a row (no answer
//   within the timeout, or not ok) it force-restarts the server: SIGTERM, then SIGKILL to the
//   server's whole process group (its omp agents included). Failures count once the server has
//   answered once, or after the startup grace period.
// - SIGTERM / SIGINT / SIGHUP stop the server (same escalation) and then the supervisor.
// - Runs the server with OMP_UI_SUPERVISED=1 (the resource guard's graceful restart needs it). Exit
//   code 75 (RESTART_EXIT_CODE) is a requested restart (resource guard, cluster role changes, a
//   replica's disconnect watchdog or an admin's restore): it restarts the server after 1 s without
//   counting as a crash. Before exiting 75 the server may write its own reason to the file named by
//   OMP_UI_RESTART_REASON_FILE (in a private 0700 dir per supervisor in the OS temp dir, removed when
//   the supervisor exits); the supervisor reads and deletes it on every server exit and passes it on
//   for code 75 only.
// - Tells every server it starts after the first why (OMP_UI_RESTART_REASON, e.g. "crashed (signal
//   SIGKILL, up 42 s)", "unhealthy: 3 failed health checks (…)", the server's own reason from the
//   file, else "restart requested"); cluster mode reports it to the primary. The first server
//   starts without it.
// The first probe also boots the agent manager, which resumes interrupted and failed cards.
//
// Environment (milliseconds unless noted):
//   PORT, HOST                  where the server listens (probe target; wildcard hosts → 127.0.0.1)
//   OMP_UI_HEALTH_URL           probe URL instead of http://<host>:<port>/api/v1/health
//   OMP_UI_HEALTH_INTERVAL_MS   between probes (default 15000)
//   OMP_UI_HEALTH_TIMEOUT_MS    per probe (default 10000)
//   OMP_UI_HEALTH_FAILURES      failed probes in a row before a force restart (default 3; 0 = never)
//   OMP_UI_HEALTH_GRACE_MS      startup time before failures count (default 120000)
//   OMP_UI_STOP_TIMEOUT_MS      SIGTERM → SIGKILL escalation (default 8000)
//   AGENTMEMORY_ENABLED         auto (default) | true | false: keep the agentmemory memory server
//                               running (bin/agentmemory.mjs) — checked at boot, then every
//                               OMP_UI_MEMORY_CHECK_MS (default 300000; 0 = boot only). Never fatal.
// Set on the server (not read): OMP_UI_SUPERVISED=1, OMP_UI_RESTART_REASON, OMP_UI_RESTART_REASON_FILE
// (see above).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentmemoryMode, ensureAgentmemory } from "./agentmemory.mjs";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: node bin/supervisor.mjs <command> [args…]");
  process.exit(2);
}

const IS_WIN = process.platform === "win32";
const WILDCARD_HOSTS = new Set(["", "0.0.0.0", "::", "[::]", "localhost", "::1", "[::1]"]);

function envMs(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const HEALTH_INTERVAL_MS = envMs("OMP_UI_HEALTH_INTERVAL_MS", 15_000);
const HEALTH_TIMEOUT_MS = envMs("OMP_UI_HEALTH_TIMEOUT_MS", 10_000);
const HEALTH_FAILURES = Math.floor(envMs("OMP_UI_HEALTH_FAILURES", 3));
const HEALTH_GRACE_MS = envMs("OMP_UI_HEALTH_GRACE_MS", 120_000);
const STOP_TIMEOUT_MS = envMs("OMP_UI_STOP_TIMEOUT_MS", 8_000);
const FIRST_PROBE_MS = 1_000;
const STABLE_UPTIME_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;
/** Exit code the server uses to ask for a restart; must match lib/agent/resource-guard.ts. */
const RESTART_EXIT_CODE = 75;
/** Env var telling a restarted server why; must match RESTART_REASON_ENV in lib/cluster/types.ts. */
const RESTART_REASON_ENV = "OMP_UI_RESTART_REASON";
/**
 * Env var naming the file a server writes its own restart reason to before exiting 75; must match
 * RESTART_REASON_FILE_ENV in lib/cluster/types.ts.
 */
const RESTART_REASON_FILE_ENV = "OMP_UI_RESTART_REASON_FILE";
/**
 * A private 0700 dir per supervisor in the OS temp dir (mkdtemp: random name, created atomically),
 * so no other local user can plant a file, FIFO or symlink at the reason file's path — a fixed name
 * in a shared sticky /tmp would let them block the supervisor or spoof reasons. Null when the temp
 * dir is unusable: servers then get no reason file, supervising goes on.
 */
const RESTART_REASON_DIR = makeReasonDir();
const RESTART_REASON_FILE = RESTART_REASON_DIR && path.join(RESTART_REASON_DIR, "restart-reason.txt");
/** Longest reason passed on: it ends up in a log line and a cluster notice, not a stack dump. */
const MAX_REASON_CHARS = 500;

function makeReasonDir() {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-supervisor-"));
  } catch (err) {
    console.error(`[supervisor] could not create a temp dir for restart reasons: ${err?.message ?? err}`);
    return null;
  }
}

function healthUrl() {
  if (process.env.OMP_UI_HEALTH_URL) return process.env.OMP_UI_HEALTH_URL;
  const host = (process.env.HOST ?? "").trim();
  const h = WILDCARD_HOSTS.has(host) ? "127.0.0.1" : host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${h}:${process.env.PORT || 3000}/api/v1/health`;
}

const HEALTH_URL = healthUrl();

function say(message) {
  console.log(`[supervisor ${new Date().toISOString()}] ${message}`);
}

/** Delete the reason file (best effort: a missing file is the normal case). */
function removeReasonFile() {
  if (!RESTART_REASON_FILE) return;
  try {
    fs.rmSync(RESTART_REASON_FILE, { force: true });
  } catch {
    // unwritable dir: the next server's exclusive create then fails and it sends no reason
  }
}

/** Remove the private reason dir when the supervisor exits (best effort). */
function removeReasonDir() {
  if (!RESTART_REASON_DIR) return;
  try {
    fs.rmSync(RESTART_REASON_DIR, { recursive: true, force: true });
  } catch {
    // nothing more to do on the way out
  }
}

/** Open flags for the reason file: never follow a symlink, never block on a FIFO (0 where unsupported). */
const REASON_OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * Read and delete the reason the exited server left, so it never leaks into a later exit. Returns it
 * on one line without control characters, capped at MAX_REASON_CHARS; null when there is no file,
 * it is not a regular file (anything else is removed unread), or it holds only whitespace.
 */
function takeReasonFile() {
  if (!RESTART_REASON_FILE) return null;
  let text = null;
  let fd;
  try {
    fd = fs.openSync(RESTART_REASON_FILE, REASON_OPEN_FLAGS);
    // Only a regular file is read: a FIFO or device would block the event loop (or never end).
    if (fs.fstatSync(fd).isFile()) text = fs.readFileSync(fd, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  removeReasonFile();
  if (text === null) return null;
  const reason = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters (ESC sequences) from log lines
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_REASON_CHARS)
    .trimEnd();
  return reason || null;
}

/** Current server: its process, when it started, and whether it has answered a probe yet. */
let child = null;
let startedAt = 0;
let healthyOnce = false;
let failures = 0;
/** Unexpected exits in a row within STABLE_UPTIME_MS of starting. */
let crashStreak = 0;
let stopping = false;
/** Why the next server starts (null for the first one). */
let restartReason = null;
/** Set when the supervisor force-restarts the server: the reason its following exit gets. */
let forcedReason = null;
let probeTimer;
let restartTimer;
let killTimer;

function signalGroup(proc, signal) {
  // The server leads its own process group (detached), so this reaches its omp agents too.
  try {
    process.kill(IS_WIN ? proc.pid : -proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** SIGTERM the server (it drains its agents itself), SIGKILL its whole group if it lingers. */
function terminate(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  clearTimeout(killTimer);
  killTimer = setTimeout(() => {
    say(`server (pid ${proc.pid}) did not exit within ${STOP_TIMEOUT_MS} ms — killing it`);
    signalGroup(proc, "SIGKILL");
  }, STOP_TIMEOUT_MS);
}

function start() {
  restartTimer = undefined;
  if (stopping) return;
  startedAt = Date.now();
  healthyOnce = false;
  failures = 0;
  const env = { ...process.env, OMP_UI_SUPERVISED: "1" };
  if (RESTART_REASON_FILE) env[RESTART_REASON_FILE_ENV] = RESTART_REASON_FILE;
  else delete env[RESTART_REASON_FILE_ENV];
  if (restartReason) env[RESTART_REASON_ENV] = restartReason;
  else delete env[RESTART_REASON_ENV];
  // A reason left by an earlier server must not be mistaken for the new server's; the server also
  // creates the file exclusively, so it must not exist yet.
  removeReasonFile();
  const proc = spawn(command, args, {
    stdio: "inherit",
    detached: !IS_WIN,
    windowsHide: true,
    env,
  });
  child = proc;
  say(`started server (pid ${proc.pid}): ${[command, ...args].join(" ")}`);
  proc.once("error", (err) => {
    say(`could not start the server: ${err.message}`);
    onExit(proc, null, null);
  });
  proc.once("exit", (code, signal) => onExit(proc, code, signal));
  scheduleProbe(FIRST_PROBE_MS);
}

function onExit(proc, code, signal) {
  if (child !== proc) return;
  child = null;
  // Read on every exit so a reason written by a server that then crashed is not kept around.
  const fileReason = takeReasonFile();
  clearTimeout(probeTimer);
  clearTimeout(killTimer);
  // Agents the server left behind (it was killed before it could stop them) must not keep running
  // next to the runs the new server resumes.
  signalGroup(proc, "SIGKILL");
  if (stopping) {
    say("server stopped");
    process.exit(0);
  }
  const uptime = Date.now() - startedAt;
  const forced = forcedReason;
  forcedReason = null;
  if (code === RESTART_EXIT_CODE) {
    const requested = fileReason ? `restart requested: ${fileReason}` : "restart requested";
    say(`server exited with code ${RESTART_EXIT_CODE} (${requested}) — restarting it`);
    restartReason = forced ?? fileReason ?? "restart requested";
    crashStreak = 0;
    restartTimer = setTimeout(start, 1_000);
    return;
  }
  crashStreak = uptime >= STABLE_UPTIME_MS ? 1 : crashStreak + 1;
  const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (crashStreak - 1));
  const how = signal ? `signal ${signal}` : `code ${code}`;
  say(`server exited unexpectedly (${how}, up ${Math.round(uptime / 1000)}s) — restarting in ${delay / 1000}s`);
  restartReason = forced ?? `crashed (${how}, up ${Math.round(uptime / 1000)} s)`;
  restartTimer = setTimeout(start, delay);
}

function scheduleProbe(delay) {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(probe, delay);
}

async function probe() {
  const proc = child;
  if (!proc || stopping) return;
  let problem = null;
  try {
    const res = await fetch(HEALTH_URL, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.ok !== true) problem = `HTTP ${res.status}${body?.error ? `: ${body.error}` : ""}`;
  } catch (err) {
    problem = err?.name === "TimeoutError" ? `no answer within ${HEALTH_TIMEOUT_MS} ms` : (err?.cause?.code ?? err?.message ?? String(err));
  }
  if (child !== proc || stopping) return;
  if (!problem) {
    if (!healthyOnce) say(`server is healthy (${HEALTH_URL})`);
    else if (failures > 0) say("server is healthy again");
    healthyOnce = true;
    failures = 0;
  } else if (healthyOnce || Date.now() - startedAt >= HEALTH_GRACE_MS) {
    failures++;
    say(`health check failed (${failures}/${HEALTH_FAILURES || "∞"}): ${problem}`);
    if (HEALTH_FAILURES > 0 && failures >= HEALTH_FAILURES) {
      say("server is unhealthy — force restarting it");
      forcedReason = `unhealthy: ${failures} failed health checks (${problem})`;
      terminate(proc);
      return;
    }
  }
  // Until the server first answers, probe often: that first answer also resumes the agents.
  scheduleProbe(healthyOnce ? HEALTH_INTERVAL_MS : Math.min(HEALTH_INTERVAL_MS, 2_000));
}

function stop(signal) {
  if (stopping) {
    // A second Ctrl+C: do not wait any longer.
    if (child) signalGroup(child, "SIGKILL");
    return;
  }
  stopping = true;
  say(`${signal} received — stopping the server`);
  clearTimeout(restartTimer);
  clearTimeout(probeTimer);
  if (child) terminate(child);
  else process.exit(0);
}

const MEMORY_CHECK_MS = envMs("OMP_UI_MEMORY_CHECK_MS", 300_000);
let memoryState = null;

/** Start the memory server when it is down; logs only when its state changes. */
async function keepMemory() {
  if (stopping) return;
  const result = await ensureAgentmemory();
  const missingQuietly = result.state === "missing" && agentmemoryMode() === "auto";
  if (result.state !== memoryState && !missingQuietly) {
    const detail = result.detail ? `: ${result.detail}` : "";
    const messages = {
      running: `memory server is up (${result.url})`,
      started: `started the memory server (${result.url})`,
      starting: `memory server is still starting (${result.url})`,
      missing: "AGENTMEMORY_ENABLED=true but agentmemory is not installed (npx -y @agentmemory/agentmemory@latest)",
      "remote-down": `memory server at ${result.url} is not answering`,
      failed: `could not start the memory server${detail}`,
    };
    if (messages[result.state]) say(messages[result.state]);
  }
  memoryState = result.state;
  if (MEMORY_CHECK_MS > 0 && result.state !== "disabled" && !stopping) setTimeout(keepMemory, MEMORY_CHECK_MS).unref();
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => stop(signal));
// Every way out of the supervisor ends in process.exit: leave no reason dir behind in the temp dir.
process.on("exit", removeReasonDir);

start();
void keepMemory();
