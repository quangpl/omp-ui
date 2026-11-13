// "@" mention candidates for the card composer: files and directories of a board's project folders,
// ranked like OMP's own "@" file picker. Folders are listed with `git ls-files` (so .gitignore'd
// files never show), falling back to a bounded directory walk outside git. Listings are cached
// briefly because the composer queries on every keystroke.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { childEnv } from "@/lib/child-env";
import type { Board, ProjectFileHit } from "@/lib/types";

const CACHE_TTL_MS = 15_000;
const GIT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 64 * 1024 * 1024;
/** Paths kept per folder; huge monorepos are truncated rather than slowing every keystroke. */
const MAX_PATHS = 50_000;
const WALK_MAX_FILES = 20_000;
const WALK_MAX_DEPTH = 8;
/** Bulky generated/vendor directories the fallback walk never enters (hidden dirs are skipped too). */
const WALK_SKIP_DIRS: Record<string, true> = { node_modules: true, dist: true, build: true, coverage: true };

const GIT_ENV: NodeJS.ProcessEnv = childEnv({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });

/** One listed path with the lowercased forms the ranking compares against. */
interface Entry {
  /** Relative to the project folder, "/"-separated; directories end with "/". */
  path: string;
  kind: "file" | "dir";
  lower: string;
  /** Lowercased basename (no trailing "/"). */
  base: string;
  /** Lowercased parent directory with trailing "/"; "" at the top level. */
  parent: string;
}

const g = globalThis as unknown as {
  __ompUiProjectFiles?: Map<string, { at: number; entries: Promise<Entry[]> }>;
};

function makeEntry(p: string, kind: Entry["kind"]): Entry {
  const trimmed = kind === "dir" ? p.slice(0, -1) : p;
  const slash = trimmed.lastIndexOf("/");
  return {
    path: p,
    kind,
    lower: p.toLowerCase(),
    base: trimmed.slice(slash + 1).toLowerCase(),
    parent: trimmed.slice(0, slash + 1).toLowerCase(),
  };
}

/** File entries plus one entry per ancestor directory. */
function toEntries(files: Iterable<string>): Entry[] {
  const entries: Entry[] = [];
  const dirs = new Set<string>();
  for (const file of files) {
    if (entries.length - dirs.size >= MAX_PATHS) break;
    entries.push(makeEntry(file, "file"));
    for (let i = file.lastIndexOf("/"); i > 0; i = file.lastIndexOf("/", i - 1)) {
      const dir = file.slice(0, i + 1);
      // Its ancestors were added together with it.
      if (dirs.has(dir)) break;
      dirs.add(dir);
      entries.push(makeEntry(dir, "dir"));
    }
  }
  return entries;
}

/** Tracked + untracked, non-ignored files of a git work tree; null outside git or on failure. */
function gitFiles(folder: string): Promise<string[] | null> {
  const { promise, resolve } = Promise.withResolvers<string[] | null>();
  execFile(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: folder, timeout: GIT_TIMEOUT_MS, env: GIT_ENV, maxBuffer: MAX_BUFFER, windowsHide: true },
    (err, stdout) => {
      if (err) return resolve(null);
      // Unmerged paths are listed once per stage.
      resolve([...new Set(stdout.split("\0").filter(Boolean))]);
    },
  );
  return promise;
}

/** Breadth-first walk, bounded in depth and size, skipping hidden and generated directories. */
async function walkFiles(folder: string): Promise<string[]> {
  const files: string[] = [];
  const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
  for (let next = 0; next < queue.length && files.length < WALK_MAX_FILES; next++) {
    const { rel, depth } = queue[next];
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(rel ? path.join(folder, rel) : folder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (depth < WALK_MAX_DEPTH && !d.name.startsWith(".") && !Object.hasOwn(WALK_SKIP_DIRS, d.name)) {
          queue.push({ rel: child, depth: depth + 1 });
        }
      } else if (d.isFile() || d.isSymbolicLink()) {
        files.push(child);
        if (files.length >= WALK_MAX_FILES) break;
      }
    }
  }
  return files;
}

async function loadEntries(folder: string): Promise<Entry[]> {
  try {
    if (!(await fs.promises.stat(folder)).isDirectory()) return [];
    return toEntries((await gitFiles(folder)) ?? (await walkFiles(folder)));
  } catch {
    return [];
  }
}

/** Cached listing of one absolute folder; concurrent callers share the same load. Never rejects. */
function folderEntries(folder: string): Promise<Entry[]> {
  const cache = (g.__ompUiProjectFiles ??= new Map());
  const now = Date.now();
  const cached = cache.get(folder);
  if (cached && now - cached.at <= CACHE_TTL_MS) return cached.entries;
  for (const [key, value] of cache) {
    if (now - value.at > CACHE_TTL_MS) cache.delete(key);
  }
  const entries = loadEntries(folder);
  cache.set(folder, { at: now, entries });
  return entries;
}

/** Width of the tightest-ending window holding `query` as a subsequence of `text`; -1 when absent. */
function subsequenceSpan(text: string, query: string): number {
  let j = 0;
  let end = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === query[j] && ++j === query.length) {
      end = i;
      break;
    }
  }
  if (end < 0) return -1;
  // Walk back from the end so the window starts as late as possible.
  let k = query.length - 1;
  for (let i = end; i >= 0; i--) {
    if (text[i] === query[k] && --k < 0) return end - i + 1;
  }
  return -1;
}

interface Scored {
  folder: number;
  entry: Entry;
  rank: number;
  span: number;
}

/** 0 exact basename, 1 basename prefix, 2 basename substring, 3 path substring, 4 subsequence; null = no match. */
function score(entry: Entry, query: string): { rank: number; span: number } | null {
  if (entry.base === query) return { rank: 0, span: 0 };
  if (entry.base.startsWith(query)) return { rank: 1, span: 0 };
  if (entry.base.includes(query)) return { rank: 2, span: 0 };
  if (entry.lower.includes(query)) return { rank: 3, span: 0 };
  const span = subsequenceSpan(entry.lower, query);
  return span < 0 ? null : { rank: 4, span };
}

function compareText(a: Entry, b: Entry): number {
  if (a.lower !== b.lower) return a.lower < b.lower ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function toHit(folders: string[], index: number, entry: Entry): ProjectFileHit {
  if (index === 0) return { path: entry.path, kind: entry.kind, insert: entry.path };
  const folder = folders[index];
  return { path: entry.path, kind: entry.kind, insert: path.join(folder, entry.path), folder: path.basename(folder) };
}

/**
 * "@" mention candidates for `query` across the board's project folders (workdir first):
 * - "" → top-level entries of the workdir;
 * - ending with "/" → direct children of that directory (OMP-style path browsing);
 * - otherwise a case-insensitive fuzzy match on the path.
 * An absolute query is scoped to the project folder containing it (extra-folder hits insert absolute paths).
 * Directories come first when browsing; never throws.
 */
export async function searchProjectFiles(
  board: Pick<Board, "workdir" | "extraFolders">,
  query: string,
  limit = 30,
): Promise<ProjectFileHit[]> {
  const folders = [board.workdir, ...board.extraFolders];
  let scopes = folders.map((_, i) => i);
  let rel = query.replace(/^(\.\/)+/, "");
  if (path.isAbsolute(rel)) {
    let best = -1;
    folders.forEach((folder, i) => {
      const inside = rel === folder || rel.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
      if (inside && (best < 0 || folder.length > folders[best].length)) best = i;
    });
    if (best < 0) return [];
    scopes = [best];
    rel = rel.slice(folders[best].length).replace(/^\/+/, "");
  } else if (!rel) {
    scopes = [0];
  }
  const listings = await Promise.all(scopes.map((i) => folderEntries(folders[i])));
  const max = Math.max(0, limit);
  const q = rel.toLowerCase();

  if (!q || q.endsWith("/")) {
    const children: { folder: number; entry: Entry }[] = [];
    listings.forEach((entries, s) => {
      for (const entry of entries) if (entry.parent === q) children.push({ folder: scopes[s], entry });
    });
    children.sort(
      (a, b) =>
        a.folder - b.folder ||
        (a.entry.kind === b.entry.kind ? 0 : a.entry.kind === "dir" ? -1 : 1) ||
        compareText(a.entry, b.entry),
    );
    return children.slice(0, max).map((c) => toHit(folders, c.folder, c.entry));
  }

  const matches: Scored[] = [];
  listings.forEach((entries, s) => {
    for (const entry of entries) {
      const scored = score(entry, q);
      if (scored) matches.push({ folder: scopes[s], entry, ...scored });
    }
  });
  matches.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.span - b.span ||
      a.entry.path.length - b.entry.path.length ||
      compareText(a.entry, b.entry) ||
      a.folder - b.folder,
  );
  return matches.slice(0, max).map((m) => toHit(folders, m.folder, m.entry));
}
