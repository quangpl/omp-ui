// Keep the agentmemory server (https://github.com/rohitg00/agentmemory) running next to OMP UI.
// Used by `omp-ui up` and bin/supervisor.mjs (plain Node, no build step; mirrors the start logic of
// lib/server/agentmemory.ts, which serves Settings → Memory).
//
//   AGENTMEMORY_ENABLED   auto (default): start it when agentmemory is installed · true: also warn
//                         when it is missing · false: never start it
//   AGENTMEMORY_URL       REST API (default http://127.0.0.1:3111); only a loopback URL is started
//
// Start order: an enabled systemd user unit `agentmemory.service` (`systemctl --user start`; it
// owns the lifecycle), else the `agentmemory` CLI (PATH, ~/.npm-global/bin, `npm prefix -g`, npx
// cache), which boots the server, hands it to a detached daemon and exits. Never fatal.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_URL = "http://127.0.0.1:3111";
const DEFAULT_PORT = 3111;
const PACKAGE_PATH = ["@agentmemory", "agentmemory"];
/** OMP UI's own secrets, never handed to the memory daemon (same list as lib/child-env.ts). */
const SECRET_ENV_KEYS = ["ADMIN_PASSWORD", "AUTH_SECRET", "DATABASE_URL", "COMPOSE_DATABASE_URL", "POSTGRES_PASSWORD", "MONGODB_DB"];

export function agentmemoryMode(env = process.env) {
  const value = String(env.AGENTMEMORY_ENABLED ?? "").trim().toLowerCase();
  if (["true", "1", "on"].includes(value)) return "true";
  if (["false", "0", "off"].includes(value)) return "false";
  return "auto";
}

function restUrl(env) {
  return (env.AGENTMEMORY_URL?.trim() || DEFAULT_URL).replace(/\/+$/, "");
}

function isLoopback(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/** `/agentmemory/livez` answers without auth once the REST worker is up. */
async function alive(url) {
  try {
    const res = await fetch(`${url}/agentmemory/livez`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function daemonEnv(env) {
  const out = { ...env, CI: "1" };
  for (const key of Object.keys(out)) {
    if (SECRET_ENV_KEYS.includes(key) || key.startsWith("OMP_UI_")) delete out[key];
  }
  return out;
}

function probe(command, args, env) {
  const r = spawnSync(command, args, { env, encoding: "utf8", timeout: 10_000, windowsHide: true });
  return r.status === 0 ? String(r.stdout ?? "").trim() : null;
}

function npxCli() {
  const root = path.join(process.env.npm_config_cache?.trim() || path.join(os.homedir(), ".npm"), "_npx");
  let best = null;
  for (const entry of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, entry, "node_modules", ...PACKAGE_PATH);
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.agentmemory;
      if (typeof pkg.version !== "string" || typeof bin !== "string") continue;
      const newer = !best || pkg.version.localeCompare(best.version, undefined, { numeric: true }) > 0;
      if (newer) best = { version: pkg.version, command: process.execPath, prefix: [path.join(dir, bin)] };
    } catch {
      // not an agentmemory install
    }
  }
  return best;
}

/** The agentmemory CLI as { command, prefix }, or null when it is not installed. */
export function findAgentmemoryCli(env = process.env) {
  const candidates = ["agentmemory", path.join(os.homedir(), ".npm-global", "bin", "agentmemory")];
  const prefix = probe("npm", ["prefix", "-g"], env);
  if (prefix && path.isAbsolute(prefix)) candidates.push(path.join(prefix, process.platform === "win32" ? "" : "bin", "agentmemory"));
  for (const command of candidates) {
    if (probe(command, ["--version"], env) !== null) return { command, prefix: [] };
  }
  return npxCli();
}

function systemdUnitEnabled(env) {
  if (process.platform !== "linux") return false;
  const r = spawnSync("systemctl", ["--user", "is-enabled", "agentmemory.service"], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  return String(r.stdout ?? "").trim().split("\n")[0] === "enabled";
}

/** Run a launcher detached (the daemon must outlive OMP UI); resolves with its exit code and output tail. */
function launch(command, args, env) {
  const { promise, resolve } = Promise.withResolvers();
  let output = "";
  const child = spawn(command, args, {
    cwd: os.homedir(), // instance 0 reuses ./data/state_store.db of its cwd
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const collect = (chunk) => {
    output = (output + chunk).slice(-4_000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.once("error", (err) => resolve({ code: null, output: err.message }));
  child.once("close", (code) => resolve({ code, output }));
  return promise;
}

function lastLine(output) {
  const lines = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? "";
}

async function waitAlive(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await alive(url)) return true;
    await sleep(1_000);
  }
  return false;
}

/**
 * Make sure the memory server runs. Resolves (never rejects) with
 * { state, url, detail? }: state is "disabled" | "running" | "remote-down" | "missing" | "started" |
 * "starting" (launched, not answering within `waitMs` yet) | "failed".
 */
export async function ensureAgentmemory({ env = process.env, waitMs = 90_000 } = {}) {
  const url = restUrl(env);
  const mode = agentmemoryMode(env);
  if (mode === "false") return { state: "disabled", url };
  if (await alive(url)) return { state: "running", url };
  if (!isLoopback(url)) return { state: "remote-down", url };
  const childEnv = daemonEnv(env);
  let result;
  if (systemdUnitEnabled(childEnv)) {
    result = await launch("systemctl", ["--user", "start", "--no-block", "agentmemory.service"], childEnv);
  } else {
    const cli = findAgentmemoryCli(childEnv);
    if (!cli) return { state: "missing", url, mode };
    const port = Number(new URL(url).port);
    const portArgs = port && port !== DEFAULT_PORT ? ["--port", String(port)] : [];
    result = await launch(cli.command, [...cli.prefix, ...portArgs], childEnv);
  }
  if (result.code !== 0) return { state: "failed", url, detail: lastLine(result.output) || `exit code ${result.code}` };
  return (await waitAlive(url, waitMs)) ? { state: "started", url } : { state: "starting", url };
}
