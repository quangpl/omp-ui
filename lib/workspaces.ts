// Dedicated workspaces: on a board with `worktrees` on, every card's agent works in its own git
// worktree of each project folder that is a git repository, under DATA_DIR/workspaces/<taskId>/,
// on branch `omp/<card-slug>-<id>`. Non-git folders stay shared.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { childEnv } from "@/lib/child-env";
import { boardDefaultBranch } from "@/lib/default-branch";
import { dataDir } from "@/lib/files";
import { defaultBranchRef, repoDefaultBranch } from "@/lib/git";
import type { Board, Task, TaskWorkspace, WorkspaceFolder } from "@/lib/types";

const GIT_TIMEOUT_MS = 60_000;

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): Promise<GitResult> {
  const { promise, resolve } = Promise.withResolvers<GitResult>();
  execFile(
    "git",
    args,
    { cwd, env: childEnv({ GIT_TERMINAL_PROMPT: "0" }), timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }),
  );
  return promise;
}

function workspacesRoot(): string {
  return path.join(dataDir(), "workspaces");
}

function taskRoot(taskId: string): string {
  return path.join(workspacesRoot(), taskId);
}

/** `omp/<title-slug>-<first 6 chars of the id>`: stable for the card's lifetime. */
export function workspaceBranch(task: Pick<Task, "id" | "title">): string {
  const slug =
    task.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "task";
  return `omp/${slug}-${task.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toLowerCase()}`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Repository top level of `folder`, or null when it is not inside a git work tree with a commit. */
async function repoTop(folder: string): Promise<string | null> {
  const top = await git(folder, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return null;
  const head = await git(folder, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return head.ok ? top.stdout.trim() : null;
}

/** Board folders in order, each with a unique worktree folder name. */
function planFolders(board: Board, taskId: string): { source: string; target: string }[] {
  const used = new Set<string>();
  return [board.workdir, ...board.extraFolders].map((source) => {
    const base = path.basename(source) || "project";
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name);
    return { source, target: path.join(taskRoot(taskId), name) };
  });
}

/** The card's workspace as it is now (nothing is created). */
export async function getWorkspace(board: Board, task: Pick<Task, "id" | "title">): Promise<TaskWorkspace> {
  const branch = workspaceBranch(task);
  const folders = await Promise.all(
    planFolders(board, task.id).map(async ({ source, target }): Promise<WorkspaceFolder> => {
      if (await exists(target)) return { source, path: target, branch, isolated: true, exists: true };
      if (board.worktrees && (await repoTop(source)) === path.resolve(source)) {
        return { source, path: target, branch, isolated: true, exists: false };
      }
      return { source, path: source, branch: null, isolated: false, exists: true };
    }),
  );
  return { enabled: board.worktrees, folders };
}

/**
 * Create the card's missing worktrees (board.worktrees must be on). A folder that is not the top
 * of a git repository with at least one commit, or whose worktree cannot be created, stays shared;
 * `notes` explains why.
 */
export async function ensureWorkspace(
  board: Board,
  task: Pick<Task, "id" | "title">,
): Promise<{ workspace: TaskWorkspace; notes: string[] }> {
  const branch = workspaceBranch(task);
  const notes: string[] = [];
  const folders: WorkspaceFolder[] = [];
  for (const { source, target } of planFolders(board, task.id)) {
    if (await exists(target)) {
      folders.push({ source, path: target, branch, isolated: true, exists: true });
      continue;
    }
    const top = await repoTop(source);
    if (top !== path.resolve(source)) {
      notes.push(
        top === null
          ? `${source} is not a git repository with a commit; the agent shares it.`
          : `${source} is inside the repository ${top}, not its top folder; the agent shares it.`,
      );
      folders.push({ source, path: source, branch: null, isolated: false, exists: true });
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await git(source, ["worktree", "prune"]);
    const hasBranch = (await git(source, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
    // Start from the repo's default branch (`Board.defaultBranches`, else the repo's own), so a
    // card never inherits whatever the shared folder happened to be checked out on.
    const name = boardDefaultBranch(board, source) ?? (await repoDefaultBranch(source));
    const base = await defaultBranchRef(source, name);
    const added = await git(
      source,
      hasBranch ? ["worktree", "add", target, branch] : ["worktree", "add", "-b", branch, target, base],
    );
    if (!added.ok) {
      notes.push(`Could not create a worktree of ${source} (${added.stderr.trim() || "git failed"}); the agent shares it.`);
      folders.push({ source, path: source, branch: null, isolated: false, exists: true });
      continue;
    }
    notes.push(`Created worktree ${target} on branch ${branch}.`);
    folders.push({ source, path: target, branch, isolated: true, exists: true });
  }
  return { workspace: { enabled: true, folders }, notes };
}

/**
 * Remove the card's worktrees and their local branches (whether or not the board still has
 * dedicated workspaces on). Never throws; returns problems as text.
 */
export async function removeWorkspace(board: Board | null, task: Pick<Task, "id" | "title">): Promise<string[]> {
  const problems: string[] = [];
  const root = taskRoot(task.id);
  if (!(await exists(root))) return problems;
  const branch = workspaceBranch(task);
  const planned = board ? planFolders(board, task.id) : [];
  for (const { source, target } of planned) {
    if (!(await exists(target))) continue;
    const removed = await git(source, ["worktree", "remove", "--force", target]);
    if (!removed.ok) problems.push(`${target}: ${removed.stderr.trim() || "git worktree remove failed"}`);
    await git(source, ["branch", "-D", branch]);
  }
  try {
    await fs.rm(root, { recursive: true, force: true });
  } catch (err) {
    problems.push(`${root}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Drop registrations of worktrees whose folders are now gone (e.g. board folders changed).
  for (const { source } of planned) await git(source, ["worktree", "prune"]);
  return problems;
}

/**
 * Folders the card ships from: its existing worktrees, else the board's folders. Each with the
 * board folder it belongs to (`source`), which names its default branch (`Board.defaultBranches`).
 */
export async function shipTargets(
  board: Board,
  task: Pick<Task, "id" | "title">,
): Promise<{ source: string; path: string }[]> {
  const workspace = await getWorkspace(board, task);
  return workspace.folders.map((f) => ({ source: f.source, path: f.isolated && f.exists ? f.path : f.source }));
}

/** Folders the card ships from: its existing worktrees, else the board's folders. */
export async function shipFolders(board: Board, task: Pick<Task, "id" | "title">): Promise<string[]> {
  return (await shipTargets(board, task)).map((t) => t.path);
}
