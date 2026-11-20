// Git operations for project folders: clone, init, status, branches, push to the project's push branch, open PR/MR.
// Every command runs via execFile with an argument array (never a shell) and never prompts.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { childEnv } from "@/lib/child-env";
import { DEFAULT_BRANCH } from "@/lib/default-branch";
import { HttpError } from "@/lib/server/http";
import { isValidBranchName } from "@/lib/push-branch";
import type { GitBranches, GitProvider, GitRepoActionResult, GitStatus, GitSwitchResult } from "@/lib/types";
import { getWorkspaceRoot } from "@/lib/workspace";

const QUICK_TIMEOUT_MS = 15_000;
const NETWORK_TIMEOUT_MS = 2 * 60_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;

const COMMAND_ENV: NodeJS.ProcessEnv = childEnv({
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  // Fail instead of asking for an SSH passphrase/host confirmation (unless the admin configured ssh).
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes",
  GH_PROMPT_DISABLED: "1",
  NO_PROMPT: "1",
});

interface CommandResult {
  ok: boolean;
  stdout: string;
  /** stdout + stderr, trimmed. */
  output: string;
  timedOut: boolean;
  missing: boolean;
}

function run(cmd: string, args: string[], cwd: string, timeout: number): Promise<CommandResult> {
  const { promise, resolve } = Promise.withResolvers<CommandResult>();
  execFile(
    cmd,
    args,
    { cwd, timeout, env: COMMAND_ENV, maxBuffer: MAX_BUFFER, windowsHide: true },
    (err, stdout, stderr) => {
      const output = [stdout, stderr]
        .map((s) => s.trim())
        .filter(Boolean)
        .join("\n");
      resolve({
        ok: !err,
        stdout,
        output: output || (err ? err.message : ""),
        timedOut: Boolean(err?.killed),
        missing: err?.code === "ENOENT",
      });
    },
  );
  return promise;
}

function git(cwd: string, args: string[], timeout = QUICK_TIMEOUT_MS): Promise<CommandResult> {
  return run("git", args, cwd, timeout);
}

/** Turn raw git/gh/glab output into a sentence a non-expert can act on. */
function explain(cmd: string, result: CommandResult): string {
  if (result.missing) return `"${cmd}" is not installed on the server.`;
  if (result.timedOut) return `"${cmd}" took too long and was stopped. Check the network and try again.`;
  const text = result.output;
  const rules: [RegExp, string][] = [
    [
      /could not read (username|password)|authentication failed|permission denied \(publickey|terminal prompts disabled|host key verification failed|invalid username or password/i,
      "The server couldn't sign in to the git host. Set up an SSH key or saved credentials for the server user.",
    ],
    [
      /(?<!remote): permission denied|insufficient permission|read-only file system/i,
      "The server isn't allowed to write to this folder.",
    ],
    [
      /repository not found|does not appear to be a git repository|project you were looking for could not be found/i,
      "The repository wasn't found, or the server has no access to it.",
    ],
    [
      /could not resolve host|network is unreachable|connection timed out|connection refused/i,
      "The server can't reach the git host. Check the network connection.",
    ],
    [
      /protected branch|pre-receive hook declined|gh006/i,
      "This branch is protected. Use “Create PR” instead.",
    ],
    [
      /\[rejected\]|non-fast-forward|fetch first|updates were rejected/i,
      "The remote branch has newer commits. Pull them first, or use “Create PR” instead.",
    ],
    [
      /please tell me who you are|empty ident/i,
      "Git doesn't know who you are. Set user.name and user.email (git config --global).",
    ],
    [/gh auth login|not logged in|glab auth login/i, `"${cmd}" isn't signed in. Run "${cmd} auth login" on the server.`],
    [
      /would be overwritten by merge/i,
      "Uncommitted changes would be overwritten by the update. Commit or discard them, then pull.",
    ],
    [
      /would be overwritten by checkout|commit your changes or stash them/i,
      "Uncommitted changes would be overwritten by switching. Commit or discard them first.",
    ],
    [
      /not possible to fast-forward|diverging branches/i,
      "The branch has local commits that aren't on the remote, so it wasn't updated. Merge or rebase it yourself.",
    ],
    [/already exists/i, "That already exists."],
  ];
  for (const [pattern, message] of rules) if (pattern.test(text)) return message;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const fatal = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines.at(-1);
  return fatal ? fatal.replace(/^(fatal|error):\s*/i, "") : `"${cmd}" failed.`;
}

class CommandError extends Error {}

function formatCommand(cmd: string, args: string[]): string {
  return [cmd, ...args]
    .map((a) => {
      const shown = a.length > 80 ? `${a.slice(0, 77)}...` : a;
      return /[\s"']/.test(shown) ? JSON.stringify(shown) : shown;
    })
    .join(" ");
}

/** Runs commands in one folder, keeping a transcript; failing steps throw a plain-language error. */
type Step = (
  cmd: string,
  args: string[],
  timeout?: number,
  allowFailure?: boolean,
) => Promise<CommandResult>;

function makeRunner(folder: string): { log: string[]; step: Step } {
  const log: string[] = [];
  const step: Step = async (cmd, args, timeout = QUICK_TIMEOUT_MS, allowFailure = false) => {
    const result = await run(cmd, args, folder, timeout);
    log.push(`$ ${formatCommand(cmd, args)}`);
    if (result.output) log.push(result.output);
    if (!result.ok && !allowFailure) throw new CommandError(explain(cmd, result));
    return result;
  };
  return { log, step };
}

// Serialize git actions per folder so two clicks never race on the index lock.
const g = globalThis as unknown as { __ompUiGitLocks?: Map<string, Promise<unknown>> };
const locks: Map<string, Promise<unknown>> = (g.__ompUiGitLocks ??= new Map());

async function withFolderLock<T>(folder: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(folder) ?? Promise.resolve()).catch(() => undefined).then(fn);
  locks.set(folder, next);
  try {
    return await next;
  } finally {
    if (locks.get(folder) === next) locks.delete(folder);
  }
}

// ---------------------------------------------------------------------------
// Remotes / providers

function commandExists(name: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

/**
 * Remote URL without secrets (safe to show in the UI). http(s) credentials are tokens or
 * passwords (`https://user:token@host` or `https://<token>@host`), so the whole userinfo goes.
 * The ssh login name (`ssh://git@host/…`, scp-style `git@host:…`) is not a secret and is kept;
 * only an ssh password, if one was embedded, is removed.
 */
function redactRemote(remote: string): string {
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return remote; // scp-style (git@host:path) or a local path: nothing secret to redact
  }
  if (url.protocol === "https:" || url.protocol === "http:") {
    if (!url.username && !url.password) return remote;
    url.username = "";
    url.password = "";
    return url.toString();
  }
  if (!url.password) return remote;
  url.password = "";
  return url.toString();
}

function webUrlFor(remote: string): string | null {
  let origin: string;
  let repoPath: string;
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(remote);
  if (scp) {
    origin = `https://${scp[1]}`;
    repoPath = scp[2];
  } else {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return null;
    }
    if (url.protocol === "https:" || url.protocol === "http:") origin = `${url.protocol}//${url.host}`;
    else if (url.protocol === "ssh:" || url.protocol === "git:") origin = `https://${url.hostname}`;
    else return null;
    repoPath = url.pathname;
  }
  repoPath = repoPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return repoPath ? `${origin}/${repoPath}` : null;
}

function providerFor(webUrl: string | null, remote: string): GitProvider {
  let host = remote;
  if (webUrl) {
    try {
      host = new URL(webUrl).hostname;
    } catch {
      // fall back to the raw remote
    }
  }
  host = host.toLowerCase();
  if (host.includes("github")) return "github";
  if (host.includes("gitlab")) return "gitlab";
  return "other";
}

function prCliFor(provider: GitProvider | null): "gh" | "glab" | null {
  if (provider === "github") return "gh";
  if (provider === "gitlab") return "glab";
  return null;
}

async function resolveDefaultBranch(folder: string, current: string | null): Promise<string> {
  const head = await git(folder, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const fromHead = head.ok ? head.stdout.trim().replace(/^origin\//, "") : "";
  if (fromHead) return fromHead;
  for (const ref of ["refs/remotes/origin/", "refs/heads/"]) {
    for (const name of ["main", "master"]) {
      if ((await git(folder, ["rev-parse", "--verify", "--quiet", `${ref}${name}`])).ok) return name;
    }
  }
  return current ?? DEFAULT_BRANCH;
}

/**
 * The repo's own default branch: origin/HEAD, then a local/remote main or master, then the
 * checked-out branch, then "main".
 */
export async function repoDefaultBranch(folder: string): Promise<string> {
  const head = await git(folder, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return resolveDefaultBranch(folder, (head.ok && head.stdout.trim()) || null);
}

/**
 * The ref a worktree of `folder` should be created from: `branch` as a local branch, else as
 * `origin/<branch>`, else HEAD (a repo without that branch keeps today's behavior).
 */
export async function defaultBranchRef(folder: string, branch: string): Promise<string> {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    if ((await git(folder, ["rev-parse", "--verify", "--quiet", ref])).ok) return ref;
  }
  return "HEAD";
}

// ---------------------------------------------------------------------------
// Status

export async function isGitRepo(folder: string): Promise<boolean> {
  try {
    if (!fs.statSync(folder).isDirectory()) return false;
  } catch {
    return false;
  }
  const result = await git(folder, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.trim() === "true";
}

/**
 * Git status of `folder`. `options.defaultBranch` overrides the branch resolved from the repo
 * itself (the project's per-repo default branch); it is never empty.
 */
export async function gitStatus(
  folder: string,
  options?: { defaultBranch?: string | null },
): Promise<GitStatus> {
  const empty: GitStatus = {
    folder,
    isRepo: false,
    branch: null,
    defaultBranch: null,
    remoteUrl: null,
    webUrl: null,
    provider: null,
    dirty: false,
    changedFiles: 0,
    ahead: 0,
    behind: 0,
    prCliAvailable: false,
  };
  if (!(await isGitRepo(folder))) return empty;

  const [status, branchRes, remoteRes, counts] = await Promise.all([
    git(folder, ["status", "--porcelain"]),
    git(folder, ["symbolic-ref", "--short", "-q", "HEAD"]),
    git(folder, ["remote", "get-url", "origin"]),
    git(folder, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
  ]);
  const changedFiles = status.ok ? status.stdout.split("\n").filter((l) => l.trim()).length : 0;
  const branch = (branchRes.ok && branchRes.stdout.trim()) || null;
  const remote = (remoteRes.ok && remoteRes.stdout.trim()) || null;
  const webUrl = remote ? webUrlFor(remote) : null;
  const provider = remote ? providerFor(webUrl, remote) : null;
  const [behind, ahead] = counts.ok
    ? counts.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10) || 0)
    : [0, 0];
  const cli = prCliFor(provider);
  return {
    ...empty,
    isRepo: true,
    branch,
    defaultBranch: options?.defaultBranch || (await resolveDefaultBranch(folder, branch)),
    remoteUrl: remote ? redactRemote(remote) : null,
    webUrl,
    provider,
    dirty: changedFiles > 0,
    changedFiles,
    ahead: ahead ?? 0,
    behind: behind ?? 0,
    prCliAvailable: cli ? commandExists(cli) : false,
  };
}

// ---------------------------------------------------------------------------
// Discard

/**
 * Discard every uncommitted change in `folder`: `git reset --hard HEAD` restores tracked and
 * staged files, `git clean -fd` deletes untracked files and directories. Unpushed commits, git
 * checkpoints (refs/agentman/…) and ignored files are left alone.
 */
export async function discardChanges(folder: string): Promise<void> {
  return withFolderLock(folder, async () => {
    const reset = await git(folder, ["reset", "--hard", "HEAD"]);
    if (!reset.ok) throw new HttpError(400, explain("git", reset));
    const clean = await git(folder, ["clean", "-fd"]);
    if (!clean.ok) throw new HttpError(400, explain("git", clean));
  });
}

// ---------------------------------------------------------------------------
// Branches

/** Short names of the refs under `prefix`, most recent commit first. */
async function refNames(folder: string, prefix: string): Promise<string[]> {
  const strip = prefix.split("/").length;
  const result = await git(folder, ["for-each-ref", "--sort=-committerdate", `--format=%(refname:lstrip=${strip})`, prefix]);
  return result.ok ? result.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

/** Local branches (most recent commit first), then origin branches with no local copy. */
export async function listBranches(folder: string): Promise<GitBranches> {
  if (!(await isGitRepo(folder))) throw new HttpError(400, "This project folder is not a git repository.");
  const [head, localNames, remoteNames] = await Promise.all([
    git(folder, ["symbolic-ref", "--short", "-q", "HEAD"]),
    refNames(folder, "refs/heads"),
    refNames(folder, "refs/remotes/origin"),
  ]);
  const known = new Set(localNames);
  return {
    folder,
    current: (head.ok && head.stdout.trim()) || null,
    branches: [
      ...localNames.map((name) => ({ name, remoteOnly: false })),
      ...remoteNames
        .filter((name) => name !== "HEAD" && !known.has(name))
        .map((name) => ({ name, remoteOnly: true })),
    ],
  };
}

/**
 * Fast-forward the checked-out branch to its upstream. A branch without an upstream is left as is;
 * a failed pull (offline, diverged, conflicting local edits) changes nothing and returns the reason.
 */
async function pullCurrent(folder: string): Promise<Pick<GitSwitchResult, "pulled" | "pullError">> {
  const upstream = await git(folder, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (!upstream.ok) return { pulled: 0, pullError: null };
  const before = (await git(folder, ["rev-parse", "HEAD"])).stdout.trim();
  const pull = await git(folder, ["pull", "--ff-only", "--no-rebase"], NETWORK_TIMEOUT_MS);
  if (!pull.ok) return { pulled: 0, pullError: explain("git", pull) };
  const count = await git(folder, ["rev-list", "--count", `${before}..HEAD`]);
  return { pulled: (count.ok && Number.parseInt(count.stdout, 10)) || 0, pullError: null };
}

/**
 * Check out an existing branch (local, or origin-only → new local tracking branch), then pull its
 * upstream (fast-forward only). Uncommitted changes carry over unless they conflict, in which case
 * git refuses and nothing changes. A failed pull leaves the switch in place and is reported.
 */
export function switchBranch(
  folder: string,
  name: string,
  defaultBranch?: string | null,
): Promise<GitSwitchResult> {
  return withFolderLock(folder, async () => {
    const { current, branches } = await listBranches(folder);
    const branch = branches.find((b) => b.name === name);
    if (!branch) throw new HttpError(400, `There is no branch named “${name}”.`);
    if (name !== current) {
      const result = await git(
        folder,
        branch.remoteOnly ? ["switch", "--track", `origin/${name}`] : ["switch", "--", name],
      );
      if (!result.ok) throw new HttpError(400, explain("git", result));
    }
    const pull = await pullCurrent(folder);
    return { ...(await gitStatus(folder, { defaultBranch })), ...pull };
  });
}

// ---------------------------------------------------------------------------
// Clone

const URL_PATTERNS = [
  /^https:\/\/\S+$/i,
  /^ssh:\/\/\S+$/i,
  /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\S+$/,
];

function isCloneUrl(url: string): boolean {
  if (URL_PATTERNS.some((p) => p.test(url))) return true;
  return path.isAbsolute(url) && url.endsWith(".git");
}

function sanitizeName(name: string): string {
  return name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/-+$/, "")
    .slice(0, 100);
}

export async function cloneRepo(input: {
  url: string;
  name?: string | null;
  branch?: string | null;
}): Promise<{ path: string; output: string }> {
  const url = input.url.trim();
  if (!url || url.startsWith("-") || !isCloneUrl(url)) {
    throw new HttpError(
      400,
      "That doesn't look like a git repository address. Use https://…, ssh://…, git@host:owner/repo.git, or a local path ending in .git.",
    );
  }
  const branch = input.branch?.trim() || null;
  if (branch && (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-"))) {
    throw new HttpError(400, `"${branch}" is not a valid branch name.`);
  }
  const fallbackName = url.replace(/[/\\]+$/, "").split(/[/:\\]/).at(-1)?.replace(/\.git$/i, "") ?? "";
  const name = sanitizeName(input.name?.trim() || fallbackName);
  if (!name) throw new HttpError(400, "Please choose a folder name for the cloned repository.");

  const root = getWorkspaceRoot();
  const target = path.join(root, name);
  if (fs.existsSync(target)) {
    throw new HttpError(
      409,
      `A folder named "${name}" already exists in the workspace. Pick another name, or choose that folder instead.`,
    );
  }
  const args = ["clone", ...(branch ? ["--branch", branch] : []), "--", url, target];
  const result = await run("git", args, root, CLONE_TIMEOUT_MS);
  if (!result.ok) {
    fs.rmSync(target, { recursive: true, force: true });
    throw new HttpError(400, `Clone failed: ${explain("git", result)}`);
  }
  return { path: target, output: result.output };
}

// ---------------------------------------------------------------------------
// Init

/** Absolute, normalized path of an existing directory; 400 with a plain reason otherwise. */
function resolveFolder(raw: string): string {
  const trimmed = raw.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new HttpError(400, `Please use a full folder path starting with "/" (got "${trimmed}").`);
  }
  const folder = path.resolve(trimmed);
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(folder).isDirectory();
  } catch {
    // Missing or unreadable: reported below.
  }
  if (!isDirectory) throw new HttpError(400, `This folder doesn't exist (or isn't a folder): ${folder}`);
  return folder;
}

/** Whether an existing folder is inside a git work tree (a sub-folder of a repository counts). */
export async function checkRepo(raw: string): Promise<{ path: string; isGitRepo: boolean }> {
  const folder = resolveFolder(raw);
  return { path: folder, isGitRepo: await isGitRepo(folder) };
}

/** `git init` an existing folder that is not yet inside a git work tree (server's git config applies). */
export async function initRepo(raw: string): Promise<{ path: string; output: string }> {
  const folder = resolveFolder(raw);
  return withFolderLock(folder, async () => {
    if (await isGitRepo(folder)) {
      throw new HttpError(409, `This folder is already a git repository: ${folder}`);
    }
    const result = await git(folder, ["init"]);
    if (!result.ok) throw new HttpError(400, `Couldn't initialize git: ${explain("git", result)}`);
    return { path: folder, output: result.output };
  });
}

// ---------------------------------------------------------------------------
// Push / PR

export interface GitFolderOutcome {
  result: GitRepoActionResult;
  /** One plain-language line for the task comment (links included). */
  summary: string;
}

function label(folder: string): string {
  return `${path.basename(folder) || folder}/`;
}

/** `-c user.name/-c user.email` when the server user has no git identity, so commits never fail on it. */
async function identityArgs(folder: string): Promise<string[]> {
  const email = await git(folder, ["config", "user.email"]);
  if (email.ok && email.stdout.trim()) return [];
  return ["-c", "user.name=AgentMan", "-c", "user.email=agentman@localhost"];
}

/** Commit everything if the tree is dirty; returns the new commit sha or null. */
async function commitAll(
  folder: string,
  step: Step,
  message: string,
): Promise<string | null> {
  const status = await step("git", ["status", "--porcelain"]);
  if (!status.stdout.trim()) return null;
  await step("git", ["add", "-A"]);
  await step("git", [...(await identityArgs(folder)), "commit", "-m", message]);
  return (await step("git", ["rev-parse", "HEAD"])).stdout.trim();
}

/** Commits not yet on origin/<branch>; null when the remote branch is unknown. */
async function unpushedCount(folder: string, remoteBranch: string): Promise<number | null> {
  const ref = `refs/remotes/origin/${remoteBranch}`;
  if (!(await git(folder, ["rev-parse", "--verify", "--quiet", ref])).ok) return null;
  const count = await git(folder, ["rev-list", "--count", `${ref}..HEAD`]);
  return count.ok ? Number.parseInt(count.stdout.trim(), 10) || 0 : null;
}

function baseResult(folder: string): GitRepoActionResult {
  return { folder, branch: null, commit: null, url: null, output: "", error: null, skipped: false };
}

/**
 * Commit uncommitted changes (if any) and push HEAD to `target` on origin (the project's push
 * branch), creating it there if missing.
 */
export function pushToBranch(folder: string, target: string, message: string): Promise<GitFolderOutcome> {
  return withFolderLock(folder, async () => {
    const result = baseResult(folder);
    const name = label(folder);
    if (!isValidBranchName(target)) {
      const error = `“${target}” isn't a valid branch name. Change the project's push branch in its settings.`;
      return { result: { ...result, error }, summary: `Couldn't push ${name}: ${error}` };
    }
    const status = await gitStatus(folder);
    if (!status.isRepo) {
      return { result: { ...result, skipped: true, output: "Not a git repository." }, summary: `${name}: not a git repository, skipped.` };
    }
    if (!status.remoteUrl) {
      const error = "This folder has no “origin” remote, so there is nowhere to push.";
      return { result: { ...result, error }, summary: `Couldn't push ${name}: ${error}` };
    }
    const { log, step } = makeRunner(folder);
    try {
      result.branch = target;
      await step("git", ["fetch", "origin", `refs/heads/${target}`], NETWORK_TIMEOUT_MS, true);
      result.commit = await commitAll(folder, step, message);
      if (!result.commit && (await unpushedCount(folder, target)) === 0) {
        return {
          result: { ...result, branch: null, skipped: true, output: log.join("\n") },
          summary: `Nothing to push in ${name}`,
        };
      }
      await step("git", ["push", "origin", `HEAD:refs/heads/${target}`], NETWORK_TIMEOUT_MS);
      const sha = (await step("git", ["rev-parse", "HEAD"])).stdout.trim();
      if (status.webUrl && status.provider === "github") result.url = `${status.webUrl}/commit/${sha}`;
      else if (status.webUrl && status.provider === "gitlab") result.url = `${status.webUrl}/-/commit/${sha}`;
      else result.url = status.webUrl;
      result.output = log.join("\n");
      return {
        result,
        summary: `Pushed to ${target} in ${name}${result.url ? ` — ${result.url}` : ""}`,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        result: { ...result, output: log.join("\n"), error },
        summary: `Couldn't push ${name} to ${target}: ${error}`,
      };
    }
  });
}

function compareUrl(status: GitStatus, base: string, branch: string): string | null {
  if (!status.webUrl) return null;
  if (status.provider === "github") return `${status.webUrl}/compare/${base}...${branch}?expand=1`;
  if (status.provider === "gitlab") {
    const q = new URLSearchParams({
      "merge_request[source_branch]": branch,
      "merge_request[target_branch]": base,
    });
    return `${status.webUrl}/-/merge_requests/new?${q.toString()}`;
  }
  return null;
}

function findUrl(output: string): string | null {
  const urls = output.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  return urls.find((u) => /\/pull\/\d+|merge_requests\/\d+/.test(u)) ?? urls.at(-1) ?? null;
}

/**
 * Commit to a new branch `branchName` from the current HEAD, push it, and open a PR (gh) / MR
 * (glab) against `baseBranch` (the project's default branch for that repo, else the repo's own).
 * Without the CLI, the branch is still pushed and the provider's "new PR" link returned.
 */
export function createPullRequest(
  folder: string,
  input: { title: string; body: string; branchName: string; baseBranch?: string | null },
): Promise<GitFolderOutcome> {
  return withFolderLock(folder, async () => {
    const result = baseResult(folder);
    const name = label(folder);
    const status = await gitStatus(folder, { defaultBranch: input.baseBranch });
    if (!status.isRepo) {
      return { result: { ...result, skipped: true, output: "Not a git repository." }, summary: `${name}: not a git repository, skipped.` };
    }
    if (!status.remoteUrl) {
      const error = "This folder has no “origin” remote, so a pull request can't be opened.";
      return { result: { ...result, error }, summary: `Couldn't open a PR for ${name}: ${error}` };
    }
    const base = status.defaultBranch ?? DEFAULT_BRANCH;
    const { log, step } = makeRunner(folder);
    try {
      await step("git", ["fetch", "origin", base], NETWORK_TIMEOUT_MS, true);
      if (!status.dirty && (await unpushedCount(folder, base)) === 0) {
        return {
          result: { ...result, skipped: true, output: log.join("\n") },
          summary: `Nothing to put in a pull request for ${name}`,
        };
      }
      const branch = input.branchName;
      await step("git", ["switch", "-c", branch]);
      result.branch = branch;
      result.commit = await commitAll(folder, step, input.title);
      await step("git", ["push", "-u", "origin", branch], NETWORK_TIMEOUT_MS);

      const fallback = compareUrl(status, base, branch);
      const cli = prCliFor(status.provider);
      if (cli && commandExists(cli)) {
        const args =
          cli === "gh"
            ? ["pr", "create", "--title", input.title, "--body", input.body, "--base", base, "--head", branch]
            : [
                "mr",
                "create",
                "--title",
                input.title,
                "--description",
                input.body,
                "--target-branch",
                base,
                "--source-branch",
                branch,
                "--yes",
              ];
        const created = await step(cli, args, NETWORK_TIMEOUT_MS, true);
        const url = created.ok ? findUrl(created.output) : null;
        if (url) {
          result.url = url;
          result.output = log.join("\n");
          const kind = cli === "gh" ? "PR" : "MR";
          return { result, summary: `Opened ${kind} for ${name} — ${url}` };
        }
        log.push(`Couldn't open it automatically: ${explain(cli, created)}`);
      }
      result.url = fallback;
      result.output = log.join("\n");
      return {
        result,
        summary: fallback
          ? `Pushed branch ${branch} in ${name} — open the pull request here: ${fallback}`
          : `Pushed branch ${branch} in ${name}. Open a pull request for it on your git host.`,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        result: { ...result, output: log.join("\n"), error },
        summary: `Couldn't open a PR for ${name}: ${error}`,
      };
    }
  });
}
