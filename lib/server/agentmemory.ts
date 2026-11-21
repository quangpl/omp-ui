// agentmemory (https://github.com/rohitg00/agentmemory, npm `@agentmemory/agentmemory`): a local
// memory server for coding agents. REST API on http://localhost:3111, live viewer on :3113 (both on
// loopback), config in ~/.agentmemory/.env, bearer secret auto-generated at ~/.agentmemory/secret.
// `agentmemory connect omp --with-mcp` installs its native OMP extension (recall + capture + skills)
// into omp's agent dir, so every omp process — card runs included — remembers through it.
//
// Server-only: the secret is read here and attached to requests; it never reaches the client.
import { execFile, spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { childEnv } from "@/lib/child-env";
import { HttpError } from "@/lib/server/http";
import { agentDir as ompAgentDir, getOmpSetting } from "@/lib/server/omp-config";
import type { MemoryEnabledMode, MemoryStats, MemoryStatus } from "@/lib/types";

const DEFAULT_URL = "http://127.0.0.1:3111";
const DEFAULT_PORT = 3111;
const PACKAGE = "@agentmemory/agentmemory";
const FETCH_TIMEOUT_MS = 5_000;
const CLI_CACHE_MS = 60_000;
const CLI_PROBE_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 120_000;
/** How long POST /memory/start waits before answering `starting: true`; the start itself goes on. */
const START_WAIT_MS = 60_000;
/** After the CLI hands the runtime to its daemon, health must turn green within this long. */
const HEALTH_WAIT_MS = 15_000;
const OUTPUT_TAIL = 4_000;

// ─── config + authenticated fetch ────────────────────────────────────────────

export interface AgentmemoryConfig {
  /** REST API base without a trailing slash (`AGENTMEMORY_URL`, default http://127.0.0.1:3111). */
  url: string;
  /**
   * Live viewer: `AGENTMEMORY_VIEWER_URL` (agentmemory's own override, e.g. a forwarded port), else
   * the REST host on `III_VIEWER_PORT` or the REST port + 2 (agentmemory's derivation).
   */
  viewerUrl: string;
}

export function agentmemoryConfig(): AgentmemoryConfig {
  const url = (process.env.AGENTMEMORY_URL?.trim() || DEFAULT_URL).replace(/\/+$/, "");
  const viewerUrl =
    process.env.AGENTMEMORY_VIEWER_URL?.trim().replace(/\/+$/, "") ||
    viewerUrlFor(url, Number(process.env.III_VIEWER_PORT) || null);
  return { url, viewerUrl };
}

function viewerUrlFor(url: string, viewerPort: number | null): string {
  try {
    const parsed = new URL(url);
    const restPort = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
    return `${parsed.protocol}//${parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname}:${viewerPort ?? restPort + 2}`;
  } catch {
    return "http://127.0.0.1:3113";
  }
}

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

function agentmemoryHome(): string {
  return path.join(os.homedir(), ".agentmemory");
}

/** `~/.agentmemory/.env` (or `AGENTMEMORY_ENV_FILE`) as key → value; empty when missing. */
async function readEnvFile(): Promise<Record<string, string>> {
  const file = process.env.AGENTMEMORY_ENV_FILE?.trim() || path.join(agentmemoryHome(), ".env");
  const raw = await readFile(file, "utf8").catch(() => "");
  const values: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = trimmed.slice(eq + 1).trim();
    const quote = value[0];
    const close = quote === '"' || quote === "'" ? value.indexOf(quote, 1) : -1;
    if (close > 0) value = value.slice(1, close);
    else if (value.includes(" #")) value = value.slice(0, value.indexOf(" #")).trim();
    values[key] = value;
  }
  return values;
}

function usable(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.startsWith("${") && trimmed.endsWith("}") ? "" : trimmed;
}

/**
 * The bearer secret, resolved the way agentmemory's own clients do: `AGENTMEMORY_SECRET`, else —
 * for loopback URLs only — `~/.agentmemory/.env`, then the generated `~/.agentmemory/secret`.
 */
async function resolveSecret(url: string): Promise<string> {
  const explicit = usable(process.env.AGENTMEMORY_SECRET);
  if (explicit) return explicit;
  if (process.env.AGENTMEMORY_CREDENTIAL_MODE === "explicit" || !isLoopbackUrl(url)) return "";
  const fromEnv = usable((await readEnvFile()).AGENTMEMORY_SECRET);
  if (fromEnv) return fromEnv;
  return usable(await readFile(path.join(agentmemoryHome(), "secret"), "utf8").catch(() => ""));
}

/**
 * Authenticated request to the agentmemory REST API. `pathname` is absolute under the base URL
 * (`/agentmemory/memories?limit=50`) or relative to `/agentmemory/` (`memories?limit=50`).
 * Adds `Authorization: Bearer <secret>` and a 5 s timeout (combined with `init.signal`). Any HTTP
 * status resolves as-is; an unreachable server or a timeout throws HttpError 503 / 504.
 */
export async function agentmemoryFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  const { url } = agentmemoryConfig();
  const target = `${url}${pathname.startsWith("/") ? pathname : `/agentmemory/${pathname}`}`;
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (init.body !== undefined && init.body !== null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const secret = await resolveSecret(url);
  if (secret && !headers.has("authorization")) headers.set("authorization", `Bearer ${secret}`);
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    return await fetch(target, { ...init, headers, signal, redirect: "error" });
  } catch (err) {
    if (timeout.aborted) throw new HttpError(504, `agentmemory did not answer within ${FETCH_TIMEOUT_MS / 1000}s at ${url}`);
    if (init.signal?.aborted) throw err;
    throw new HttpError(503, `agentmemory is unreachable at ${url}`);
  }
}

async function fetchJson<T>(pathname: string): Promise<{ status: number; body: T | null }> {
  const res = await agentmemoryFetch(pathname);
  const body = (await res.json().catch(() => null)) as T | null;
  return { status: res.status, body };
}

// ─── CLI discovery ───────────────────────────────────────────────────────────

interface Cli {
  command: string;
  /** Arguments before the subcommand (the cached package's bin for npx installs). */
  prefix: string[];
  source: "path" | "npx";
  version: string | null;
}

const g = globalThis as unknown as {
  __ompUiAgentmemoryCli?: { at: number; cli: Promise<Cli | null> };
  __ompUiAgentmemoryStart?: Promise<void> | null;
};

function run(
  command: string,
  args: string[],
  timeout: number,
): Promise<{ code: number | string | null; output: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number | string | null; output: string }>();
  execFile(
    command,
    args,
    // Instance 0 reuses ./data/state_store.db of its cwd: run from home, never from AgentMan's folder.
    { cwd: os.homedir(), env: childEnv({ CI: "1" }), timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    (err, stdout, stderr) => {
      const code = err ? (("code" in err ? err.code : undefined) ?? (err.killed ? "TIMEOUT" : 1)) : 0;
      resolve({ code, output: `${stdout}\n${stderr}` });
    },
  );
  return promise;
}

function versionOf(output: string): string | null {
  return /\d+\.\d+\.\d+[\w.-]*/.exec(output)?.[0] ?? null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The newest `@agentmemory/agentmemory` in npx's cache (`npx -y @agentmemory/agentmemory@latest` installs). */
async function findNpxCli(): Promise<Cli | null> {
  const cache = process.env.npm_config_cache?.trim() || path.join(os.homedir(), ".npm");
  const root = path.join(cache, "_npx");
  const entries = await readdir(root).catch(() => [] as string[]);
  let best: { version: string; bin: string } | null = null;
  for (const entry of entries) {
    const dir = path.join(root, entry, "node_modules", ...PACKAGE.split("/"));
    const pkg = await readFile(path.join(dir, "package.json"), "utf8")
      .then((raw) => JSON.parse(raw) as { version?: unknown; bin?: unknown })
      .catch(() => null);
    if (!pkg || typeof pkg.version !== "string") continue;
    const binField = pkg.bin;
    const rel =
      typeof binField === "string"
        ? binField
        : binField && typeof binField === "object" && "agentmemory" in binField
          ? binField.agentmemory
          : undefined;
    if (typeof rel !== "string") continue;
    if (!best || compareVersions(pkg.version, best.version) > 0) best = { version: pkg.version, bin: path.join(dir, rel) };
  }
  return best ? { command: "node", prefix: [best.bin], source: "npx", version: best.version } : null;
}

async function cliAt(command: string, source: Cli["source"]): Promise<Cli | null> {
  const probe = await run(command, ["--version"], CLI_PROBE_TIMEOUT_MS);
  return probe.code === 0 ? { command, prefix: [], source, version: versionOf(probe.output) } : null;
}

/**
 * `agentmemory` on PATH, else in npm's global bin (services often run without the user's PATH:
 * `~/.npm-global/bin`, then `npm prefix -g`), else the npx cache.
 */
async function detectCli(): Promise<Cli | null> {
  const onPath = await cliAt("agentmemory", "path");
  if (onPath) return onPath;
  const userPrefix = await cliAt(path.join(os.homedir(), ".npm-global", "bin", "agentmemory"), "path");
  if (userPrefix) return userPrefix;
  const prefix = await run("npm", ["prefix", "-g"], CLI_PROBE_TIMEOUT_MS);
  const globalBin = prefix.code === 0 ? prefix.output.trim().split("\n")[0]?.trim() : "";
  if (globalBin && path.isAbsolute(globalBin)) {
    const global = await cliAt(path.join(globalBin, process.platform === "win32" ? "" : "bin", "agentmemory"), "path");
    if (global) return global;
  }
  return findNpxCli();
}

/** The agentmemory CLI, cached for a minute. */
function findCli(refresh = false): Promise<Cli | null> {
  const cached = g.__ompUiAgentmemoryCli;
  if (!refresh && cached && Date.now() - cached.at < CLI_CACHE_MS) return cached.cli;
  const cli = detectCli();
  g.__ompUiAgentmemoryCli = { at: Date.now(), cli };
  return cli;
}

/**
 * A systemd user unit `agentmemory.service` that is enabled owns the server's lifecycle (it restarts
 * a server stopped behind its back), so starts go through `systemctl --user` then.
 */
async function systemdUnitEnabled(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  const result = await run("systemctl", ["--user", "is-enabled", "agentmemory.service"], CLI_PROBE_TIMEOUT_MS);
  return result.output.trim().split("\n")[0]?.trim() === "enabled";
}

/** Whether the agentmemory CLI is installed (the cached probe of findCli). */
export async function agentmemoryInstalled(): Promise<boolean> {
  return (await findCli()) !== null;
}

function cleanOutput(output: string): string {
  const text = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[│◇◆●○■└┌┐┘─]+/g, " ");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.join("\n").slice(-OUTPUT_TAIL);
}

// ─── status ──────────────────────────────────────────────────────────────────

export function memoryEnabledMode(): MemoryEnabledMode {
  const value = process.env.AGENTMEMORY_ENABLED?.trim().toLowerCase();
  if (value === "true" || value === "1" || value === "on") return "true";
  if (value === "false" || value === "0" || value === "off") return "false";
  return "auto";
}

/** AgentMan talks to agentmemory (starts it, tags card sessions) unless AGENTMEMORY_ENABLED=false. */
export function agentmemoryEnabled(): boolean {
  return memoryEnabledMode() !== "false";
}

interface HealthBody {
  status?: string;
  version?: string;
  viewerPort?: number | null;
  health?: { status?: string } | null;
}

interface StatusReportBody {
  status?: string;
  headline?: string;
  service?: { version?: string; ports?: { viewer?: number | null } };
  provider?: { llm?: string; embeddings?: string };
  index?: { sessions?: number | null; observationsIndexed?: number; memoriesIndexed?: number; lessonsIndexed?: number };
  problems?: { level?: string; message?: string; fix?: string }[];
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function embeddingsLabel(provider: string | undefined): string {
  const value = provider?.trim();
  return value && value !== "none" ? value : "bm25";
}

/** omp's agent dir and whether `agentmemory connect omp` wired it (extension listed, MCP added). */
async function ompConnection(ompPath: string): Promise<MemoryStatus["omp"]> {
  let dir: string;
  try {
    dir = await ompAgentDir(ompPath);
  } catch (err) {
    return { agentDir: null, connected: false, mcp: false, error: err instanceof Error ? err.message : String(err) };
  }
  const target = path.join(dir, "agentmemory");
  const [marker, configYml, configYaml, bundledMcp, userMcp] = await Promise.all([
    // Written by the connector next to the copied extension.
    readFile(path.join(target, ".agentmemory-install.json"), "utf8").catch(() => null),
    readFile(path.join(dir, "config.yml"), "utf8").catch(() => null),
    readFile(path.join(dir, "config.yaml"), "utf8").catch(() => null),
    readFile(path.join(target, ".mcp.json"), "utf8").catch(() => null),
    readFile(path.join(dir, "mcp.json"), "utf8").catch(() => null),
  ]);
  const config = configYml ?? configYaml ?? "";
  const home = os.homedir();
  const tilde = target.startsWith(`${home}${path.sep}`) ? `~${target.slice(home.length)}` : null;
  const listed = config.includes(target) || (tilde !== null && config.includes(tilde));
  const hasServer = (raw: string | null) => {
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      const servers = parsed && typeof parsed === "object" && "mcpServers" in parsed ? parsed.mcpServers : null;
      return Boolean(servers && typeof servers === "object" && "agentmemory" in servers);
    } catch {
      return false;
    }
  };
  return {
    agentDir: dir,
    connected: marker !== null && listed,
    mcp: hasServer(bundledMcp) || hasServer(userMcp),
    error: null,
  };
}

/** Server health, stats and embeddings mode as the REST API reports them (all null when it is down). */
async function serverState(): Promise<
  Pick<MemoryStatus, "reachable" | "healthy" | "error" | "level" | "headline" | "problems" | "llm" | "stats"> & {
    version: string | null;
    viewerPort: number | null;
    embeddings: string | null;
  }
> {
  const down = {
    reachable: false,
    healthy: false,
    level: null,
    headline: null,
    problems: [],
    llm: null,
    stats: null,
    version: null,
    viewerPort: null,
    embeddings: null,
  };
  let health: { status: number; body: HealthBody | null };
  try {
    health = await fetchJson<HealthBody>("/agentmemory/health");
  } catch (err) {
    return { ...down, error: err instanceof Error ? err.message : String(err) };
  }
  if (health.status === 401) {
    return {
      ...down,
      reachable: true,
      error: "agentmemory rejected the bearer secret: set AGENTMEMORY_SECRET for AgentMan to the server's secret",
    };
  }
  const state = health.body?.status || health.body?.health?.status || "";
  const healthy = ["ok", "healthy", "degraded"].includes(state);
  const [report, memories] = await Promise.all([
    fetchJson<StatusReportBody>("/agentmemory/status").catch(() => null),
    fetchJson<{ total?: number; latestCount?: number }>("/agentmemory/memories?count=true").catch(() => null),
  ]);
  const r = report?.status === 200 ? report.body : null;
  const m = memories?.status === 200 ? memories.body : null;
  const stats: MemoryStats | null =
    r || m
      ? {
          memories: count(m?.latestCount ?? m?.total) ?? count(r?.index?.memoriesIndexed),
          sessions: count(r?.index?.sessions),
          observations: count(r?.index?.observationsIndexed),
          lessons: count(r?.index?.lessonsIndexed),
        }
      : null;
  return {
    reachable: true,
    healthy,
    error: healthy ? null : `agentmemory health is ${state || `HTTP ${health.status}`}`,
    level: r?.status ?? null,
    headline: r?.headline ?? null,
    problems: (r?.problems ?? [])
      .filter((p) => typeof p?.message === "string")
      .map((p) => ({ level: p.level ?? "warn", message: p.message!, ...(p.fix ? { fix: p.fix } : {}) })),
    llm: r?.provider?.llm ?? null,
    stats,
    version: health.body?.version ?? r?.service?.version ?? null,
    viewerPort: count(health.body?.viewerPort) ?? count(r?.service?.ports?.viewer),
    embeddings: r?.provider?.embeddings !== undefined ? embeddingsLabel(r.provider.embeddings) : null,
  };
}

/** Everything the Memory settings section shows. Never throws for a missing install or a down server. */
export async function getMemoryStatus(ompPath: string, options: { refresh?: boolean } = {}): Promise<MemoryStatus> {
  const config = agentmemoryConfig();
  const [cli, server, omp, envFile] = await Promise.all([
    findCli(options.refresh),
    serverState(),
    ompConnection(ompPath),
    readEnvFile(),
  ]);
  const configured = usable(process.env.EMBEDDING_PROVIDER) || usable(envFile.EMBEDDING_PROVIDER);
  return {
    enabled: memoryEnabledMode(),
    installed: cli !== null,
    installSource: cli?.source ?? null,
    version: server.version ?? cli?.version ?? null,
    url: config.url,
    // The bound viewer port beats the derived one; an explicit AGENTMEMORY_VIEWER_URL beats both.
    viewerUrl:
      server.viewerPort && !process.env.AGENTMEMORY_VIEWER_URL?.trim()
        ? viewerUrlFor(config.url, server.viewerPort)
        : config.viewerUrl,
    reachable: server.reachable,
    healthy: server.healthy,
    starting: Boolean(g.__ompUiAgentmemoryStart),
    error: server.error,
    level: server.level,
    headline: server.headline,
    problems: server.problems,
    embeddings: server.embeddings ?? embeddingsLabel(configured),
    embeddingsSource: server.embeddings !== null ? "server" : "config",
    llm: server.llm,
    stats: server.stats,
    omp,
  };
}

// ─── actions ─────────────────────────────────────────────────────────────────

function notInstalled(): HttpError {
  return new HttpError(
    409,
    `agentmemory is not installed. Run \`npx -y ${PACKAGE}@latest\` once (or \`npm install -g ${PACKAGE}@latest\`) on the server host.`,
  );
}

/** `--port N` when AGENTMEMORY_URL points at a non-default loopback port. */
function startArgs(url: string): string[] {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    return isLoopbackUrl(url) && port && port !== DEFAULT_PORT ? ["--port", String(port)] : [];
  } catch {
    return [];
  }
}

async function waitHealthy(deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if ((await serverState()).healthy) return true;
    await sleep(1_000);
  }
  return false;
}

interface Launcher {
  command: string;
  args: string[];
  label: string;
  /** Health must turn green this long after the launcher exits. */
  healthWaitMs: number;
}

/**
 * Run the launcher — `systemctl --user start --no-block agentmemory.service`, or `agentmemory`,
 * which boots the pinned iii runtime, hands it to a detached daemon and exits — then wait for
 * health. Single-flight; rejects with the launcher's output tail.
 */
function startServer(launcher: Launcher, url: string): Promise<void> {
  if (g.__ompUiAgentmemoryStart) return g.__ompUiAgentmemoryStart;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(launcher.command, launcher.args, {
    cwd: os.homedir(),
    env: childEnv({ CI: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-OUTPUT_TAIL * 4);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", (err) => reject(new HttpError(502, `${launcher.label} failed: ${err.message}`)));
  child.on("close", (code) => {
    if (code !== 0) {
      reject(new HttpError(502, `${launcher.label} exited with code ${code}:\n${cleanOutput(output)}`));
      return;
    }
    void waitHealthy(Date.now() + launcher.healthWaitMs).then((ok) =>
      ok ? resolve() : reject(new HttpError(502, `${launcher.label} ran but ${url} is not healthy:\n${cleanOutput(output)}`)),
    );
  });
  const tracked = promise.finally(() => {
    g.__ompUiAgentmemoryStart = null;
  });
  // A start nobody awaits any more (the route answered `starting`) must not crash the process.
  tracked.catch((err: unknown) => console.warn("[agentmemory] start failed:", err instanceof Error ? err.message : err));
  g.__ompUiAgentmemoryStart = tracked;
  return tracked;
}

/** POST /memory/start: start the server unless it is already healthy; waits up to a minute. */
export async function startMemoryServer(ompPath: string): Promise<MemoryStatus> {
  const { url } = agentmemoryConfig();
  if (!(await serverState()).healthy) {
    if (!isLoopbackUrl(url)) {
      throw new HttpError(409, `AGENTMEMORY_URL points at ${url}; AgentMan only starts a local server`);
    }
    let launcher: Launcher;
    if (await systemdUnitEnabled()) {
      launcher = {
        command: "systemctl",
        args: ["--user", "start", "--no-block", "agentmemory.service"],
        label: "systemctl --user start agentmemory",
        // The unit allows a first boot (engine download) up to 10 minutes.
        healthWaitMs: 10 * 60_000,
      };
    } else {
      const cli = await findCli(true);
      if (!cli) throw notInstalled();
      launcher = { command: cli.command, args: [...cli.prefix, ...startArgs(url)], label: "agentmemory", healthWaitMs: HEALTH_WAIT_MS };
    }
    await Promise.race([startServer(launcher, url), sleep(START_WAIT_MS)]);
  }
  return getMemoryStatus(ompPath);
}

/** POST /memory/connect-omp: `agentmemory connect omp --with-mcp` into omp's agent dir. */
export async function connectOmp(ompPath: string): Promise<MemoryStatus> {
  const cli = await findCli(true);
  if (!cli) throw notInstalled();
  // The connector finds omp's agent dir from the same env (PI_CODING_AGENT_DIR, OMP_PROFILE, …)
  // that `omp config path` and AgentMan's agents use.
  const result = await run(cli.command, [...cli.prefix, "connect", "omp", "--with-mcp"], CONNECT_TIMEOUT_MS);
  if (result.code !== 0) {
    throw new HttpError(502, `agentmemory connect omp failed:\n${cleanOutput(result.output)}`);
  }
  return getMemoryStatus(ompPath);
}

// ─── omp process environment ─────────────────────────────────────────────────

/**
 * The agentmemory project of a card run, passed as `AGENTMEMORY_PROJECT_NAME`. agentmemory's OMP
 * extension files captures and scopes recall by that env, else by the git root (or cwd) basename —
 * which for a card running in a worktree is the worktree's folder, not the project. This is what an
 * omp session in the board's own folder resolves to, so cards, their worktrees and the user's own
 * omp sessions share one project. An explicit AGENTMEMORY_PROJECT_NAME in AgentMan's environment wins.
 */
export async function memoryProjectName(boardWorkdir: string): Promise<string> {
  const explicit = process.env.AGENTMEMORY_PROJECT_NAME?.trim();
  if (explicit) return explicit;
  const { promise, resolve } = Promise.withResolvers<string>();
  execFile(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd: boardWorkdir, env: childEnv(), timeout: 2_000, windowsHide: true },
    (err, stdout) => resolve(err ? "" : String(stdout).trim()),
  );
  return path.basename((await promise) || boardWorkdir);
}

/**
 * Env for pooled helper workers (advisor, summaries, assistants): no memory capture or recall. The
 * OMP extension has no off switch, so the helpers get no credentials: `AGENTMEMORY_CREDENTIAL_MODE=
 * explicit` without `AGENTMEMORY_SECRET` makes the authenticated server reject their health check
 * (no recall, no session) and every capture (401: dropped, not retried), and with
 * `AGENTMEMORY_CAPTURE_SPOOL=false` nothing is queued offline either.
 */
export function helperMemoryEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, AGENTMEMORY_CREDENTIAL_MODE: "explicit", AGENTMEMORY_CAPTURE_SPOOL: "false" };
  delete out.AGENTMEMORY_SECRET;
  return out;
}

/**
 * Env for a card run with memory off (`ignoreMemory`): same lockout as helperMemoryEnv, as
 * defense in depth should the extension still load. Spread over the run env (no project name).
 */
export const MEMORY_OFF_ENV = {
  AGENTMEMORY_CREDENTIAL_MODE: "explicit",
  AGENTMEMORY_SECRET: "",
  AGENTMEMORY_CAPTURE_SPOOL: "false",
} as const;

/** The MCP server key agentmemory's connector and bundled `.mcp.json` register. */
const MEMORY_MCP_ENTRY = "mcp:agentmemory";

function isMemoryExtension(entry: string): boolean {
  if (entry.includes("@agentmemory/")) return true;
  return path.basename(entry.replace(/[\\/]+$/, "")) === "agentmemory";
}

/**
 * `--config` overlay additions that turn agentmemory off for one run. omp's overlay arrays REPLACE
 * the effective (project-or-user) lists, so both are copied: `extensions` without agentmemory's dir
 * (dropping it drops its hooks — recall/capture —, `memory_*` tools, skills and bundled `.mcp.json`
 * server; omitted when nothing matched), and `disabledExtensions` plus `mcp:agentmemory`, which
 * hides an `agentmemory` server the user defined in mcp.json.
 */
export function memoryOffSettings(
  extensions: readonly string[],
  disabledExtensions: readonly string[],
): { extensions?: string[]; disabledExtensions: string[] } {
  const kept = extensions.filter((entry) => !isMemoryExtension(entry));
  const disabled = [...new Set([...disabledExtensions, MEMORY_MCP_ENTRY])];
  return kept.length === extensions.length ? { disabledExtensions: disabled } : { extensions: kept, disabledExtensions: disabled };
}

function stringList(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error("not a string list");
  return value;
}

/**
 * memoryOffSettings for omp's effective `extensions`/`disabledExtensions` in `cwd` (the run's
 * workdir, so project `.omp` settings apply). Null when omp can't report them.
 */
export async function memoryOffOverlay(
  ompPath: string,
  cwd: string,
): Promise<{ extensions?: string[]; disabledExtensions: string[] } | null> {
  try {
    const [extensions, disabled] = await Promise.all([
      getOmpSetting(ompPath, "extensions", cwd),
      getOmpSetting(ompPath, "disabledExtensions", cwd),
    ]);
    return memoryOffSettings(stringList(extensions), stringList(disabled));
  } catch {
    return null;
  }
}

/**
 * Label a card's omp session in agentmemory with the card, so its memories are attributable in the
 * viewer and the Memory tab. `session/start` merges into the session the extension opened (keeps
 * its observation count; the title becomes the session summary until agentmemory summarizes it).
 * Best effort: silent when the server is down or not installed. Callers check agentmemoryEnabled().
 */
export async function tagMemorySession(input: {
  sessionId: string;
  project: string;
  cwd: string;
  title: string;
}): Promise<void> {
  try {
    const res = await agentmemoryFetch("/agentmemory/session/start", {
      method: "POST",
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(2_000),
    });
    await res.body?.cancel();
  } catch {}
}
