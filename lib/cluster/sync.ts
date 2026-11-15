// Folder sync between cluster nodes over a ClusterChannel: folder manifests (git-aware for
// project trees), diffs against the receiver's disk (down) or the sender's last-synced baseline
// (up), chunked + deflated transfer, safe atomic writes, primary <-> node path rewriting
// (PathMap), and the consistent SQLite snapshot the primary replicates. Server-only.
//
// One push, sender → receiver (requests are answered `sync.ok` or `sync.reject {message}`):
//   sync.begin {scope, push, dir, deleteExtras, folders, map}  request: the receiver matches the folder ids
//                                                               against its OWN specs and locks the scope
//   sync.list {push, f, entries, deleted} × n                  the sender's manifest (down) or its changes
//                                                               since the baseline (up), in batches
//   sync.listed {push}                                         request: the receiver diffs against its disk,
//   sync.want {push, f, paths} × n                              sends the paths it needs, then answers
//   binary sync.file {push, f, p, o, last, z?, m, mode} × n    chunks ≤ 1 MiB, one file after the other
//   sync.done {push}                                           request: the receiver creates symlinks, deletes,
//                                                               runs onApplied and answers with its SyncStats
//   sync.abort {push, message}                                 the sender gave up; the receiver drops the push
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  lutimes,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import type { ClusterChannel } from "@/lib/cluster/protocol";
import type { BinaryHeader, SyncFolderSpec, SyncKind, WireMessage } from "@/lib/cluster/types";

/** Largest (uncompressed) payload of one `sync.file` frame. */
const CHUNK_BYTES = 1024 * 1024;
/** Smaller chunks are sent as they are; deflate cannot win much there. */
const MIN_DEFLATE_BYTES = 512;
/** Manifest entries per `sync.list` and paths per `sync.want` (keeps frames far below the 16 MiB cap). */
const LIST_BATCH = 2_000;
/** A request of a push may wait for the receiver's scope lock, a full scan or onApplied (binary download). */
const SYNC_REQUEST_TIMEOUT_MS = 10 * 60_000;
/** Files are the same version when their mtimes differ by less than this (filesystem precision). */
const MTIME_TOLERANCE_MS = 2;
/** lstat calls in flight while turning a `git ls-files` listing into manifest entries. */
const STAT_BATCH = 256;
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const SQLITE_BUSY_TIMEOUT_MS = 10_000;
/** Longest relative path or symlink target accepted from the network. */
const MAX_PATH_LENGTH = 4096;
/** Prefix of in-flight temp files (and symlinks) next to their final location. */
const TEMP_PREFIX = ".omp-sync-";
/** Dependency/cache folders a `tree` folder without git never syncs. */
const PRUNED_DIRS = new Set(["node_modules", ".venv", "venv", "__pycache__", ".next", ".turbo", ".cache"]);
/** Environment that would point git at another repository than the scanned folder. */
const GIT_REPO_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"];
/** Characters that continue a path segment: a mapped path never starts or ends next to one. */
const PATH_CHAR = /[\p{L}\p{N}_.~+@%-]/u;
/** `.git/worktrees/<name>/gitdir`: the worktree's back pointer (absolute path of its `.git` file). */
const WORKTREE_GITDIR = /(?:^|\/)\.git\/worktrees\/[^/]+\/gitdir$/;
const ROOT_WORKTREE_GITDIR = /^worktrees\/[^/]+\/gitdir$/;
/**
 * Paths inside a git dir (relative to it) a node may never change on the primary: they configure
 * or run code there (config, per-worktree config, hooks, a worktree's common dir), also inside
 * submodules and worktree dirs. Prefix match: `config/x` would replace `config` by a directory.
 */
const GIT_DENIED = /^(?:(?:modules\/.+|worktrees\/[^/]+)\/)?(?:config(?:\.worktree)?|commondir|hooks)(?:\/|$)/i;

// --- Path mapping -----------------------------------------------------------------------------

/** One rewrite rule: `from` becomes `to`; `to: null` marks an already mapped path that is kept. */
interface Rule {
  from: string;
  to: string | null;
}

/** One direction of a PathMap. */
class Rewriter {
  private readonly rules: Rule[];

  constructor(pairs: ReadonlyArray<readonly [from: string, to: string]>) {
    const rules: Rule[] = [
      ...pairs.map(([from, to]) => ({ from, to })),
      ...pairs.map(([, to]) => ({ from: to, to: null })),
    ];
    // Longest first; on equal length an already mapped path wins (never double-map).
    rules.sort((a, b) => b.from.length - a.from.length || (a.to === null ? 0 : 1) - (b.to === null ? 0 : 1));
    const seen = new Set<string>();
    this.rules = rules.filter((rule) => !seen.has(rule.from) && Boolean(seen.add(rule.from)));
  }

  path(p: string): string {
    for (const { from, to } of this.rules) {
      if (p === from || p.startsWith(`${from}/`)) return to === null ? p : to + p.slice(from.length);
    }
    return p;
  }

  text(s: string): string {
    if (!this.rules.some((rule) => rule.to !== null && s.includes(rule.from))) return s;
    let out = "";
    let last = 0;
    let i = s.indexOf("/");
    while (i >= 0) {
      const rule = this.ruleAt(s, i);
      if (!rule) {
        i = s.indexOf("/", i + 1);
        continue;
      }
      if (rule.to !== null) {
        out += s.slice(last, i) + rule.to;
        last = i + rule.from.length;
      }
      i = s.indexOf("/", i + rule.from.length);
    }
    return last === 0 ? s : out + s.slice(last);
  }

  /** The longest rule whose path stands at `i` as a whole path (boundaries on both sides). */
  private ruleAt(s: string, i: number): Rule | null {
    if (i > 0 && PATH_CHAR.test(s[i - 1])) return null;
    for (const rule of this.rules) {
      if (!s.startsWith(rule.from, i)) continue;
      const next = s[i + rule.from.length];
      if (next === undefined || next === "/" || !PATH_CHAR.test(next)) return rule;
    }
    return null;
  }
}

/**
 * Maps absolute primary paths to the node paths of their copies and back. Rewrites are
 * longest-prefix, path-boundary safe (`/a/b` never matches inside `/a/bc` or `/x/a/b`) and never
 * double-map: a path that already is a mapped path is kept as it is.
 */
export class PathMap {
  /** [primaryPath, nodePath], resolved; identical pairs and filesystem roots are dropped. */
  readonly pairs: ReadonlyArray<readonly [string, string]>;
  private readonly down: Rewriter;
  private readonly up: Rewriter;

  constructor(pairs: ReadonlyArray<readonly [primaryPath: string, nodePath: string]>) {
    const seen = new Set<string>();
    const clean: Array<readonly [string, string]> = [];
    for (const [primaryPath, nodePath] of pairs) {
      const primary = path.resolve(primaryPath);
      const node = path.resolve(nodePath);
      const isFsRoot = path.parse(primary).root === primary || path.parse(node).root === node;
      if (primary === node || isFsRoot || seen.has(primary)) continue;
      seen.add(primary);
      clean.push([primary, node]);
    }
    this.pairs = clean;
    this.down = new Rewriter(clean);
    this.up = new Rewriter(clean.map(([primary, node]) => [node, primary] as const));
  }

  static identity(): PathMap {
    return new PathMap([]);
  }

  /** One absolute primary path as a node path (unmapped → unchanged). */
  pathToNode(p: string): string {
    return this.down.path(p);
  }

  /** One absolute node path as a primary path (unmapped → unchanged). */
  pathToPrimary(p: string): string {
    return this.up.path(p);
  }

  /** Every primary path in free text / JSON lines rewritten to its node path. */
  toNode(text: string): string {
    return this.down.text(text);
  }

  /** Every node path in free text / JSON lines rewritten to its primary path. */
  toPrimary(text: string): string {
    return this.up.text(text);
  }
}

// --- Manifests --------------------------------------------------------------------------------

/** One file (or symlink) of a synced folder. */
export interface ManifestEntry {
  /** Path relative to the folder root, posix separators. */
  p: string;
  /** Size in bytes. */
  s: number;
  /** mtime, integer milliseconds. */
  m: number;
  /** Executable (any exec bit). */
  x?: true;
  /** Symlink target (as stored, not followed). */
  l?: string;
}

function entryOf(rel: string, st: Stats, link?: string): ManifestEntry {
  const entry: ManifestEntry = { p: rel, s: st.size, m: Math.floor(st.mtimeMs) };
  if (link !== undefined) entry.l = link;
  else if ((st.mode & 0o111) !== 0) entry.x = true;
  return entry;
}

/** The entry of a file or symlink under `root`; null for anything else or when it is gone. */
async function statEntry(root: string, rel: string): Promise<ManifestEntry | null> {
  const abs = path.join(root, rel);
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) return entryOf(rel, st, await readlink(abs));
    return st.isFile() ? entryOf(rel, st) : null;
  } catch {
    return null;
  }
}

/** Equal versions: same symlink target, or same size (unless ignored), mtime and exec bit. */
function sameEntry(a: ManifestEntry, b: ManifestEntry, ignoreSize: boolean): boolean {
  if (a.l !== undefined || b.l !== undefined) return a.l === b.l;
  return (
    (ignoreSize || a.s === b.s) && Math.abs(a.m - b.m) < MTIME_TOLERANCE_MS && (a.x === true) === (b.x === true)
  );
}

/** A relative posix path that stays inside its root: no absolute path, `.`/`..`/empty segment, NUL or backslash. */
function isSafeRel(p: unknown): p is string {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    p.length <= MAX_PATH_LENGTH &&
    !/[\0\\]/.test(p) &&
    !p.startsWith("/") &&
    p.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    isSafeRel(e.p) &&
    Number.isSafeInteger(e.s) &&
    (e.s as number) >= 0 &&
    typeof e.m === "number" &&
    Number.isFinite(e.m) &&
    (e.x === undefined || e.x === true) &&
    (e.l === undefined ||
      (typeof e.l === "string" && e.l.length > 0 && e.l.length <= MAX_PATH_LENGTH && !e.l.includes("\0")))
  );
}

/** Git lock files (`index.lock`, `HEAD.lock`, …) are transient and never synced. */
function isGitLock(rel: string, gitRoot: boolean): boolean {
  return rel.endsWith(".lock") && (gitRoot || rel.split("/").slice(0, -1).includes(".git"));
}

/**
 * Files whose content holds absolute paths of the other side: a worktree's `.git` pointer file
 * and the `gitdir` back pointer of a worktree inside a git dir.
 */
function isPointerFile(rel: string, gitRoot: boolean): boolean {
  return (
    path.posix.basename(rel) === ".git" ||
    WORKTREE_GITDIR.test(rel) ||
    (gitRoot && ROOT_WORKTREE_GITDIR.test(rel))
  );
}

/**
 * Upstream changes the primary refuses: pointer files (the primary wrote them; a rewritten one
 * would point git at a directory the node controls), git config/hooks (see GIT_DENIED) and
 * symlinks inside a git dir.
 */
function isDeniedUpstream(rel: string, gitRoot: boolean, link: boolean): boolean {
  if (isPointerFile(rel.toLowerCase(), gitRoot)) return true;
  const segments = rel.split("/");
  if (gitRoot && (link || GIT_DENIED.test(rel))) return true;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].toLowerCase() !== ".git") continue;
    if (link) return true;
    if (GIT_DENIED.test(segments.slice(i + 1).join("/"))) return true;
  }
  return false;
}

function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Every file and symlink below `root/dir` (`prune`: skip PRUNED_DIRS). Symlinks are not followed. */
async function walk(root: string, dir: string, prune: boolean, gitRoot: boolean, out: ManifestEntry[]): Promise<void> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(dir ? path.join(root, dir) : root, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    dirents.map(async (dirent) => {
      const rel = dir ? `${dir}/${dirent.name}` : dirent.name;
      if (!isSafeRel(rel)) return;
      if (dirent.isDirectory()) {
        if (!(prune && PRUNED_DIRS.has(dirent.name))) await walk(root, rel, prune, gitRoot, out);
        return;
      }
      if (isGitLock(rel, gitRoot)) return;
      const entry = await statEntry(root, rel);
      if (entry) out.push(entry);
    }),
  );
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of GIT_REPO_ENV) delete env[key];
  return env;
}

/** Tracked + untracked-not-ignored files of the work tree at `root`; null when git cannot list them. */
function gitListFiles(root: string): Promise<string[] | null> {
  const { promise, resolve } = Promise.withResolvers<string[] | null>();
  try {
    execFile(
      "git",
      ["-c", "core.fsmonitor=false", "ls-files", "-z", "-co", "--exclude-standard"],
      { cwd: root, env: gitEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (err, stdout) => resolve(err ? null : String(stdout).split("\0").filter(Boolean)),
    );
  } catch {
    resolve(null);
  }
  return promise;
}

/** A `tree` folder with a `.git` dir or pointer file, listed through git; false when git is unusable. */
async function scanGitTree(root: string, out: ManifestEntry[]): Promise<boolean> {
  const dotGit = await lstat(path.join(root, ".git")).catch(() => null);
  if (!dotGit || !(dotGit.isDirectory() || dotGit.isFile())) return false;
  const listed = await gitListFiles(root);
  if (!listed) return false;
  // Directories (submodules, nested repos) end in "/" and fail isSafeRel.
  const files = [...new Set(listed)].filter((p) => isSafeRel(p) && p !== ".git" && !p.startsWith(".git/"));
  for (let i = 0; i < files.length; i += STAT_BATCH) {
    const entries = await Promise.all(files.slice(i, i + STAT_BATCH).map((rel) => statEntry(root, rel)));
    for (const entry of entries) if (entry) out.push(entry);
  }
  if (dotGit.isDirectory()) {
    await walk(root, ".git", false, false, out);
  } else {
    const pointer = await statEntry(root, ".git");
    if (pointer) out.push(pointer);
  }
  return true;
}

/**
 * Manifest of a folder, sorted by path (missing root → []). `tree`: git-aware listing (tracked +
 * untracked-not-ignored files plus the `.git` dir or pointer file) when the root holds `.git` and
 * git works, else every file outside dependency/cache folders. `raw`: every file. Symlinks are
 * recorded with their target, never followed; git lock files are skipped.
 */
export async function scanFolder(root: string, kind: SyncKind): Promise<ManifestEntry[]> {
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) return [];
  const out: ManifestEntry[] = [];
  if (!(kind === "tree" && (await scanGitTree(root, out)))) {
    await walk(root, "", kind === "tree", path.basename(root) === ".git", out);
  }
  return out.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
}

/** The common git dir of the worktree checked out at `root` (its `.git` is a pointer file), else null. */
async function worktreeCommonDir(root: string): Promise<string | null> {
  const pointer = await readFile(path.join(root, ".git"), "utf8").catch(() => null);
  const match = pointer?.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match) return null;
  const gitDir = path.resolve(root, match[1]);
  const commonDir = await readFile(path.join(gitDir, "commondir"), "utf8").catch(() => null);
  return commonDir === null ? gitDir : path.resolve(gitDir, commonDir.trim());
}

/**
 * For the git worktree checkouts among `paths` (their `.git` is a pointer file), the common `.git`
 * dirs they need that are not inside any of `paths` (deduplicated).
 */
export async function gitCommonDirs(paths: string[]): Promise<string[]> {
  const roots = paths.map((p) => path.resolve(p));
  const found = await Promise.all(roots.map(worktreeCommonDir));
  const dirs = new Set<string>();
  for (const dir of found) {
    if (dir && !roots.some((root) => isInside(root, dir))) dirs.add(dir);
  }
  return [...dirs];
}

// --- Baselines and stats ----------------------------------------------------------------------

/** Outcome of one push, as the receiver applied it (`ms`: the sender's wall time). */
export interface SyncStats {
  /** Files and symlinks written. */
  files: number;
  /** Uncompressed bytes written. */
  bytes: number;
  deleted: number;
  /** Changes refused: upstream deny-list, symlinks or parents leading out of the folder, directories in the way. */
  skipped: number;
  ms: number;
}

function readStats(value: unknown): SyncStats {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const num = (key: string) => (typeof v[key] === "number" ? (v[key] as number) : 0);
  return { files: num("files"), bytes: num("bytes"), deleted: num("deleted"), skipped: num("skipped"), ms: num("ms") };
}

/** Per-scope, per-folder manifests (the baselines of upstream diffs). Owned by a long-lived component (the replica's run host) so baselines survive reconnects. */
export class SyncBaselines {
  private readonly scopes = new Map<string, Map<string, Map<string, ManifestEntry>>>();

  /** The folder's state after its last completed sync; undefined before the first one. */
  get(scope: string, folderId: string): ReadonlyMap<string, ManifestEntry> | undefined {
    return this.scopes.get(scope)?.get(folderId);
  }

  /** Replace a folder's baseline. */
  set(scope: string, folderId: string, entries: Iterable<ManifestEntry>): void {
    this.folders(scope).set(folderId, new Map([...entries].map((entry) => [entry.p, entry])));
  }

  /** Record pushed changes: `changed` entries replace theirs, `deleted` paths are removed. */
  merge(scope: string, folderId: string, changed: Iterable<ManifestEntry>, deleted: Iterable<string>): void {
    const folders = this.folders(scope);
    const base = folders.get(folderId) ?? new Map<string, ManifestEntry>();
    for (const entry of changed) base.set(entry.p, entry);
    for (const rel of deleted) base.delete(rel);
    folders.set(folderId, base);
  }

  drop(scope: string): void {
    this.scopes.delete(scope);
  }

  private folders(scope: string): Map<string, Map<string, ManifestEntry>> {
    let folders = this.scopes.get(scope);
    if (!folders) this.scopes.set(scope, (folders = new Map()));
    return folders;
  }
}

/** Per-key FIFO mutex. */
class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const tail = previous.then(() => promise);
    this.tails.set(key, tail);
    await previous;
    return () => {
      resolve();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}

// --- Endpoint ---------------------------------------------------------------------------------

type Side = "primary" | "node";
type Direction = "down" | "up";

/** What a receiver accepts; see SyncEndpoint.receive. */
interface ReceiveHandler {
  folders(scope: string): SyncFolderSpec[] | null;
  onApplied?(scope: string, stats: SyncStats): void | Promise<void>;
}

/** One folder of a push being sent. */
interface PushPlan {
  spec: SyncFolderSpec;
  root: string;
  /** Down: the whole manifest; up: the entries changed since the baseline. */
  offered: Map<string, ManifestEntry>;
  /** Up: baseline paths that are gone. */
  deleted: string[];
}

/** One folder of a push being received. */
interface InFolder {
  spec: SyncFolderSpec;
  root: string;
  /** realpath of `root`: every write must resolve inside it. */
  realRoot: string;
  /** The folder root itself is a git dir (a worktree's common dir). */
  gitRoot: boolean;
  offered: Map<string, ManifestEntry>;
  deleted: string[];
  /** Local manifest before the push. */
  disk: Map<string, ManifestEntry>;
  /** Files still expected as `sync.file` chunks. */
  want: Set<string>;
  links: ManifestEntry[];
  removals: string[];
  /** What the push changed locally (null = deleted), for the node's baseline. */
  applied: Map<string, ManifestEntry | null>;
}

/** The file currently being received (`handle` null: refused, its chunks are dropped). */
interface InFile {
  folder: InFolder;
  rel: string;
  target: string;
  temp: string;
  handle: FileHandle | null;
  size: number;
}

/** A push being received. Its messages are handled strictly in order through `queue`. */
interface Incoming {
  id: string;
  scope: string;
  dir: Direction;
  deleteExtras: boolean;
  map: PathMap;
  handler: ReceiveHandler;
  folders: Map<string, InFolder>;
  /** Folder ids of the push this side does not accept now (unknown, busy, not upstream): their lists are ignored. */
  ignored: Set<string>;
  stats: SyncStats;
  started: number;
  queue: Promise<void>;
  file: InFile | null;
  /** First failure; the push is rejected at its next request. */
  error: string | null;
  release: () => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** [primary, node] pairs of a `sync.begin` map (malformed pairs are ignored). */
function pairsOf(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (pair): pair is [string, string] =>
      Array.isArray(pair) &&
      pair.length === 2 &&
      typeof pair[0] === "string" &&
      typeof pair[1] === "string" &&
      path.isAbsolute(pair[0]) &&
      path.isAbsolute(pair[1]),
  );
}

/**
 * Syncs folders over one cluster channel, in both roles: `push` sends, `receive` accepts pushes.
 * Use one endpoint per channel (every endpoint answers every `sync.begin`).
 */
export class SyncEndpoint {
  private readonly baselines: SyncBaselines;
  private readonly pushLocks = new KeyedLock();
  private readonly receiveLocks = new KeyedLock();
  private readonly receivers: Array<{ prefix: string; handler: ReceiveHandler }> = [];
  private readonly incoming = new Map<string, Incoming>();
  /** Paths the receiver wants, per outgoing push and folder. */
  private readonly outgoing = new Map<string, Map<string, Set<string>>>();
  private readonly unsubscribe: Array<() => void>;
  private closed = false;

  constructor(
    private readonly channel: ClusterChannel,
    private readonly side: Side,
    baselines?: SyncBaselines,
  ) {
    this.baselines = baselines ?? new SyncBaselines();
    this.unsubscribe = [
      channel.on("sync.", (msg) => this.onMessage(msg)),
      channel.onBinary("sync.file", (header, data) =>
        this.enqueue(header.push, null, (inc) => this.writeChunk(inc, header, data)),
      ),
      channel.onClose(() => this.dropIncoming()),
    ];
  }

  /**
   * primary side ("down"): make the node's copy of every folder identical to the primary's (changed/missing files sent,
   * extra files deleted unless deleteExtras=false). node side ("up"): send the changes of every `upstream` folder since
   * the scope's baseline (the state after its last completed down- or up-sync). Resolves once the peer applied
   * everything (peer ack). Concurrent pushes of the same scope are serialized.
   */
  async push(
    scope: string,
    folders: SyncFolderSpec[],
    map: PathMap,
    opts: { deleteExtras?: boolean } = {},
  ): Promise<SyncStats> {
    if (this.closed) throw new Error("Sync endpoint is closed");
    const release = await this.pushLocks.acquire(scope);
    try {
      return await this.pushLocked(scope, folders, map, opts.deleteExtras ?? true);
    } finally {
      release();
    }
  }

  /**
   * Receive pushes for scopes starting with `prefix`. `folders(scope)` returns the specs this side accepts for the
   * scope (null = reject the whole push). The primary side MUST use its own specs (never the sender's paths).
   * `onApplied` runs after a push was fully applied, before the ack.
   */
  receive(prefix: string, handler: ReceiveHandler): () => void {
    const receiver = { prefix, handler };
    this.receivers.push(receiver);
    return () => {
      const index = this.receivers.indexOf(receiver);
      if (index >= 0) this.receivers.splice(index, 1);
    };
  }

  /** Forget a scope's baseline. */
  dropScope(scope: string): void {
    this.baselines.drop(scope);
  }

  /** Stop handling the channel; pushes being received are dropped (their temp files removed). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.unsubscribe) off();
    this.dropIncoming();
  }

  // --- sending --------------------------------------------------------------------------------

  private async pushLocked(
    scope: string,
    folders: SyncFolderSpec[],
    map: PathMap,
    deleteExtras: boolean,
  ): Promise<SyncStats> {
    const started = Date.now();
    const up = this.side === "node";
    const plans = await Promise.all(
      (up ? folders.filter((spec) => spec.upstream) : folders).map((spec) => this.planPush(scope, spec)),
    );
    const push = randomUUID();
    const wants = new Map<string, Set<string>>();
    this.outgoing.set(push, wants);
    try {
      await this.ask(scope, {
        t: "sync.begin",
        scope,
        push,
        dir: up ? "up" : "down",
        deleteExtras,
        folders: plans.map((plan) => plan.spec.id),
        map: map.pairs,
      });
      for (const plan of plans) await this.sendList(push, plan);
      await this.ask(scope, { t: "sync.listed", push });
      for (const plan of plans) {
        for (const rel of wants.get(plan.spec.id) ?? []) {
          const entry = plan.offered.get(rel);
          if (entry && entry.l === undefined) await this.sendFile(push, plan, rel);
        }
      }
      const done = await this.ask(scope, { t: "sync.done", push });
      if (up) for (const plan of plans) this.baselines.merge(scope, plan.spec.id, plan.offered.values(), plan.deleted);
      return { ...readStats(done.stats), ms: Date.now() - started };
    } catch (err) {
      this.channel.send({ t: "sync.abort", push, message: errorMessage(err) });
      throw err;
    } finally {
      this.outgoing.delete(push);
    }
  }

  /** Down: the full manifest. Up: changes against the scope's baseline (everything without one). */
  private async planPush(scope: string, spec: SyncFolderSpec): Promise<PushPlan> {
    const root = this.side === "node" ? spec.nodePath : spec.primaryPath;
    const entries = await scanFolder(root, spec.kind);
    if (this.side === "primary") {
      return { spec, root, offered: new Map(entries.map((entry) => [entry.p, entry])), deleted: [] };
    }
    const base = this.baselines.get(scope, spec.id);
    const offered = new Map<string, ManifestEntry>();
    const present = new Set<string>();
    for (const entry of entries) {
      present.add(entry.p);
      const before = base?.get(entry.p);
      if (!before || !sameEntry(before, entry, false)) offered.set(entry.p, entry);
    }
    const deleted = base ? [...base.keys()].filter((rel) => !present.has(rel)) : [];
    return { spec, root, offered, deleted };
  }

  private async sendList(push: string, plan: PushPlan): Promise<void> {
    const entries = [...plan.offered.values()];
    for (let i = 0; i < entries.length || i < plan.deleted.length; i += LIST_BATCH) {
      this.send({
        t: "sync.list",
        push,
        f: plan.spec.id,
        entries: entries.slice(i, i + LIST_BATCH),
        deleted: plan.deleted.slice(i, i + LIST_BATCH),
      });
      await this.channel.drain();
    }
  }

  /** Stream one file as `sync.file` chunks (a file that vanished or became a symlink is skipped). */
  private async sendFile(push: string, plan: PushPlan, rel: string): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await open(path.join(plan.root, rel), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch {
      return;
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) return;
      const header = { t: "sync.file", push, f: plan.spec.id, p: rel, m: Math.floor(st.mtimeMs), mode: st.mode & 0o777 };
      for (let offset = 0; ; ) {
        const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, offset);
        const chunk = buffer.subarray(0, bytesRead);
        const packed = bytesRead >= MIN_DEFLATE_BYTES ? deflateRawSync(chunk) : null;
        const compressed = packed !== null && packed.length < bytesRead;
        const last = bytesRead < CHUNK_BYTES;
        const frame = { ...header, o: offset, last, ...(compressed ? { z: true } : {}) };
        if (!this.channel.sendBinary(frame, compressed ? packed : chunk)) throw new Error("Cluster channel closed");
        offset += bytesRead;
        await this.channel.drain();
        if (last) return;
      }
    } finally {
      await handle.close();
    }
  }

  private send(msg: WireMessage): void {
    if (!this.channel.send(msg)) throw new Error("Cluster channel closed");
  }

  /** A request of the push protocol; a `sync.reject` (or anything but `sync.ok`) fails the push. */
  private async ask(scope: string, msg: WireMessage): Promise<WireMessage> {
    const reply = await this.channel.request(msg, SYNC_REQUEST_TIMEOUT_MS);
    if (reply.t === "sync.ok") return reply;
    const reason = typeof reply.message === "string" ? reply.message : reply.t;
    throw new Error(`Sync of ${scope} to ${this.channel.peer.name} failed: ${reason}`);
  }

  private onWant(msg: WireMessage): void {
    const wants = typeof msg.push === "string" ? this.outgoing.get(msg.push) : undefined;
    if (!wants || typeof msg.f !== "string" || !Array.isArray(msg.paths)) return;
    let paths = wants.get(msg.f);
    if (!paths) wants.set(msg.f, (paths = new Set()));
    for (const rel of msg.paths) if (typeof rel === "string") paths.add(rel);
  }

  // --- receiving ------------------------------------------------------------------------------

  private onMessage(msg: WireMessage): void {
    switch (msg.t) {
      case "sync.begin":
        void this.onBegin(msg).catch((err: unknown) => this.channel.reply(msg, { t: "sync.reject", message: errorMessage(err) }));
        return;
      case "sync.list":
        this.enqueue(msg.push, msg, (inc) => this.onList(inc, msg));
        return;
      case "sync.listed":
        this.enqueue(msg.push, msg, (inc) => this.onListed(inc, msg));
        return;
      case "sync.done":
        this.enqueue(msg.push, msg, (inc) => this.onDone(inc, msg));
        return;
      case "sync.abort":
        this.enqueue(msg.push, null, async (inc) => this.finish(inc));
        return;
      case "sync.want":
        this.onWant(msg);
    }
  }

  /** Run `work` after everything queued for the push; unknown pushes are rejected (requests) or ignored. */
  private enqueue(push: unknown, request: WireMessage | null, work: (inc: Incoming) => Promise<void>): void {
    const inc = typeof push === "string" ? this.incoming.get(push) : undefined;
    if (!inc) {
      if (request?.rid) this.channel.reply(request, { t: "sync.reject", message: "Unknown sync push" });
      return;
    }
    inc.queue = inc.queue.then(() => work(inc)).catch((err: unknown) => this.fail(inc, errorMessage(err)));
  }

  private receiverFor(scope: string): ReceiveHandler | null {
    let best: { prefix: string; handler: ReceiveHandler } | null = null;
    for (const receiver of this.receivers) {
      if (scope.startsWith(receiver.prefix) && (!best || receiver.prefix.length > best.prefix.length)) best = receiver;
    }
    return best?.handler ?? null;
  }

  /**
   * The folders of a push resolved against this side's own specs (the reason when refused). Folders
   * `folders(scope)` leaves out (and, on the primary, non-upstream ones) are skipped, not rejected:
   * receivers filter folders that are busy right now.
   */
  private acceptedSpecs(msg: WireMessage, handler: ReceiveHandler): SyncFolderSpec[] | string {
    const scope = msg.scope as string;
    const ids = msg.folders as string[];
    const specs = handler.folders(scope);
    if (!specs) return `Sync of ${scope} refused`;
    if (new Set(ids).size !== ids.length) return "Duplicate folder ids";
    return specs.filter((spec) => ids.includes(spec.id) && (this.side === "node" || spec.upstream));
  }

  private async onBegin(msg: WireMessage): Promise<void> {
    const reject = (message: string) => void this.channel.reply(msg, { t: "sync.reject", message });
    const { scope, push, folders } = msg;
    if (typeof scope !== "string" || typeof push !== "string" || !Array.isArray(folders)) {
      return reject("Malformed sync.begin");
    }
    if (!folders.every((id) => typeof id === "string")) return reject("Malformed sync.begin");
    const dir: Direction = this.side === "node" ? "down" : "up";
    if (msg.dir !== dir) return reject(`This node only accepts ${dir} syncs`);
    const handler = this.receiverFor(scope);
    if (!handler) return reject(`No receiver for ${scope}`);
    const specs = this.acceptedSpecs(msg, handler);
    if (typeof specs === "string") return reject(specs);
    const release = await this.receiveLocks.acquire(scope);
    if (this.closed || this.channel.closed || this.incoming.has(push)) {
      release();
      return reject("Sync push not accepted");
    }
    const inFolders = new Map<string, InFolder>();
    try {
      for (const spec of specs) inFolders.set(spec.id, await this.openFolder(spec));
    } catch (err) {
      release();
      return reject(errorMessage(err));
    }
    const specPairs = specs.map((spec) => [spec.primaryPath, spec.nodePath] as const);
    this.incoming.set(push, {
      id: push,
      scope,
      dir,
      deleteExtras: msg.deleteExtras !== false,
      // The node trusts the primary's map; the primary only its own specs.
      map: new PathMap(this.side === "node" ? [...pairsOf(msg.map), ...specPairs] : specPairs),
      handler,
      folders: inFolders,
      ignored: new Set((folders as string[]).filter((id) => !inFolders.has(id))),
      stats: { files: 0, bytes: 0, deleted: 0, skipped: 0, ms: 0 },
      started: Date.now(),
      queue: Promise.resolve(),
      file: null,
      error: null,
      release,
    });
    this.channel.reply(msg, { t: "sync.ok" });
  }

  private async openFolder(spec: SyncFolderSpec): Promise<InFolder> {
    const root = path.resolve(this.side === "node" ? spec.nodePath : spec.primaryPath);
    await mkdir(root, { recursive: true });
    return {
      spec,
      root,
      realRoot: await realpath(root),
      gitRoot: path.basename(root) === ".git",
      offered: new Map(),
      deleted: [],
      disk: new Map(),
      want: new Set(),
      links: [],
      removals: [],
      applied: new Map(),
    };
  }

  private async onList(inc: Incoming, msg: WireMessage): Promise<void> {
    if (inc.error) return;
    const folder = typeof msg.f === "string" ? inc.folders.get(msg.f) : undefined;
    if (!folder) {
      if (!inc.ignored.has(msg.f as string)) this.fail(inc, "Sync list for an unknown folder");
      return;
    }
    for (const entry of Array.isArray(msg.entries) ? msg.entries : []) {
      if (!isManifestEntry(entry)) return this.fail(inc, `Invalid entry in sync offer: ${describe(entry)}`);
      folder.offered.set(entry.p, entry);
    }
    if (inc.dir !== "up") return;
    for (const rel of Array.isArray(msg.deleted) ? msg.deleted : []) {
      if (!isSafeRel(rel)) return this.fail(inc, `Invalid path in sync offer: ${describe(rel)}`);
      folder.deleted.push(rel);
    }
  }

  private async onListed(inc: Incoming, msg: WireMessage): Promise<void> {
    if (!inc.error) {
      try {
        for (const folder of inc.folders.values()) await this.planReceive(inc, folder);
      } catch (err) {
        this.fail(inc, errorMessage(err));
      }
    }
    if (inc.error) {
      this.channel.reply(msg, { t: "sync.reject", message: inc.error });
      this.finish(inc);
      return;
    }
    for (const folder of inc.folders.values()) {
      const paths = [...folder.want];
      for (let i = 0; i < paths.length; i += LIST_BATCH) {
        this.channel.send({ t: "sync.want", push: inc.id, f: folder.spec.id, paths: paths.slice(i, i + LIST_BATCH) });
      }
    }
    this.channel.reply(msg, { t: "sync.ok" });
  }

  /** Diff the offer against the local folder: files to fetch, symlinks to create, paths to delete. */
  private async planReceive(inc: Incoming, folder: InFolder): Promise<void> {
    folder.disk = new Map((await scanFolder(folder.root, folder.spec.kind)).map((entry) => [entry.p, entry]));
    for (const entry of folder.offered.values()) {
      if (this.isDenied(folder, entry.p, entry.l !== undefined)) {
        inc.stats.skipped++;
        continue;
      }
      const local = folder.disk.get(entry.p);
      if (entry.l !== undefined) {
        if (local?.l !== this.linkTarget(inc, entry.l)) folder.links.push(entry);
        continue;
      }
      // Pointer files are rewritten here, so only their mtime tells versions apart.
      if (local && sameEntry(local, entry, isPointerFile(entry.p, folder.gitRoot))) continue;
      folder.want.add(entry.p);
    }
    const removals =
      inc.dir === "up"
        ? folder.deleted
        : inc.deleteExtras
          ? [...folder.disk.keys()].filter((rel) => !folder.offered.has(rel))
          : [];
    for (const rel of removals) {
      const local = folder.disk.get(rel);
      if (!local) continue;
      if (this.isDenied(folder, rel, local.l !== undefined)) inc.stats.skipped++;
      else folder.removals.push(rel);
    }
  }

  private isDenied(folder: InFolder, rel: string, link: boolean): boolean {
    return this.side === "primary" && isDeniedUpstream(rel, folder.gitRoot, link);
  }

  /** A symlink target as this side stores it: absolute targets are mapped to this side's paths. */
  private linkTarget(inc: Incoming, target: string): string {
    if (!path.isAbsolute(target)) return target;
    return this.side === "node" ? inc.map.pathToNode(target) : inc.map.pathToPrimary(target);
  }

  private async writeChunk(inc: Incoming, header: BinaryHeader, data: Buffer): Promise<void> {
    if (inc.error) return;
    const folder = typeof header.f === "string" ? inc.folders.get(header.f) : undefined;
    const rel = header.p;
    if (!folder || typeof rel !== "string" || !folder.want.has(rel)) {
      return this.fail(inc, `Unexpected file in sync: ${describe(rel)}`);
    }
    const { o: offset, m: mtime, mode } = header;
    if (
      !Number.isSafeInteger(offset) ||
      (offset as number) < 0 ||
      typeof mtime !== "number" ||
      !Number.isFinite(mtime) ||
      !Number.isInteger(mode)
    ) {
      return this.fail(inc, "Malformed sync.file header");
    }
    const bytes = header.z === true ? inflateRawSync(data, { maxOutputLength: CHUNK_BYTES }) : data;
    if (bytes.length > CHUNK_BYTES) return this.fail(inc, "Oversized sync.file chunk");
    if (offset === 0 && !inc.file) inc.file = await this.openFile(inc, folder, rel);
    const file = inc.file;
    if (!file || file.folder !== folder || file.rel !== rel || file.size !== offset) {
      return this.fail(inc, `Out-of-order chunk of ${rel}`);
    }
    if (file.handle && bytes.length > 0) {
      await file.handle.write(bytes, 0, bytes.length, file.size);
      inc.stats.bytes += bytes.length;
    }
    file.size += bytes.length;
    if (header.last !== true) return;
    inc.file = null;
    folder.want.delete(rel);
    await this.commitFile(inc, file, mtime, mode as number);
  }

  /** Open the temp file a received file is written to; a refused location yields a dropping InFile. */
  private async openFile(inc: Incoming, folder: InFolder, rel: string): Promise<InFile> {
    const placed = await this.placement(folder, rel, true, false);
    if (!placed) {
      inc.stats.skipped++;
      return { folder, rel, target: "", temp: "", handle: null, size: 0 };
    }
    const temp = path.join(placed.dir, `${TEMP_PREFIX}${randomUUID()}`);
    const handle = await open(temp, "wx", 0o600);
    return { folder, rel, target: placed.target, temp, handle, size: 0 };
  }

  /** Finish a received file: rewrite pointer files, mode, mtime, then rename it into place. */
  private async commitFile(inc: Incoming, file: InFile, mtime: number, mode: number): Promise<void> {
    const handle = file.handle;
    if (!handle) return;
    file.handle = null;
    try {
      await handle.close();
      if (isPointerFile(file.rel, file.folder.gitRoot)) {
        const text = await readFile(file.temp, "utf8");
        const mapped = this.side === "node" ? inc.map.toNode(text) : inc.map.toPrimary(text);
        if (mapped !== text) await writeFile(file.temp, mapped);
      }
      await chmod(file.temp, (mode & 0o755) | 0o600);
      await utimes(file.temp, mtime / 1000, mtime / 1000);
      if (!(await this.clearTarget(file.target))) {
        await unlink(file.temp);
        inc.stats.skipped++;
        return;
      }
      await rename(file.temp, file.target);
    } catch (err) {
      await unlink(file.temp).catch(() => undefined);
      throw err;
    }
    file.folder.applied.set(file.rel, entryOf(file.rel, await lstat(file.target)));
    inc.stats.files++;
  }

  /**
   * The real parent directory and final path of `rel` (a symlink when `link`), walking from the
   * folder's real root. Missing directories are created (`create`; a file in the way is replaced);
   * a symlinked parent must resolve inside the root. Null when refused (or, without `create`, when
   * the parent is missing).
   */
  private async placement(
    folder: InFolder,
    rel: string,
    create: boolean,
    link: boolean,
  ): Promise<{ dir: string; target: string } | null> {
    const segments = rel.split("/");
    const name = segments.pop() as string;
    let dir = folder.realRoot;
    for (const segment of segments) {
      const next = path.join(dir, segment);
      const st = await lstat(next).catch(() => null);
      if (st?.isDirectory()) {
        dir = next;
        continue;
      }
      if (st?.isSymbolicLink()) {
        const real = await realpath(next).catch(() => null);
        if (!real || !isInside(folder.realRoot, real) || !(await stat(real).catch(() => null))?.isDirectory()) return null;
        dir = real;
        continue;
      }
      if (!create) return null;
      if (st) await unlink(next);
      await mkdir(next).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
      });
      dir = next;
    }
    const target = path.join(dir, name);
    // Through in-root symlinks a path may land somewhere the logical path check did not cover.
    const resolvedRel = path.relative(folder.realRoot, target).split(path.sep).join("/");
    if (this.isDenied(folder, resolvedRel, link)) return null;
    return { dir, target };
  }

  /** Make room for a file or symlink: a directory in the way goes (on the primary only when empty). */
  private async clearTarget(target: string): Promise<boolean> {
    const st = await lstat(target).catch(() => null);
    if (!st?.isDirectory()) return true;
    if (this.side === "node") {
      await rm(target, { recursive: true, force: true });
      return true;
    }
    return rmdir(target).then(
      () => true,
      () => false,
    );
  }

  private async onDone(inc: Incoming, msg: WireMessage): Promise<void> {
    if (!inc.error) {
      try {
        await this.apply(inc);
      } catch (err) {
        this.fail(inc, errorMessage(err));
      }
    }
    if (inc.error) {
      this.channel.reply(msg, { t: "sync.reject", message: inc.error });
      this.finish(inc);
      return;
    }
    const stats = { ...inc.stats, ms: Date.now() - inc.started };
    try {
      await inc.handler.onApplied?.(inc.scope, stats);
      this.channel.reply(msg, { t: "sync.ok", stats });
    } catch (err) {
      this.channel.reply(msg, { t: "sync.reject", message: errorMessage(err) });
    }
    this.finish(inc);
  }

  /** After the last file: symlinks, deletions, and (node side) the new baselines. */
  private async apply(inc: Incoming): Promise<void> {
    if (inc.file) throw new Error(`Incomplete file ${inc.file.rel}`);
    for (const folder of inc.folders.values()) {
      for (const link of folder.links) await this.placeLink(inc, folder, link);
      for (const rel of folder.removals) await this.remove(inc, folder, rel);
      if (this.side !== "node") continue;
      const state = new Map(folder.disk);
      for (const [rel, entry] of folder.applied) {
        if (entry) state.set(rel, entry);
        else state.delete(rel);
      }
      this.baselines.set(inc.scope, folder.spec.id, state.values());
    }
  }

  /**
   * Create a symlink, only when its target resolves inside the folder. A `..` after a named
   * segment is refused outright: the name may itself be a symlink (`s -> .`), so the lexical
   * resolution would not be where the link leads on disk.
   */
  private async placeLink(inc: Incoming, folder: InFolder, link: ManifestEntry): Promise<void> {
    const target = this.linkTarget(inc, link.l as string);
    const segments = target.split("/");
    const climbs = segments.findIndex((segment) => segment !== "..");
    const placed =
      climbs >= 0 && segments.slice(climbs).includes("..") ? null : await this.placement(folder, link.p, true, true);
    if (!placed || !isInside(folder.realRoot, path.resolve(placed.dir, target))) {
      inc.stats.skipped++;
      return;
    }
    const temp = path.join(placed.dir, `${TEMP_PREFIX}${randomUUID()}`);
    await symlink(target, temp);
    try {
      await lutimes(temp, link.m / 1000, link.m / 1000);
      if (!(await this.clearTarget(placed.target))) {
        await unlink(temp);
        inc.stats.skipped++;
        return;
      }
      await rename(temp, placed.target);
    } catch (err) {
      await unlink(temp).catch(() => undefined);
      throw err;
    }
    folder.applied.set(link.p, entryOf(link.p, await lstat(placed.target), target));
    inc.stats.files++;
  }

  /** Delete a file or symlink, then the directories it leaves empty (up to the root). */
  private async remove(inc: Incoming, folder: InFolder, rel: string): Promise<void> {
    const placed = await this.placement(folder, rel, false, folder.disk.get(rel)?.l !== undefined);
    if (!placed) return;
    const st = await lstat(placed.target).catch(() => null);
    if (!st || st.isDirectory()) return;
    await unlink(placed.target);
    folder.applied.set(rel, null);
    inc.stats.deleted++;
    for (let dir = placed.dir; dir !== folder.realRoot && isInside(folder.realRoot, dir); dir = path.dirname(dir)) {
      if (!(await rmdir(dir).then(() => true, () => false))) return;
    }
  }

  private fail(inc: Incoming, message: string): void {
    inc.error ??= message;
    this.discardFile(inc);
  }

  /** Drop a push being received: its partial file is removed and its scope unlocked. */
  private finish(inc: Incoming): void {
    if (this.incoming.get(inc.id) !== inc) return;
    this.incoming.delete(inc.id);
    this.discardFile(inc);
    inc.release();
  }

  private discardFile(inc: Incoming): void {
    const file = inc.file;
    inc.file = null;
    const handle = file?.handle;
    if (!file || !handle) return;
    file.handle = null;
    void handle
      .close()
      .catch(() => undefined)
      .then(() => unlink(file.temp))
      .catch(() => undefined);
  }

  private dropIncoming(): void {
    for (const inc of [...this.incoming.values()]) this.finish(inc);
  }
}

/** A short, log-safe rendering of an untrusted value. */
function describe(value: unknown): string {
  return JSON.stringify(value)?.slice(0, 200) ?? String(value);
}

// --- SQLite snapshots -------------------------------------------------------------------------

/** Consistent copy of a SQLite database (VACUUM INTO via node:sqlite, read-only source); `target` is replaced atomically. */
export async function snapshotSqlite(source: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    const db = new DatabaseSync(source, { readOnly: true, timeout: SQLITE_BUSY_TIMEOUT_MS });
    try {
      db.exec(`VACUUM INTO '${temp.replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}
