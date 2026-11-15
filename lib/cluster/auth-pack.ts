// The primary's git/npm authentication, shipped to every node so cards run there with nothing to
// set up. The pack is a staging folder (DATA_DIR/cluster/staging/auth, mode 0700, files 0600)
// synced down to the node's DATA_DIR/cluster/auth for each remote run and by replication:
//   gitconfig        includes the node's own ~/.gitconfig, then the primary's identity and portable
//                    settings, then a `store` credential helper reading $OMPUI_AUTH_DIR/git-credentials
//   git-credentials  the primary's stored credentials plus its GitHub token (env or `gh auth token`)
//   npmrc            the primary's npm user config
// Tokens for the run environment (GH_TOKEN, GITLAB_TOKEN, NPM_TOKEN, …) are returned, never written.
// SSH private keys are never shipped and the node's real HOME is never written to.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { clusterPaths } from "@/lib/cluster/paths";

const execFileAsync = promisify(execFile);

/** The pack is rebuilt at most this often. */
const PACK_REFRESH_MS = 60_000;
/** Limit for each `git config` / `gh auth token` call. */
const TOOL_TIMEOUT_MS = 5_000;

const GITCONFIG = "gitconfig";
const GIT_CREDENTIALS = "git-credentials";
const NPMRC = "npmrc";

/** Global git settings copied when set on the primary (identity is handled separately). */
const PORTABLE_GIT_SETTINGS: ReadonlyArray<[section: string, key: string]> = [
  ["init", "defaultBranch"],
  ["pull", "rebase"],
  ["push", "autoSetupRemote"],
];

/** Tokens forwarded from the primary's environment as they are. */
const FORWARDED_TOKENS = ["GITLAB_TOKEN", "GL_TOKEN", "NPM_TOKEN"] as const;

export interface AuthPack {
  /** The staging folder (primary path). */
  dir: string;
  /** Run environment: tokens only; never written to disk. */
  env: Record<string, string>;
}

/** Where a node keeps the pack: DATA_DIR/cluster/auth of the node with DATA_DIR `nodeDataDir`. */
export function nodeAuthDir(nodeDataDir: string): string {
  return path.join(nodeDataDir, "cluster", "auth");
}

interface PackState {
  key: string;
  builtAt: number;
  pending: Promise<AuthPack> | null;
  last: AuthPack | null;
}

let state: PackState | null = null;

/**
 * Build (at most every 60 s; concurrent calls share one build) the auth pack from this machine's
 * HOME and environment. Missing tools or files only make the pack smaller.
 */
export function buildAuthPack(): Promise<AuthPack> {
  const home = os.homedir();
  const dir = path.join(clusterPaths().staging, "auth");
  const key = `${dir}\0${home}`;
  if (!state || state.key !== key) state = { key, builtAt: 0, pending: null, last: null };
  const current = state;
  if (current.pending) return current.pending;
  if (current.last && Date.now() - current.builtAt < PACK_REFRESH_MS) return Promise.resolve(current.last);
  const pending = writePack(dir, home)
    .then((pack) => {
      current.builtAt = Date.now();
      current.last = pack;
      return pack;
    })
    .finally(() => {
      current.pending = null;
    });
  current.pending = pending;
  return pending;
}

/** Environment of a run whose node holds the pack at `nodeAuthDir` (a node path). */
export function authRunEnv(nodeAuthDir: string, pack: AuthPack): Record<string, string> {
  const env: Record<string, string> = {
    ...pack.env,
    OMPUI_AUTH_DIR: nodeAuthDir,
    GIT_CONFIG_GLOBAL: path.join(nodeAuthDir, GITCONFIG),
  };
  if (existsSync(path.join(pack.dir, NPMRC))) env.NPM_CONFIG_USERCONFIG = path.join(nodeAuthDir, NPMRC);
  return env;
}

async function writePack(dir: string, home: string): Promise<AuthPack> {
  const [identity, settings, storedCredentials, githubToken, npmrc] = await Promise.all([
    Promise.all([gitGlobal("user.name"), gitGlobal("user.email")]),
    Promise.all(PORTABLE_GIT_SETTINGS.map(([section, key]) => gitGlobal(`${section}.${key}`))),
    readCredentialLines(home),
    githubTokenOf(),
    readOptional(process.env.NPM_CONFIG_USERCONFIG?.trim() || path.join(home, ".npmrc")),
  ]);

  const credentials = [...storedCredentials];
  if (githubToken && !credentials.some(coversGithub)) {
    credentials.push(`https://x-access-token:${encodeURIComponent(githubToken)}@github.com`);
  }

  await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  await writeSecret(path.join(dir, GITCONFIG), gitconfigText(identity, settings));
  await writeOrRemove(path.join(dir, GIT_CREDENTIALS), credentials.length > 0 ? `${credentials.join("\n")}\n` : null);
  await writeOrRemove(path.join(dir, NPMRC), npmrc);

  const env: Record<string, string> = {};
  if (githubToken) {
    env.GH_TOKEN = githubToken;
    env.GITHUB_TOKEN = githubToken;
  }
  for (const name of FORWARDED_TOKENS) {
    const value = process.env[name]?.trim();
    if (value) env[name] = value;
  }
  return { dir, env };
}

function gitconfigText([name, email]: (string | null)[], settings: (string | null)[]): string {
  const lines = ["[include]", "\tpath = ~/.gitconfig"];
  if (name || email) {
    lines.push("[user]");
    if (name) lines.push(`\tname = ${gitValue(name)}`);
    if (email) lines.push(`\temail = ${gitValue(email)}`);
  }
  PORTABLE_GIT_SETTINGS.forEach(([section, key], i) => {
    const value = settings[i];
    if (value) lines.push(`[${section}]`, `\t${key} = ${gitValue(value)}`);
  });
  // git runs credential helpers through the shell, so the variable expands on the node.
  lines.push("[credential]", '\thelper = store --file=\\"$OMPUI_AUTH_DIR/git-credentials\\"');
  return `${lines.join("\n")}\n`;
}

/** A git config value, quoted and escaped. */
function gitValue(value: string): string {
  return `"${value.replace(/[\r\n]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** `git config --global --get <key>`, or null when unset or git is unavailable. */
async function gitGlobal(key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--global", "--get", key], {
      timeout: TOOL_TIMEOUT_MS,
      encoding: "utf8",
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Stored git credentials: ~/.git-credentials, plus the pack this server itself runs with (a
 * promoted node using the replicated pack passes its credentials on).
 */
async function readCredentialLines(home: string): Promise<string[]> {
  const files = [path.join(home, ".git-credentials")];
  const ownPack = process.env.OMPUI_AUTH_DIR?.trim();
  if (ownPack) files.push(path.join(ownPack, GIT_CREDENTIALS));
  const lines = new Set<string>();
  for (const file of files) {
    const text = await readOptional(file);
    for (const line of text?.split("\n") ?? []) {
      const trimmed = line.trim();
      if (trimmed) lines.add(trimmed);
    }
  }
  return [...lines];
}

function coversGithub(line: string): boolean {
  try {
    return new URL(line).hostname === "github.com";
  } catch {
    return false;
  }
}

/** GH_TOKEN / GITHUB_TOKEN, else `gh auth token --hostname github.com`; null when there is none. */
async function githubTokenOf(): Promise<string | null> {
  const fromEnv = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token", "--hostname", "github.com"], {
      timeout: TOOL_TIMEOUT_MS,
      encoding: "utf8",
    });
    return stdout.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function writeOrRemove(file: string, content: string | null): Promise<void> {
  if (content === null) await fs.rm(file, { force: true });
  else await writeSecret(file, content);
}

/**
 * Replace `file` atomically with `content` (mode 0600), via a temp file next to the pack so a sync
 * scanning it never sees partial files; unchanged files keep their mtime, so syncs skip them.
 */
async function writeSecret(file: string, content: string): Promise<void> {
  if ((await readOptional(file)) === content) {
    await fs.chmod(file, 0o600);
    return;
  }
  const temp = `${path.dirname(file)}.${path.basename(file)}.tmp`;
  await fs.writeFile(temp, content, { mode: 0o600 });
  await fs.chmod(temp, 0o600);
  await fs.rename(temp, file);
}
