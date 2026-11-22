import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getAgentManager } from "@/lib/agent/manager";
import type { OmpRpcProcess } from "@/lib/agent/rpc";
import type { AgentManager } from "@/lib/agent/types";
import { SECRET_ENV_KEYS, childEnv } from "@/lib/child-env";
import { getRepo } from "@/lib/db";
import type { Repository } from "@/lib/db/types";
import { subscribe } from "@/lib/events";
import type { Board, Task } from "@/lib/types";

const FAKE_OMP = fileURLToPath(new URL("../fixtures/fake-omp.mjs", import.meta.url));

/** Process-wide singletons the app caches on globalThis (lib/db/index.ts, lib/agent/manager.ts, lib/agent/rpc.ts). */
const globals = globalThis as typeof globalThis & {
  __ompUiRepo?: Promise<Repository>;
  __ompUiAgentManager?: Promise<AgentManager>;
  __ompUiRpcProcesses?: Set<OmpRpcProcess>;
};

/** Host credentials the children must inherit. */
const CREDENTIALS = {
  ANTHROPIC_API_KEY: "sk-ant-test-credential",
  SSH_AUTH_SOCK: "/tmp/omp-ui-test-agent.sock",
  GH_TOKEN: "ghp_test_credential",
  GITLAB_TOKEN: "glpat-test-credential",
  OPENAI_API_KEY: "sk-openai-test-credential",
  GIT_AUTHOR_NAME: "Test Author",
  XDG_CONFIG_HOME: "/tmp/omp-ui-test-xdg",
  HTTPS_PROXY: "http://proxy.test:3128",
  NODE_EXTRA_CA_CERTS: "/tmp/omp-ui-test-ca.pem",
} as const;

/** OMP-UI's own secrets the children must never see. */
const SECRETS = {
  ADMIN_PASSWORD: "admin-password-secret",
  AUTH_SECRET: "auth-secret-value",
  COMPOSE_DATABASE_URL: "postgres://omp:secret@db/omp",
  POSTGRES_PASSWORD: "postgres-secret",
  MONGODB_DB: "omp-ui-test",
  OMP_UI_TEST_SECRET: "omp-ui-prefixed-secret",
} as const;

const ENV_KEYS = [
  "HOME",
  "DATABASE_URL",
  "DATA_DIR",
  "OMP_PATH",
  "MAX_AGENTS",
  "OMP_EXTRA_ARGS",
  "FAKE_OMP_LOG",
  "FAKE_OMP_SCENARIO",
  "FAKE_OMP_SESSION_DIR",
  ...Object.keys(CREDENTIALS),
  ...Object.keys(SECRETS),
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

interface ArgvEntry {
  pid: number;
  kind: string;
  envKeys?: string[];
  env?: Record<string, string>;
}

let root: string;
let workdir: string;
let logFile: string;
let repo: Repository;
let board: Board;

/** Resolves once the manager publishes the task as done and idle. */
function waitDone(taskId: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const unsubscribe = subscribe((event) => {
    if (event.type !== "task.updated" || event.task.id !== taskId) return;
    if (event.task.status !== "done" || event.task.agentState !== "idle") return;
    unsubscribe();
    resolve();
  });
  return promise;
}

function argvEntries(): ArgvEntry[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ArgvEntry)
    .filter((entry) => entry.kind === "argv");
}

beforeAll(() => {
  chmodSync(FAKE_OMP, 0o755);
});

afterAll(restoreEnv);

describe("childEnv", () => {
  beforeEach(() => {
    Object.assign(process.env, CREDENTIALS, SECRETS, { DATABASE_URL: "sqlite:/tmp/omp-ui-secret.db" });
    process.env.HOME ||= os.userInfo().homedir;
  });

  afterEach(restoreEnv);

  it("removes OMP-UI's own secrets, including any OMP_UI_* key", () => {
    const env = childEnv();
    for (const key of [...SECRET_ENV_KEYS, "OMP_UI_TEST_SECRET"]) expect(env).not.toHaveProperty(key);
    expect(SECRET_ENV_KEYS).toEqual(
      expect.arrayContaining([
        "ADMIN_PASSWORD",
        "AUTH_SECRET",
        "DATABASE_URL",
        "COMPOSE_DATABASE_URL",
        "POSTGRES_PASSWORD",
        "MONGODB_DB",
      ]),
    );
  });

  it("keeps the host user's credentials and environment verbatim", () => {
    const env = childEnv();
    for (const [key, value] of Object.entries(CREDENTIALS)) expect(env[key]).toBe(value);
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.PATH).toBe(process.env.PATH);
    const kept = Object.keys(process.env).filter(
      (key) => !SECRET_ENV_KEYS.includes(key) && !key.startsWith("OMP_UI_"),
    );
    expect(Object.keys(env).sort()).toEqual(kept.sort());
  });

  it("applies extra on top, overriding inherited values", () => {
    const env = childEnv({ GIT_TERMINAL_PROMPT: "0", GH_TOKEN: "override" });
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GH_TOKEN).toBe("override");
    expect(env.ANTHROPIC_API_KEY).toBe(CREDENTIALS.ANTHROPIC_API_KEY);
  });

  it("does not mutate process.env", () => {
    const before = { ...process.env };
    const env = childEnv({ EXTRA_ONLY_IN_CHILD: "1" });
    env.ANTHROPIC_API_KEY = "changed";
    expect(process.env).toEqual(before);
    expect(process.env.ADMIN_PASSWORD).toBe(SECRETS.ADMIN_PASSWORD);
    expect(process.env).not.toHaveProperty("EXTRA_ONLY_IN_CHILD");
  });

  it("derives HOME from the user database when it is unset", () => {
    delete process.env.HOME;
    expect(childEnv().HOME).toBe(os.userInfo().homedir);
    expect(process.env).not.toHaveProperty("HOME");
  });
});

describe("agent processes inherit host credentials", () => {
  beforeEach(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "omp-ui-child-env-test-")));
    workdir = path.join(root, "project");
    const sessionDir = path.join(root, "sessions");
    logFile = path.join(root, "fake-omp.log");
    mkdirSync(workdir);
    mkdirSync(sessionDir);

    process.env.DATABASE_URL = `sqlite:${path.join(root, "omp-ui.db")}`;
    process.env.DATA_DIR = root;
    process.env.OMP_PATH = FAKE_OMP;
    process.env.FAKE_OMP_LOG = logFile;
    process.env.FAKE_OMP_SESSION_DIR = sessionDir;
    process.env.FAKE_OMP_SCENARIO = "success";
    delete process.env.MAX_AGENTS;
    delete process.env.OMP_EXTRA_ARGS;
    Object.assign(process.env, CREDENTIALS, SECRETS);
    globals.__ompUiRepo = undefined;
    globals.__ompUiAgentManager = undefined;

    repo = await getRepo();
    board = await repo.createBoard({ name: "Test board", workdir, model: "fake/model-1" });
  });

  afterEach(async () => {
    const pendingManager = globals.__ompUiAgentManager;
    if (pendingManager) {
      const manager = await pendingManager.catch(() => null);
      if (manager) {
        const { running, queued } = manager.stats();
        await Promise.all([...running, ...queued].map((id) => manager.stop(id).catch(() => null)));
      }
    }
    const live = [...(globals.__ompUiRpcProcesses ?? [])];
    for (const proc of live) proc.kill("SIGKILL");
    await Promise.all(live.map((proc) => proc.waitExit()));
    await repo.close();
    globals.__ompUiRepo = undefined;
    globals.__ompUiAgentManager = undefined;
    rmSync(root, { recursive: true, force: true });
    restoreEnv();
  });

  it("passes HOME, SSH_AUTH_SOCK and tokens to omp but not ADMIN_PASSWORD/AUTH_SECRET/DATABASE_URL", async () => {
    const task: Task = await repo.createTask({
      boardId: board.id,
      title: "Check credentials",
      description: "",
      status: "todo",
    });
    const done = waitDone(task.id);
    const manager = await getAgentManager();
    await manager.start(task.id);
    await done;

    const [entry, ...rest] = argvEntries();
    expect(rest).toEqual([]);
    expect(entry?.env).toEqual({
      HOME: process.env.HOME || os.userInfo().homedir,
      SSH_AUTH_SOCK: CREDENTIALS.SSH_AUTH_SOCK,
      ANTHROPIC_API_KEY: CREDENTIALS.ANTHROPIC_API_KEY,
      GH_TOKEN: CREDENTIALS.GH_TOKEN,
    });

    const envKeys = entry?.envKeys ?? [];
    expect(envKeys).toEqual(expect.arrayContaining(["HOME", "PATH", ...Object.keys(CREDENTIALS)]));
    for (const key of [...SECRET_ENV_KEYS, "OMP_UI_TEST_SECRET"]) expect(envKeys).not.toContain(key);
  });
});
