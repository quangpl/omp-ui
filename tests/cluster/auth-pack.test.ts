import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authRunEnv, buildAuthPack, nodeAuthDir } from "@/lib/cluster/auth-pack";

const ENV_KEYS = [
  "DATA_DIR",
  "HOME",
  "PATH",
  "XDG_CONFIG_HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "GL_TOKEN",
  "NPM_TOKEN",
  "NPM_CONFIG_USERCONFIG",
  "OMPUI_AUTH_DIR",
] as const;

const HELPER_LINE = '\thelper = store --file=\\"$OMPUI_AUTH_DIR/git-credentials\\"';

describe("auth pack", () => {
  const saved = new Map<string, string | undefined>();
  let root = "";
  let home = "";
  let bin = "";

  /** A `gh` on PATH ahead of any real one: prints `token`, or fails when null. */
  const fakeGh = (token: string | null): void => {
    const script = token === null ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\necho ${token}\n`;
    writeFileSync(path.join(bin, "gh"), script);
    chmodSync(path.join(bin, "gh"), 0o755);
  };

  const read = (dir: string, name: string): string => readFileSync(path.join(dir, name), "utf8");

  beforeEach(() => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "omp-ui-auth-pack-")));
    home = path.join(root, "home");
    bin = path.join(root, "bin");
    mkdirSync(home);
    mkdirSync(bin);
    process.env.DATA_DIR = path.join(root, "data");
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.PATH = `${bin}${path.delimiter}${saved.get("PATH") ?? ""}`;
    for (const key of [
      "GIT_CONFIG_GLOBAL",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GITLAB_TOKEN",
      "GL_TOKEN",
      "NPM_TOKEN",
      "NPM_CONFIG_USERCONFIG",
      "OMPUI_AUTH_DIR",
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("packs the primary's git identity, credentials, GitHub token and npmrc", async () => {
    writeFileSync(
      path.join(home, ".gitconfig"),
      "[user]\n\tname = Primary User\n\temail = primary@example.com\n[init]\n\tdefaultBranch = trunk\n",
    );
    writeFileSync(path.join(home, ".git-credentials"), "https://alice:pw@gitlab.example.com\n");
    writeFileSync(path.join(home, ".npmrc"), "//registry.npmjs.org/:_authToken=npm_secret\n");
    process.env.GITLAB_TOKEN = "glpat-123";
    fakeGh("ghp_fromgh");

    const [pack, again] = await Promise.all([buildAuthPack(), buildAuthPack()]);
    expect(again).toBe(pack);

    expect(pack.dir).toBe(path.join(root, "data", "cluster", "staging", "auth"));
    expect(statSync(pack.dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(pack.dir).sort()).toEqual(["git-credentials", "gitconfig", "npmrc"]);
    for (const name of readdirSync(pack.dir)) {
      expect(statSync(path.join(pack.dir, name)).mode & 0o777, name).toBe(0o600);
    }

    const gitconfig = read(pack.dir, "gitconfig").split("\n");
    expect(gitconfig.slice(0, 2)).toEqual(["[include]", "\tpath = ~/.gitconfig"]);
    expect(gitconfig).toContain('\tname = "Primary User"');
    expect(gitconfig).toContain('\temail = "primary@example.com"');
    expect(gitconfig).toContain('\tdefaultBranch = "trunk"');
    expect(gitconfig).not.toContain("[pull]");
    expect(gitconfig).toContain(HELPER_LINE);
    expect(gitconfig.indexOf(HELPER_LINE)).toBeGreaterThan(gitconfig.indexOf('\temail = "primary@example.com"'));

    expect(read(pack.dir, "git-credentials")).toBe(
      "https://alice:pw@gitlab.example.com\nhttps://x-access-token:ghp_fromgh@github.com\n",
    );
    expect(read(pack.dir, "npmrc")).toBe("//registry.npmjs.org/:_authToken=npm_secret\n");
    expect(pack.env).toEqual({ GH_TOKEN: "ghp_fromgh", GITHUB_TOKEN: "ghp_fromgh", GITLAB_TOKEN: "glpat-123" });
  });

  it("prefers the environment's GitHub token and keeps an existing github.com credential", async () => {
    writeFileSync(path.join(home, ".git-credentials"), "https://bob:stored@github.com\n");
    process.env.GH_TOKEN = "ghp_fromenv";
    fakeGh("ghp_fromgh");

    const pack = await buildAuthPack();

    expect(read(pack.dir, "git-credentials")).toBe("https://bob:stored@github.com\n");
    expect(pack.env).toEqual({ GH_TOKEN: "ghp_fromenv", GITHUB_TOKEN: "ghp_fromenv" });
  });

  it("builds a gitconfig-only pack without gh, token, identity or files", async () => {
    fakeGh(null);

    const pack = await buildAuthPack();

    expect(readdirSync(pack.dir)).toEqual(["gitconfig"]);
    expect(read(pack.dir, "gitconfig")).toBe(`[include]\n\tpath = ~/.gitconfig\n[credential]\n${HELPER_LINE}\n`);
    expect(pack.env).toEqual({});
  });

  it("authRunEnv points git and npm at the node's copy of the pack", async () => {
    writeFileSync(path.join(home, ".npmrc"), "registry=https://registry.example.com/\n");
    process.env.GITHUB_TOKEN = "ghp_env";
    fakeGh(null);
    const pack = await buildAuthPack();
    const nodeDir = nodeAuthDir("/srv/node-data");

    expect(nodeDir).toBe("/srv/node-data/cluster/auth");
    expect(authRunEnv(nodeDir, pack)).toEqual({
      GH_TOKEN: "ghp_env",
      GITHUB_TOKEN: "ghp_env",
      OMPUI_AUTH_DIR: nodeDir,
      GIT_CONFIG_GLOBAL: "/srv/node-data/cluster/auth/gitconfig",
      NPM_CONFIG_USERCONFIG: "/srv/node-data/cluster/auth/npmrc",
    });
    expect(authRunEnv(nodeDir, { dir: path.join(root, "no-pack"), env: {} })).toEqual({
      OMPUI_AUTH_DIR: nodeDir,
      GIT_CONFIG_GLOBAL: "/srv/node-data/cluster/auth/gitconfig",
    });
  });

  it("gives git on a node the primary's identity and credentials while keeping the node's own settings", async () => {
    writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = Primary User\n\temail = primary@example.com\n");
    fakeGh("ghp_e2e");
    const pack = await buildAuthPack();

    // The node: its own HOME (with its own ~/.gitconfig), the pack at OMPUI_AUTH_DIR.
    const nodeHome = path.join(root, "node-home");
    mkdirSync(nodeHome);
    writeFileSync(path.join(nodeHome, ".gitconfig"), "[core]\n\teditor = node-editor\n[user]\n\temail = node@example.com\n");
    const env = {
      ...process.env,
      HOME: nodeHome,
      XDG_CONFIG_HOME: path.join(nodeHome, ".config"),
      GIT_TERMINAL_PROMPT: "0",
      ...authRunEnv(pack.dir, pack),
    };
    const git = (args: string[], input?: string): string =>
      execFileSync("git", args, { cwd: root, env, encoding: "utf8", input }).trim();

    expect(git(["config", "--get", "user.email"])).toBe("primary@example.com");
    expect(git(["config", "--get", "user.name"])).toBe("Primary User");
    expect(git(["config", "--get", "core.editor"])).toBe("node-editor");
    expect(git(["config", "--get", "credential.helper"])).toBe('store --file="$OMPUI_AUTH_DIR/git-credentials"');

    const filled = git(["credential", "fill"], "protocol=https\nhost=github.com\n\n").split("\n");
    expect(filled).toContain("username=x-access-token");
    expect(filled).toContain("password=ghp_e2e");
  });
});
