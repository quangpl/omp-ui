#!/usr/bin/env node
// omp-ui — one-command launcher and ops CLI for AgentMan.
// Zero dependencies: only node: built-ins. Config lives in <project>/.env,
// runtime state (pid, logs, tunnel) in DATA_DIR (default ./data).

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { agentmemoryMode, ensureAgentmemory } from "./agentmemory.mjs";

// ─── Constants ──────────────────────────────────────────────────────────────

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env");
const STANDALONE_SERVER = path.join(ROOT, "dist", "standalone", "server.js");
/** Restarts the server when it crashes or stops answering /api/v1/health (see the file). */
const SUPERVISOR = path.join(ROOT, "bin", "supervisor.mjs");
/** The server process: the supervisor running server.js. The pid file holds the supervisor's pid. */
const SERVER_ARGS = [SUPERVISOR, process.execPath, STANDALONE_SERVER];
const DIST_DIR = path.join(ROOT, "dist");
/** The previous build while a new one is being made (restored if the build fails). */
const PREV_DIST_DIR = path.join(ROOT, "dist.prev");
const VITE_BIN = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const MIN_NODE = 24;
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
const IS_WIN = process.platform === "win32";
const OMP_INSTALL_CMD = "curl -fsSL https://omp.sh/install | sh";
const CLOUDFLARED_DOWNLOADS =
  "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
/** Database drivers: DATABASE_URL defaults for local installs and URL validation. */
const DATABASES = {
  sqlite: { label: "SQLite", url: (dataDir) => `sqlite:${dataDir}/omp-ui.db`, valid: /^(sqlite|file):/ },
  mongodb: { label: "MongoDB", url: () => "mongodb://localhost:27017/omp_ui", valid: /^mongodb(\+srv)?:\/\// },
  postgres: {
    label: "PostgreSQL",
    url: () => "postgres://postgres:postgres@localhost:5432/omp_ui",
    valid: /^postgres(ql)?:\/\//,
  },
};
const DB_ALIASES = { sqlite: "sqlite", sqlite3: "sqlite", mongo: "mongodb", mongodb: "mongodb", postgres: "postgres", postgresql: "postgres", pg: "postgres" };
/** Compose services (profiles) that can back the Docker deployment. */
const COMPOSE_DBS = {
  mongo: { label: "MongoDB", url: () => "mongodb://mongo:27017/omp_ui" },
  postgres: { label: "PostgreSQL", url: (env) => `postgres://omp_ui:${encodeURIComponent(env.POSTGRES_PASSWORD)}@postgres:5432/omp_ui` },
};
/**
 * Credential variables omp, git, gh and glab read from the environment. The server and its
 * agents inherit them from this shell; docker-compose.yml passes the same names through.
 * doctor reports which are set — by name only, never the value.
 */
const CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "CEREBRAS_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AZURE_OPENAI_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
];

function dbKindFromUrl(url = "") {
  return Object.keys(DATABASES).find((k) => DATABASES[k].valid.test(url)) ?? "sqlite";
}
const SERVER_MARK = ["server.js"];
const TUNNEL_MARK = ["cloudflared", "ngrok"];
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
/** Paths whose changes require a rebuild of dist/standalone. */
const BUILD_INPUTS = [
  "app",
  "components",
  "hooks",
  "lib",
  "public",
  "middleware.ts",
  "proxy.ts",
  "instrumentation.ts",
  "next.config.ts",
  "vite.config.ts",
  "tsconfig.json",
  "postcss.config.mjs",
  "package.json",
  "pnpm-lock.yaml",
];

// ─── Output ─────────────────────────────────────────────────────────────────

const useColor = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb";
})();
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: paint("1"),
  dim: paint("2"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  blue: paint("34"),
  magenta: paint("35"),
  cyan: paint("36"),
};

const log = {
  info: (m) => console.log(`${c.cyan("›")} ${m}`),
  ok: (m) => console.log(`${c.green("✓")} ${m}`),
  warn: (m) => console.error(`${c.yellow("!")} ${m}`),
  error: (m) => console.error(`${c.red("✗")} ${m}`),
  step: (m) => console.log(`\n${c.bold(m)}`),
  hint: (m) => console.log(`  ${c.dim(m)}`),
};

class CliError extends Error {
  constructor(message, { hint, exitCode = 1 } = {}) {
    super(message);
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function rel(p) {
  const r = path.relative(process.cwd(), p);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : p;
}

function rmQuiet(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // already gone
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ─── .env handling ──────────────────────────────────────────────────────────

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function parseEnvValue(raw) {
  const v = raw.trim();
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    return end === -1 ? v.slice(1) : v.slice(1, end);
  }
  if (v.startsWith('"')) {
    let out = "";
    for (let i = 1; i < v.length; i++) {
      const ch = v[i];
      if (ch === "\\" && i + 1 < v.length) {
        const next = v[++i];
        out += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next;
        continue;
      }
      if (ch === '"') break;
      out += ch;
    }
    return out;
  }
  const comment = v.search(/\s#/);
  return (comment === -1 ? v : v.slice(0, comment)).trim();
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = ENV_LINE.exec(line);
    if (m) out[m[1]] = parseEnvValue(m[2]);
  }
  return out;
}

/** Serialise a value so both this parser and `docker compose` read it back verbatim. */
function formatEnvValue(value) {
  const v = String(value);
  if (/^[A-Za-z0-9_./:@%+,=-]*$/.test(v)) return v;
  if (!v.includes("'") && !v.includes("\n")) return `'${v}'`;
  return `"${v.replace(/[\\"$]/g, (ch) => `\\${ch}`).replace(/\n/g, "\\n")}"`;
}

function readEnvFile() {
  try {
    return parseEnv(fs.readFileSync(ENV_FILE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function writeSecretFile(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // non-POSIX filesystem
  }
}

/** Set (string) or remove (null) keys in .env, preserving comments and order. */
function updateEnvFile(updates) {
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
  if (lines.length && lines.at(-1) === "") lines.pop();
  const written = new Set();
  const out = [];
  for (const line of lines) {
    const m = ENV_LINE.exec(line);
    if (!m || !(m[1] in updates)) {
      out.push(line);
      continue;
    }
    const value = updates[m[1]];
    if (value == null || written.has(m[1])) continue;
    out.push(`${m[1]}=${formatEnvValue(value)}`);
    written.add(m[1]);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (value != null && !written.has(key)) out.push(`${key}=${formatEnvValue(value)}`);
  }
  writeSecretFile(ENV_FILE, `${out.join("\n")}\n`);
}

// ─── Config ─────────────────────────────────────────────────────────────────

function parsePort(value, source = "port") {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new CliError(`Invalid ${source}: "${value}" (expected 1-65535).`);
  }
  return n;
}

/**
 * Effective config: inherited env < .env (authoritative) < explicit overrides.
 * The inherited env is this shell's full environment — provider API keys, GH_TOKEN,
 * SSH_AUTH_SOCK, proxies, HOME (→ ~/.omp, ~/.claude, ~/.gitconfig, ~/.ssh, gh/glab logins) —
 * so the server and its agents use the credentials this machine already has. Keep them
 * out of .env: .env only overrides what it sets.
 */
function loadConfig(overrides = {}) {
  const file = readEnvFile();
  const env = { ...process.env, ...(file ?? {}) };
  for (const [k, v] of Object.entries(overrides)) if (v != null) env[k] = String(v);
  env.PORT ||= "3000";
  env.HOST ||= "0.0.0.0";
  env.DATA_DIR ||= "./data";
  const port = parsePort(env.PORT, "PORT");
  const host = env.HOST;
  const dataDir = path.resolve(ROOT, env.DATA_DIR);
  return { env, file, port, host, dataDir, hasEnvFile: file !== null };
}

function statePaths(cfg) {
  const d = cfg.dataDir;
  return {
    pid: path.join(d, "omp-ui.pid"),
    log: path.join(d, "omp-ui.log"),
    tunnelPid: path.join(d, "tunnel.pid"),
    tunnelUrl: path.join(d, "tunnel.url"),
    tunnelLog: path.join(d, "tunnel.log"),
  };
}

const WILDCARD_HOSTS = new Set(["", "0.0.0.0", "::", "[::]"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function urlHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** Base URL the CLI uses to talk to the local server. */
function probeBase(cfg) {
  const h = WILDCARD_HOSTS.has(cfg.host) || LOOPBACK_HOSTS.has(cfg.host) ? "127.0.0.1" : urlHost(cfg.host);
  return `http://${h}:${cfg.port}`;
}

function localUrl(cfg) {
  const h = WILDCARD_HOSTS.has(cfg.host) || LOOPBACK_HOSTS.has(cfg.host) ? "localhost" : urlHost(cfg.host);
  return `http://${h}:${cfg.port}`;
}

function lanUrls(cfg) {
  if (!WILDCARD_HOSTS.has(cfg.host)) return [];
  const urls = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) urls.push(`http://${a.address}:${cfg.port}`);
    }
  }
  return [...new Set(urls)];
}

// ─── Processes & tools ──────────────────────────────────────────────────────

function expandHome(p) {
  return p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function isExecutable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (!IS_WIN) fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a command on PATH (or an explicit path) to an absolute executable path. */
function which(cmd) {
  const target = expandHome(cmd);
  if (target.includes("/") || (IS_WIN && target.includes("\\"))) {
    const abs = path.resolve(ROOT, target);
    return isExecutable(abs) ? abs : null;
  }
  const exts = IS_WIN ? ["", ...(process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, target + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** Locate omp: configured path/name first, then the installer's default location. */
function resolveOmp(ompPath = "omp") {
  const found = which(ompPath);
  if (found) return { path: found, onPath: true };
  if (ompPath === "omp") {
    const fallback = path.join(os.homedir(), ".local", "bin", IS_WIN ? "omp.exe" : "omp");
    if (isExecutable(fallback)) return { path: fallback, onPath: false };
  }
  return null;
}

/** Run a command and return trimmed stdout (or null when it fails). */
function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000, shell: IS_WIN, cwd: ROOT, ...opts });
  if (r.error || r.status !== 0) return null;
  return `${r.stdout ?? ""}`.trim() || `${r.stderr ?? ""}`.trim();
}

function toolVersion(cmd, args = ["--version"]) {
  if (!which(cmd)) return null;
  const out = capture(cmd, args);
  return out ? out.split("\n")[0].trim() : "installed";
}

/** True when a file has more than an empty placeholder ("" or "{}") / a directory has entries. */
function hasContent(p) {
  try {
    const st = fs.statSync(p);
    return st.isDirectory() ? fs.readdirSync(p).length > 0 : st.size > 4;
  } catch {
    return false;
  }
}

/** Providers omp has a signed-in account for (`omp usage --json`), or null when omp cannot tell. */
function ompProviders(ompPath) {
  const out = capture(ompPath, ["usage", "--json"], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  try {
    const reports = JSON.parse(out ?? "").reports;
    if (!Array.isArray(reports)) return null;
    return [...new Set(reports.map((r) => r?.provider).filter((p) => typeof p === "string" && p))];
  } catch {
    return null;
  }
}

/** Run a command attached to this terminal; resolves with its exit code. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit", shell: IS_WIN, ...opts });
    const forward = (sig) => () => {
      // Ctrl+C in a terminal already reaches the child via the process group.
      if (sig === "SIGINT" && process.stdin.isTTY) return;
      child.kill(sig);
    };
    const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((sig) => [sig, forward(sig)]);
    for (const [sig, h] of handlers) process.on(sig, h);
    const done = () => {
      for (const [sig, h] of handlers) process.off(sig, h);
    };
    child.once("error", (err) => {
      done();
      reject(err.code === "ENOENT" ? new CliError(`Command not found: ${cmd}`) : err);
    });
    child.once("exit", (code, signal) => {
      done();
      resolve(signal ? 128 + (os.constants.signals[signal] ?? 1) : (code ?? 0));
    });
  });
}

async function runOrFail(what, cmd, args, opts) {
  const code = await run(cmd, args, opts);
  if (code !== 0) throw new CliError(`${what} failed (exit ${code}).`);
}

function readPid(file) {
  const pid = Number.parseInt(readText(file), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Guard against pid reuse: on Linux confirm the command line looks like ours. */
function cmdlineMatches(pid, needles) {
  if (process.platform !== "linux") return true;
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return needles.some((n) => cmd.includes(n));
  } catch {
    return false;
  }
}

/** Live pid from a pid file, cleaning up stale files. */
function runningPid(file, needles) {
  const pid = readPid(file);
  if (pid && isAlive(pid) && cmdlineMatches(pid, needles)) return pid;
  if (pid) rmQuiet(file);
  return null;
}

function sendSignal(pid, sig, group = false) {
  try {
    process.kill(group && !IS_WIN ? -pid : pid, sig);
  } catch {
    if (group) {
      try {
        process.kill(pid, sig);
      } catch {
        // already exited
      }
    }
  }
}

/** SIGTERM, wait up to timeoutMs, then SIGKILL the whole process group. */
async function terminate(pid, timeoutMs = 10_000) {
  sendSignal(pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return "terminated";
    await sleep(200);
  }
  sendSignal(pid, "SIGKILL", true);
  for (let i = 0; i < 25 && isAlive(pid); i++) await sleep(100);
  return "killed";
}

function portStatus(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (err) => resolve(err.code === "EACCES" ? "denied" : "in-use"));
    srv.once("listening", () => srv.close(() => resolve("free")));
    srv.listen({ port, host: WILDCARD_HOSTS.has(host) ? undefined : host, exclusive: true });
  });
}

async function fetchJson(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, ok: res.ok, json };
  } catch {
    return null;
  }
}

async function getHealth(cfg) {
  const r = await fetchJson(`${probeBase(cfg)}/api/v1/health`);
  return r?.ok && r.json?.ok ? r.json : null;
}

async function waitForHealth(cfg, { pid, timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pid && !isAlive(pid)) return null;
    const h = await getHealth(cfg);
    if (h) return h;
    await sleep(400);
  }
  return null;
}

function tailLines(file, n) {
  if (n <= 0) return "";
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const size = fs.fstatSync(fd).size;
    const chunk = 64 * 1024;
    let pos = size;
    let data = Buffer.alloc(0);
    while (pos > 0) {
      const len = Math.min(chunk, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      data = Buffer.concat([buf, data]);
      let count = 0;
      for (const b of data) if (b === 10) count++;
      if (count > n) break;
    }
    const lines = data.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const out = lines.slice(-n).join("\n");
    return out ? `${out}\n` : "";
  } finally {
    fs.closeSync(fd);
  }
}

function rotateLog(file) {
  try {
    if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // no log yet
  }
}

function openInBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : IS_WIN
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

// ─── Prompts ────────────────────────────────────────────────────────────────

const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

async function ask(question, def = "") {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => {
    rl.close();
    process.stdout.write("\n");
    process.exit(130);
  });
  try {
    const answer = (await rl.question(`${c.cyan("?")} ${question}${def ? c.dim(` (${def})`) : ""} `)).trim();
    return answer || def;
  } finally {
    rl.close();
  }
}

function askHidden(question) {
  const { stdin, stdout } = process;
  stdout.write(`${c.cyan("?")} ${question} `);
  return new Promise((resolve) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      if (chunk.startsWith("\x1b")) return; // arrow keys & other escape sequences
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\x04") {
          cleanup();
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\x03") {
          cleanup();
          stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\x7f" || ch === "\b") {
          value = [...value].slice(0, -1).join("");
          continue;
        }
        if (ch >= " ") value += ch;
      }
    };
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function askNewPassword(label = "Admin password") {
  for (;;) {
    const first = await askHidden(`${label} ${c.dim("(min 8 chars, hidden)")}`);
    if (first.length < 8) {
      log.warn("Too short — use at least 8 characters.");
      continue;
    }
    const again = await askHidden("Repeat password");
    if (again !== first) {
      log.warn("Passwords do not match, try again.");
      continue;
    }
    return first;
  }
}

async function readStdinLine() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
}

function validatePassword(pw) {
  if (pw.length < 8) throw new CliError("Admin password must be at least 8 characters.");
  return pw;
}

// ─── Checks ─────────────────────────────────────────────────────────────────

function requireNode() {
  if (NODE_MAJOR < MIN_NODE) {
    throw new CliError(`Node.js ${MIN_NODE}+ is required (found ${process.versions.node}).`, {
      hint: "Install Node 24: https://nodejs.org/en/download  (or: nvm install 24)",
    });
  }
}

function warnIfOmpMissing(ompPath) {
  const omp = resolveOmp(ompPath);
  if (!omp) {
    log.warn(`omp was not found (${ompPath}). Agents cannot run until it is installed:`);
    log.hint(OMP_INSTALL_CMD);
    log.hint("Then run `omp` once to sign in to a provider.");
    return;
  }
  if (!fs.existsSync(path.join(os.homedir(), ".omp", "agent"))) {
    log.warn("omp is installed but looks unconfigured — run `omp` once to sign in to a provider.");
  }
}

function depsInstalled() {
  return fs.existsSync(VITE_BIN) && fs.existsSync(path.join(ROOT, "node_modules", "vinext"));
}

function newestMtime(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.mtimeMs;
  let max = st.mtimeMs;
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    max = Math.max(max, newestMtime(path.join(p, entry.name)));
  }
  return max;
}

/** "missing" | "stale" | "fresh" */
function buildState() {
  let built;
  try {
    built = fs.statSync(STANDALONE_SERVER).mtimeMs;
  } catch {
    return "missing";
  }
  return BUILD_INPUTS.some((p) => newestMtime(path.join(ROOT, p)) > built) ? "stale" : "fresh";
}

// ─── Actions ────────────────────────────────────────────────────────────────

async function initProject(values, { fromUp = false } = {}) {
  if (fs.existsSync(ENV_FILE) && !values.force) {
    throw new CliError(".env already exists — refusing to overwrite it.", {
      hint: "Use --force to recreate it, edit .env directly, or change the password with: omp-ui passwd",
    });
  }
  const tty = isInteractive();
  const wizard = tty && !values.yes && !fromUp;
  const existing = readEnvFile() ?? {};

  if (!fromUp) {
    console.log(`\n${c.bold("AgentMan setup")} ${c.dim(`→ ${rel(ENV_FILE)}`)}\n`);
  }
  if (NODE_MAJOR < MIN_NODE) {
    log.warn(`Node.js ${MIN_NODE}+ is required to run AgentMan (found ${process.versions.node}).`);
  }

  // With an existing .env (--force), every value not given by a flag or wizard answer is kept.
  let password = values.password ?? (existing.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "");
  let generated = false;
  if (values.password !== undefined || (password && !existing.ADMIN_PASSWORD)) validatePassword(password);
  if (!password) {
    if (tty) password = await askNewPassword();
    else {
      password = randomBytes(12).toString("base64url");
      generated = true;
    }
  }

  const defaultPort = existing.PORT || process.env.PORT || "3000";
  const port = parsePort(values.port ?? (wizard ? await ask("Port", defaultPort) : defaultPort));

  const existingKind = existing.DATABASE_URL ? dbKindFromUrl(existing.DATABASE_URL) : "sqlite";
  const dbUrlFlag = values["db-url"] ?? values["mongo-url"];
  let db = values.db ?? (dbUrlFlag ? dbKindFromUrl(dbUrlFlag) : undefined);
  if (!db) db = wizard ? await ask("Database: sqlite, mongodb or postgres?", existingKind) : existingKind;
  const kind = DB_ALIASES[db.trim().toLowerCase()];
  if (!kind) throw new CliError(`Unknown database "${db}" (use sqlite, mongodb or postgres).`);

  const existingDataDir = existing.DATA_DIR || "./data";
  let dataDir = values["data-dir"] ?? (wizard ? await ask("Data directory", existingDataDir) : existingDataDir);
  dataDir = dataDir.replace(/[\\/]+$/, "") || ".";

  const driver = DATABASES[kind];
  // Keep the current URL for the same driver, unless it is the derived SQLite default
  // (then it follows a changed data directory).
  const keepUrl =
    kind === existingKind &&
    existing.DATABASE_URL &&
    !(kind === "sqlite" && existing.DATABASE_URL === DATABASES.sqlite.url(existingDataDir.replace(/[\\/]+$/, "") || "."));
  let databaseUrl = dbUrlFlag ?? (keepUrl ? existing.DATABASE_URL : driver.url(dataDir));
  if (!dbUrlFlag && wizard && kind !== "sqlite") databaseUrl = await ask(`${driver.label} URL`, databaseUrl);
  if (!driver.valid.test(databaseUrl)) {
    throw new CliError(`Invalid ${driver.label} URL "${databaseUrl}".`, {
      hint: "Expected sqlite:<path> | mongodb://… | mongodb+srv://… | postgres://… | postgresql://…",
    });
  }

  const detected = resolveOmp("omp");
  const defaultOmp = existing.OMP_PATH || (detected && !detected.onPath ? detected.path : "omp");
  const ompPath = values["omp-path"] ?? (wizard ? await ask("omp executable", defaultOmp) : defaultOmp);

  const defaultWorkspace = existing.WORKSPACE_DIR || process.env.WORKSPACE_DIR || path.join(os.homedir(), "omp-workspace");
  const workspaceDir = expandHome(
    values.workspace ?? (wizard ? await ask("Projects folder", defaultWorkspace) : defaultWorkspace),
  );

  const defaultMaxAgents = existing.MAX_AGENTS || "auto";
  const maxAgentsRaw = values["max-agents"] ?? (wizard ? await ask("Max concurrent agents (auto or 1-16)", defaultMaxAgents) : defaultMaxAgents);
  const maxAgentsAuto = String(maxAgentsRaw).trim().toLowerCase() === "auto";
  const maxAgents = maxAgentsAuto ? "auto" : Number(maxAgentsRaw);
  if (!maxAgentsAuto && (!Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > 16)) {
    throw new CliError(`Invalid max agents "${maxAgentsRaw}" (expected auto or 1-16).`);
  }

  const managed = {
    PORT: String(port),
    HOST: existing.HOST || "0.0.0.0",
    DATA_DIR: dataDir,
    DATABASE_URL: databaseUrl,
    ADMIN_PASSWORD: password,
    AUTH_SECRET: existing.AUTH_SECRET || randomBytes(32).toString("hex"),
    OMP_PATH: ompPath,
    MAX_AGENTS: String(maxAgents),
    WORKSPACE_DIR: workspaceDir,
  };
  const kept = Object.entries(existing).filter(([k]) => !(k in managed));
  const line = (k, v) => `${k}=${formatEnvValue(v)}`;
  const content = [
    `# AgentMan configuration — generated by \`omp-ui init\` on ${new Date().toISOString().slice(0, 10)}.`,
    "# All variables are documented in .env.example. Keep this file private (chmod 600).",
    "",
    "# Server",
    line("PORT", managed.PORT),
    line("HOST", managed.HOST),
    "",
    "# Storage: sqlite:<path> | mongodb://… | mongodb+srv://… | postgres://… | postgresql://…",
    line("DATA_DIR", managed.DATA_DIR),
    line("DATABASE_URL", managed.DATABASE_URL),
    "",
    "# Auth — ADMIN_PASSWORD is applied at every boot (change it with `omp-ui passwd`)",
    line("ADMIN_PASSWORD", managed.ADMIN_PASSWORD),
    line("AUTH_SECRET", managed.AUTH_SECRET),
    "",
    "# Agents",
    line("OMP_PATH", managed.OMP_PATH),
    line("MAX_AGENTS", managed.MAX_AGENTS),
    "",
    "# Projects folder: folder-picker start point and where cloned repositories go",
    line("WORKSPACE_DIR", managed.WORKSPACE_DIR),
    ...(kept.length ? ["", "# Preserved from the previous .env", ...kept.map(([k, v]) => line(k, v))] : []),
    "",
  ].join("\n");
  writeSecretFile(ENV_FILE, content);
  fs.mkdirSync(path.resolve(ROOT, dataDir), { recursive: true });
  fs.mkdirSync(path.resolve(ROOT, expandHome(workspaceDir)), { recursive: true });

  log.ok(`Wrote ${rel(ENV_FILE)} ${c.dim("(chmod 600)")}`);
  if (generated) {
    const banner = "=".repeat(60);
    console.log(`\n${banner}\n  AgentMan ADMIN PASSWORD (generated): ${c.green(c.bold(password))}\n${banner}`);
    log.hint("Generated because none was given — save it now, or change it with: omp-ui passwd\n");
  }
  if (kind !== "sqlite") log.info(`Using ${driver.label} at ${databaseUrl}`);
  warnIfOmpMissing(ompPath);
  if (!fromUp) {
    console.log(`\n${c.bold("Next:")} ${c.cyan("omp-ui up")}`);
  }
}

async function ensureDeps({ quiet = false } = {}) {
  if (depsInstalled()) return false;
  log.step("Installing dependencies");
  // Without NODE_ENV=production, so the build tools (devDependencies) get installed too.
  const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
  delete env.NODE_ENV;
  if (which("pnpm")) {
    await runOrFail("pnpm install", "pnpm", ["install", "--frozen-lockfile"], { env });
  } else if (which("corepack")) {
    await runOrFail("corepack pnpm install", "corepack", ["pnpm", "install", "--frozen-lockfile"], { env });
  } else {
    await runOrFail("npm install", "npm", ["install", "--no-audit", "--no-fund"], { env });
  }
  if (!depsInstalled()) throw new CliError("Dependencies were installed but vite/vinext are still missing.");
  if (!quiet) log.ok("Dependencies installed");
  return true;
}

async function buildApp() {
  requireNode();
  await ensureDeps();
  log.step("Building AgentMan");
  // vite empties dist/ while building: set the current build aside so a failed build can put it back.
  fs.rmSync(PREV_DIST_DIR, { recursive: true, force: true });
  const hadBuild = fs.existsSync(STANDALONE_SERVER);
  if (hadBuild) fs.renameSync(DIST_DIR, PREV_DIST_DIR);
  try {
    await runOrFail("Build", process.execPath, [VITE_BIN, "build"], { shell: false });
    if (!fs.existsSync(STANDALONE_SERVER)) {
      throw new CliError("Build finished but dist/standalone/server.js is missing.", {
        hint: 'next.config.ts must set output: "standalone".',
      });
    }
  } catch (err) {
    if (hadBuild) {
      fs.rmSync(DIST_DIR, { recursive: true, force: true });
      fs.renameSync(PREV_DIST_DIR, DIST_DIR);
      log.info("Previous build restored");
    }
    throw err;
  }
  fs.rmSync(PREV_DIST_DIR, { recursive: true, force: true });
  log.ok("Build complete");
}

/**
 * Build before (re)starting. When the build fails, buildApp has restored the previous build: start
 * that one instead of leaving the server down; the exit code still reports the failure. The
 * server's restart button (lib/server/restart.ts) looks for this warning in its log.
 */
async function buildOrKeepPrevious() {
  try {
    await buildApp();
  } catch (err) {
    if (!(err instanceof CliError) || !fs.existsSync(STANDALONE_SERVER)) throw err;
    log.error(err.message);
    log.warn("Build failed — starting the previous build");
    process.exitCode = 1;
  }
}

/** Environment of the server process: the full inherited environment plus .env (see loadConfig). */
function serverEnv(cfg) {
  return { ...cfg.env, NODE_ENV: "production", PORT: String(cfg.port), HOST: cfg.host };
}

async function assertPortFree(cfg) {
  const state = await portStatus(cfg.port, cfg.host);
  if (state === "free") return;
  throw new CliError(
    state === "denied" ? `No permission to listen on port ${cfg.port}.` : `Port ${cfg.port} is already in use.`,
    { hint: "Choose another one: --port 3001 (saved to .env)" },
  );
}

/** Owners (pid file second line) that are service managers restarting whatever we stop. */
const SERVICE_MANAGERS = new Set(["pm2", "systemd"]);

/** Who started the running server: "pm2", "systemd", "fg" (start -f) or "cli" (background). */
function serverOwner(cfg) {
  return readText(statePaths(cfg).pid).split("\n")[1]?.trim() || "cli";
}

/** The service manager running this CLI (`up --foreground` from pm2 or omp-ui.service), or null. */
function serviceManager() {
  if (process.env.pm_id !== undefined) return "pm2";
  if (process.env.OMP_UI_SERVICE_MANAGER === "systemd") return "systemd";
  return null;
}

/** The running server when pm2 or systemd supervises it ({ pid, manager }), or null. */
function managedServer(cfg) {
  const pid = runningPid(statePaths(cfg).pid, SERVER_MARK);
  const owner = pid ? serverOwner(cfg) : null;
  return pid && SERVICE_MANAGERS.has(owner) ? { pid, manager: owner } : null;
}

/** Refuse to fight pm2/systemd: they would restart whatever we stop. */
function assertNotManaged(cfg, action) {
  const managed = managedServer(cfg);
  if (managed) {
    throw new CliError(`AgentMan is managed by ${managed.manager} (pid ${managed.pid}).`, {
      hint: `Run: omp-ui ${managed.manager} ${action}`,
    });
  }
}

/** "pid 123, managed by pm2"-style note for an already running server. */
function ownerNote(pid, owner) {
  return `pid ${pid}${SERVICE_MANAGERS.has(owner) ? `, managed by ${owner}` : ""}`;
}

async function startServer(cfg, { foreground = false } = {}) {
  requireNode();
  const paths = statePaths(cfg);
  const manager = serviceManager();
  const existing = runningPid(paths.pid, SERVER_MARK);
  if (existing) {
    const owner = serverOwner(cfg);
    if (foreground && manager && owner === manager) {
      // Left over from a previous pm2/systemd run whose supervisor was killed: replace it.
      log.warn(`Stopping a leftover server from a previous ${manager} run (pid ${existing})`);
      await terminate(existing);
      rmQuiet(paths.pid);
    } else if (foreground) {
      throw new CliError(`AgentMan is already running (${ownerNote(existing, owner)}).`, {
        hint: SERVICE_MANAGERS.has(owner) ? `Use: omp-ui ${owner} restart` : "Stop it first: omp-ui stop",
      });
    } else {
      log.info(`Already running ${c.dim(`(${ownerNote(existing, owner)})`)}`);
      return { pid: existing, health: await getHealth(cfg), already: true };
    }
  }
  if (!fs.existsSync(STANDALONE_SERVER)) {
    throw new CliError("No production build found.", { hint: "Run: omp-ui up   (or: omp-ui build)" });
  }
  if (!cfg.hasEnvFile) log.warn("No .env found — running with defaults. Create one with: omp-ui init");
  await assertPortFree(cfg);
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  if (foreground) {
    const child = spawn(process.execPath, SERVER_ARGS, { cwd: ROOT, env: serverEnv(cfg), stdio: "inherit" });
    fs.writeFileSync(paths.pid, `${child.pid}\n${manager ?? "fg"}\n`);
    log.info(`Serving at ${c.cyan(localUrl(cfg))} ${c.dim(manager ? `(supervised by ${manager})` : "(Ctrl+C to stop)")}`);
    const forward = (sig) => () => {
      if (sig === "SIGINT" && process.stdin.isTTY) return;
      child.kill(sig);
    };
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, forward(sig));
    const code = await new Promise((resolve) => {
      child.once("error", () => resolve(1));
      child.once("exit", (exitCode, signal) => resolve(signal ? 0 : (exitCode ?? 0)));
    });
    rmQuiet(paths.pid);
    process.exitCode = code;
    return { pid: child.pid, foreground: true };
  }

  rotateLog(paths.log);
  const fd = fs.openSync(paths.log, "a");
  fs.writeSync(fd, `\n=== omp-ui start ${new Date().toISOString()} · port ${cfg.port} ===\n`);
  const child = spawn(process.execPath, SERVER_ARGS, {
    cwd: ROOT,
    env: serverEnv(cfg),
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  fs.closeSync(fd);
  child.once("error", () => {});
  child.unref();
  fs.writeFileSync(paths.pid, `${child.pid}\n`);
  log.info(`Starting server ${c.dim(`(pid ${child.pid})`)}…`);

  const health = await waitForHealth(cfg, { pid: child.pid });
  if (!health) {
    const alive = isAlive(child.pid);
    if (!alive) rmQuiet(paths.pid);
    const tail = tailLines(paths.log, 25);
    if (tail) console.error(`\n${c.dim(tail)}`);
    throw new CliError(
      alive
        ? "Server started but /api/v1/health did not respond in time (its supervisor keeps restarting it)."
        : "Server exited during startup.",
      { hint: `Full log: ${rel(paths.log)}  (omp-ui logs)` },
    );
  }
  log.ok(`Server is up ${c.dim(`(v${health.version} · ${health.db})`)}`);
  return { pid: child.pid, health };
}

/** Start the agentmemory server before AgentMan (AGENTMEMORY_ENABLED, see bin/agentmemory.mjs); never fatal. */
async function ensureMemory(cfg) {
  const result = await ensureAgentmemory({ env: cfg.env, waitMs: 60_000 });
  const url = c.dim(`(${result.url})`);
  switch (result.state) {
    case "running":
      return log.info(`Memory server is running ${url}`);
    case "started":
      return log.ok(`Started the memory server ${url}`);
    case "starting":
      return log.info(`Memory server is still starting ${url} — the supervisor keeps checking`);
    case "remote-down":
      return log.warn(`Memory server at ${result.url} is not answering (AGENTMEMORY_URL)`);
    case "failed":
      return log.warn(`Could not start the memory server${result.detail ? `: ${result.detail}` : ""}`);
    case "missing":
      if (agentmemoryMode(cfg.env) === "true") {
        log.warn("AGENTMEMORY_ENABLED=true but agentmemory is not installed — run: npx -y @agentmemory/agentmemory@latest");
      }
      return;
    default:
      return;
  }
}

/** `allowManaged`: under pm2/systemd, stop a server owned by that same manager (a leftover of our previous run). */
async function stopServer(cfg, { allowManaged = false } = {}) {
  if (!(allowManaged && serverOwner(cfg) === serviceManager())) assertNotManaged(cfg, "stop");
  const paths = statePaths(cfg);
  const pid = runningPid(paths.pid, SERVER_MARK);
  if (!pid) {
    log.info("Server is not running");
    return false;
  }
  log.info(`Stopping server ${c.dim(`(pid ${pid})`)}…`);
  const how = await terminate(pid);
  rmQuiet(paths.pid);
  if (how === "killed") log.warn("Server did not exit within 10s — killed");
  else log.ok("Server stopped");
  return true;
}

// ─── pm2 ────────────────────────────────────────────────────────────────────

const PM2_APP = "omp-ui";
const ECOSYSTEM_FILE = path.join(ROOT, "ecosystem.config.cjs");
/** Must match out_file in ecosystem.config.cjs. */
const PM2_OUT_LOG = path.join(ROOT, "data", "pm2-out.log");

/** Global pm2 if installed, else `npx -y pm2`. */
function pm2Command() {
  if (which("pm2")) return ["pm2", []];
  if (which("npx")) return ["npx", ["-y", "pm2"]];
  throw new CliError("pm2 is not installed.", { hint: "Install it: npm i -g pm2" });
}

async function pm2(args, { allowFail = false } = {}) {
  const [cmd, pre] = pm2Command();
  const code = await run(cmd, [...pre, ...args]);
  if (code !== 0 && !allowFail) throw new CliError(`pm2 ${args[0]} failed (exit ${code}).`);
  return code;
}

/** pm2 status of the omp-ui app ("online", "stopped", "errored", …) or null when pm2 does not know it. */
function pm2AppStatus() {
  const [cmd, pre] = pm2Command();
  const out = capture(cmd, [...pre, "jlist"], { timeout: 120_000 });
  const json = out
    ?.split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("[") && !l.trim().startsWith("[PM2]"));
  if (!json) return null;
  try {
    const app = JSON.parse(json).find((a) => a.name === PM2_APP);
    return app ? (app.pm2_env?.status ?? "unknown") : null;
  } catch {
    return null;
  }
}

/** The generated admin password banner from a first run under pm2, if any. */
function pm2GeneratedPassword() {
  const m = /AgentMan ADMIN PASSWORD \(generated\): (\S+)/.exec(tailLines(PM2_OUT_LOG, 400).replace(/\x1b\[[0-9;]*m/g, ""));
  return m?.[1] ?? null;
}

async function pm2WaitAndReport() {
  const cfg = loadConfig();
  log.info(`Waiting for the server… ${c.dim("(a first run installs and builds — follow with: omp-ui pm2 logs)")}`);
  const health = await waitForHealth(cfg, { timeoutMs: 15 * 60_000 });
  if (!health) {
    throw new CliError("AgentMan did not come up under pm2.", { hint: "See: omp-ui pm2 logs" });
  }
  log.ok(`Running under pm2 ${c.dim(`(v${health.version} · ${health.db})`)}`);
  printUrls(cfg, { tunnelUrl: tunnelInfo(cfg)?.url });
  const generated = pm2GeneratedPassword();
  if (generated && readEnvFile()?.ADMIN_PASSWORD === generated) {
    console.log(`  ${c.bold("Admin password (generated):")} ${c.green(generated)} ${c.dim("— change it with: omp-ui passwd")}\n`);
  }
  console.log(c.bold("pm2"));
  console.log(`  ${c.dim("·")} Logs: ${c.cyan("omp-ui pm2 logs")}   Status: ${c.cyan("omp-ui pm2 status")}   Stop: ${c.cyan("omp-ui pm2 stop")}`);
  console.log(`  ${c.dim("·")} Start on boot: ${c.cyan("omp-ui pm2 save")} then ${c.cyan("omp-ui pm2 startup")}\n`);
}

/** Start (or restart) the omp-ui pm2 app, taking over from a background server. */
async function pm2Start() {
  const cfg = loadConfig();
  if (runningPid(statePaths(cfg).pid, SERVER_MARK) && serverOwner(cfg) !== "pm2") {
    log.info("Stopping the background server so pm2 can take over");
    await stopServer(cfg);
  }
  const known = pm2AppStatus() !== null;
  log.step(known ? "Restarting AgentMan under pm2" : "Starting AgentMan under pm2");
  await pm2(known ? ["restart", PM2_APP] : ["start", ECOSYSTEM_FILE]);
  await pm2WaitAndReport();
}

// ─── systemd ────────────────────────────────────────────────────────────────

const SYSTEMD_UNIT = "omp-ui.service";
/** Unit template with {{ROOT}}, {{NODE}} and {{PATH}} placeholders. */
const SYSTEMD_TEMPLATE = path.join(ROOT, "omp-ui.service");
const SYSTEMD_USAGE = "omp-ui systemd [install|uninstall|start|stop|restart|status|logs|unit]";

/** Where the user manager loads the unit from: $XDG_CONFIG_HOME/systemd/user (default ~/.config). */
function systemdUnitPath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "systemd", "user", SYSTEMD_UNIT);
}

/** PATH captured for the unit, with node's own directory added when missing; entries systemd cannot take unquoted are dropped. */
function systemdPath() {
  const raw = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
  if (/[\r\n]/.test(raw)) throw new CliError("Cannot write the systemd unit: PATH contains a line break.");
  const dirs = raw.split(":").filter((d) => path.isAbsolute(d) && !/[\s"'\\]/.test(d));
  const nodeDir = path.dirname(process.execPath);
  if (!dirs.includes(nodeDir)) dirs.unshift(nodeDir);
  return [...new Set(dirs)].join(":");
}

/** omp-ui.service with the placeholders filled in for this checkout and this node. */
function renderSystemdUnit() {
  for (const [what, value] of [["project", ROOT], ["node", process.execPath]]) {
    if (/[\s"'\\]/.test(value)) {
      throw new CliError(`Cannot write the systemd unit: the ${what} path contains spaces or quotes (${value}).`, {
        hint: "Move it to a path without them.",
      });
    }
  }
  const values = { ROOT, NODE: process.execPath, PATH: systemdPath() };
  let text = fs.readFileSync(SYSTEMD_TEMPLATE, "utf8");
  // "%" starts a systemd specifier; "%%" is a literal one.
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{{${key}}}`, value.replaceAll("%", "%%"));
  return text;
}

/** Refuse unless this is Linux with a reachable systemd user manager. */
function assertSystemd() {
  const hint = "Use pm2 instead: omp-ui up --pm2";
  if (process.platform !== "linux") throw new CliError("systemd services are Linux-only.", { hint });
  if (!which("systemctl")) throw new CliError("systemctl was not found — this system does not run systemd.", { hint });
  if (capture("systemctl", ["--user", "show-environment"]) === null) {
    throw new CliError("The systemd user manager is not reachable (systemctl --user failed).", {
      hint: `Run it from a regular login session (not su/sudo), or: ${hint}`,
    });
  }
}

async function systemctl(args, { allowFail = false } = {}) {
  const code = await run("systemctl", ["--user", ...args]);
  if (code !== 0 && !allowFail) {
    throw new CliError(`systemctl --user ${args[0]} failed (exit ${code}).`, { hint: "See: omp-ui systemd logs" });
  }
  return code;
}

/** `systemctl --user is-active` of the unit: "active", "inactive", "failed", "activating", … */
function systemdUnitState() {
  const r = spawnSync("systemctl", ["--user", "is-active", SYSTEMD_UNIT], { encoding: "utf8", timeout: 15_000 });
  return `${r.stdout ?? ""}`.trim() || "unknown";
}

function assertSystemdInstalled() {
  if (!fs.existsSync(systemdUnitPath())) {
    throw new CliError(`The systemd service is not installed (${systemdUnitPath()}).`, { hint: "Install it: omp-ui systemd install" });
  }
}

/** Stop a server this CLI started (background or attached) so the service can bind the port. */
async function systemdTakeOver() {
  const cfg = loadConfig();
  if (runningPid(statePaths(cfg).pid, SERVER_MARK) && serverOwner(cfg) !== "systemd") {
    log.info("Stopping the background server so systemd can take over");
    await stopServer(cfg);
  }
}

/** Let the user manager (and so the service) start at boot without a login. */
function ensureLinger() {
  const user = os.userInfo().username;
  if (capture("loginctl", ["show-user", user, "-p", "Linger", "--value"]) === "yes") return;
  if (which("loginctl") && capture("loginctl", ["enable-linger", user]) !== null) {
    log.ok(`Enabled lingering for ${user} — AgentMan starts at boot without a login`);
    return;
  }
  log.warn(`Could not enable lingering for ${user}: AgentMan starts only once ${user} logs in.`);
  log.hint(`To start it at boot, run: sudo loginctl enable-linger ${user}`);
}

/** The generated admin password banner from a first run under systemd, if any. */
function systemdGeneratedPassword() {
  const out = capture("journalctl", ["--user", "-u", SYSTEMD_UNIT, "-n", "400", "--no-pager", "-o", "cat"]) ?? "";
  const m = /AgentMan ADMIN PASSWORD \(generated\): (\S+)/.exec(out.replace(/\x1b\[[0-9;]*m/g, ""));
  return m?.[1] ?? null;
}

async function systemdWaitAndReport() {
  const cfg = loadConfig();
  log.info(`Waiting for the server… ${c.dim("(a first run installs and builds — follow with: omp-ui systemd logs -f)")}`);
  const health = await waitForHealth(cfg, { timeoutMs: 15 * 60_000 });
  if (!health) {
    throw new CliError("AgentMan did not come up under systemd.", { hint: "See: omp-ui systemd logs" });
  }
  log.ok(`Running under systemd ${c.dim(`(v${health.version} · ${health.db})`)}`);
  printUrls(cfg, { tunnelUrl: tunnelInfo(cfg)?.url });
  const generated = systemdGeneratedPassword();
  if (generated && readEnvFile()?.ADMIN_PASSWORD === generated) {
    console.log(`  ${c.bold("Admin password (generated):")} ${c.green(generated)} ${c.dim("— change it with: omp-ui passwd")}\n`);
  }
  console.log(c.bold("systemd"));
  console.log(`  ${c.dim("·")} Logs: ${c.cyan("omp-ui systemd logs")}   Status: ${c.cyan("omp-ui systemd status")}   Stop: ${c.cyan("omp-ui systemd stop")}`);
  console.log(`  ${c.dim("·")} Starts on boot · unit: ${c.dim(systemdUnitPath())}\n`);
}

/** Write the unit, enable it at boot and (re)start it, taking over from a CLI-started server. Idempotent. */
async function systemdInstall() {
  assertSystemd();
  const unit = renderSystemdUnit();
  await systemdTakeOver();
  const file = systemdUnitPath();
  const changed = readText(file) !== unit.trim();
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, unit);
    log.ok(`Wrote ${file}`);
  } else {
    log.info(`Unit is up to date ${c.dim(`(${file})`)}`);
  }
  await systemctl(["daemon-reload"]);
  const wasActive = systemdUnitState() === "active";
  log.step(wasActive ? "Restarting AgentMan under systemd" : "Starting AgentMan under systemd");
  await systemctl(["enable", "--now", SYSTEMD_UNIT]);
  // Already running: restart so a changed unit (or new sources: `up` rebuilds on start) applies.
  if (wasActive) await systemctl(["restart", SYSTEMD_UNIT]);
  ensureLinger();
  await systemdWaitAndReport();
}

async function systemdUninstall() {
  assertSystemd();
  const file = systemdUnitPath();
  if (!fs.existsSync(file)) {
    log.info(`The systemd service is not installed ${c.dim(`(${file})`)}`);
    return;
  }
  await systemctl(["disable", "--now", SYSTEMD_UNIT], { allowFail: true });
  rmQuiet(file);
  await systemctl(["daemon-reload"]);
  log.ok(`Removed ${file}`);
  log.hint("Start it without systemd: omp-ui up");
}

function printUrls(cfg, { tunnelUrl } = {}) {
  const label = (s) => c.dim(s.padEnd(9));
  console.log("");
  console.log(`  ${c.green("➜")} ${label("Local")}${c.cyan(c.bold(localUrl(cfg)))}`);
  for (const url of lanUrls(cfg)) console.log(`  ${c.green("➜")} ${label("Network")}${c.cyan(url)}`);
  if (tunnelUrl) console.log(`  ${c.green("➜")} ${label("Public")}${c.magenta(c.bold(tunnelUrl))}`);
  console.log("");
}

function printNextSteps() {
  console.log(c.bold("Next steps"));
  console.log(`  1. Open the URL and sign in with your admin password`);
  console.log(`  2. Create a project (folder or Git repo), add cards, move one to ${c.bold("In progress")}`);
  console.log(`  ${c.dim("·")} Phone on the same Wi-Fi: open the Network URL → Share → Add to Home Screen`);
  console.log(`  ${c.dim("·")} Share over the internet: ${c.cyan("omp-ui public")}`);
  console.log(`  ${c.dim("·")} Logs: ${c.cyan("omp-ui logs -f")}   Status: ${c.cyan("omp-ui status")}   Stop: ${c.cyan("omp-ui stop")}`);
  console.log("");
}

function printSecurityReminder() {
  console.log(c.yellow(c.bold("Security")));
  console.log(c.yellow("  Anyone with this URL reaches your login page — the admin password is the only lock."));
  console.log(c.yellow("  Agents run shell commands on this machine. Use a strong password (omp-ui passwd)."));
  console.log(c.dim("  Stop sharing: omp-ui public stop\n"));
}

// ─── Tunnel ─────────────────────────────────────────────────────────────────

const TRYCLOUDFLARE_URL = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/;

async function ngrokUrl(port) {
  const r = await fetchJson("http://127.0.0.1:4040/api/tunnels", 1500);
  const tunnels = r?.json?.tunnels ?? [];
  const match = tunnels.find(
    (t) => String(t.public_url ?? "").startsWith("https://") && String(t.config?.addr ?? "").endsWith(`:${port}`),
  );
  return match?.public_url ?? null;
}

async function tunnelStart(cfg) {
  const paths = statePaths(cfg);
  const running = runningPid(paths.tunnelPid, TUNNEL_MARK);
  if (running) {
    const url = readText(paths.tunnelUrl);
    log.info(`Tunnel already running ${c.dim(`(pid ${running})`)}`);
    if (url) printUrls(cfg, { tunnelUrl: url });
    printSecurityReminder();
    return url;
  }
  if (!(await getHealth(cfg))) {
    throw new CliError(`AgentMan is not reachable at ${localUrl(cfg)}.`, { hint: "Start it first: omp-ui up" });
  }
  const auth = await fetchJson(`${probeBase(cfg)}/api/v1/auth/status`);
  if (auth?.json && auth.json.configured === false) {
    throw new CliError("No admin password is configured — refusing to expose an unprotected server.", {
      hint: "Set one first: omp-ui passwd",
    });
  }

  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const target = probeBase(cfg);
  const cloudflared = which("cloudflared");
  const ngrok = cloudflared ? null : which("ngrok");
  if (!cloudflared && !ngrok) {
    throw new CliError("No tunnel tool found (cloudflared or ngrok).", {
      hint: `Install cloudflared (free, no account needed): ${CLOUDFLARED_DOWNLOADS}\n  macOS: brew install cloudflared · then run: omp-ui public`,
    });
  }

  const fd = fs.openSync(paths.tunnelLog, "w");
  const [cmd, args, name] = cloudflared
    ? [cloudflared, ["tunnel", "--url", target, "--no-autoupdate"], "cloudflared"]
    : [ngrok, ["http", target, "--log", "stdout"], "ngrok"];
  const child = spawn(cmd, args, { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
  fs.closeSync(fd);
  child.once("error", () => {});
  child.unref();
  fs.writeFileSync(paths.tunnelPid, `${child.pid}\n`);
  log.info(`Opening a public tunnel with ${name}…`);

  let url = null;
  const deadline = Date.now() + 45_000;
  while (!url && Date.now() < deadline && isAlive(child.pid)) {
    await sleep(500);
    url = cloudflared ? (TRYCLOUDFLARE_URL.exec(readText(paths.tunnelLog))?.[0] ?? null) : await ngrokUrl(cfg.port);
  }
  if (!url) {
    const alive = isAlive(child.pid);
    if (alive) await terminate(child.pid, 3000);
    rmQuiet(paths.tunnelPid);
    const tail = tailLines(paths.tunnelLog, 15);
    if (tail) console.error(`\n${c.dim(tail)}`);
    throw new CliError(`${name} did not report a public URL.`, {
      hint: ngrok ? "ngrok needs an account token: ngrok config add-authtoken <token>" : `Log: ${rel(paths.tunnelLog)}`,
    });
  }
  fs.writeFileSync(paths.tunnelUrl, `${url}\n`);
  log.ok(`Public tunnel is up ${c.dim(`(${name}, pid ${child.pid})`)}`);
  printUrls(cfg, { tunnelUrl: url });
  printSecurityReminder();
  return url;
}

async function tunnelStop(cfg, { quiet = false } = {}) {
  const paths = statePaths(cfg);
  const pid = runningPid(paths.tunnelPid, TUNNEL_MARK);
  rmQuiet(paths.tunnelUrl);
  if (!pid) {
    if (!quiet) log.info("No public tunnel is running");
    return false;
  }
  await terminate(pid, 5000);
  rmQuiet(paths.tunnelPid);
  log.ok("Public tunnel stopped");
  return true;
}

function tunnelInfo(cfg) {
  const paths = statePaths(cfg);
  const pid = runningPid(paths.tunnelPid, TUNNEL_MARK);
  if (!pid) {
    rmQuiet(paths.tunnelUrl);
    return null;
  }
  return { pid, url: readText(paths.tunnelUrl) || null };
}

// ─── Docker ─────────────────────────────────────────────────────────────────

function composeCommand() {
  if (which("docker") && capture("docker", ["compose", "version"])) return ["docker", ["compose"]];
  if (which("docker-compose")) return ["docker-compose", []];
  throw new CliError("Docker with the Compose plugin is required.", {
    hint: "Install Docker: https://docs.docker.com/get-docker/",
  });
}

async function compose(args, opts = {}) {
  const [cmd, pre] = composeCommand();
  await runOrFail(`docker compose ${args[0] ?? ""}`.trim(), cmd, [...pre, ...args], { shell: false, ...opts });
}

/** Add `profile` to a comma-separated COMPOSE_PROFILES list, dropping `exclude`. */
function setProfile(list, profile, exclude = []) {
  const set = new Set(String(list ?? "").split(",").map((s) => s.trim()).filter((p) => p && !exclude.includes(p)));
  set.add(profile);
  return [...set].join(",");
}

/** "mongo" | "postgres" | null from the --mongo / --postgres flags. */
function composeDbProfile(values) {
  if (values.mongo && values.postgres) throw new CliError("Choose either --mongo or --postgres, not both.");
  return values.mongo ? "mongo" : values.postgres ? "postgres" : null;
}

/**
 * Create the host paths docker-compose.yml bind-mounts for the credentials it shares, so
 * Docker does not create them as root-owned directories (a directory named ~/.gitconfig
 * would break git, one named ~/.claude.json would break Claude).
 */
function prepareHostMounts() {
  const home = os.homedir();
  fs.mkdirSync(expandHome(readEnvFile()?.OMP_HOME || "~/.omp"), { recursive: true });
  for (const dir of [".claude", ".config/git", ".config/gh", ".config/glab-cli"]) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
  }
  for (const dir of [".ssh", ".aws"]) {
    if (!fs.existsSync(path.join(home, dir))) fs.mkdirSync(path.join(home, dir), { mode: 0o700 });
  }
  const files = [
    [".gitconfig", "", 0o644],
    [".git-credentials", "", 0o600],
    [".claude.json", "{}\n", 0o600],
  ];
  for (const [name, content, mode] of files) {
    const file = path.join(home, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, content, { mode });
  }
}

/** Make sure .env exists and carries the compose-specific settings. */
async function prepareDockerEnv(values, { localMounts = true } = {}) {
  if (!fs.existsSync(ENV_FILE)) {
    log.step("First run — creating .env");
    await initProject({ password: values.password, yes: true }, { fromUp: true });
  }
  const dbProfile = composeDbProfile(values);
  if (dbProfile) {
    const file = readEnvFile() ?? {};
    const POSTGRES_PASSWORD = file.POSTGRES_PASSWORD || randomBytes(18).toString("hex");
    const others = Object.keys(COMPOSE_DBS).filter((p) => p !== dbProfile);
    updateEnvFile({
      COMPOSE_PROFILES: setProfile(file.COMPOSE_PROFILES, dbProfile, others),
      COMPOSE_DATABASE_URL: COMPOSE_DBS[dbProfile].url({ POSTGRES_PASSWORD }),
      ...(dbProfile === "postgres" ? { POSTGRES_PASSWORD } : {}),
    });
    log.ok(
      `Docker will use ${COMPOSE_DBS[dbProfile].label} ${c.dim("(COMPOSE_PROFILES/COMPOSE_DATABASE_URL saved to .env)")}`,
    );
  }
  const cfg = loadConfig();
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.mkdirSync(path.resolve(ROOT, expandHome(cfg.env.WORKSPACE_DIR || "./workspace")), { recursive: true });
  if (localMounts) prepareHostMounts();
  return cfg;
}

async function composeTunnelUrl() {
  const [cmd, pre] = composeCommand();
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const out = spawnSync(cmd, [...pre, "--profile", "public", "logs", "--no-color", "tunnel"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 10_000,
    });
    const url = TRYCLOUDFLARE_URL.exec(`${out.stdout ?? ""}${out.stderr ?? ""}`)?.[0];
    if (url) return url;
    await sleep(1000);
  }
  return null;
}

async function dockerUp(values) {
  const cfg = await prepareDockerEnv(values);
  const args = [];
  const dbProfile = composeDbProfile(values);
  if (dbProfile) args.push("--profile", dbProfile);
  if (values.public) args.push("--profile", "public");
  args.push("up", "-d");
  if (values.build) args.push("--build");
  log.step("Starting AgentMan with Docker Compose");
  await compose(args);
  log.info("Waiting for the container to become healthy…");
  const health = await waitForHealth(cfg, { timeoutMs: 180_000 });
  if (!health) {
    throw new CliError(`AgentMan did not respond on ${localUrl(cfg)}.`, { hint: "Check: omp-ui docker logs" });
  }
  log.ok(`AgentMan is up in Docker ${c.dim(`(v${health.version} · ${health.db})`)}`);
  const tunnelUrl = values.public ? await composeTunnelUrl() : null;
  if (values.public && !tunnelUrl) log.warn("Tunnel URL not found yet — check: omp-ui docker logs tunnel");
  printUrls(cfg, { tunnelUrl });
  if (tunnelUrl) printSecurityReminder();
  console.log(c.bold("Next steps"));
  console.log(`  ${c.dim("·")} omp, Claude, git, gh and glab sign-ins come from this machine ${c.dim("(omp-ui doctor lists them)")}`);
  console.log(`  ${c.dim("·")} Not signed in to omp yet? ${c.cyan("omp")} here, or ${c.cyan("docker compose exec -u omp omp-ui omp")}`);
  console.log(`  ${c.dim("·")} Projects folder ${c.cyan(cfg.env.WORKSPACE_DIR || "./workspace")} is ${c.cyan("/workspace")} inside the container`);
  console.log(`  ${c.dim("·")} Logs: ${c.cyan("omp-ui docker logs")}   Stop: ${c.cyan("omp-ui docker down")}\n`);
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Quote a remote path while letting the remote shell expand a leading ~/. */
function remotePath(dir) {
  if (dir === "~") return "~";
  if (dir.startsWith("~/")) return `~/${shq(dir.slice(2))}`;
  return shq(dir);
}

async function deployRemote(values) {
  const host = values.host;
  const dir = (values.dir ?? "omp-ui").replace(/\/+$/, "") || ".";
  for (const tool of ["ssh", "rsync"]) {
    if (!which(tool)) throw new CliError(`${tool} is required for remote deploys.`);
  }
  await prepareDockerEnv(values, { localMounts: false });
  const cfg = loadConfig();
  const rdir = remotePath(dir);

  log.step(`Deploying to ${host}:${dir}`);
  await runOrFail("ssh", "ssh", [host, `mkdir -p ${rdir}`], { shell: false });
  const excludes = ["node_modules", "dist", "data", "workspace", ".git", ".next", ".vinext", "tsconfig.tsbuildinfo"];
  await runOrFail(
    "rsync",
    "rsync",
    ["-az", "--delete", ...excludes.flatMap((e) => ["--exclude", `/${e}`]), `${ROOT}/`, `${host}:${dir}/`],
    { shell: false },
  );
  log.ok("Files synced");
  const profiles = values.public ? "--profile public " : "";
  const remote = [
    `cd ${rdir}`,
    "mkdir -p data workspace ~/.omp ~/.claude ~/.config/git ~/.config/gh ~/.config/glab-cli && mkdir -p -m 700 ~/.ssh ~/.aws && touch ~/.gitconfig",
    "{ [ -e ~/.claude.json ] || echo '{}' > ~/.claude.json; } && { [ -e ~/.git-credentials ] || (umask 077 && : > ~/.git-credentials); }",
    `export WORKSPACE_DIR="$PWD/workspace"`,
    `if docker compose version >/dev/null 2>&1; then docker compose ${profiles}up -d --build; else docker-compose ${profiles}up -d --build; fi`,
  ].join(" && ");
  await runOrFail("Remote docker compose", "ssh", [host, remote], { shell: false });

  const server = host.includes("@") ? host.slice(host.indexOf("@") + 1) : host;
  log.ok("Deployed");
  console.log(`\n  ${c.green("➜")} ${c.cyan(c.bold(`http://${server}:${cfg.port}`))}\n`);
  console.log(c.bold("Next steps"));
  console.log(`  ${c.dim("·")} Sign omp in on the server (once): ${c.cyan(`ssh -t ${host} "cd ${dir} && docker compose exec -u omp omp-ui omp"`)}`);
  console.log(`  ${c.dim("·")} Put a TLS reverse proxy in front for public access (see README)`);
  if (values.public) console.log(`  ${c.dim("·")} Tunnel URL: ${c.cyan(`ssh ${host} "cd ${dir} && docker compose logs tunnel"`)}`);
  console.log("");
}

// ─── Commands ───────────────────────────────────────────────────────────────

const PORT_OPT = { type: "string", short: "p", arg: "<port>", desc: "Port to listen on (saved to .env)" };

/** Persist --port to .env so every later command agrees on the port. */
function applyPortFlag(values) {
  if (values.port === undefined) return;
  const port = String(parsePort(values.port));
  if (fs.existsSync(ENV_FILE)) {
    if (readEnvFile()?.PORT !== port) {
      updateEnvFile({ PORT: port });
      log.info(`Saved PORT=${port} to .env`);
    }
  }
}

const COMMANDS = {
  up: {
    summary: "Set everything up and start it — the only command you need",
    usage: "omp-ui up [options]",
    options: {
      password: { type: "string", arg: "<pw>", desc: "Admin password for first-run setup (or env ADMIN_PASSWORD)" },
      port: PORT_OPT,
      public: { type: "boolean", desc: "Also open a public tunnel (cloudflared/ngrok)" },
      rebuild: { type: "boolean", desc: "Force a fresh production build" },
      open: { type: "boolean", short: "o", desc: "Open the browser when ready" },
      pm2: { type: "boolean", desc: "Hand the server to pm2 (restarts on crash, can start on boot)" },
      systemd: { type: "boolean", desc: "Install it as a systemd user service (restarts on crash, starts on boot; Linux)" },
      foreground: { type: "boolean", short: "f", desc: "Stay attached instead of running in the background (used by pm2 and systemd)" },
    },
    examples: [
      "omp-ui up",
      "omp-ui up --port 8080 --public",
      "omp-ui up --pm2",
      "omp-ui up --systemd",
      "ADMIN_PASSWORD='s3cret-pass' omp-ui up",
    ],
    async run(values) {
      requireNode();
      const managers = [values.pm2 && "--pm2", values.systemd && "--systemd", values.foreground && "--foreground"].filter(Boolean);
      if (managers.length > 1) throw new CliError(`Choose only one of ${managers.join(", ")}.`);
      if (values.public && managers.length) {
        throw new CliError("--public only works in the default background mode.", {
          hint: "Open the link separately once it runs: omp-ui public",
        });
      }
      if (values.systemd) {
        assertSystemd();
        renderSystemdUnit(); // fail before building when the paths cannot go into a unit
      }
      const prevPort = fs.existsSync(ENV_FILE) ? loadConfig().port : null;
      if (prevPort !== null && !managers.length) assertNotManaged(loadConfig(), "restart");
      if (prevPort === null) {
        log.step("First run — creating .env");
        await initProject({ password: values.password, port: values.port, yes: true }, { fromUp: true });
      } else {
        applyPortFlag(values);
      }
      let cfg = loadConfig();
      await ensureDeps();

      const managed = managedServer(cfg);
      // The manager's own `up --foreground` rebuilds if needed after the restart.
      if (values.pm2 && managed?.manager === "pm2") {
        await pm2Start();
        return;
      }
      if (values.systemd && managed?.manager === "systemd") {
        await systemdInstall();
        return;
      }

      const state = values.rebuild ? "forced" : buildState();
      const runningBefore = runningPid(statePaths(cfg).pid, SERVER_MARK);
      // Under pm2/systemd, a server owned by that manager still running is a leftover of our previous incarnation.
      const allowManaged = Boolean(values.foreground && serviceManager());
      if (state !== "fresh") {
        if (runningBefore) {
          log.info(state === "stale" ? "Sources changed — rebuilding" : "Rebuilding");
          await stopServer(cfg, { allowManaged });
        }
        await buildOrKeepPrevious();
      } else if (runningBefore && prevPort !== null && cfg.port !== prevPort) {
        log.info(`Port changed — restarting on ${cfg.port}`);
        await stopServer(loadConfig({ PORT: prevPort }), { allowManaged });
      }
      cfg = loadConfig();

      if (values.pm2) {
        await pm2Start();
        return;
      }
      if (values.systemd) {
        await systemdInstall();
        return;
      }
      await ensureMemory(cfg);
      if (values.foreground) {
        await startServer(cfg, { foreground: true });
        return;
      }
      const { health } = await startServer(cfg);
      const tunnelUrl = values.public ? await tunnelStart(cfg) : tunnelInfo(cfg)?.url;
      if (!values.public) printUrls(cfg, { tunnelUrl });
      if (health && !values.public) printNextSteps();
      if (values.open) await openInBrowser(localUrl(cfg));
    },
  },

  init: {
    summary: "Answer a few questions and save the settings to .env",
    usage: "omp-ui init [options]",
    options: {
      password: { type: "string", arg: "<pw>", desc: "Admin password (min 8 chars)" },
      port: { type: "string", short: "p", arg: "<port>", desc: "Port (default 3000)" },
      db: { type: "string", arg: "<sqlite|mongodb|postgres>", desc: "Database driver (default sqlite)" },
      "db-url": { type: "string", arg: "<url>", desc: "Database URL (mongodb://… or postgres://…; implies --db)" },
      "mongo-url": { type: "string", arg: "<url>", desc: "Alias of --db-url for MongoDB" },
      "data-dir": { type: "string", arg: "<dir>", desc: "Data directory (default ./data)" },
      "omp-path": { type: "string", arg: "<path>", desc: "omp executable (default: omp on PATH)" },
      "max-agents": { type: "string", arg: "<n|auto>", desc: "Max concurrent agents (default auto: from CPU cores and free memory)" },
      workspace: { type: "string", arg: "<dir>", desc: "Projects folder (default ~/omp-workspace)" },
      yes: { type: "boolean", short: "y", desc: "Accept defaults for anything not given" },
      force: { type: "boolean", desc: "Redo setup on an existing .env (unchanged values are kept)" },
    },
    examples: [
      "omp-ui init",
      "omp-ui init --password 'long-secret' --yes",
      "omp-ui init --db postgres --db-url postgres://user:pass@localhost:5432/omp_ui",
      "omp-ui init --db mongodb --db-url mongodb://localhost:27017/omp_ui",
    ],
    async run(values) {
      await initProject(values);
    },
  },

  start: {
    summary: "Start the server in the background",
    usage: "omp-ui start [options]",
    options: {
      port: PORT_OPT,
      foreground: { type: "boolean", short: "f", desc: "Run attached to this terminal" },
    },
    async run(values) {
      applyPortFlag(values);
      const cfg = loadConfig({ PORT: values.port });
      const result = await startServer(cfg, { foreground: values.foreground });
      if (!result.foreground) printUrls(cfg, { tunnelUrl: tunnelInfo(cfg)?.url });
    },
  },

  stop: {
    summary: "Stop the server (and the public link, if any)",
    usage: "omp-ui stop",
    options: {},
    async run() {
      const cfg = loadConfig();
      assertNotManaged(cfg, "stop");
      await tunnelStop(cfg, { quiet: true });
      await stopServer(cfg);
    },
  },

  restart: {
    summary: "Restart the server (rebuilds first when the sources changed)",
    usage: "omp-ui restart [options]",
    options: {
      port: PORT_OPT,
      rebuild: { type: "boolean", desc: "Force a fresh production build" },
    },
    async run(values) {
      const before = loadConfig();
      assertNotManaged(before, "restart");
      applyPortFlag(values);
      await stopServer(before);
      const state = values.rebuild ? "forced" : buildState();
      if (state !== "fresh") {
        log.info(state === "stale" ? "Sources changed — rebuilding" : state === "missing" ? "No build found — building" : "Rebuilding");
        await buildOrKeepPrevious();
      }
      const cfg = loadConfig();
      if (cfg.port !== before.port && tunnelInfo(before)) {
        log.warn("Port changed — stopping the public tunnel (restart it with: omp-ui public)");
        await tunnelStop(before, { quiet: true });
      }
      await startServer(cfg);
      printUrls(cfg, { tunnelUrl: tunnelInfo(cfg)?.url });
    },
  },

  status: {
    summary: "Is it running? Shows the links, uptime and health",
    usage: "omp-ui status [--json]",
    options: { json: { type: "boolean", desc: "Print machine-readable JSON" } },
    async run(values) {
      const cfg = loadConfig();
      const paths = statePaths(cfg);
      const pid = runningPid(paths.pid, SERVER_MARK);
      let startedAt = null;
      if (pid) {
        try {
          startedAt = fs.statSync(paths.pid).mtime;
        } catch {
          // pid file vanished
        }
      }
      const health = await getHealth(cfg);
      const tunnel = tunnelInfo(cfg);
      if (values.json) {
        console.log(
          JSON.stringify(
            {
              running: Boolean(pid),
              pid,
              managedBy: pid ? serverOwner(cfg) : null,
              startedAt: startedAt?.toISOString() ?? null,
              url: localUrl(cfg),
              lan: lanUrls(cfg),
              health,
              tunnel,
            },
            null,
            2,
          ),
        );
      } else {
        const row = (k, v) => console.log(`  ${c.dim(k.padEnd(9))}${v}`);
        const owner = pid ? serverOwner(cfg) : null;
        const manager = SERVICE_MANAGERS.has(owner) ? owner : null;
        const state = pid
          ? `${c.green(manager ? `● running under ${manager}` : "● running")} ${c.dim(`pid ${pid}${startedAt ? ` · up ${formatDuration(Date.now() - startedAt.getTime())}` : ""}`)}`
          : health
            ? `${c.yellow("● running elsewhere")} ${c.dim("(not started by this CLI, e.g. Docker)")}`
            : c.red("● stopped");
        console.log(`\n${c.bold("AgentMan")}  ${state}`);
        row("URL", c.cyan(localUrl(cfg)));
        for (const url of lanUrls(cfg)) row("Network", c.cyan(url));
        if (health) {
          const a = health.agents ?? { running: [], queued: [] };
          row("Health", `${c.green("ok")} ${c.dim(`v${health.version} · ${health.db} · agents ${a.running?.length ?? 0} running, ${a.queued?.length ?? 0} queued`)}`);
          row("", c.dim(JSON.stringify(health)));
        } else {
          row("Health", c.red("unreachable"));
        }
        row("Public", tunnel?.url ? c.magenta(tunnel.url) : c.dim("off (omp-ui public)"));
        const logs = {
          pm2: `${rel(PM2_OUT_LOG)} (omp-ui pm2 logs)`,
          systemd: `journalctl --user -u ${SYSTEMD_UNIT} (omp-ui systemd logs)`,
        };
        row("Logs", c.dim(logs[manager] ?? rel(paths.log)));
        if (manager) row("Manage", c.dim(`omp-ui ${manager} stop | restart | logs | status`));
        console.log("");
      }
      if (!pid && !health) process.exitCode = 3;
    },
  },

  logs: {
    summary: "Show the server log",
    usage: "omp-ui logs [-f] [-n <lines>]",
    options: {
      follow: { type: "boolean", short: "f", desc: "Keep printing new lines" },
      lines: { type: "string", short: "n", arg: "<lines>", desc: "Number of lines to show (default 100)" },
    },
    async run(values) {
      const cfg = loadConfig();
      const file = statePaths(cfg).log;
      const n = Number(values.lines ?? 100);
      if (!Number.isInteger(n) || n < 0) throw new CliError(`Invalid line count "${values.lines}".`);
      if (!fs.existsSync(file)) {
        throw new CliError(`No log file yet (${rel(file)}).`, { hint: "Start the server: omp-ui up" });
      }
      process.stdout.write(tailLines(file, n));
      if (!values.follow) return;
      let pos = fs.statSync(file).size;
      for (;;) {
        await sleep(500);
        let size;
        try {
          size = fs.statSync(file).size;
        } catch {
          continue;
        }
        if (size < pos) pos = 0; // rotated or truncated
        if (size === pos) continue;
        const fd = fs.openSync(file, "r");
        try {
          const buf = Buffer.alloc(size - pos);
          fs.readSync(fd, buf, 0, buf.length, pos);
          process.stdout.write(buf);
        } finally {
          fs.closeSync(fd);
        }
        pos = size;
      }
    },
  },

  dev: {
    summary: "Run in development mode with live reload",
    usage: "omp-ui dev [options]",
    options: { port: { type: "string", short: "p", arg: "<port>", desc: "Port (default: PORT from .env)" } },
    async run(values) {
      requireNode();
      await ensureDeps();
      const cfg = loadConfig({ PORT: values.port });
      if (!cfg.hasEnvFile) log.warn("No .env found — running with defaults. Create one with: omp-ui init");
      await assertPortFree(cfg);
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      const env = { ...cfg.env, PORT: String(cfg.port), HOST: cfg.host };
      delete env.NODE_ENV;
      const hostArg = WILDCARD_HOSTS.has(cfg.host) ? "0.0.0.0" : cfg.host;
      process.exitCode = await run(
        process.execPath,
        [VITE_BIN, "dev", "--port", String(cfg.port), "--strictPort", "--host", hostArg],
        { env, shell: false },
      );
    },
  },

  build: {
    summary: "Build the app (up does this for you)",
    usage: "omp-ui build",
    options: {},
    async run() {
      await buildApp();
      const cfg = loadConfig();
      if (runningPid(statePaths(cfg).pid, SERVER_MARK)) log.info(`Apply it with: ${c.cyan("omp-ui restart")}`);
    },
  },

  open: {
    summary: "Open AgentMan in your browser",
    usage: "omp-ui open [--public]",
    options: { public: { type: "boolean", desc: "Open the public tunnel URL instead" } },
    async run(values) {
      const cfg = loadConfig();
      let url = localUrl(cfg);
      if (values.public) {
        url = tunnelInfo(cfg)?.url;
        if (!url) throw new CliError("No public tunnel is running.", { hint: "Start one: omp-ui public" });
      } else if (!(await getHealth(cfg))) {
        log.warn(`Nothing answers at ${url} yet — start it with: omp-ui up`);
      }
      if (await openInBrowser(url)) log.ok(`Opened ${c.cyan(url)}`);
      else log.info(`Open this URL: ${c.cyan(url)}`);
    },
  },

  passwd: {
    summary: "Change the admin password",
    usage: "omp-ui passwd [password]",
    positionals: true,
    options: {},
    description:
      "Updates ADMIN_PASSWORD in .env; it is applied at the next boot and signs out every existing session.\nOmit the argument to be prompted (hidden) — or pipe it: echo 'new-pass' | omp-ui passwd",
    async run(_values, positionals) {
      if (!fs.existsSync(ENV_FILE)) throw new CliError("No .env found.", { hint: "Run: omp-ui init  (or: omp-ui up)" });
      if (positionals.length > 1) throw new CliError("Too many arguments — quote passwords that contain spaces.");
      let pw = positionals[0];
      if (pw === undefined) pw = isInteractive() ? await askNewPassword("New admin password") : await readStdinLine();
      validatePassword(pw);
      updateEnvFile({ ADMIN_PASSWORD: pw });
      log.ok("Admin password saved to .env");
      const cfg = loadConfig();
      const managed = managedServer(cfg);
      if (managed) {
        log.info(`Restarting under ${managed.manager} to apply it…`);
        if (managed.manager === "pm2") await pm2(["restart", PM2_APP]);
        else await systemctl(["restart", SYSTEMD_UNIT]);
        await waitForHealth(cfg, { timeoutMs: 120_000 });
        log.ok("New password is active — all previous sessions were signed out");
      } else if (runningPid(statePaths(cfg).pid, SERVER_MARK)) {
        log.info("Restarting to apply it…");
        await stopServer(cfg);
        await startServer(cfg);
        log.ok("New password is active — all previous sessions were signed out");
      } else {
        log.hint("Applied at next boot: omp-ui restart  (Docker: omp-ui docker up)");
      }
    },
  },

  public: {
    summary: "Get a public https link to use it from anywhere",
    usage: "omp-ui public [start|stop|status]",
    positionals: true,
    options: {},
    description:
      "Prefers cloudflared (free quick tunnel, https://<random>.trycloudflare.com), falls back to ngrok.\nThe URL changes every time the tunnel starts. `omp-ui stop` also closes the tunnel.",
    async run(_values, positionals) {
      const action = positionals[0] ?? "start";
      const cfg = loadConfig();
      if (action === "start") await tunnelStart(cfg);
      else if (action === "stop") await tunnelStop(cfg);
      else if (action === "status") {
        const t = tunnelInfo(cfg);
        if (t) console.log(`${c.green("● public")} ${c.magenta(t.url ?? "(URL unknown)")} ${c.dim(`pid ${t.pid}`)}`);
        else {
          console.log(c.dim("● not public (start with: omp-ui public)"));
          process.exitCode = 3;
        }
      } else throw new CliError(`Unknown action "${action}".`, { hint: "Use: omp-ui public [start|stop|status]" });
    },
  },

  pm2: {
    summary: "Keep it running with pm2 (restarts on crash, starts on boot)",
    usage: "omp-ui pm2 [start|stop|restart|logs|status|save|startup|delete]",
    positionals: true,
    options: {
      lines: { type: "string", short: "n", arg: "<lines>", desc: "Lines of history (logs, default 100)" },
      rebuild: { type: "boolean", desc: "Stop, force a fresh production build, then start (restart)" },
    },
    description:
      "Uses pm2 if installed, otherwise `npx -y pm2`. Config: ecosystem.config.cjs.\nLogs: data/pm2-out.log and data/pm2-error.log. Without an action: status.",
    examples: ["omp-ui pm2 start", "omp-ui pm2 restart --rebuild", "omp-ui pm2 logs", "omp-ui pm2 save && omp-ui pm2 startup"],
    async run(values, positionals) {
      const [action = "status", ...rest] = positionals;
      switch (action) {
        case "start":
          return pm2Start();
        case "restart":
          if (values.rebuild) {
            // Stop first: building over dist/ breaks the running server's lazily loaded chunks.
            await pm2(["stop", PM2_APP]);
            await buildOrKeepPrevious();
          }
          // On a stopped app pm2 restart starts it; `up --foreground` then finds the build fresh.
          await pm2(["restart", PM2_APP]);
          return pm2WaitAndReport();
        case "stop":
          return pm2(["stop", PM2_APP]);
        case "delete":
          return pm2(["delete", PM2_APP]);
        case "logs":
          return pm2(["logs", PM2_APP, "--lines", String(values.lines ?? 100), ...rest]);
        case "status": {
          await pm2(["describe", PM2_APP], { allowFail: true });
          const health = await getHealth(loadConfig());
          console.log(health ? `${c.green("✓")} Healthy ${c.dim(`v${health.version} · ${health.db}`)}` : `${c.red("✗")} Not answering at ${localUrl(loadConfig())}`);
          return;
        }
        case "save":
          await pm2(["save"]);
          log.hint("Restored at boot once `omp-ui pm2 startup` is set up.");
          return;
        case "startup": {
          if (!which("pm2")) {
            throw new CliError("Starting on boot needs pm2 installed globally.", { hint: "Install it: npm i -g pm2 — then: omp-ui pm2 startup" });
          }
          if (!IS_WIN && process.getuid?.() === 0) {
            log.info(`Run this yourself to register pm2 at boot: ${c.cyan("pm2 startup && pm2 save")}`);
            return;
          }
          // As a normal user pm2 only prints the (sudo) command to run — it changes nothing itself.
          await pm2(["startup"], { allowFail: true });
          log.hint("Run the command printed above, then: omp-ui pm2 save");
          return;
        }
        default:
          throw new CliError(`Unknown pm2 action "${action}".`, {
            hint: "Use: omp-ui pm2 [start|stop|restart|logs|status|save|startup|delete]",
          });
      }
    },
  },

  systemd: {
    summary: "Run it as a systemd user service (restarts on crash, starts on boot; Linux)",
    usage: SYSTEMD_USAGE,
    positionals: true,
    options: {
      lines: { type: "string", short: "n", arg: "<lines>", desc: "Lines of history (logs, default 100)" },
      follow: { type: "boolean", short: "f", desc: "Keep printing new lines (logs)" },
      rebuild: { type: "boolean", desc: "Stop, force a fresh production build, then start (restart)" },
    },
    description: [
      "install    Write ~/.config/systemd/user/omp-ui.service from omp-ui.service, enable and start it,",
      "           and enable lingering so it starts at boot without a login. Rerun after moving node.",
      "uninstall  Stop and disable the service and delete the unit.",
      "start      systemctl --user start omp-ui.service (stops a server started by `omp-ui up` first).",
      "stop       systemctl --user stop omp-ui.service.",
      "restart    systemctl --user restart omp-ui.service (--rebuild: stop, build, start).",
      "status     systemctl --user status omp-ui.service plus a health check. Default action.",
      "logs       journalctl --user -u omp-ui.service (-n <lines>, -f to follow).",
      "unit       Print the rendered unit, to review or install by hand.",
      "The service runs `omp-ui up --foreground`: it rebuilds when the sources changed, and bin/supervisor.mjs",
      "restarts a server that crashes or stops answering /api/v1/health.",
    ].join("\n"),
    examples: [
      "omp-ui systemd install",
      "omp-ui systemd restart --rebuild",
      "omp-ui systemd logs -f",
      "omp-ui systemd unit > ~/.config/systemd/user/omp-ui.service",
    ],
    async run(values, positionals) {
      const [action = "status"] = positionals;
      if (action === "unit") {
        process.stdout.write(renderSystemdUnit());
        return;
      }
      if (!["install", "uninstall", "start", "stop", "restart", "status", "logs"].includes(action)) {
        throw new CliError(`Unknown systemd action "${action}".`, { hint: `Use: ${SYSTEMD_USAGE}` });
      }
      assertSystemd();
      switch (action) {
        case "install":
          return systemdInstall();
        case "uninstall":
          return systemdUninstall();
        case "start":
          assertSystemdInstalled();
          await systemdTakeOver();
          await systemctl(["start", SYSTEMD_UNIT]);
          return systemdWaitAndReport();
        case "restart":
          assertSystemdInstalled();
          await systemdTakeOver();
          if (values.rebuild) {
            // Stop first: building over dist/ breaks the running server's lazily loaded chunks.
            await systemctl(["stop", SYSTEMD_UNIT]);
            await buildOrKeepPrevious();
            await systemctl(["start", SYSTEMD_UNIT]);
          } else {
            // `up --foreground` rebuilds on start when the sources changed.
            await systemctl(["restart", SYSTEMD_UNIT]);
          }
          return systemdWaitAndReport();
        case "stop":
          assertSystemdInstalled();
          return systemctl(["stop", SYSTEMD_UNIT]);
        case "logs": {
          const n = Number(values.lines ?? 100);
          if (!Number.isInteger(n) || n < 0) throw new CliError(`Invalid line count "${values.lines}".`);
          const code = await run("journalctl", ["--user", "-u", SYSTEMD_UNIT, "-n", String(n), "--no-pager", ...(values.follow ? ["-f"] : [])]);
          if (code !== 0) process.exitCode = code;
          return;
        }
        default: {
          if (!fs.existsSync(systemdUnitPath())) log.hint("Not installed — install it with: omp-ui systemd install");
          await systemctl(["status", "--no-pager", SYSTEMD_UNIT], { allowFail: true });
          const cfg = loadConfig();
          const health = await getHealth(cfg);
          console.log(health ? `${c.green("✓")} Healthy ${c.dim(`v${health.version} · ${health.db}`)}` : `${c.red("✗")} Not answering at ${localUrl(cfg)}`);
          return;
        }
      }
    },
  },

  docker: {
    summary: "Run it in Docker: up, down, logs, build, ps",
    usage: "omp-ui docker <up|down|logs|build|ps> [options] [services…]",
    positionals: true,
    options: {
      mongo: { type: "boolean", desc: "Use the bundled MongoDB service (saved to .env as COMPOSE_PROFILES)" },
      postgres: { type: "boolean", desc: "Use the bundled PostgreSQL service (saved to .env as COMPOSE_PROFILES)" },
      public: { type: "boolean", desc: "Also run the cloudflared tunnel service (up)" },
      build: { type: "boolean", desc: "Rebuild the image before starting (up)" },
      password: { type: "string", arg: "<pw>", desc: "Admin password when .env does not exist yet (up)" },
      follow: { type: "boolean", short: "f", desc: "Follow log output (logs)" },
      lines: { type: "string", short: "n", arg: "<lines>", desc: "Lines of history (logs, default 200)" },
    },
    examples: [
      "omp-ui docker up",
      "omp-ui docker up --postgres --build",
      "omp-ui docker up --mongo",
      "omp-ui docker logs -f omp-ui",
      "omp-ui docker down",
    ],
    async run(values, positionals) {
      const [sub, ...services] = positionals;
      const allProfiles = ["mongo", "postgres", "public"].flatMap((p) => ["--profile", p]);
      switch (sub) {
        case "up":
          return dockerUp(values);
        case "down":
          return compose([...allProfiles, "down", ...services]);
        case "logs":
          return compose([
            ...allProfiles,
            "logs",
            "--tail",
            String(values.lines ?? 200),
            ...(values.follow ? ["--follow"] : []),
            ...services,
          ]);
        case "build":
          if (composeDbProfile(values)) await prepareDockerEnv(values);
          return compose(["build", ...services]);
        case "ps":
          return compose([...allProfiles, "ps", ...services]);
        default:
          throw new CliError(sub ? `Unknown docker command "${sub}".` : "Missing docker command.", {
            hint: "Use: omp-ui docker <up|down|logs|build|ps>",
          });
      }
    },
  },

  deploy: {
    summary: "Put it on a server (Docker over ssh)",
    usage: "omp-ui deploy [--host user@server] [--dir path]",
    options: {
      host: { type: "string", arg: "<user@server>", desc: "SSH target; omit to deploy on this machine" },
      dir: { type: "string", arg: "<path>", desc: "Remote directory (default ~/omp-ui)" },
      mongo: { type: "boolean", desc: "Use the bundled MongoDB service" },
      postgres: { type: "boolean", desc: "Use the bundled PostgreSQL service" },
      public: { type: "boolean", desc: "Also run the cloudflared tunnel service" },
      password: { type: "string", arg: "<pw>", desc: "Admin password when .env does not exist yet" },
    },
    description:
      "Without --host: same as `omp-ui docker up --build`.\nWith --host: rsyncs the project (minus node_modules, dist, data, workspace, .git — .env included)\nto the server and runs `docker compose up -d --build` there. The server needs Docker + rsync.",
    examples: [
      "omp-ui deploy",
      "omp-ui deploy --host root@203.0.113.10",
      "omp-ui deploy --host me@box --dir /srv/omp-ui --postgres",
    ],
    async run(values) {
      if (values.host) return deployRemote(values);
      return dockerUp({ ...values, build: true });
    },
  },

  doctor: {
    summary: "Check that everything is installed and working",
    usage: "omp-ui doctor",
    options: {},
    async run() {
      let failures = 0;
      const row = (status, label, detail = "") => {
        const icon = { ok: c.green("✓"), warn: c.yellow("!"), fail: c.red("✗"), info: c.dim("·") }[status];
        if (status === "fail") failures++;
        console.log(`${icon} ${label.padEnd(16)} ${detail}`);
      };
      console.log(`\n${c.bold("omp-ui doctor")} ${c.dim(ROOT)}\n`);

      row(NODE_MAJOR >= MIN_NODE ? "ok" : "fail", "Node.js", NODE_MAJOR >= MIN_NODE ? `v${process.versions.node}` : `v${process.versions.node} — need ${MIN_NODE}+ (https://nodejs.org)`);

      const cfg = loadConfig();
      if (cfg.hasEnvFile) {
        const mode = fs.statSync(ENV_FILE).mode & 0o777;
        row(!IS_WIN && mode & 0o077 ? "warn" : "ok", ".env", !IS_WIN && mode & 0o077 ? `readable by others (mode ${mode.toString(8)}) — chmod 600 .env` : rel(ENV_FILE));
        row(cfg.file.ADMIN_PASSWORD ? "ok" : "warn", "Admin password", cfg.file.ADMIN_PASSWORD ? "set in .env" : "not in .env — set one: omp-ui passwd");
      } else {
        row("warn", ".env", "missing — run: omp-ui init (or omp-ui up)");
      }

      const ompPath = cfg.env.OMP_PATH || "omp";
      const omp = resolveOmp(ompPath);
      if (!omp) row("fail", "omp", `not found (${ompPath}) — install: ${OMP_INSTALL_CMD}`);
      else {
        const v = capture(omp.path, ["--version"]);
        if (!omp.onPath) row("warn", "omp", `${v ?? "installed"} at ${omp.path} — not on PATH; set OMP_PATH=${omp.path} in .env`);
        else row(v ? "ok" : "warn", "omp", v ? `${v} ${c.dim(omp.path)}` : `${omp.path} did not answer --version`);
      }
      const ompAgentDir = path.join(os.homedir(), ".omp", "agent");
      row(fs.existsSync(ompAgentDir) ? "ok" : "warn", "omp config", fs.existsSync(ompAgentDir) ? ompAgentDir : "~/.omp/agent missing — run `omp` once and sign in to a provider");

      const git = toolVersion("git");
      row(git ? "ok" : "fail", "git", git ?? "not found — install git (needed for Clone, PR/MR and Push)");
      const gh = toolVersion("gh");
      if (!gh) row("info", "GitHub CLI", c.dim("gh not installed (optional, for GitHub PRs) — https://cli.github.com"));
      else {
        const authed = Boolean(cfg.env.GH_TOKEN || cfg.env.GITHUB_TOKEN) || spawnSync("gh", ["auth", "status"], { stdio: "ignore", timeout: 15_000 }).status === 0;
        row(authed ? "ok" : "warn", "GitHub CLI", authed ? `${gh} · signed in` : `${gh} · not signed in — run: gh auth login (or set GH_TOKEN)`);
      }
      const glab = toolVersion("glab");
      if (!glab) row("info", "GitLab CLI", c.dim("glab not installed (optional, for GitLab MRs) — https://gitlab.com/gitlab-org/cli"));
      else {
        const authed = Boolean(cfg.env.GITLAB_TOKEN) || spawnSync("glab", ["auth", "status"], { stdio: "ignore", timeout: 15_000 }).status === 0;
        row(authed ? "ok" : "warn", "GitLab CLI", authed ? `${glab} · signed in` : `${glab} · not signed in — run: glab auth login (or set GITLAB_TOKEN)`);
      }
      const workspace = path.resolve(ROOT, expandHome(cfg.env.WORKSPACE_DIR || path.join(os.homedir(), "omp-workspace")));
      row(fs.existsSync(workspace) ? "ok" : "warn", "Projects folder", fs.existsSync(workspace) ? workspace : `${workspace} missing — it is created on first use`);

      const pm2Global = toolVersion("pm2");
      row(pm2Global || which("npx") ? "ok" : "info", "pm2", pm2Global ? `v${pm2Global}` : which("npx") ? c.dim("not installed globally — `npx -y pm2` is used (npm i -g pm2 for boot start)") : c.dim("not installed (optional) — npm i -g pm2"));

      const pnpm = toolVersion("pnpm");
      row(pnpm ? "ok" : "info", "pnpm", pnpm ? `v${pnpm}` : c.dim("not found (corepack/npm used instead)"));
      row(depsInstalled() ? "ok" : "warn", "Dependencies", depsInstalled() ? "installed" : "missing — omp-ui up installs them");
      const build = buildState();
      row(build === "fresh" ? "ok" : "warn", "Build", build === "fresh" ? "up to date" : build === "stale" ? "outdated — omp-ui up rebuilds" : "missing — omp-ui up builds it");
      const docker = toolVersion("docker");
      row(docker ? "ok" : "info", "Docker", docker ?? c.dim("not installed (optional)"));
      const cloudflared = toolVersion("cloudflared");
      const ngrok = toolVersion("ngrok", ["version"]);
      row(cloudflared || ngrok ? "ok" : "info", "Tunnel tool", cloudflared ?? ngrok ?? c.dim(`none (optional) — ${CLOUDFLARED_DOWNLOADS}`));

      const pid = runningPid(statePaths(cfg).pid, SERVER_MARK);
      const health = await getHealth(cfg);
      if (pid || health) {
        row("ok", "Port", `${cfg.port} in use by AgentMan`);
      } else {
        const port = await portStatus(cfg.port, cfg.host);
        row(port === "free" ? "ok" : "fail", "Port", port === "free" ? `${cfg.port} free` : `${cfg.port} ${port === "denied" ? "not permitted" : "in use by another process"} — change PORT in .env`);
      }
      if (health) {
        const by = pid ? serverOwner(cfg) : null;
        const owner = pid ? (SERVICE_MANAGERS.has(by) ? `pid ${pid} under ${by}` : `pid ${pid}`) : "running (external/Docker)";
        row("ok", "Server", `${owner} · v${health.version} · ${localUrl(cfg)}`);
        row("ok", "Database", `${health.db} reachable`);
      } else if (pid) {
        row("fail", "Server", `pid ${pid} is running but /api/v1/health does not answer — omp-ui logs`);
        row("fail", "Database", "unknown (server unhealthy)");
      } else {
        row("info", "Server", c.dim("not running — omp-ui up"));
        row("info", "Database", c.dim(`${dbKindFromUrl(cfg.env.DATABASE_URL)} (checked when the server runs)`));
      }
      const tunnel = tunnelInfo(cfg);
      row(tunnel ? "ok" : "info", "Public tunnel", tunnel ? (tunnel.url ?? `pid ${tunnel.pid}`) : c.dim("off"));

      console.log(`\n${c.bold("Credentials")} ${c.dim("inherited from this machine by the server, its agents and Docker (values never shown)")}`);
      const home = os.homedir();
      const providers = omp ? ompProviders(omp.path) : null;
      if (providers?.length) row("ok", "omp sign-in", providers.join(", "));
      else if (omp) row("info", "omp sign-in", c.dim("no subscription sign-in reported by `omp usage` (API keys below also work)"));

      const claude = [
        hasContent(path.join(home, ".claude")) && "~/.claude",
        hasContent(path.join(home, ".claude.json")) && "~/.claude.json",
        ...["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => cfg.env[k]),
      ].filter(Boolean);
      row(claude.length ? "ok" : "info", "Claude", claude.length ? claude.join(", ") : c.dim("no ~/.claude, ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (optional)"));

      const envKeys = CREDENTIAL_ENV_KEYS.filter((k) => cfg.env[k]);
      row(envKeys.length ? "ok" : "info", "Env credentials", envKeys.length ? envKeys.join(", ") : c.dim("none set (omp, gh and glab sign-ins are enough)"));

      if (git) {
        const name = capture("git", ["config", "--get", "user.name"], { cwd: home });
        const email = capture("git", ["config", "--get", "user.email"], { cwd: home });
        row(name && email ? "ok" : "warn", "Git identity", name && email ? `${name} <${email}>` : 'user.name/user.email not set — git config --global user.name "…" (and user.email)');
        // Only the helper's command name (e.g. "store", "gh", "osxkeychain"), never its arguments.
        const helpers = (capture("git", ["config", "--get-regexp", "^credential\\..*helper$"], { cwd: home, shell: false }) ?? "")
          .split("\n")
          .map((line) => {
            const space = line.indexOf(" ");
            return space < 0 ? "" : line.slice(space + 1).trim().replace(/^!\s*/, "").split(/\s+/)[0];
          })
          .filter(Boolean)
          .map((h) => path.basename(h));
        const gitCreds = [...new Set(helpers)].map((h) => `helper ${h}`);
        if (hasContent(path.join(home, ".git-credentials"))) gitCreds.push("~/.git-credentials");
        row(gitCreds.length ? "ok" : "info", "Git credentials", gitCreds.length ? gitCreds.join(", ") : c.dim("no credential helper or ~/.git-credentials (SSH keys or GH_TOKEN/GITLAB_TOKEN also work)"));
      }

      const ssh = [];
      let sshUsable = false;
      if (cfg.env.SSH_AUTH_SOCK && which("ssh-add")) {
        const r = spawnSync("ssh-add", ["-l"], { encoding: "utf8", timeout: 5000, env: cfg.env });
        const keys = `${r.stdout ?? ""}`.split("\n").filter(Boolean).length;
        if (r.status === 0) ssh.push(`agent with ${keys} key${keys === 1 ? "" : "s"}`);
        else if (r.status === 1) ssh.push("agent (no keys loaded)");
        else ssh.push("agent not reachable");
        sshUsable ||= r.status === 0;
      }
      let keyFiles = [];
      try {
        keyFiles = fs.readdirSync(path.join(home, ".ssh")).filter((f) => /^id_[^.]+$/.test(f));
      } catch {
        // no ~/.ssh
      }
      if (keyFiles.length) ssh.push(`~/.ssh/${keyFiles.join(", ~/.ssh/")}`);
      sshUsable ||= keyFiles.length > 0;
      row(sshUsable ? "ok" : "info", "SSH", ssh.length ? ssh.join(", ") : c.dim("no ssh-agent or ~/.ssh/id_* keys (needed only for SSH remotes)"));

      console.log("");
      if (failures) {
        log.error(`${failures} problem${failures > 1 ? "s" : ""} found`);
        process.exitCode = 1;
      } else {
        log.ok("All good");
      }
    },
  },

  version: {
    summary: "Print the version",
    usage: "omp-ui version",
    options: {},
    async run() {
      console.log(`omp-ui ${packageVersion()} ${c.dim(`(node ${process.versions.node})`)}`);
    },
  },
};

// ─── Help ───────────────────────────────────────────────────────────────────

function printMainHelp() {
  const groups = [
    ["Start", ["up", "init", "start", "stop", "restart", "status", "logs", "open"]],
    ["Configure", ["passwd", "public", "doctor"]],
    ["Deploy", ["pm2", "systemd", "docker", "deploy"]],
    ["Develop", ["dev", "build", "version"]],
  ];
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length)) + 2;
  console.log(`\n${c.bold("omp-ui")} ${c.dim(packageVersion())} — kanban board for omp coding agents\n`);
  console.log(`${c.bold("Usage")}\n  omp-ui <command> [options]\n`);
  for (const [title, names] of groups) {
    console.log(c.bold(title));
    for (const name of names) console.log(`  ${c.cyan(name.padEnd(width))}${COMMANDS[name].summary}`);
    console.log("");
  }
  console.log(`${c.bold("Quick start")}\n  ${c.cyan("./omp-ui up")}   ${c.dim("set up, install, build, start — prints the URL")}\n`);
  console.log(c.dim("Run `omp-ui <command> --help` for details. Config: .env · state & logs: DATA_DIR (./data)\n"));
}

function printCommandHelp(name) {
  const cmd = COMMANDS[name];
  console.log(`\n${c.bold(`omp-ui ${name}`)} — ${cmd.summary}\n`);
  console.log(`${c.bold("Usage")}\n  ${cmd.usage}\n`);
  if (cmd.description) console.log(`${cmd.description.split("\n").map((l) => `  ${l}`).join("\n")}\n`);
  const opts = Object.entries({ ...cmd.options, help: { type: "boolean", short: "h", desc: "Show this help" } }).map(
    ([long, o]) => [`${o.short ? `-${o.short}, ` : "    "}--${long}${o.arg ? ` ${o.arg}` : ""}`, o.desc],
  );
  const width = Math.max(...opts.map(([flag]) => flag.length)) + 2;
  console.log(c.bold("Options"));
  for (const [flag, desc] of opts) console.log(`  ${c.cyan(flag.padEnd(width))}${desc}`);
  if (cmd.examples?.length) {
    console.log(`\n${c.bold("Examples")}`);
    for (const ex of cmd.examples) console.log(`  ${c.dim("$")} ${ex}`);
  }
  console.log("");
}

// ─── Entry ──────────────────────────────────────────────────────────────────

async function main(argv) {
  let [name, ...rest] = argv;
  if (name === "-v" || name === "--version") name = "version";
  if (!name || name === "-h" || name === "--help" || name === "help") {
    if (rest[0] && COMMANDS[rest[0]]) printCommandHelp(rest[0]);
    else printMainHelp();
    return;
  }
  const cmd = COMMANDS[name];
  if (!cmd) throw new CliError(`Unknown command "${name}".`, { hint: "See: omp-ui --help" });

  const options = { help: { type: "boolean", short: "h" } };
  for (const [long, o] of Object.entries(cmd.options)) {
    options[long] = o.short ? { type: o.type, short: o.short } : { type: o.type };
  }
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options, allowPositionals: Boolean(cmd.positionals), strict: true });
  } catch (err) {
    throw new CliError(err.message, { hint: `See: omp-ui ${name} --help` });
  }
  if (parsed.values.help) {
    printCommandHelp(name);
    return;
  }
  await cmd.run(parsed.values, parsed.positionals);
}

main(process.argv.slice(2)).then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    if (err instanceof CliError) {
      log.error(err.message);
      if (err.hint) for (const line of err.hint.split("\n")) console.error(`  ${c.dim(line.trim())}`);
      process.exit(err.exitCode);
    }
    log.error(err?.stack ?? String(err));
    process.exit(1);
  },
);
