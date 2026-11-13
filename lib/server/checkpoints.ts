// Git checkpoints: before each run (Settings → gitCheckpoints) every git project folder of the card
// is snapshotted as a commit under refs/agentman/checkpoints/<taskId>/<id>, so a run that wrecks
// the files can be rolled back from the card. Snapshots go through a temporary index file: the
// user's branch, index, stash and working tree are never touched, and ignored files are skipped.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { childEnv } from "@/lib/child-env";
import type { TaskCheckpoint } from "@/lib/types";

/** `git add -A` hashes every file whose stat data the temporary index lacks (no seed index). */
const GIT_TIMEOUT_MS = 2 * 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const REF_ROOT = "refs/agentman/checkpoints";
/** Newest snapshots kept per card and repository; older refs are deleted. */
export const MAX_CHECKPOINTS_PER_TASK = 20;
/** Task ids and checkpoint ids become ref name segments: keep them to safe characters. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Snapshots are AgentMan's own commits: no identity lookup, never signed (no prompts). */
const COMMIT_CONFIG = ["-c", "user.name=AgentMan", "-c", "user.email=agentman@localhost", "-c", "commit.gpgsign=false"];
const GITLINK_MODE = "160000";

export const BEFORE_RESTORE_LABEL = "Before restore";

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<GitResult> {
  const { promise, resolve } = Promise.withResolvers<GitResult>();
  execFile(
    "git",
    args,
    {
      cwd,
      env: childEnv({ GIT_TERMINAL_PROMPT: "0", ...env }),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    },
    (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) || (err ? err.message : "") }),
  );
  return promise;
}

/** Like git(), but a failing command throws with git's own explanation. */
async function mustGit(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const result = await git(cwd, args, env);
  if (!result.ok) throw new Error(`git ${args[0]} failed in ${cwd}: ${result.stderr.trim() || "unknown error"}`);
  return result.stdout;
}

// Snapshots and restores of one folder never overlap (two runs starting at once, double clicks).
const g = globalThis as unknown as { __ompUiCheckpointLocks?: Map<string, Promise<unknown>> };
const locks: Map<string, Promise<unknown>> = (g.__ompUiCheckpointLocks ??= new Map());

async function withFolderLock<T>(folder: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(folder) ?? Promise.resolve()).catch(() => undefined).then(fn);
  locks.set(folder, next);
  try {
    return await next;
  } finally {
    if (locks.get(folder) === next) locks.delete(folder);
  }
}

function taskPrefix(taskId: string): string {
  return `${REF_ROOT}/${taskId}/`;
}

export interface CheckpointMeta {
  taskId: string;
  runId: string | null;
  label: string;
}

/** Keys of the metadata lines in a snapshot's commit message. */
const META_KEYS = { task: "Task", run: "Run", folder: "Folder", label: "Label", created: "Created", files: "Files" };

function commitMessage(folder: string, meta: CheckpointMeta, createdAt: string, filesChanged: number): string {
  const label = meta.label.replace(/\s+/g, " ").trim();
  return [
    `AgentMan checkpoint: ${label}`,
    "",
    `${META_KEYS.task}: ${meta.taskId}`,
    `${META_KEYS.run}: ${meta.runId ?? "-"}`,
    `${META_KEYS.folder}: ${folder}`,
    `${META_KEYS.label}: ${label}`,
    `${META_KEYS.created}: ${createdAt}`,
    `${META_KEYS.files}: ${filesChanged}`,
    "",
  ].join("\n");
}

/** Every snapshot of the card in the repository containing `folder` (any folder), newest first. */
async function readCheckpoints(folder: string, taskId: string): Promise<TaskCheckpoint[]> {
  const prefix = taskPrefix(taskId);
  const listed = await git(folder, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(contents)%00", prefix]);
  if (!listed.ok) return [];
  const checkpoints: TaskCheckpoint[] = [];
  for (const record of listed.stdout.split("\0\n")) {
    const [ref, sha, contents] = record.split("\0");
    if (!ref?.startsWith(prefix) || !sha || contents === undefined) continue;
    const fields = new Map<string, string>();
    for (const line of contents.split("\n")) {
      const match = /^(\w+): (.*)$/.exec(line);
      if (match && !fields.has(match[1]!)) fields.set(match[1]!, match[2]!);
    }
    const files = Number(fields.get(META_KEYS.files));
    const run = fields.get(META_KEYS.run);
    checkpoints.push({
      id: ref.slice(prefix.length),
      folder: fields.get(META_KEYS.folder) ?? "",
      sha,
      runId: run && run !== "-" ? run : null,
      label: fields.get(META_KEYS.label) ?? "",
      createdAt: fields.get(META_KEYS.created) ?? "",
      ...(Number.isInteger(files) && files >= 0 ? { filesChanged: files } : {}),
    });
  }
  return checkpoints.sort(newestFirst);
}

function newestFirst(a: TaskCheckpoint, b: TaskCheckpoint): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

/** Files that differ between `tree` and its parent commit (all files when there is none). */
async function countChangedFiles(folder: string, parent: string | null, tree: string): Promise<number> {
  const out = parent
    ? await mustGit(folder, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", parent, tree])
    : await mustGit(folder, ["ls-tree", "-r", "-z", "--name-only", tree]);
  return out.split("\0").filter(Boolean).length;
}

/** Delete the card's refs beyond the newest MAX_CHECKPOINTS_PER_TASK in this repository. */
async function prune(folder: string, taskId: string): Promise<void> {
  const stale = (await readCheckpoints(folder, taskId)).slice(MAX_CHECKPOINTS_PER_TASK);
  for (const checkpoint of stale) await git(folder, ["update-ref", "-d", `${taskPrefix(taskId)}${checkpoint.id}`]);
}

let lastStamp = 0;

/**
 * Seed the private index at `indexFile` before `git add -A -- .` records the folder's files. A copy
 * of the repository's real index (only read) keeps its stat cache, so unchanged files are not
 * rehashed; entries outside `folder`, which that add leaves alone, are put back to HEAD so the
 * user's staged changes there stay out of the snapshot. Without a real index: HEAD's tree, or
 * nothing on an unborn branch.
 */
async function seedIndex(folder: string, parent: string | null, indexFile: string): Promise<void> {
  const env = { GIT_INDEX_FILE: indexFile };
  // Both relative to `folder`; the index path is also right for worktrees, where .git is a file.
  const paths = await mustGit(folder, ["rev-parse", "--show-prefix", "--git-path", "index"]);
  const [prefix = "", gitPath = ""] = paths.split("\n");
  try {
    await fs.copyFile(path.resolve(folder, gitPath), indexFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    if (parent) await mustGit(folder, ["read-tree", parent], env);
    return;
  }
  if (!prefix) return;
  const outside = ["--", ":(top)", ":(exclude)."];
  // Quiet path resets skip the index refresh; only entries that differ from HEAD are rewritten.
  if (parent) await mustGit(folder, ["reset", "-q", parent, ...outside], env);
  else await mustGit(folder, ["rm", "--cached", "-r", "-f", "-q", "--ignore-unmatch", ...outside], env);
}

/** Snapshot `folder` (resolved, caller holds its lock); null when it is not inside a git work tree. */
async function snapshot(folder: string, meta: CheckpointMeta): Promise<TaskCheckpoint | null> {
  if (!(await git(folder, ["rev-parse", "--show-toplevel"])).ok) return null;
  const head = await git(folder, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const parent = head.ok ? head.stdout.trim() : null;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agentman-checkpoint-"));
  try {
    // A private index: `git add -A` then records the folder's tracked and untracked files (minus
    // ignored ones) as they are in the working tree, without disturbing what the user has staged.
    const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
    await seedIndex(folder, parent, env.GIT_INDEX_FILE);
    await mustGit(folder, ["add", "-A", "--", "."], env);
    const tree = (await mustGit(folder, ["write-tree"], env)).trim();

    // Strictly increasing in this process, so snapshots taken within one millisecond still sort.
    const stamp = (lastStamp = Math.max(Date.now(), lastStamp + 1));
    const createdAt = new Date(stamp).toISOString();
    const filesChanged = await countChangedFiles(folder, parent, tree);
    const message = commitMessage(folder, meta, createdAt, filesChanged);
    const sha = (
      await mustGit(folder, [...COMMIT_CONFIG, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message])
    ).trim();
    const id = `${stamp}-${randomBytes(3).toString("hex")}`;
    await mustGit(folder, ["update-ref", `${taskPrefix(meta.taskId)}${id}`, sha]);
    await prune(folder, meta.taskId);
    return { id, folder, sha, runId: meta.runId, label: meta.label, createdAt, filesChanged };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Snapshot every file of `folder` (except ignored ones) as a checkpoint of the card. Returns null
 * when the folder is not inside a git work tree; throws when git fails.
 */
export function createCheckpoint(folder: string, meta: CheckpointMeta): Promise<TaskCheckpoint | null> {
  if (!SAFE_SEGMENT.test(meta.taskId)) throw new Error(`Invalid task id for a checkpoint: ${meta.taskId}`);
  const dir = path.resolve(folder);
  return withFolderLock(dir, () => snapshot(dir, meta));
}

/**
 * Snapshot each folder (duplicates and non-git folders are skipped). Never throws: a folder that
 * fails is reported in `errors` so a run can start anyway.
 */
export async function createCheckpoints(
  folders: string[],
  meta: CheckpointMeta,
): Promise<{ saved: TaskCheckpoint[]; errors: string[] }> {
  const saved: TaskCheckpoint[] = [];
  const errors: string[] = [];
  for (const folder of new Set(folders.map((f) => path.resolve(f)))) {
    try {
      const checkpoint = await createCheckpoint(folder, meta);
      if (checkpoint) saved.push(checkpoint);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { saved, errors };
}

/** The card's checkpoints of these folders (non-git and missing folders have none), newest first. */
export async function listCheckpoints(folders: string[], taskId: string): Promise<TaskCheckpoint[]> {
  if (!SAFE_SEGMENT.test(taskId)) return [];
  const unique = [...new Set(folders.map((f) => path.resolve(f)))];
  // Folders of one repository share its refs: each keeps only the snapshots taken in it.
  const perFolder = await Promise.all(
    unique.map(async (folder) => (await readCheckpoints(folder, taskId)).filter((c) => c.folder === folder)),
  );
  return perFolder.flat().sort(newestFirst);
}

export interface CheckpointRestore {
  checkpoint: TaskCheckpoint;
  /** Snapshot taken right before the restore: restoring it undoes the restore. */
  undo: TaskCheckpoint;
  /** Files (relative to the folder) written back from the checkpoint. */
  restored: string[];
  /** Files (relative to the folder) deleted because the checkpoint did not have them. */
  removed: string[];
}

interface TreeChange {
  status: string;
  path: string;
}

/**
 * `git diff --raw` from `from` to `to`, limited to the current folder with paths relative to it.
 * Submodules (gitlinks) are left out: restoring never deletes or rewrites a nested repository.
 */
async function treeChanges(folder: string, from: string, to: string): Promise<TreeChange[]> {
  const out = await mustGit(folder, ["diff", "--raw", "-z", "--no-renames", "--no-ext-diff", "--relative", from, to, "--", "."]);
  const parts = out.split("\0");
  const changes: TreeChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [oldMode, newMode, , , status] = parts[i]!.replace(/^:/, "").split(" ");
    if (!status || oldMode === GITLINK_MODE || newMode === GITLINK_MODE) continue;
    changes.push({ status: status[0]!, path: parts[i + 1]! });
  }
  return changes;
}

/** Absolute path of `relative` inside `folder`; throws when it would escape the folder. */
function insideFolder(folder: string, relative: string): string {
  const target = path.resolve(folder, relative);
  const rel = path.relative(folder, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Refusing to touch ${target}: outside ${folder}`);
  return target;
}

/** Delete a file the checkpoint did not have, then its parent folders that became empty. */
async function removeFile(folder: string, relative: string): Promise<void> {
  const target = insideFolder(folder, relative);
  await fs.rm(target, { force: true });
  for (let dir = path.dirname(target); dir !== folder && dir.startsWith(folder + path.sep); dir = path.dirname(dir)) {
    try {
      await fs.rmdir(dir);
    } catch {
      break; // Not empty (or already gone): stop climbing.
    }
  }
}

/**
 * Roll `folder`'s files back to checkpoint `id` of the card: modified and deleted files are
 * written back, files added since are deleted; ignored files, the index and HEAD stay as they
 * are. A "Before restore" checkpoint is taken first so the restore can be undone. Null when the
 * checkpoint does not exist in this folder.
 */
export async function restoreCheckpoint(folder: string, taskId: string, id: string): Promise<CheckpointRestore | null> {
  if (!SAFE_SEGMENT.test(taskId) || !SAFE_SEGMENT.test(id)) return null;
  const dir = path.resolve(folder);
  return withFolderLock(dir, async () => {
    const checkpoint = (await readCheckpoints(dir, taskId)).find((c) => c.id === id && c.folder === dir);
    if (!checkpoint) return null;
    const undo = await snapshot(dir, { taskId, runId: null, label: BEFORE_RESTORE_LABEL });
    if (!undo) throw new Error(`${dir} is no longer a git repository.`);

    const changes = await treeChanges(dir, checkpoint.sha, undo.sha);
    const removed = changes.filter((c) => c.status === "A").map((c) => c.path);
    const restored = changes.filter((c) => c.status !== "A").map((c) => c.path);
    for (const file of removed) await removeFile(dir, file);
    if (restored.length > 0) {
      for (const file of restored) insideFolder(dir, file);
      const list = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "agentman-restore-")), "paths");
      try {
        await fs.writeFile(list, restored.join("\0"));
        // Only the changed paths are written (untouched files keep their mtimes); the index stays.
        await mustGit(dir, [
          "--literal-pathspecs",
          "restore",
          `--source=${checkpoint.sha}`,
          "--worktree",
          `--pathspec-from-file=${list}`,
          "--pathspec-file-nul",
        ]);
      } finally {
        await fs.rm(path.dirname(list), { recursive: true, force: true });
      }
    }
    return { checkpoint, undo, restored, removed };
  });
}
