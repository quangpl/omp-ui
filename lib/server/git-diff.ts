// A card's code changes for the Changes tab: per folder the card works in (its worktree, else the
// project folder), the uncommitted changes (staged, unstaged and untracked) plus the commits on
// HEAD that are not on the base branch. Every git command runs via spawn with an argument array
// (never a shell), reads at most a capped amount of output, and is scoped to the folder
// (`--relative`), so nothing outside the board's folders or the card's worktrees is touched.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { childEnv } from "@/lib/child-env";
import type { DiffFile, DiffFileStatus, RepoDiff, TaskDiff } from "@/lib/diff-types";
import type { Board, Task } from "@/lib/types";
import { getWorkspace } from "@/lib/workspaces";

const GIT_TIMEOUT_MS = 20_000;
/** Patch text sent to the browser, across every repo of the card. */
const MAX_TOTAL_PATCH_BYTES = 400 * 1024;
/** One file's patch is cut at this size. */
const MAX_FILE_PATCH_BYTES = 160 * 1024;
/** Raw git output read per command; the rest is dropped (the diff is marked truncated). */
const MAX_READ_BYTES = 8 * 1024 * 1024;
/** Untracked files larger than this are listed without content. */
const MAX_UNTRACKED_BYTES = 256 * 1024;
/** Untracked files whose content is read; further ones are listed without content. */
const MAX_UNTRACKED_READS = 300;
/** Files listed per repo. */
const MAX_FILES = 2000;
/** Bytes inspected for a NUL to tell binary files apart. */
const BINARY_SNIFF_BYTES = 8000;
/** A computed diff is reused this long (the summary request follows the diff request). */
const REUSE_MS = 4000;

// No index refresh/lock while the card's agent may be working in the same folder.
const ENV = childEnv({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });

interface ReadResult {
  ok: boolean;
  stdout: string;
  /** Output went past the read limit and was cut. */
  cut: boolean;
  stderr: string;
}

/** Run git in `cwd`, keeping at most `maxBytes` of stdout. */
function gitRead(cwd: string, args: string[], maxBytes = MAX_READ_BYTES): Promise<ReadResult> {
  const { promise, resolve } = Promise.withResolvers<ReadResult>();
  const child = spawn("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    env: ENV,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const chunks: Buffer[] = [];
  let size = 0;
  let cut = false;
  let stderr = "";
  let settled = false;
  const finish = (ok: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ ok, stdout: Buffer.concat(chunks).toString("utf8"), cut, stderr: stderr.trim() });
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    stderr ||= "git took too long.";
    finish(false);
  }, GIT_TIMEOUT_MS);
  child.stdout.on("data", (chunk: Buffer) => {
    if (cut) return;
    const room = maxBytes - size;
    if (chunk.length > room) {
      chunks.push(chunk.subarray(0, room));
      size = maxBytes;
      cut = true;
      child.kill("SIGTERM");
      return;
    }
    chunks.push(chunk);
    size += chunk.length;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  child.on("error", (err: NodeJS.ErrnoException) => {
    stderr = err.code === "ENOENT" ? "git is not installed on the server." : err.message;
    finish(false);
  });
  child.on("close", (code) => finish(cut || code === 0));
  return promise;
}

async function gitText(cwd: string, args: string[]): Promise<string | null> {
  const result = await gitRead(cwd, args, 64 * 1024);
  const text = result.stdout.trim();
  return result.ok && text ? text : null;
}

/** POSIX shell quoting, for the copy-paste command only (never executed here). */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** origin's default branch ("main"), else a local/remote main or master; null when none. */
async function defaultBranch(folder: string): Promise<string | null> {
  const head = await gitText(folder, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^origin\//, "");
  for (const name of ["main", "master"]) {
    for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
      if (await gitText(folder, ["rev-parse", "--verify", "--quiet", ref])) return name;
    }
  }
  return null;
}

interface Base {
  /** Commit the working tree is compared with. */
  sha: string;
  /** Display name of the base branch; null = HEAD (uncommitted changes only). */
  ref: string | null;
}

/**
 * The commit the card's changes started from. A worktree branched off its source folder's branch;
 * a shared project folder is compared with its upstream (unpushed commits) or the default branch.
 * No base branch → HEAD; no commit at all → the empty tree.
 */
async function resolveBase(folder: string, branch: string | null, source: string | null): Promise<Base> {
  const candidates: { ref: string; label: string }[] = [];
  const main = await defaultBranch(folder);
  if (source) {
    const sourceBranch = await gitText(source, ["symbolic-ref", "--short", "-q", "HEAD"]);
    if (sourceBranch && sourceBranch !== branch) candidates.push({ ref: `refs/heads/${sourceBranch}`, label: sourceBranch });
    if (main && main !== branch) candidates.push({ ref: `refs/heads/${main}`, label: main });
    if (main) candidates.push({ ref: `refs/remotes/origin/${main}`, label: `origin/${main}` });
  } else {
    const upstream = await gitText(folder, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    if (upstream) candidates.push({ ref: "@{upstream}", label: upstream });
    if (main) candidates.push({ ref: `refs/remotes/origin/${main}`, label: `origin/${main}` });
    if (main && main !== branch) candidates.push({ ref: `refs/heads/${main}`, label: main });
  }
  const head = await gitText(folder, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head) {
    const empty = await gitText(folder, ["hash-object", "-t", "tree", "--stdin"]);
    return { sha: empty ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904", ref: null };
  }
  for (const { ref, label } of candidates) {
    const sha = await gitText(folder, ["merge-base", ref, "HEAD"]);
    if (sha) return { sha, ref: label };
  }
  return { sha: head, ref: null };
}

interface Entry {
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
}

/** `git diff --name-status -z`: status, then one path (two for renames and copies). */
function parseNameStatus(raw: string): Entry[] {
  const tokens = raw.split("\0");
  const entries: Entry[] = [];
  for (let i = 0; i < tokens.length; ) {
    const code = tokens[i++];
    if (!code) continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i++] ?? "";
      const newPath = tokens[i++] ?? "";
      if (newPath) entries.push({ path: newPath, oldPath: letter === "R" ? oldPath : null, status: letter === "R" ? "R" : "A" });
      continue;
    }
    const file = tokens[i++] ?? "";
    if (!file) continue;
    entries.push({ path: file, oldPath: null, status: letter === "A" ? "A" : letter === "D" ? "D" : "M" });
  }
  return entries;
}

interface Counts {
  additions: number;
  deletions: number;
  binary: boolean;
}

/** `git diff --numstat -z`: "add\tdel\tpath\0", or "add\tdel\t\0old\0new\0" for renames. Keyed by new path. */
function parseNumstat(raw: string): Map<string, Counts> {
  const tokens = raw.split("\0");
  const counts = new Map<string, Counts>();
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i++];
    if (!token) continue;
    const [added = "", deleted = "", file = ""] = token.split("\t");
    let key = file;
    if (!file) {
      i++; // old path
      key = tokens[i++] ?? "";
    }
    if (!key) continue;
    const binary = added === "-" || deleted === "-";
    counts.set(key, {
      additions: binary ? 0 : Number.parseInt(added, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deleted, 10) || 0,
      binary,
    });
  }
  return counts;
}

interface Chunk {
  header: string;
  binary: boolean;
  /** Text from the first `@@` line on; null when there are no hunks. */
  hunks: string | null;
  /** The read limit cut this chunk short. */
  partial: boolean;
}

/** Split `git diff` output into one chunk per `diff --git` header. */
function splitPatch(raw: string, cut: boolean): Chunk[] {
  const chunks: Chunk[] = [];
  const parts = raw.split(/^(?=diff --git )/m).filter((part) => part.startsWith("diff --git "));
  parts.forEach((part, index) => {
    const partial = cut && index === parts.length - 1;
    const body = partial ? part.slice(0, part.lastIndexOf("\n") + 1) : part;
    const newline = body.indexOf("\n");
    const header = newline === -1 ? body : body.slice(0, newline);
    const hunkStart = body.search(/^@@ /m);
    const preamble = hunkStart === -1 ? body : body.slice(0, hunkStart);
    chunks.push({
      header,
      binary: /^(Binary files .* differ|GIT binary patch)$/m.test(preamble),
      hunks: hunkStart === -1 ? null : body.slice(hunkStart).replace(/\n$/, ""),
      partial,
    });
  });
  return chunks;
}

/** Whether a `diff --git a/… b/…` header names `file` as its new path. */
function headerMatches(header: string, file: string): boolean {
  return header.endsWith(` b/${file}`) || header.endsWith(` "b/${file}"`);
}

interface Budget {
  remaining: number;
}

/** Fit `text` into the per-file and remaining total budget; cut at a line end. */
function takePatch(text: string, budget: Budget): { patch: string | null; truncated: boolean } {
  const size = Buffer.byteLength(text);
  const limit = Math.min(MAX_FILE_PATCH_BYTES, budget.remaining);
  if (size <= limit) {
    budget.remaining -= size;
    return { patch: text, truncated: false };
  }
  if (limit < 4096) return { patch: null, truncated: true };
  // Character slicing is close enough to bytes for a cap; keep whole lines.
  const slice = text.slice(0, limit);
  const end = slice.lastIndexOf("\n");
  const patch = end > 0 ? slice.slice(0, end) : slice;
  budget.remaining -= Buffer.byteLength(patch);
  return { patch, truncated: true };
}

/** An untracked file as an all-added diff, without following symlinks or leaving `folder`. */
async function untrackedFile(folder: string, file: string, readContent: boolean, budget: Budget): Promise<DiffFile> {
  const base: DiffFile = {
    path: file,
    oldPath: null,
    status: "A",
    additions: 0,
    deletions: 0,
    binary: false,
    untracked: true,
    patch: null,
    truncated: false,
  };
  const full = path.resolve(folder, file);
  if (!full.startsWith(folder + path.sep)) return { ...base, truncated: true };
  let text: string;
  try {
    const info = await fs.lstat(full);
    if (info.isSymbolicLink()) {
      text = `${await fs.readlink(full)}`;
    } else {
      if (!info.isFile()) return { ...base, truncated: true };
      if (!readContent || info.size > MAX_UNTRACKED_BYTES) return { ...base, truncated: true };
      const content = await fs.readFile(full);
      if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { ...base, binary: true };
      text = content.toString("utf8");
    }
  } catch {
    return { ...base, truncated: true };
  }
  if (text === "") return { ...base, patch: "" };
  const endsWithNewline = text.endsWith("\n");
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split("\n");
  const hunks = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)];
  if (!endsWithNewline) hunks.push("\\ No newline at end of file");
  const { patch, truncated } = takePatch(hunks.join("\n"), budget);
  return { ...base, additions: lines.length, patch, truncated };
}

function emptyRepo(folder: string, isRepo: boolean, error: string | null): RepoDiff {
  return {
    folder,
    name: path.basename(folder) || folder,
    isRepo,
    branch: null,
    baseRef: null,
    commitsAhead: 0,
    files: [],
    truncated: false,
    command: "",
    error,
  };
}

/** The changes in one folder. `source` is the project folder a worktree was made from (null when shared). */
async function repoDiff(folder: string, source: string | null, budget: Budget): Promise<RepoDiff> {
  const isFolder = await fs.stat(folder).then((info) => info.isDirectory(), () => false);
  if (!isFolder) return emptyRepo(folder, false, "This folder no longer exists.");
  const inside = await gitText(folder, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return emptyRepo(folder, false, null);

  const branch = await gitText(folder, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const base = await resolveBase(folder, branch, source);
  const range = ["--find-renames", "--relative", base.sha, "--"];
  const [names, numstat, patch, others, ahead] = await Promise.all([
    gitRead(folder, ["diff", "--name-status", "-z", ...range]),
    gitRead(folder, ["diff", "--numstat", "-z", ...range]),
    gitRead(folder, ["diff", "--no-color", "--no-ext-diff", "-U3", ...range]),
    gitRead(folder, ["ls-files", "--others", "--exclude-standard", "-z"]),
    base.ref ? gitText(folder, ["rev-list", "--count", `${base.sha}..HEAD`]) : Promise.resolve(null),
  ]);
  const command = `cd ${shellQuote(folder)} && git diff ${base.ref ? `$(git merge-base ${shellQuote(base.ref)} HEAD)` : "HEAD"}`;
  const repo: RepoDiff = {
    ...emptyRepo(folder, true, null),
    branch,
    baseRef: base.ref,
    commitsAhead: ahead ? Number.parseInt(ahead, 10) || 0 : 0,
    command,
  };
  if (!names.ok || !numstat.ok) {
    return { ...repo, error: (names.stderr || numstat.stderr).split("\n").at(-1)?.replace(/^(fatal|error):\s*/i, "") || "git diff failed." };
  }

  const entries = parseNameStatus(names.stdout);
  const counts = parseNumstat(numstat.stdout);
  const chunks = patch.ok ? splitPatch(patch.stdout, patch.cut) : [];
  let truncated = names.cut || numstat.cut || patch.cut || !patch.ok || entries.length > MAX_FILES;
  const files: DiffFile[] = [];
  for (const [index, entry] of entries.slice(0, MAX_FILES).entries()) {
    const count = counts.get(entry.path) ?? { additions: 0, deletions: 0, binary: false };
    // Same order as --name-status; search when a file changed between the two commands.
    const chunk = chunks[index] && headerMatches(chunks[index].header, entry.path)
      ? chunks[index]
      : chunks.find((c) => headerMatches(c.header, entry.path));
    const file: DiffFile = {
      ...entry,
      ...count,
      binary: count.binary || Boolean(chunk?.binary),
      untracked: false,
      patch: null,
      truncated: false,
    };
    if (!chunk) {
      file.truncated = !file.binary;
    } else if (chunk.hunks !== null && !file.binary) {
      const taken = takePatch(chunk.hunks, budget);
      file.patch = taken.patch;
      file.truncated = taken.truncated || chunk.partial;
    }
    if (file.truncated) truncated = true;
    files.push(file);
  }

  const untracked = others.ok
    ? others.stdout.split("\0").filter((name) => name && !name.endsWith("/"))
    : [];
  const room = Math.max(0, MAX_FILES - files.length);
  if (untracked.length > room || others.cut) truncated = true;
  for (const [index, name] of untracked.slice(0, room).entries()) {
    const file = await untrackedFile(folder, name, index < MAX_UNTRACKED_READS, budget);
    if (file.truncated) truncated = true;
    files.push(file);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ...repo, files, truncated };
}

/** Folders the card's changes live in: its existing worktrees, else the board's folders (deduped). */
async function diffFolders(board: Board, task: Pick<Task, "id" | "title">): Promise<{ folder: string; source: string | null }[]> {
  const workspace = await getWorkspace(board, task);
  const seen = new Set<string>();
  const folders: { folder: string; source: string | null }[] = [];
  for (const f of workspace.folders) {
    const isolated = f.isolated && f.exists;
    const folder = path.resolve(isolated ? f.path : f.source);
    if (seen.has(folder)) continue;
    seen.add(folder);
    folders.push({ folder, source: isolated ? path.resolve(f.source) : null });
  }
  return folders;
}

async function computeTaskDiff(board: Board, task: Pick<Task, "id" | "title">): Promise<TaskDiff> {
  const budget: Budget = { remaining: MAX_TOTAL_PATCH_BYTES };
  const repos: RepoDiff[] = [];
  // One repo at a time: the patch budget goes to the first folders first.
  for (const { folder, source } of await diffFolders(board, task)) {
    repos.push(await repoDiff(folder, source, budget));
  }
  const stats = { files: 0, additions: 0, deletions: 0 };
  for (const repo of repos) {
    for (const file of repo.files) {
      stats.files++;
      stats.additions += file.additions;
      stats.deletions += file.deletions;
    }
  }
  const hash = createHash("sha256")
    .update(JSON.stringify(repos.map((r) => [r.folder, r.baseRef, r.files])))
    .digest("hex");
  return {
    taskId: task.id,
    repos,
    stats,
    truncated: repos.some((r) => r.truncated),
    hash,
    generatedAt: new Date().toISOString(),
  };
}

const g = globalThis as unknown as { __ompUiTaskDiffs?: Map<string, { at: number; diff: Promise<TaskDiff> }> };
const recent: Map<string, { at: number; diff: Promise<TaskDiff> }> = (g.__ompUiTaskDiffs ??= new Map());

/**
 * The card's code changes. A diff computed in the last few seconds is reused (the Changes tab
 * asks for the diff and its summary together); `fresh` always recomputes.
 */
export function taskDiff(board: Board, task: Pick<Task, "id" | "title">, fresh = false): Promise<TaskDiff> {
  const now = Date.now();
  for (const [id, entry] of recent) if (now - entry.at > REUSE_MS) recent.delete(id);
  const hit = recent.get(task.id);
  if (hit && !fresh) return hit.diff;
  const diff = computeTaskDiff(board, task);
  recent.set(task.id, { at: now, diff });
  diff.catch(() => recent.delete(task.id));
  return diff;
}
