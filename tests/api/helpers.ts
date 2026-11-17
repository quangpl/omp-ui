// Shared harness for API route tests: calls the exported route handlers directly with real
// `Request` objects against a fresh SQLite database, workspace and fake omp per suite.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as loginRoute from "@/app/api/v1/auth/login/route";
import * as setupRoute from "@/app/api/v1/auth/setup/route";
import { killAllOmpProcesses } from "@/lib/agent/rpc";
import type { AgentManager } from "@/lib/agent/types";
import type { Repository } from "@/lib/db/types";
import type { User, UserRole } from "@/lib/types";

// Git must behave the same on every machine: ignore the user's/system git config and identity,
// and never touch the network (any ssh remote fails immediately).
// lib/git.ts snapshots process.env when it is first imported, so test files import this module
// before any other route module (none of this module's own imports load lib/git.ts).
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_SSH_COMMAND = "false";
for (const key of [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "EMAIL",
  "GIT_DIR",
  "GIT_WORK_TREE",
]) {
  delete process.env[key];
}

export const FAKE_OMP = fileURLToPath(new URL("../fixtures/fake-omp.mjs", import.meta.url));

export type Method = "GET" | "POST" | "PATCH" | "DELETE";
// Route params differ per handler.
type RouteHandler = (req: Request, context?: { params?: Promise<any> }) => Promise<Response>;
export type RouteModule = Partial<Record<Method, RouteHandler>>;

export interface CallOptions {
  /** JSON-encoded request body. */
  body?: unknown;
  /** Raw request body (sent as-is). */
  rawBody?: string;
  /** Bearer token; `undefined` = the token from the last setupAdmin(), `null` = none. */
  token?: string | null;
  /** Raw Cookie header. */
  cookie?: string;
  /** Route params passed to the handler as `{ params: Promise.resolve(params) }`. */
  params?: Record<string, string>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ApiResult<T> {
  status: number;
  headers: Headers;
  body: T;
}

export interface TestEnv {
  root: string;
  dataDir: string;
  workspaceDir: string;
  dbFile: string;
  ompLog: string;
}

const MANAGED_ENV = [
  "DATA_DIR",
  "DATABASE_URL",
  "WORKSPACE_DIR",
  "OMP_PATH",
  "ADMIN_PASSWORD",
  "AUTH_SECRET",
  "MAX_AGENTS",
  "OMP_EXTRA_ARGS",
  "MONGODB_DB",
  "FAKE_OMP_LOG",
  "FAKE_OMP_SESSION_DIR",
  "FAKE_OMP_SCENARIO",
  "FAKE_OMP_STARTUP",
  "FAKE_OMP_PROTOCOLS",
  "FAKE_OMP_SKILLS",
  "OMP_UI_CLUSTER_PORT",
  "OMP_UI_CLUSTER_JOIN",
  "OMP_UI_CLUSTER_TOKEN",
];

// Process-wide singletons the app keeps on globalThis (lib/db, lib/agent/manager, lib/auth,
// lib/stats, app/api/v1/system, lib/omp-skills, lib/cluster/node).
const g = globalThis as unknown as {
  __ompUiRepo?: Promise<Repository>;
  __ompUiAgentManager?: Promise<AgentManager>;
  __ompUiAuthSecret?: Promise<string>;
  __ompUiAuthBoot?: Promise<void>;
  __ompUiDummyHash?: Promise<string>;
  __ompUiLoginFailures?: Map<string, unknown>;
  __ompUiAiStats?: unknown;
  __ompUiAiStatsInFlight?: unknown;
  __ompUiOmpInfo?: unknown;
  __ompUiSkills?: unknown;
  __ompUiClusterListener?: Promise<{ close(): Promise<void> }>;
  __ompUiClusterStart?: Promise<void>;
  __ompUiClusterNode?: unknown;
  __ompUiClusterCreated?: string;
};

let current: TestEnv | null = null;
const roots: string[] = [];
let defaultToken: string | null = null;

/** Current suite environment (throws if freshEnv() was not called). */
export function env(): TestEnv {
  if (!current) throw new Error("freshEnv() has not been called");
  return current;
}

/**
 * Simulate a server shutdown: kill agents, close the database, and drop every cached singleton
 * so the next request boots again from the current environment variables.
 */
export async function stopServer(): Promise<void> {
  const managerPromise = g.__ompUiAgentManager;
  g.__ompUiAgentManager = undefined;
  const manager = managerPromise ? await managerPromise.catch(() => null) : null;
  // A suite that enabled cluster mode and did not disable it must not leak its listener.
  const listener = g.__ompUiClusterListener;
  g.__ompUiClusterListener = undefined;
  if (listener) await (await listener.catch(() => null))?.close();
  g.__ompUiClusterStart = undefined;
  g.__ompUiClusterNode = undefined;
  g.__ompUiClusterCreated = undefined;
  if (manager) {
    const { running, queued } = manager.stats();
    for (const taskId of [...running, ...queued]) await manager.onTaskDeleted(taskId);
  }
  killAllOmpProcesses("SIGKILL");

  const repoPromise = g.__ompUiRepo;
  g.__ompUiRepo = undefined;
  const repo = repoPromise ? await repoPromise.catch(() => null) : null;
  if (repo) await repo.close().catch(() => undefined);

  g.__ompUiAuthSecret = undefined;
  g.__ompUiAuthBoot = undefined;
  g.__ompUiDummyHash = undefined;
  // lib/auth.ts holds this map in a module constant: clear it in place.
  g.__ompUiLoginFailures?.clear();
  g.__ompUiAiStats = undefined;
  g.__ompUiAiStatsInFlight = undefined;
  g.__ompUiOmpInfo = undefined;
  g.__ompUiSkills = undefined;
}

function applyEnv(overrides: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/**
 * Fresh, isolated server: new temp dir with its own SQLite file, DATA_DIR, WORKSPACE_DIR (not
 * created yet) and fake omp. `overrides` are applied last (`undefined` unsets a variable).
 */
export async function freshEnv(overrides: Record<string, string | undefined> = {}): Promise<TestEnv> {
  await stopServer();
  const root = mkdtempSync(path.join(os.tmpdir(), "omp-ui-api-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const sessions = path.join(root, "sessions");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const next: TestEnv = {
    root,
    dataDir,
    workspaceDir: path.join(root, "ws"),
    dbFile: path.join(root, "db.sqlite"),
    ompLog: path.join(root, "fake-omp.log"),
  };
  for (const key of MANAGED_ENV) delete process.env[key];
  applyEnv({
    DATA_DIR: next.dataDir,
    DATABASE_URL: `sqlite:${next.dbFile}`,
    WORKSPACE_DIR: next.workspaceDir,
    OMP_PATH: FAKE_OMP,
    FAKE_OMP_LOG: next.ompLog,
    FAKE_OMP_SESSION_DIR: sessions,
    ...overrides,
  });
  current = next;
  defaultToken = null;
  return next;
}

/** Restart the server on the same database (boot logic runs again on the next request). */
export async function restartServer(overrides: Record<string, string | undefined> = {}): Promise<void> {
  await stopServer();
  applyEnv(overrides);
}

/** Stop the server and delete every temp dir created by freshEnv(). Use in afterAll. */
export async function teardown(): Promise<void> {
  await stopServer();
  current = null;
  defaultToken = null;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** New directory inside the suite's temp root. */
export function tempDir(name: string): string {
  const dir = path.join(env().root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write an executable Node script (used as a stand-in `omp` binary) and return its path. */
export function writeScript(file: string, source: string): string {
  writeFileSync(file, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  return file;
}

// ---------------------------------------------------------------------------------------------
// Requests

/** Call a route handler directly. `routePath` is relative to `/api/v1` and may carry a query. */
export function call(
  mod: RouteModule,
  method: Method,
  routePath: string,
  options: CallOptions = {},
): Promise<Response> {
  const handler = mod[method];
  if (!handler) throw new Error(`Route module has no ${method} handler (${routePath})`);
  const headers = new Headers(options.headers);
  const token = options.token === undefined ? defaultToken : options.token;
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (options.cookie) headers.set("cookie", options.cookie);
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set("content-type", "application/json");
  }
  const req = new Request(`http://localhost/api/v1${routePath}`, {
    method,
    headers,
    body,
    signal: options.signal,
  });
  return handler(req, options.params ? { params: Promise.resolve(options.params) } : undefined);
}

/** call() + JSON body (callers choose the expected body type). */
export async function api<T = any>(
  mod: RouteModule,
  method: Method,
  routePath: string,
  options: CallOptions = {},
): Promise<ApiResult<T>> {
  const res = await call(mod, method, routePath, options);
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  let body: unknown = text;
  if (contentType.includes("application/json")) body = JSON.parse(text);
  return { status: res.status, headers: res.headers, body: body as T };
}

export const ADMIN_PASSWORD = "correct-horse-battery";

/** Create the first admin (username `admin`); the returned token becomes the default for call()/api(). */
export async function setupAdmin(password = ADMIN_PASSWORD): Promise<string> {
  const res = await api<{ token?: string; error?: string }>(setupRoute, "POST", "/auth/setup", {
    body: { password },
    token: null,
  });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`auth setup failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  defaultToken = res.body.token;
  return res.body.token;
}

/** Create a user through POST /users with the default (admin) token; role defaults to "user". */
export async function createUser(input: {
  username: string;
  password: string;
  role?: UserRole;
  email?: string | null;
}): Promise<User> {
  // Loaded lazily: the users route pulls in board teardown code, and this module's static imports
  // must not load lib/git.ts before the git environment above is set.
  const usersRoute = await import("@/app/api/v1/users/route");
  const res = await api<User & { error?: string }>(usersRoute, "POST", "/users", { body: input });
  if (res.status !== 201) throw new Error(`user creation failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Sign in via POST /auth/login (`username` may be an email) and return the session token. */
export async function loginAs(username: string, password: string): Promise<string> {
  const res = await api<{ token?: string; error?: string }>(loginRoute, "POST", "/auth/login", {
    body: { username, password },
    token: null,
  });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`login as ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

/** Override the default token used by call()/api() (null = unauthenticated by default). */
export function useToken(token: string | null): void {
  defaultToken = token;
}

// ---------------------------------------------------------------------------------------------
// Polling / fake omp log

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Poll `fn` until it returns a truthy value; throws with the last value/error on timeout. */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  timeout = 15_000,
  interval = 50,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value as NonNullable<T>;
      last = value;
    } catch (err) {
      last = err;
    }
    if (Date.now() >= deadline) {
      const detail = last instanceof Error ? last.message : JSON.stringify(last);
      throw new Error(`waitFor timed out after ${timeout}ms (last: ${detail})`);
    }
    await sleep(interval);
  }
}

export interface FakeOmpLogEntry {
  pid: number;
  kind: string;
  argv?: string[];
  cwd?: string;
  command?: { type: string; id?: string; message?: string; [key: string]: unknown };
  message?: string;
  /** Print mode: the prompt read from stdin. */
  prompt?: string;
}

/** Entries the fake omp appended to FAKE_OMP_LOG in this suite. */
export function readOmpLog(): FakeOmpLogEntry[] {
  const file = env().ompLog;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeOmpLogEntry);
}

/** argv of every fake omp process started in this suite, in start order. */
export function ompLaunches(): string[][] {
  return readOmpLog()
    .filter((e) => e.kind === "argv")
    .map((e) => e.argv ?? []);
}
