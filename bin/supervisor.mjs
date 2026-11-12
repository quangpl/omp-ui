#!/usr/bin/env node
// Self-healing supervisor for the OMP UI server:
//   node bin/supervisor.mjs <command> [args…]        e.g. node bin/supervisor.mjs node server.js
//
// - Restarts the server whenever it exits unexpectedly (crash, OOM kill, force restart below),
//   backing off 1 s, 2 s, 4 s … 30 s while it keeps dying within a minute of starting.
// - Probes GET /api/v1/health. After OMP_UI_HEALTH_FAILURES failed probes in a row (no answer
//   within the timeout, or not ok) it force-restarts the server: SIGTERM, then SIGKILL to the
//   server's whole process group (its omp agents included). Failures count once the server has
//   answered once, or after the startup grace period.
// - SIGTERM / SIGINT / SIGHUP stop the server (same escalation) and then the supervisor.
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
import { spawn } from "node:child_process";
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

/** Current server: its process, when it started, and whether it has answered a probe yet. */
let child = null;
let startedAt = 0;
let healthyOnce = false;
let failures = 0;
/** Unexpected exits in a row within STABLE_UPTIME_MS of starting. */
let crashStreak = 0;
let stopping = false;
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
  const proc = spawn(command, args, { stdio: "inherit", detached: !IS_WIN, windowsHide: true });
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
  crashStreak = uptime >= STABLE_UPTIME_MS ? 1 : crashStreak + 1;
  const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (crashStreak - 1));
  say(
    `server exited unexpectedly (${signal ? `signal ${signal}` : `code ${code}`}, up ${Math.round(uptime / 1000)}s) — restarting in ${delay / 1000}s`,
  );
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

start();
void keepMemory();
