// Helpers for exercising bin/omp-ui.mjs end to end against throwaway project directories.
//
// The CLI locates its project root from its own path (`<bin>/..`), never from cwd. Each test project
// therefore gets its own copy of bin/omp-ui.mjs + package.json, with `dist` and `node_modules`
// symlinked to the real repo, so `.env`, `data/` (pid, log, sqlite) and the workspace all live in a
// temp dir and the real repo state is never touched.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const CLI_SOURCE = path.join(REPO_ROOT, "bin", "omp-ui.mjs");
export const WRAPPER_SOURCE = path.join(REPO_ROOT, "omp-ui");
export const SUPERVISOR_SOURCE = path.join(REPO_ROOT, "bin", "supervisor.mjs");
export const STANDALONE_SERVER = path.join(REPO_ROOT, "dist", "standalone", "server.js");
export const PACKAGE_VERSION: string = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
).version;

/** Every command the CLI advertises in `omp-ui --help`. */
export const COMMANDS = [
  "up",
  "init",
  "start",
  "stop",
  "restart",
  "status",
  "logs",
  "open",
  "passwd",
  "public",
  "doctor",
  "docker",
  "deploy",
  "dev",
  "build",
  "version",
] as const;

/** Version line printed by the fake omp executable created in every project. */
export const FAKE_OMP_VERSION = "omp 0.0.0-cli-test";

// Long enough for a cold server boot (start/passwd/restart/up wait for /api/v1/health).
export const LIFECYCLE_TIMEOUT = 150_000;

export interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** stdout followed by stderr (relative order between the two streams is not preserved). */
  output: string;
}

export interface RunOptions {
  /** Written to the CLI's stdin, which is then closed (stdin is never a TTY). */
  input?: string;
  /** Extra environment variables layered over the project's isolated environment. */
  env?: Record<string, string>;
  /** Working directory; defaults to the project root. */
  cwd?: string;
  timeoutMs?: number;
}

export interface TempProject {
  root: string;
  /** Isolated HOME (the CLI defaults WORKSPACE_DIR to ~/omp-workspace). */
  home: string;
  envFile: string;
  dataDir: string;
  pidFile: string;
  logFile: string;
  /** Executable stand-in for omp that only answers --version. */
  fakeOmp: string;
  /** Path of the copied CLI inside the project. */
  cli: string;
  /** Path of the copied ./omp-ui sh wrapper inside the project. */
  wrapper: string;
  /** Isolated environment every CLI invocation runs with. */
  env: Record<string, string>;
  run(args: string[], options?: RunOptions): Promise<CliResult>;
  readEnv(): Record<string, string>;
  /** Set raw `KEY=value` lines in .env (values must not need quoting). */
  setEnv(updates: Record<string, string>): void;
  /** Pid recorded in DATA_DIR/omp-ui.pid, or null. */
  readPid(): number | null;
  /** Stop any server started from this project and delete the directory. */
  cleanup(): Promise<void>;
}

/**
 * Create an isolated project directory. With `build: false` the `dist` symlink is omitted, so the
 * CLI sees no production build.
 */
export function createProject({ build = true }: { build?: boolean } = {}): TempProject {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-cli-")));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const cli = path.join(root, "bin", "omp-ui.mjs");
  fs.copyFileSync(CLI_SOURCE, cli);
  fs.copyFileSync(SUPERVISOR_SOURCE, path.join(root, "bin", "supervisor.mjs"));
  fs.copyFileSync(path.join(REPO_ROOT, "bin", "agentmemory.mjs"), path.join(root, "bin", "agentmemory.mjs"));
  const wrapper = path.join(root, "omp-ui");
  fs.copyFileSync(WRAPPER_SOURCE, wrapper);
  fs.chmodSync(wrapper, 0o755);

  // package.json is a build input: backdate the copy so the CLI's build-freshness check
  // (`up`, `doctor`) compares it as older than dist/standalone/server.js.
  const pkg = path.join(root, "package.json");
  fs.copyFileSync(path.join(REPO_ROOT, "package.json"), pkg);
  const old = new Date("2000-01-01T00:00:00Z");
  fs.utimesSync(pkg, old, old);

  fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(root, "node_modules"), "dir");
  if (build) fs.symlinkSync(path.join(REPO_ROOT, "dist"), path.join(root, "dist"), "dir");

  const fakeOmp = path.join(root, "fake-omp");
  fs.writeFileSync(fakeOmp, `#!/bin/sh\necho "${FAKE_OMP_VERSION}"\n`, { mode: 0o755 });

  const env: Record<string, string> = {
    PATH: [path.dirname(process.execPath), process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    HOME: home,
    NO_COLOR: "1",
    LANG: "C.UTF-8",
    TMPDIR: os.tmpdir(),
    // Servers these tests start must neither start nor write to the real agentmemory server.
    AGENTMEMORY_ENABLED: "false",
  };

  const envFile = path.join(root, ".env");
  const dataDir = path.join(root, "data");
  const pidFile = path.join(dataDir, "omp-ui.pid");
  const logFile = path.join(dataDir, "omp-ui.log");

  const project: TempProject = {
    root,
    home,
    envFile,
    dataDir,
    pidFile,
    logFile,
    fakeOmp,
    cli,
    wrapper,
    env,
    run: (args, options = {}) =>
      runProcess(process.execPath, [cli, ...args], {
        ...options,
        cwd: options.cwd ?? root,
        env: { ...env, ...options.env },
      }),
    readEnv: () => parseEnv(fs.readFileSync(envFile, "utf8")),
    setEnv(updates) {
      const lines = fs.readFileSync(envFile, "utf8").split("\n");
      const pending = new Map(Object.entries(updates));
      const out = lines.map((line) => {
        const key = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
        if (key === undefined || !pending.has(key)) return line;
        const value = pending.get(key);
        pending.delete(key);
        return `${key}=${value}`;
      });
      if (out.at(-1) === "") out.pop();
      for (const [key, value] of pending) out.push(`${key}=${value}`);
      fs.writeFileSync(envFile, `${out.join("\n")}\n`);
    },
    readPid: () => readPidFile(pidFile),
    async cleanup() {
      // On Linux only kill processes whose cmdline is this project's server.js: a pid file may hold a
      // stale or deliberately unrelated pid. Elsewhere fall back to the recorded pid.
      const pids = () =>
        (process.platform === "linux" ? serverPids(root) : [readPidFile(pidFile)]).filter(
          (pid): pid is number => pid !== null && isAlive(pid),
        );
      if (pids().length) await project.run(["stop"], { timeoutMs: 30_000 }).catch(() => undefined);
      for (const pid of pids()) killGroup(pid);
      await waitUntil(() => pids().length === 0, 10_000).catch(() => undefined);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return project;
}

/** Run a command with captured output; never rejects on a non-zero exit. */
export function runProcess(
  cmd: string,
  args: string[],
  { input, env, cwd, timeoutMs = LIFECYCLE_TIMEOUT }: RunOptions & { env: Record<string, string> },
): Promise<CliResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CliResult>();
  // Cast: the project augments NodeJS.ProcessEnv with a required NODE_ENV the CLI must not inherit.
  const child: ChildProcessWithoutNullStreams = spawn(cmd, args, {
    cwd,
    env: env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  child.once("error", (err) => {
    clearTimeout(timer);
    reject(err);
  });
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal, stdout, stderr, output: `${stdout}${stderr}` });
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(input ?? "");
  return promise;
}

/** Minimal dotenv reader: KEY=value, 'single' (literal) and "double" (backslash escapes) quotes. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2].trim();
    if (raw.startsWith("'")) {
      const end = raw.indexOf("'", 1);
      out[m[1]] = raw.slice(1, end === -1 ? undefined : end);
    } else if (raw.startsWith('"')) {
      let value = "";
      for (let i = 1; i < raw.length; i++) {
        const ch = raw[i];
        if (ch === "\\" && i + 1 < raw.length) {
          const next = raw[++i];
          value += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next;
        } else if (ch === '"') break;
        else value += ch;
      }
      out[m[1]] = value;
    } else {
      const hash = raw.search(/\s#/);
      out[m[1]] = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    }
  }
  return out;
}

export function readPidFile(file: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
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

/** Command line and parent pid of a live process (Linux), or null once it is gone. */
function procInfo(pid: number): { argv: string[]; ppid: number } | null {
  try {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    // stat: "pid (comm) state ppid …"; comm may contain spaces, so parse after the last ")".
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return { argv, ppid: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) };
  } catch {
    return null;
  }
}

/**
 * Server instances launched from `root`: the pid of each bin/supervisor.mjs, which is what the
 * pid file records (Linux /proc scan; [] elsewhere). `children: true` lists the server.js
 * processes the supervisors run instead.
 */
export function serverPids(root: string, { children = false }: { children?: boolean } = {}): number[] {
  if (process.platform !== "linux") return [];
  const server = path.join(root, "dist", "standalone", "server.js");
  const matches = new Map<number, number>();
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const info = procInfo(Number(entry));
    if (info?.argv.includes(server)) matches.set(Number(entry), info.ppid);
  }
  return [...matches].filter(([, ppid]) => matches.has(ppid) === children).map(([pid]) => pid);
}

/** A pid that certainly belonged to a process that has already exited. */
export function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  if (!r.pid) throw new Error("could not spawn a short-lived process");
  return r.pid;
}

const handedOut = new Set<number>();

/** A currently free TCP port on 127.0.0.1, never returned twice in this test run. */
export async function freePort(): Promise<number> {
  for (;;) {
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    const port = await promise;
    if (!handedOut.has(port)) {
      handedOut.add(port);
      return port;
    }
  }
}

/** True when something accepts TCP connections on 127.0.0.1:port. */
export function portOpen(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = net.connect({ port, host: "127.0.0.1" });
  socket.setTimeout(2000);
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("timeout", () => {
    socket.destroy();
    resolve(false);
  });
  socket.once("error", () => resolve(false));
  return promise;
}

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 15_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}

export interface Health {
  ok: boolean;
  version: string;
  db: string;
  agents: unknown;
}

/** GET /api/v1/health on 127.0.0.1:port; null when unreachable or not ok. */
export async function health(port: number): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = (await res.json()) as Health;
    return body.ok ? body : null;
  } catch {
    return null;
  }
}

export async function login(port: number, password: string): Promise<{ status: number; token?: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string };
  return { status: res.status, token: body.token };
}

/** `authenticated` from /api/v1/auth/status for a bearer token. */
export async function isAuthenticated(port: number, token: string): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/status`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  const body = (await res.json()) as { authenticated?: boolean };
  return body.authenticated === true;
}

export function fileMode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}
