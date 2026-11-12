// End-to-end tests for the `omp-ui` CLI (bin/omp-ui.mjs) and its ./omp-ui sh wrapper.
// Every suite works in throwaway project directories (see helpers.ts) so the real repo's .env
// and data/ are never read or written. Lifecycle suites run the real production build.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  COMMANDS,
  FAKE_OMP_VERSION,
  LIFECYCLE_TIMEOUT,
  PACKAGE_VERSION,
  STANDALONE_SERVER,
  createProject,
  deadPid,
  fileMode,
  freePort,
  health,
  isAlive,
  isAuthenticated,
  login,
  portOpen,
  runProcess,
  serverPids,
  waitUntil,
  type TempProject,
} from "./helpers";

const HEX_64 = /^[0-9a-f]{64}$/;

if (!fs.existsSync(STANDALONE_SERVER)) {
  throw new Error(`Missing ${STANDALONE_SERVER} — build the app before running the CLI tests.`);
}

/** `init` with everything explicit, so no prompt or machine-specific default is involved. */
function initArgs(project: TempProject, port: number, password: string, extra: string[] = []): string[] {
  return [
    "init",
    "--yes",
    "--password",
    password,
    "--port",
    String(port),
    "--omp-path",
    project.fakeOmp,
    "--workspace",
    path.join(project.root, "workspace"),
    ...extra,
  ];
}

describe("help, version and argument errors", () => {
  let project: TempProject;

  beforeAll(() => {
    project = createProject();
  });
  afterAll(async () => {
    await project.cleanup();
  });

  it.each<[string[]]>([[[]], [["--help"]], [["-h"]], [["help"]]])("main help for %j lists every command", async (args) => {
    const r = await project.run(args);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("Usage");
    expect(r.stdout).toContain("omp-ui <command> [options]");
    expect(r.stdout).toContain(PACKAGE_VERSION);
    for (const name of COMMANDS) expect(r.stdout).toMatch(new RegExp(`^  ${name}\\s+\\S`, "m"));
    // No color codes with NO_COLOR.
    expect(r.stdout).not.toContain("\x1b[");
  });

  it.each(COMMANDS.map((name) => [name]))("%s --help prints its usage", async (name) => {
    const r = await project.run([name, "--help"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain(`omp-ui ${name} — `);
    expect(r.stdout).toContain("Usage");
    expect(r.stdout).toContain(`omp-ui ${name}`);
    expect(r.stdout).toContain("Options");
    expect(r.stdout).toContain("-h, --help");
  });

  it("help <command> and <command> -h print the command help", async () => {
    for (const args of [["help", "init"], ["init", "-h"]]) {
      const r = await project.run(args);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("omp-ui init — ");
      expect(r.stdout).toContain("--password <pw>");
      expect(r.stdout).toContain("--force");
    }
  });

  it("--help does not run the command", async () => {
    const r = await project.run(["init", "--help"]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(project.envFile)).toBe(false);
  });

  it("rejects an unknown command with a pointer to --help", async () => {
    const r = await project.run(["frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain('Unknown command "frobnicate"');
    expect(r.stderr).toContain("omp-ui --help");
  });

  it("rejects unknown options and stray arguments with a pointer to the command help", async () => {
    const unknown = await project.run(["status", "--bogus"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("--bogus");
    expect(unknown.stderr).toContain("omp-ui status --help");

    const stray = await project.run(["stop", "now"]);
    expect(stray.code).toBe(1);
    expect(stray.stderr).toContain("omp-ui stop --help");
  });

  it.each<[string[]]>([[["version"]], [["--version"]], [["-v"]]])("%j prints the package version", async (args) => {
    const r = await project.run(args);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(`omp-ui ${PACKAGE_VERSION} (node ${process.versions.node})`);
  });

  it("the ./omp-ui wrapper forwards to the CLI, also through a symlink", async () => {
    const direct = await runProcess("sh", [project.wrapper, "--version"], { env: project.env, cwd: project.home });
    expect(direct.code).toBe(0);
    expect(direct.stdout.trim()).toBe(`omp-ui ${PACKAGE_VERSION} (node ${process.versions.node})`);

    const link = path.join(project.home, "omp-ui-link");
    fs.symlinkSync(project.wrapper, link);
    const viaLink = await runProcess(link, ["status", "--help"], { env: project.env, cwd: project.home });
    expect(viaLink.code).toBe(0);
    expect(viaLink.stdout).toContain("omp-ui status — ");
  });
});

describe("init", () => {
  let project: TempProject;
  let port: number;

  beforeEach(async () => {
    project = createProject();
    port = await freePort();
  });
  afterEach(async () => {
    await project.cleanup();
  });

  it("writes a complete sqlite .env with mode 0600", async () => {
    const workspace = path.join(project.root, "workspace");
    const r = await project.run(initArgs(project, port, "init-secret-1", ["--db", "sqlite"]));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Wrote .env");

    const env = project.readEnv();
    expect(env.PORT).toBe(String(port));
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.DATA_DIR).toBe("./data");
    expect(env.DATABASE_URL).toBe("sqlite:./data/omp-ui.db");
    expect(env.ADMIN_PASSWORD).toBe("init-secret-1");
    expect(env.AUTH_SECRET).toMatch(HEX_64);
    expect(env.OMP_PATH).toBe(project.fakeOmp);
    expect(env.MAX_AGENTS).toBe("2");
    expect(env.WORKSPACE_DIR).toBe(workspace);
    expect(fileMode(project.envFile)).toBe(0o600);
    expect(fs.statSync(project.dataDir).isDirectory()).toBe(true);
    expect(fs.statSync(workspace).isDirectory()).toBe(true);
  });

  it("writes .env into the CLI's project root regardless of cwd", async () => {
    const r = await project.run(initArgs(project, port, "init-secret-1"), { cwd: project.home });
    expect(r.code).toBe(0);
    expect(fs.existsSync(project.envFile)).toBe(true);
    expect(fs.existsSync(path.join(project.home, ".env"))).toBe(false);
  });

  it("generates and prints a password when none is given; workspace defaults to ~/omp-workspace", async () => {
    const r = await project.run(["init", "--yes", "--omp-path", project.fakeOmp]);
    expect(r.code).toBe(0);
    const env = project.readEnv();
    expect(env.ADMIN_PASSWORD.length).toBeGreaterThanOrEqual(8);
    // Shown in a banner (also meant for pm2 logs): title line, then the value close by.
    const banner = r.stdout.search(/ADMIN PASSWORD/i);
    expect(banner).toBeGreaterThanOrEqual(0);
    const shown = r.stdout.indexOf(env.ADMIN_PASSWORD, banner);
    expect(shown).toBeGreaterThanOrEqual(0);
    expect(shown - banner).toBeLessThan(200);
    expect(env.PORT).toBe("3000");
    expect(env.DATABASE_URL).toBe("sqlite:./data/omp-ui.db");
    const workspace = path.join(project.home, "omp-workspace");
    expect(env.WORKSPACE_DIR).toBe(workspace);
    expect(fs.statSync(workspace).isDirectory()).toBe(true);
  });

  it("takes the password from ADMIN_PASSWORD in the environment", async () => {
    const r = await project.run(["init", "--yes", "--omp-path", project.fakeOmp], {
      env: { ADMIN_PASSWORD: "from-env-pass" },
    });
    expect(r.code).toBe(0);
    expect(project.readEnv().ADMIN_PASSWORD).toBe("from-env-pass");
    expect(r.stdout).not.toContain("from-env-pass");
  });

  it("refuses to overwrite an existing .env without --force", async () => {
    expect((await project.run(initArgs(project, port, "init-secret-1"))).code).toBe(0);
    const before = fs.readFileSync(project.envFile, "utf8");

    const r = await project.run(initArgs(project, port, "other-secret-2"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(".env already exists");
    expect(r.stderr).toContain("--force");
    expect(fs.readFileSync(project.envFile, "utf8")).toBe(before);
  });

  it("--force rewrites .env but keeps AUTH_SECRET and unknown keys", async () => {
    expect((await project.run(initArgs(project, port, "init-secret-1"))).code).toBe(0);
    const secret = project.readEnv().AUTH_SECRET;
    fs.appendFileSync(project.envFile, "CUSTOM_FLAG=keep-me\n");

    const r = await project.run(initArgs(project, port, "other-secret-2", ["--force"]));
    expect(r.code).toBe(0);
    const env = project.readEnv();
    expect(env.AUTH_SECRET).toBe(secret);
    expect(env.ADMIN_PASSWORD).toBe("other-secret-2");
    expect(env.CUSTOM_FLAG).toBe("keep-me");
    expect(fileMode(project.envFile)).toBe(0o600);
  });

  it("--force without flags keeps every existing value", async () => {
    const url = "postgres://u:p@h/db";
    const workspace = path.join(project.root, "workspace");
    const created = await project.run(
      initArgs(project, port, "init-secret-1", ["--db-url", url, "--max-agents", "4"]),
    );
    expect(created.code).toBe(0);
    const before = project.readEnv();

    const r = await project.run(["init", "--force", "--yes"]);
    expect(r.code, r.output).toBe(0);
    expect(r.stdout).not.toContain("init-secret-1");
    const env = project.readEnv();
    expect(env).toEqual(before);
    expect(env).toMatchObject({
      PORT: String(port),
      DATABASE_URL: url,
      ADMIN_PASSWORD: "init-secret-1",
      OMP_PATH: project.fakeOmp,
      MAX_AGENTS: "4",
      WORKSPACE_DIR: workspace,
    });
  });

  it("--force with flags changes only those values", async () => {
    expect((await project.run(initArgs(project, port, "init-secret-1"))).code).toBe(0);
    const before = project.readEnv();
    const newPort = await freePort();

    const r = await project.run(["init", "--force", "--yes", "--port", String(newPort)]);
    expect(r.code, r.output).toBe(0);
    expect(project.readEnv()).toEqual({ ...before, PORT: String(newPort) });
  });

  it.each<[string, string, string]>([
    ["postgres", "postgres://u:p@h/db", "PostgreSQL"],
    ["mongodb", "mongodb://h/db", "MongoDB"],
  ])("--db %s --db-url writes the given DATABASE_URL", async (db, url, label) => {
    const r = await project.run(initArgs(project, port, "init-secret-1", ["--db", db, "--db-url", url]));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Using ${label} at ${url}`);
    expect(project.readEnv().DATABASE_URL).toBe(url);
  });

  it.each<[string[], string]>([
    [["--db-url", "postgresql://u:p@h:5432/db"], "postgresql://u:p@h:5432/db"],
    [["--mongo-url", "mongodb+srv://u:p@cluster.example/db"], "mongodb+srv://u:p@cluster.example/db"],
    [["--db", "pg", "--db-url", "postgres://u:p@h/db"], "postgres://u:p@h/db"],
  ])("infers the driver / accepts aliases: %j", async (flags, url) => {
    const r = await project.run(initArgs(project, port, "init-secret-1", flags));
    expect(r.code).toBe(0);
    expect(project.readEnv().DATABASE_URL).toBe(url);
  });

  it("--data-dir moves the sqlite database", async () => {
    const dataDir = path.join(project.root, "state");
    const r = await project.run(initArgs(project, port, "init-secret-1", ["--data-dir", `${dataDir}/`]));
    expect(r.code).toBe(0);
    const env = project.readEnv();
    expect(env.DATA_DIR).toBe(dataDir);
    expect(env.DATABASE_URL).toBe(`sqlite:${dataDir}/omp-ui.db`);
    expect(fs.statSync(dataDir).isDirectory()).toBe(true);
  });

  it("stores passwords with quotes, spaces and $ so they read back verbatim", async () => {
    const password = `it's a "pass" $HOME #1`;
    const r = await project.run(initArgs(project, port, password));
    expect(r.code).toBe(0);
    expect(project.readEnv().ADMIN_PASSWORD).toBe(password);
  });

  it.each<[string[], string]>([
    [["--db", "oracle"], 'Unknown database "oracle"'],
    [["--db", "postgres", "--db-url", "mongodb://h/db"], 'Invalid PostgreSQL URL "mongodb://h/db"'],
    [["--db", "mongodb", "--db-url", "http://h/db"], 'Invalid MongoDB URL "http://h/db"'],
    [["--max-agents", "0"], 'Invalid max agents "0"'],
  ])("rejects %j without writing .env", async (flags, message) => {
    const r = await project.run(initArgs(project, port, "init-secret-1", flags));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(message);
    expect(fs.existsSync(project.envFile)).toBe(false);
  });

  it("rejects a short password and an invalid port", async () => {
    const short = await project.run(initArgs(project, port, "short"));
    expect(short.code).toBe(1);
    expect(short.stderr).toContain("at least 8 characters");

    const badPort = await project.run(["init", "--yes", "--password", "init-secret-1", "--port", "70000"]);
    expect(badPort.code).toBe(1);
    expect(badPort.stderr).toContain('Invalid port: "70000"');
    expect(fs.existsSync(project.envFile)).toBe(false);
  });
});

describe("passwd (server not running)", () => {
  let project: TempProject;

  beforeEach(() => {
    project = createProject();
  });
  afterEach(async () => {
    await project.cleanup();
  });

  it("fails without a .env", async () => {
    const r = await project.run(["passwd", "new-password-1"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No .env found");
  });

  it("updates ADMIN_PASSWORD and leaves everything else alone", async () => {
    expect((await project.run(initArgs(project, await freePort(), "old-password-1"))).code).toBe(0);
    const before = project.readEnv();

    const r = await project.run(["passwd", "new-password-1"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Admin password saved to .env");
    expect(r.stdout).toContain("Applied at next boot");
    expect(project.readEnv()).toEqual({ ...before, ADMIN_PASSWORD: "new-password-1" });
    expect(fileMode(project.envFile)).toBe(0o600);
    expect(fs.existsSync(project.pidFile)).toBe(false);
  });

  it("reads the password from stdin when no argument is given", async () => {
    expect((await project.run(initArgs(project, await freePort(), "old-password-1"))).code).toBe(0);
    const r = await project.run(["passwd"], { input: "piped-password-9\nignored second line\n" });
    expect(r.code).toBe(0);
    expect(project.readEnv().ADMIN_PASSWORD).toBe("piped-password-9");
  });

  it("rejects short passwords and extra arguments without touching .env", async () => {
    expect((await project.run(initArgs(project, await freePort(), "old-password-1"))).code).toBe(0);
    const before = fs.readFileSync(project.envFile, "utf8");

    const short = await project.run(["passwd", "short"]);
    expect(short.code).toBe(1);
    expect(short.stderr).toContain("at least 8 characters");

    const extra = await project.run(["passwd", "two", "words-here"]);
    expect(extra.code).toBe(1);
    expect(extra.stderr).toContain("Too many arguments");

    expect(fs.readFileSync(project.envFile, "utf8")).toBe(before);
  });
});

describe("doctor", () => {
  let project: TempProject;

  beforeEach(() => {
    project = createProject();
  });
  afterEach(async () => {
    await project.cleanup();
  });

  it("passes on an initialized project and lists the Node, .env and omp checks", async () => {
    expect((await project.run(initArgs(project, await freePort(), "doctor-pass-1"))).code).toBe(0);
    const r = await project.run(["doctor"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(project.root);
    expect(r.stdout).toMatch(new RegExp(`✓ Node\\.js\\s+v${process.versions.node.replace(/\./g, "\\.")}`));
    expect(r.stdout).toMatch(/✓ \.env\s+\.env/);
    expect(r.stdout).toMatch(/✓ Admin password\s+set in \.env/);
    expect(r.stdout).toMatch(new RegExp(`✓ omp\\s+${FAKE_OMP_VERSION}`));
    expect(r.stdout).toMatch(/✓ Dependencies\s+installed/);
    expect(r.stdout).toMatch(/✓ Build\s+up to date/);
    expect(r.stdout).toMatch(/Server\s+not running/);
    expect(r.stdout).toContain("All good");
  });

  it("warns when .env is readable by others", async () => {
    expect((await project.run(initArgs(project, await freePort(), "doctor-pass-1"))).code).toBe(0);
    fs.chmodSync(project.envFile, 0o644);
    const r = await project.run(["doctor"]);
    expect(r.stdout).toMatch(/! \.env\s+readable by others \(mode 644\)/);
  });

  it("reports a missing .env", async () => {
    const r = await project.run(["doctor"]);
    expect(r.stdout).toMatch(/! \.env\s+missing — run: omp-ui init/);
  });
});

describe("start/logs preconditions", () => {
  let project: TempProject;

  afterEach(async () => {
    await project.cleanup();
  });

  it("start without a production build fails with a hint", async () => {
    project = createProject({ build: false });
    expect((await project.run(initArgs(project, await freePort(), "start-pass-1"))).code).toBe(0);
    const r = await project.run(["start"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No production build found");
    expect(r.stderr).toContain("omp-ui up");
    expect(fs.existsSync(project.pidFile)).toBe(false);
  });

  it("start refuses a port that is already taken", async () => {
    project = createProject();
    const port = await freePort();
    expect((await project.run(initArgs(project, port, "start-pass-1"))).code).toBe(0);
    project.setEnv({ HOST: "127.0.0.1" });
    const blocker = net.createServer();
    blocker.listen(port, "127.0.0.1");
    await once(blocker, "listening");
    try {
      const r = await project.run(["start"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`Port ${port} is already in use`);
      expect(r.stderr).toContain("--port");
      expect(fs.existsSync(project.pidFile)).toBe(false);
      expect(serverPids(project.root)).toEqual([]);
    } finally {
      blocker.close();
      await once(blocker, "close");
    }
  });

  it("logs fails cleanly before the first start and validates -n", async () => {
    project = createProject();
    expect((await project.run(initArgs(project, await freePort(), "start-pass-1"))).code).toBe(0);
    const none = await project.run(["logs"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("No log file yet");

    const bad = await project.run(["logs", "-n", "abc"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('Invalid line count "abc"');
  });
});

describe("pm2-managed server guards (simulated, pm2 not required)", () => {
  let project: TempProject;
  let fakeServer: ChildProcess | undefined;
  let pid: number;

  beforeEach(async () => {
    project = createProject();
    expect((await project.run(initArgs(project, await freePort(), "pm2-guard-pass-1"))).code).toBe(0);
    project.setEnv({ HOST: "127.0.0.1" });
    // A live process whose command line contains "server.js" passes the CLI's pid-reuse guard;
    // the second pid-file line "pm2" is the marker `start --foreground` writes under pm2.
    const script = path.join(project.root, "fake", "server.js");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "setInterval(() => {}, 1000);\n");
    fakeServer = spawn(process.execPath, [script], { stdio: "ignore" });
    pid = fakeServer.pid as number;
    fs.writeFileSync(project.pidFile, `${pid}\npm2\n`);
  });
  afterEach(async () => {
    fakeServer?.kill("SIGKILL");
    fakeServer = undefined;
    await project.cleanup();
  });

  it.each<[string[], string]>([
    [["stop"], "omp-ui pm2 stop"],
    [["restart"], "omp-ui pm2 restart"],
    [["up"], "omp-ui pm2 restart"],
  ])("%j refuses to touch it and points at omp-ui pm2", async (args, hint) => {
    const r = await project.run(args);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`managed by pm2 (pid ${pid})`);
    expect(r.stderr).toContain(hint);
    expect(isAlive(pid)).toBe(true);
    expect(fs.readFileSync(project.pidFile, "utf8")).toBe(`${pid}\npm2\n`);
  });

  it("start and status report the pm2-managed server instead of spawning another", async () => {
    const start = await project.run(["start"]);
    expect(start.code).toBe(0);
    expect(start.stdout).toContain(`Already running (pid ${pid}, managed by pm2)`);
    expect(serverPids(project.root)).toEqual([]);

    const status = await project.run(["status"]);
    expect(status.stdout).toContain("running under pm2");
    expect(status.stdout).toContain("omp-ui pm2");
    expect(isAlive(pid)).toBe(true);
  });
});

describe("server lifecycle: start / status / logs / passwd / restart / stop", () => {
  const PASSWORD = "lifecycle-pass-1";
  // Quotes, spaces and $ exercise .env quoting all the way into the server's environment.
  const NEW_PASSWORD = `new "life" cycle's $pass`;
  let project: TempProject;
  let port: number;
  let pid: number;
  let sideProcess: ChildProcess | undefined;

  beforeAll(async () => {
    project = createProject();
    port = await freePort();
    const r = await project.run(initArgs(project, port, PASSWORD));
    expect(r.code).toBe(0);
    // Keep the test server on loopback only.
    project.setEnv({ HOST: "127.0.0.1" });
  });
  afterAll(async () => {
    sideProcess?.kill("SIGKILL");
    await project.cleanup();
  });

  it("status reports stopped (exit 3) before the first start", async () => {
    const r = await project.run(["status", "--json"]);
    expect(r.code).toBe(3);
    const status = JSON.parse(r.stdout);
    expect(status).toMatchObject({ running: false, pid: null, health: null, tunnel: null });
  });

  it(
    "start launches the server in the background and waits for health",
    async () => {
      const r = await project.run(["start"]);
      expect(r.code, r.output).toBe(0);
      expect(r.stdout).toContain("Server is up");
      expect(r.stdout).toContain(`http://localhost:${port}`);

      pid = project.readPid() as number;
      expect(pid).toBeGreaterThan(0);
      expect(isAlive(pid)).toBe(true);
      const h = await health(port);
      expect(h).toMatchObject({ ok: true, db: "sqlite" });
      expect(typeof h?.version).toBe("string");
      // DATA_DIR resolved inside the temp project, not the repo.
      expect(fs.existsSync(path.join(project.dataDir, "omp-ui.db"))).toBe(true);
      if (process.platform === "linux") expect(serverPids(project.root)).toEqual([pid]);
    },
    LIFECYCLE_TIMEOUT,
  );

  it("status --json reports running with health", async () => {
    const r = await project.run(["status", "--json"]);
    expect(r.code).toBe(0);
    const status = JSON.parse(r.stdout);
    expect(status.running).toBe(true);
    expect(status.pid).toBe(pid);
    expect(status.url).toBe(`http://localhost:${port}`);
    expect(status.lan).toEqual([]);
    expect(Number.isNaN(Date.parse(status.startedAt))).toBe(false);
    expect(status.health).toMatchObject({ ok: true, db: "sqlite" });
    expect(status.tunnel).toBeNull();
  });

  it("status prints a human summary", async () => {
    const r = await project.run(["status"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("● running");
    expect(r.stdout).toContain(`pid ${pid}`);
    expect(r.stdout).toMatch(/Health\s+ok/);
  });

  it("a second start does not spawn a duplicate", async () => {
    const r = await project.run(["start"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Already running (pid ${pid})`);
    expect(project.readPid()).toBe(pid);
    if (process.platform === "linux") expect(serverPids(project.root)).toEqual([pid]);
  });

  it("logs -n 5 prints the tail of the server log", async () => {
    const r = await project.run(["logs", "-n", "5"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.replace(/\n$/, "").split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.length).toBeLessThanOrEqual(5);

    const all = await project.run(["logs"]);
    expect(all.stdout).toContain(`=== omp-ui start`);
    expect(all.stdout).toContain(`port ${port} ===`);
  });

  // Regression: `lines.slice(-0)` used to dump the whole log for `-n 0` (and replay it under -f).
  it("logs -n 0 prints nothing", async () => {
    const r = await project.run(["logs", "-n", "0"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("login works with ADMIN_PASSWORD from .env (applied at boot)", async () => {
    const ok = await login(port, PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.token).toBeTruthy();
    expect(await isAuthenticated(port, ok.token as string)).toBe(true);

    expect((await login(port, "wrong-password")).status).toBe(401);
  });

  it(
    "passwd while running restarts the server and applies the new password",
    async () => {
      const oldToken = (await login(port, PASSWORD)).token as string;
      const oldPid = pid;

      const r = await project.run(["passwd", NEW_PASSWORD]);
      expect(r.code, r.output).toBe(0);
      expect(r.stdout).toContain("Restarting to apply it");
      expect(r.stdout).toContain("New password is active");
      expect(project.readEnv().ADMIN_PASSWORD).toBe(NEW_PASSWORD);

      pid = project.readPid() as number;
      expect(pid).not.toBe(oldPid);
      expect(isAlive(oldPid)).toBe(false);
      expect(await health(port)).toMatchObject({ ok: true });

      const fresh = await login(port, NEW_PASSWORD);
      expect(fresh.status).toBe(200);
      expect(await isAuthenticated(port, fresh.token as string)).toBe(true);
      expect((await login(port, PASSWORD)).status).toBe(401);
      // Changing the password signs out existing sessions.
      expect(await isAuthenticated(port, oldToken)).toBe(false);
    },
    LIFECYCLE_TIMEOUT,
  );

  it(
    "restart replaces the server process",
    async () => {
      const oldPid = pid;
      const r = await project.run(["restart"]);
      expect(r.code, r.output).toBe(0);
      expect(r.stdout).toContain("Server stopped");
      expect(r.stdout).toContain("Server is up");
      pid = project.readPid() as number;
      expect(pid).not.toBe(oldPid);
      expect(isAlive(oldPid)).toBe(false);
      expect(await health(port)).toMatchObject({ ok: true });
      expect((await login(port, NEW_PASSWORD)).status).toBe(200);
    },
    LIFECYCLE_TIMEOUT,
  );

  it("stop terminates the server, removes the pid file and frees the port", async () => {
    const r = await project.run(["stop"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Server stopped");
    await waitUntil(() => !isAlive(pid));
    expect(fs.existsSync(project.pidFile)).toBe(false);
    await waitUntil(async () => !(await portOpen(port)));
    expect(serverPids(project.root)).toEqual([]);

    const status = await project.run(["status", "--json"]);
    expect(status.code).toBe(3);
    expect(JSON.parse(status.stdout).running).toBe(false);
  }, LIFECYCLE_TIMEOUT);

  it("stop when not running exits cleanly", async () => {
    const r = await project.run(["stop"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Server is not running");
  });

  it("status clears a stale pid file whose process is gone", async () => {
    fs.writeFileSync(project.pidFile, `${deadPid()}\n`);
    const r = await project.run(["status", "--json"]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({ running: false, pid: null });
    expect(fs.existsSync(project.pidFile)).toBe(false);
  });

  it("a pid file pointing at an unrelated live process is ignored and that process is never killed", async () => {
    sideProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const unrelated = sideProcess.pid as number;

    fs.writeFileSync(project.pidFile, `${unrelated}\n`);
    const status = await project.run(["status", "--json"]);
    expect(status.code).toBe(3);
    expect(JSON.parse(status.stdout).running).toBe(false);
    expect(fs.existsSync(project.pidFile)).toBe(false);

    fs.writeFileSync(project.pidFile, `${unrelated}\n`);
    const stop = await project.run(["stop"]);
    expect(stop.code).toBe(0);
    expect(stop.stdout).toContain("Server is not running");
    expect(isAlive(unrelated)).toBe(true);

    sideProcess.kill("SIGKILL");
    sideProcess = undefined;
  });

  it(
    "start replaces a stale pid file",
    async () => {
      const stale = deadPid();
      fs.writeFileSync(project.pidFile, `${stale}\n`);
      const r = await project.run(["start"]);
      expect(r.code, r.output).toBe(0);
      expect(r.stdout).toContain("Server is up");
      pid = project.readPid() as number;
      expect(pid).not.toBe(stale);
      expect(isAlive(pid)).toBe(true);
      expect(await health(port)).toMatchObject({ ok: true });

      const stop = await project.run(["stop"]);
      expect(stop.code).toBe(0);
      await waitUntil(() => !isAlive(pid));
      expect(fs.existsSync(project.pidFile)).toBe(false);
    },
    LIFECYCLE_TIMEOUT,
  );
});

describe("up on a fresh project", () => {
  const PASSWORD = "up-password-1";
  let project: TempProject;
  let port: number;
  let port2: number;
  let pid: number;

  beforeAll(async () => {
    project = createProject();
    port = await freePort();
    port2 = await freePort();
  });
  afterAll(async () => {
    await project.cleanup();
  });

  it(
    "initializes .env and starts without installing or building",
    async () => {
      const r = await project.run(["up", "--password", PASSWORD, "--port", String(port)]);
      expect(r.code, r.output).toBe(0);
      expect(r.stdout).toContain("First run — creating .env");
      expect(r.stdout).not.toContain("Installing dependencies");
      expect(r.stdout).not.toContain("Building OMP UI");
      expect(r.stdout).toContain("Server is up");
      expect(r.stdout).toContain(`http://localhost:${port}`);
      expect(r.stdout).toContain("Next steps");

      const env = project.readEnv();
      expect(env.PORT).toBe(String(port));
      expect(env.ADMIN_PASSWORD).toBe(PASSWORD);
      expect(env.AUTH_SECRET).toMatch(HEX_64);
      expect(env.DATABASE_URL).toBe("sqlite:./data/omp-ui.db");
      expect(env.WORKSPACE_DIR).toBe(path.join(project.home, "omp-workspace"));
      expect(fileMode(project.envFile)).toBe(0o600);

      pid = project.readPid() as number;
      expect(isAlive(pid)).toBe(true);
      expect(await health(port)).toMatchObject({ ok: true, db: "sqlite" });
      expect((await login(port, PASSWORD)).status).toBe(200);
    },
    LIFECYCLE_TIMEOUT,
  );

  it("a second up leaves the running server alone", async () => {
    const r = await project.run(["up"]);
    expect(r.code, r.output).toBe(0);
    expect(r.stdout).not.toContain("First run");
    expect(r.stdout).toContain(`Already running (pid ${pid})`);
    expect(project.readPid()).toBe(pid);
  });

  it(
    "up --port moves a running server to the new port and saves it",
    async () => {
      const r = await project.run(["up", "--port", String(port2)]);
      expect(r.code, r.output).toBe(0);
      expect(r.stdout).toContain(`Saved PORT=${port2} to .env`);
      expect(r.stdout).toContain(`Port changed — restarting on ${port2}`);
      expect(project.readEnv().PORT).toBe(String(port2));

      const oldPid = pid;
      pid = project.readPid() as number;
      expect(pid).not.toBe(oldPid);
      expect(isAlive(oldPid)).toBe(false);
      expect(await health(port2)).toMatchObject({ ok: true });
      await waitUntil(async () => !(await portOpen(port)));
    },
    LIFECYCLE_TIMEOUT,
  );

  it("stop shuts it down", async () => {
    const r = await project.run(["stop"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Server stopped");
    await waitUntil(() => !isAlive(pid));
    expect(fs.existsSync(project.pidFile)).toBe(false);
    await waitUntil(async () => !(await portOpen(port2)));
  }, LIFECYCLE_TIMEOUT);
});
