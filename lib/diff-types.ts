// Shapes of `GET /api/v1/tasks/:id/diff` and `/diff/summary`, plus the deterministic summary line
// (shared by the server and the Changes tab).

/** A = added, M = modified, D = deleted, R = renamed (possibly also modified). */
export type DiffFileStatus = "A" | "M" | "D" | "R";

export interface DiffFile {
  /** Path relative to the repository top level (the new path for renames). */
  path: string;
  /** Previous path of a renamed file; null otherwise. */
  oldPath: string | null;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Not tracked by git yet (shown as all-added). */
  untracked: boolean;
  /**
   * Unified diff hunks (from the first `@@` line on), without the `diff --git`/`---`/`+++` header.
   * Null for binary files, mode-only changes, and files left out because the diff is too large.
   */
  patch: string | null;
  /** The patch was cut short or left out (too large); the counts are still exact for tracked files. */
  truncated: boolean;
}

export interface RepoDiff {
  /** Folder the diff was taken in: the card's worktree, else the project folder. */
  folder: string;
  /** Display name: the folder's base name. */
  name: string;
  isRepo: boolean;
  /** Checked-out branch; null when detached or not a repo. */
  branch: string | null;
  /** Ref the committed changes are compared against ("origin/main"); null = uncommitted changes only. */
  baseRef: string | null;
  /** Commits on HEAD that are not on `baseRef`. */
  commitsAhead: number;
  files: DiffFile[];
  /** Some files' patches were cut short or left out. */
  truncated: boolean;
  /** Shell command that shows this repo's full diff (for the "open in terminal" hint). */
  command: string;
  /** Git failed in this folder (plain language); null when fine. */
  error: string | null;
}

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
}

export interface TaskDiff {
  taskId: string;
  repos: RepoDiff[];
  stats: DiffStats;
  /** Any repo's diff is truncated. */
  truncated: boolean;
  /** Content hash of the changes: the summary cache key. */
  hash: string;
  generatedAt: string;
}

export interface DiffSummary {
  /** One or two plain sentences. */
  text: string;
  /** "model": written by the summary agent; "fallback": the deterministic file-count line. */
  source: "model" | "fallback";
  /** The summary agent is still writing; ask again for its answer. */
  pending: boolean;
  /** Why the model summary is unavailable (fallback only); null otherwise. */
  error: string | null;
  /** Hash of the changes the summary describes. */
  hash: string;
}

/** Files named in the deterministic summary line. */
const FALLBACK_FILES = 3;

/** "3 files changed (+120 −14): app/page.tsx, lib/x.ts, README.md …" */
export function fallbackSummary(diff: TaskDiff): string {
  const { files, additions, deletions } = diff.stats;
  if (files === 0) return "No code changes yet.";
  const names = diff.repos.flatMap((repo) => repo.files.map((file) => file.path));
  const shown = names.slice(0, FALLBACK_FILES).join(", ");
  const more = names.length > FALLBACK_FILES ? " …" : "";
  return `${files} ${files === 1 ? "file" : "files"} changed (+${additions} −${deletions}): ${shown}${more}`;
}
