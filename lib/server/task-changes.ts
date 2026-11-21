// What each card changed in a shared project folder. Cards work in the project folders on whatever
// branch is checked out, next to the user and other cards, so a card's own changes are recorded
// per run: a tree snapshot of every git folder when the run starts and when it ends, kept as
// commits under refs/agentman/task-runs/<taskId>/<runKey>/{start,end}. "Create PR" replays only
// those start→end differences on top of the repo's default branch. Snapshots go through a private
// index (see checkpoints.ts): the user's branch, index and working tree are never touched.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { COMMIT_CONFIG, SAFE_SEGMENT, git, mustGit, snapshotTree } from "@/lib/server/checkpoints";

const REF_ROOT = "refs/agentman/task-runs";

export type RunPhase = "start" | "end";

/** Identifies one run's snapshots; sorts in run order. */
export function newRunKey(runId: string): string {
  return `${Date.now().toString().padStart(13, "0")}-${runId}`;
}

function taskPrefix(taskId: string): string {
  return `${REF_ROOT}/${taskId}/`;
}

/**
 * Snapshot each git folder as the `phase` of the run. Never throws: a folder that fails is
 * reported in `errors` so the run can go on (its changes then cannot be told apart later).
 */
export async function recordRunSnapshot(
  folders: string[],
  input: { taskId: string; runKey: string; phase: RunPhase },
): Promise<{ saved: number; errors: string[] }> {
  const errors: string[] = [];
  let saved = 0;
  if (!SAFE_SEGMENT.test(input.taskId) || !SAFE_SEGMENT.test(input.runKey)) {
    return { saved, errors: [`Invalid task or run id for change tracking: ${input.taskId} ${input.runKey}`] };
  }
  for (const folder of new Set(folders.map((f) => path.resolve(f)))) {
    try {
      const recorded = await snapshotTree(folder);
      if (!recorded) continue;
      const message = `AgentMan run ${input.phase}\n\nTask: ${input.taskId}\nFolder: ${folder}\n`;
      const sha = (await mustGit(folder, [...COMMIT_CONFIG, "commit-tree", recorded.tree, "-m", message])).trim();
      await mustGit(folder, ["update-ref", `${taskPrefix(input.taskId)}${input.runKey}/${input.phase}`, sha]);
      saved++;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { saved, errors };
}

/** Delete the card's run snapshots in each of these folders' repositories. Never throws. */
export async function removeRunSnapshots(folders: string[], taskId: string): Promise<void> {
  if (!SAFE_SEGMENT.test(taskId)) return;
  for (const folder of new Set(folders.map((f) => path.resolve(f)))) {
    const listed = await git(folder, ["for-each-ref", "--format=%(refname)", taskPrefix(taskId)]);
    if (!listed.ok) continue;
    for (const ref of listed.stdout.split("\n").filter(Boolean)) await git(folder, ["update-ref", "-d", ref]);
  }
}

interface RunInterval {
  start: string;
  /** Null when the run never recorded its end (server stopped, folder failed): resolved by the caller. */
  end: string | null;
}

async function readIntervals(folder: string, taskId: string): Promise<RunInterval[]> {
  const prefix = taskPrefix(taskId);
  const listed = await git(folder, ["for-each-ref", "--format=%(refname) %(objectname)", prefix]);
  if (!listed.ok) return [];
  const runs = new Map<string, { start?: string; end?: string }>();
  for (const line of listed.stdout.split("\n")) {
    const [ref, sha] = line.split(" ");
    if (!ref?.startsWith(prefix) || !sha) continue;
    const [key, phase] = ref.slice(prefix.length).split("/");
    if (!key || (phase !== "start" && phase !== "end")) continue;
    runs.set(key, { ...runs.get(key), [phase]: sha });
  }
  return [...runs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([, run]) => (run.start ? [{ start: run.start, end: run.end ?? null }] : []));
}

export class NoTrackedChangesError extends Error {}

/**
 * The tree of `base` (a commit) plus only the changes the card made in `folder`: each run's
 * start→end difference, limited to `folder`, applied in run order. A run without a recorded end
 * lasts until the next run starts, or until now for the last one. Throws NoTrackedChangesError
 * when the card has no recorded run here and a plain Error when its changes don't apply on `base`.
 */
export async function taskChangesTree(
  folder: string,
  taskId: string,
  base: { commit: string; label: string },
): Promise<{ tree: string; baseTree: string }> {
  const dir = path.resolve(folder);
  const intervals = SAFE_SEGMENT.test(taskId) ? await readIntervals(dir, taskId) : [];
  if (intervals.length === 0) {
    throw new NoTrackedChangesError(
      "AgentMan has no record of what this card changed here (it ran before changes were tracked, or in another checkout).",
    );
  }
  const top = (await mustGit(dir, ["rev-parse", "--show-toplevel"])).trim();
  const baseTree = (await mustGit(dir, ["rev-parse", `${base.commit}^{tree}`])).trim();
  // Only a card whose last run has no recorded end needs the folder as it is now.
  const last = intervals[intervals.length - 1]!;
  const now = last.end === null ? (await snapshotTree(dir))?.tree ?? null : null;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agentman-task-changes-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
    await mustGit(dir, ["read-tree", baseTree], env);
    for (const [i, interval] of intervals.entries()) {
      const end = interval.end ?? intervals[i + 1]?.start ?? now;
      if (!end) continue;
      const patch = await mustGit(dir, [
        "diff",
        "--binary",
        "--full-index",
        "--no-renames",
        "--no-ext-diff",
        interval.start,
        end,
        "--",
        ".",
      ]);
      if (!patch.trim()) continue;
      const patchFile = path.join(tmp, `run-${i}.patch`);
      await fs.writeFile(patchFile, patch);
      const applied = await git(top, ["apply", "--cached", "--3way", "--whitespace=nowarn", patchFile], env);
      if (!applied.ok) {
        throw new Error(
          `The card's changes don't apply on top of ${base.label} (they build on commits that are not there yet): ${
            applied.stderr.trim().split("\n").slice(-3).join(" ") || "git apply failed"
          }`,
        );
      }
    }
    const written = await git(dir, ["write-tree"], env);
    if (!written.ok) {
      throw new Error(
        `The card's changes conflict with ${base.label}: ${written.stderr.trim().split("\n").slice(-3).join(" ")}`,
      );
    }
    return { tree: written.stdout.trim(), baseTree };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
