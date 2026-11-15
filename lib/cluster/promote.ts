// A replica becoming primary (lib/cluster/node.ts promoteSelf) inherits the old primary's database,
// whose paths point at the old primary's disk. Rewrite what must work on this machine: project
// folders → this machine's own originals (failback: brought up to date from the replicated copy)
// or else their replicated mirrors, omp session files → this node's DATA_DIR, the omp binary → the
// one downloaded from the old primary, and the omp agent dir → the replicated copy.
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, realpath, rename, rm, stat, symlink, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clusterNotice } from "@/lib/cluster/node";
import { canonicalPath, clusterPaths, mirrorPath } from "@/lib/cluster/paths";
import { replicationOrigin } from "@/lib/cluster/replication";
import { type ManifestEntry, scanFolder } from "@/lib/cluster/sync";
import type { Repository } from "@/lib/db/types";
import { dataDir } from "@/lib/files";
import { getAppSettings, updateAppSettings } from "@/lib/settings";
import type { Board } from "@/lib/types";

/**
 * Files that describe where a checkout lives (worktree pointers) or hold machine-local git
 * settings: the original's own copies stay authoritative, so they are never overwritten or deleted.
 */
const LOCATION_FILES = [/(^|\/)\.git$/, /(^|\/)\.git\/(config|hooks\/.*|worktrees\/[^/]+\/(gitdir|config\.worktree))$/];
/** Same as lib/cluster/sync.ts: files whose size matches and mtimes differ by less than this are equal. */
const MTIME_TOLERANCE_MS = 2;

/** `folder` when it exists here, else its replicated mirror when that exists, else unchanged. */
function localFolder(folder: string): string {
  if (existsSync(folder)) return folder;
  const mirrored = mirrorPath(folder);
  return existsSync(mirrored) ? mirrored : folder;
}

/** `file` moved from under `from` to under `to`; null when it is not inside `from`. */
function rebase(file: string, from: string, to: string): string | null {
  const rel = path.relative(from, file);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return path.join(to, rel);
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Whether `command` (a path, or a name looked up on PATH) can be executed on this machine. */
function canExecute(command: string): boolean {
  if (command.includes("/") || command.includes("\\")) return isExecutableFile(command);
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD").split(";")] : [""];
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => exts.some((ext) => isExecutableFile(path.join(dir, command + ext))));
}

/** The newest omp binary downloaded from the old primary (`cluster/bin/omp-<sha>`), if any. */
function downloadedOmp(): string | null {
  const dir = clusterPaths().bin;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const binaries = names
    .filter((name) => name.startsWith("omp-") && !name.endsWith(".tmp"))
    .map((name) => path.join(dir, name))
    .filter(isExecutableFile)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return binaries[0] ?? null;
}

function within(p: string, root: string): boolean {
  return p === root || p.startsWith(`${root}${path.sep}`);
}

function sameEntry(a: ManifestEntry, b: ManifestEntry): boolean {
  return a.s === b.s && Math.abs(a.m - b.m) < MTIME_TOLERANCE_MS && a.x === b.x && a.l === b.l;
}

/** Copy one manifest entry from `source` into `target` (mtime and mode kept); false when refused. */
async function copyEntry(source: string, target: string, targetReal: string, entry: ManifestEntry): Promise<boolean> {
  const dest = path.join(target, ...entry.p.split("/"));
  if (!within(dest, target)) return false;
  await mkdir(path.dirname(dest), { recursive: true });
  // Never write through a symlinked parent that leads out of the folder.
  if (!within(await realpath(path.dirname(dest)), targetReal)) return false;
  if ((await lstat(dest).catch(() => null))?.isDirectory()) await rm(dest, { recursive: true, force: true });
  if (entry.l !== undefined) {
    if (path.isAbsolute(entry.l) || !within(path.resolve(path.dirname(dest), entry.l), target)) return false;
    await rm(dest, { force: true });
    await symlink(entry.l, dest);
    return true;
  }
  const src = path.join(source, ...entry.p.split("/"));
  const info = await stat(src);
  const temp = `${dest}.omp-ui-${randomBytes(4).toString("hex")}.tmp`;
  try {
    await copyFile(src, temp);
    await chmod(temp, info.mode & 0o777);
    await utimes(temp, info.atime, info.mtime);
    await rename(temp, dest);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
  return true;
}

/**
 * Make `target` identical to `source` for the files a sync manages (`tree` manifests: git-ignored
 * files such as node_modules are never touched; location files stay as they are). Returns the
 * number of files changed.
 */
async function reconcileFolder(target: string, source: string): Promise<number> {
  const [have, want] = await Promise.all([scanFolder(target, "tree"), scanFolder(source, "tree")]);
  const managed = (entry: ManifestEntry) => !LOCATION_FILES.some((re) => re.test(entry.p));
  const current = new Map(have.filter(managed).map((e) => [e.p, e]));
  const targetReal = await realpath(target);
  let changed = 0;
  for (const entry of want.filter(managed)) {
    const existing = current.get(entry.p);
    current.delete(entry.p);
    if (existing && sameEntry(existing, entry)) continue;
    if (await copyEntry(source, target, targetReal, entry)) changed++;
  }
  for (const stale of current.keys()) {
    const file = path.join(target, ...stale.split("/"));
    if (!within(file, target) || !within(await realpath(path.dirname(file)), targetReal)) continue;
    await rm(file, { force: true });
    changed++;
  }
  return changed;
}

/**
 * Where a board folder `folder` that is missing here lives now: this machine's original (the
 * project came from here: a home primary after failback), brought up to date from the replicated
 * copy; else the replicated copy; null when neither exists (left unchanged).
 */
async function relocateFolder(board: Board, folder: string, oldMirrorRoot: string | null): Promise<string | null> {
  const original = oldMirrorRoot ? canonicalPath(folder, oldMirrorRoot) : folder;
  const replicated = [mirrorPath(original), mirrorPath(folder)].find((p) => existsSync(p)) ?? null;
  if (original !== folder && existsSync(original)) {
    if (!replicated) return original;
    try {
      const changed = await reconcileFolder(original, replicated);
      clusterNotice(
        "info",
        `Project ${board.name}: brought the changes made during the failover into ${original} (${changed} file(s))`,
      );
      return original;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      clusterNotice("error", `Project ${board.name}: could not update ${original} (${reason}); using ${replicated}`);
      return replicated;
    }
  }
  if (!replicated) return null;
  clusterNotice("info", `Project ${board.name}: now uses its replicated folder ${replicated}`);
  return replicated;
}

/** Boards' workdir/extraFolders missing here → this machine's originals or the replicated mirrors. */
async function migrateBoards(repo: Repository): Promise<void> {
  const origin = replicationOrigin().primaryDataDir;
  const oldMirrorRoot = origin ? path.join(origin, "cluster", "mirror") : null;
  for (const board of await repo.listBoards()) {
    const relocate = async (folder: string) =>
      existsSync(folder) ? folder : ((await relocateFolder(board, folder, oldMirrorRoot)) ?? folder);
    const workdir = await relocate(board.workdir);
    const extraFolders: string[] = [];
    for (const folder of board.extraFolders) extraFolders.push(await relocate(folder));
    if (workdir === board.workdir && extraFolders.every((f, i) => f === board.extraFolders[i])) continue;
    await repo.updateBoard(board.id, { workdir, extraFolders });
  }
}

/** Cards' omp session files: old primary DATA_DIR → ours; other missing files → their mirrors. */
async function migrateSessionFiles(repo: Repository): Promise<void> {
  const from = replicationOrigin().primaryDataDir;
  const to = dataDir();
  let changed = 0;
  for (const board of await repo.listBoards()) {
    for (const task of await repo.listTasks(board.id)) {
      if (!task.sessionFile) continue;
      const rebased = from && from !== to ? rebase(task.sessionFile, from, to) : null;
      const sessionFile = rebased ?? localFolder(task.sessionFile);
      if (sessionFile === task.sessionFile) continue;
      await repo.updateTask(task.id, { sessionFile });
      changed++;
    }
  }
  if (changed > 0) clusterNotice("info", `Promotion: ${changed} card session file(s) now point to this node`);
}

/**
 * settings.ompPath not executable here → `omp` installed on this machine (PATH), so a home
 * primary back after failback uses its own, upgradable install; else the binary downloaded from the
 * old primary.
 */
async function migrateOmpPath(repo: Repository): Promise<void> {
  const { ompPath } = await getAppSettings(repo);
  if (canExecute(ompPath)) return;
  if (canExecute("omp")) {
    await updateAppSettings(repo, { ompPath: "omp" });
    clusterNotice("info", `Promotion: "${ompPath}" is not available here; omp now runs from this node's PATH`);
    return;
  }
  const binary = downloadedOmp();
  if (!binary) {
    clusterNotice("warning", `Promotion: omp ("${ompPath}") is not available on this node; install it to run cards`);
    return;
  }
  await updateAppSettings(repo, { ompPath: binary });
  clusterNotice("info", `Promotion: omp now runs from ${binary}, the copy downloaded from the old primary`);
}

/**
 * Point omp at the replicated agent dir (config, credentials, skills) when this machine has no omp
 * setup of its own (~/.omp/agent without config.yml or agent.db) and PI_CODING_AGENT_DIR is unset.
 * Process-wide; node.ts also calls it whenever a primary boots, since the env does not survive restarts.
 */
export function useReplicatedOmpAgentDir(): void {
  if (process.env.PI_CODING_AGENT_DIR) return;
  const own = path.join(os.homedir(), ".omp", "agent");
  if (existsSync(path.join(own, "config.yml")) || existsSync(path.join(own, "agent.db"))) return;
  const replicated = clusterPaths().ompAgent;
  if (!existsSync(replicated)) return;
  process.env.PI_CODING_AGENT_DIR = replicated;
  clusterNotice("info", `omp uses the agent settings replicated from the old primary (${replicated})`);
}

/**
 * Make the inherited database usable on this machine after a promotion. Each step is best effort:
 * a failure is reported as a notice and the next step still runs.
 */
export async function migrateForPromotion(repo: Repository): Promise<void> {
  const steps: Array<[label: string, run: () => Promise<void> | void]> = [
    ["project folders", () => migrateBoards(repo)],
    ["card session files", () => migrateSessionFiles(repo)],
    ["omp binary", () => migrateOmpPath(repo)],
    ["omp agent dir", useReplicatedOmpAgentDir],
  ];
  for (const [label, run] of steps) {
    try {
      await run();
    } catch (err) {
      clusterNotice("error", `Promotion: could not migrate ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
