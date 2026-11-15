// The omp runtime a cluster shares. The primary serves its own omp binary (replicas download it
// once per build, verified by sha256, into DATA_DIR/cluster/bin) and keeps a staging copy of its
// omp agent dir (config, credentials db snapshot, skills, extensions, rules, mcp.json) that is
// synced to every node as the PI_CODING_AGENT_DIR of remote runs. Replicas report what they can
// run with (localOmpInfo) in register / node.status.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, type Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, pipeline as pipeStreams } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";

import { clusterPaths } from "@/lib/cluster/paths";
import { snapshotSqlite } from "@/lib/cluster/sync";
import type { NodeOmpInfo } from "@/lib/types";

const execFileAsync = promisify(execFile);

const VERSION_TIMEOUT_MS = 10_000;
/** The agent dir pack is rebuilt at most this often. */
const PACK_REFRESH_MS = 60_000;
/** A binary download that receives nothing for this long is aborted. */
const DOWNLOAD_IDLE_MS = 60_000;
/** Downloaded binaries kept in DATA_DIR/cluster/bin (the newest ones). */
const KEPT_BINARIES = 2;
/** The local `omp` is probed again this often while it is missing. */
const LOCAL_PROBE_RETRY_MS = 60_000;

/** Top-level folders of the agent dir that are node-local or bulky (never shipped). */
const EXCLUDED_DIRS = new Set(["sessions", "blobs", "terminal-sessions", "cache", "logs", "predict"]);

/** History databases, SQLite side files (the snapshot is self-contained) and backups. */
function excludedFile(name: string): boolean {
  return (
    name.startsWith("history.db") || name.endsWith(".db-wal") || name.endsWith(".db-shm") || name.includes(".pre-")
  );
}

// ---------------------------------------------------------------------------------------------
// Primary: the binary it shares

/** The primary's omp binary, as served at /api/v1/cluster/runtime/omp. */
export interface OmpBinaryInfo {
  /** Real path of the executable (symlinks resolved). */
  path: string;
  /** First line of `omp --version`. */
  version: string;
  sha256: string;
  size: number;
  platform: string;
  arch: string;
}

/** Per resolved path: the file stamp (size + mtime) the cached description belongs to. */
const binaryCache = new Map<string, { stamp: string; info: Promise<OmpBinaryInfo | null> }>();

/**
 * Describe the omp binary `ompPath` names (a command looked up on PATH, or a path). null when it
 * cannot be found or does not answer `--version`. Cached until the file's size or mtime changes.
 */
export async function primaryOmpBinary(ompPath: string): Promise<OmpBinaryInfo | null> {
  const resolved = await resolveExecutable(ompPath);
  if (!resolved) return null;
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) return null;
  const stamp = `${stat.size}:${stat.mtimeMs}`;
  const cached = binaryCache.get(resolved);
  if (cached?.stamp === stamp) return cached.info;
  const info = describeBinary(resolved, stat.size);
  binaryCache.set(resolved, { stamp, info });
  // Failures are not cached: `--version` may just have timed out under load.
  void info.then((result) => {
    if (!result && binaryCache.get(resolved)?.info === info) binaryCache.delete(resolved);
  });
  return info;
}

async function describeBinary(file: string, size: number): Promise<OmpBinaryInfo | null> {
  const [version, sha256] = await Promise.all([ompVersion(file), fileSha256(file).catch(() => null)]);
  if (!version || !sha256) return null;
  return { path: file, version, sha256, size, platform: process.platform, arch: process.arch };
}

/** Real path of an executable: `command` with a path separator is taken as a path, else looked up on PATH. */
async function resolveExecutable(command: string): Promise<string | null> {
  const name = command.trim();
  if (!name) return null;
  const candidates =
    path.isAbsolute(name) || name.includes("/") || name.includes(path.sep)
      ? [path.resolve(name)]
      : (process.env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((dir) => path.join(dir, name));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      const real = await fs.realpath(candidate);
      if ((await fs.stat(real)).isFile()) return real;
    } catch {
      // Not here; try the next PATH entry.
    }
  }
  return null;
}

/** First non-empty line of `<file> --version`, or null when it fails. */
async function ompVersion(file: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, ["--version"], { timeout: VERSION_TIMEOUT_MS, encoding: "utf8" });
    return (
      stdout
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean) ?? null
    );
  } catch {
    return null;
  }
}

async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Primary: the agent dir pack

interface PackState {
  source: string;
  target: string;
  builtAt: number;
  pending: Promise<string> | null;
  /** Staging path of each snapshotted database → stamp of its source (db + -wal) at that time. */
  dbStamps: Map<string, string>;
}

let pack: PackState | null = null;

/**
 * Staging copy of the omp agent dir (PI_CODING_AGENT_DIR || ~/.omp/agent) at
 * DATA_DIR/cluster/staging/omp-agent (mode 0700): everything except sessions/, blobs/,
 * terminal-sessions/, cache/, logs/, predict/, history.db*, *.db-wal, *.db-shm and *.pre-*;
 * SQLite databases are consistent snapshots; symlinks are followed. Refreshed at most every
 * 60 s (concurrent calls share one refresh); resolves with the staging dir.
 */
export function buildOmpAgentPack(): Promise<string> {
  const source = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".omp", "agent");
  const target = path.join(clusterPaths().staging, "omp-agent");
  if (!pack || pack.source !== source || pack.target !== target) {
    pack = { source, target, builtAt: 0, pending: null, dbStamps: new Map() };
  }
  const state = pack;
  if (state.pending) return state.pending;
  if (Date.now() - state.builtAt < PACK_REFRESH_MS) return Promise.resolve(target);
  const pending = refreshPack(state)
    .then(() => {
      state.builtAt = Date.now();
      return target;
    })
    .finally(() => {
      state.pending = null;
    });
  state.pending = pending;
  return pending;
}

async function refreshPack(state: PackState): Promise<void> {
  await fs.mkdir(path.dirname(state.target), { recursive: true, mode: 0o700 });
  await fs.mkdir(state.target, { recursive: true, mode: 0o700 });
  await fs.chmod(state.target, 0o700);
  // Copies are written next to the pack and renamed in, so a sync scanning it never sees partial files.
  const tempDir = `${state.target}.tmp`;
  await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });
  try {
    await mirrorDir(state, state.source, state.target, tempDir, new Set(), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/** Make `target` a copy of `source` (minus the deny-list); `ancestors` holds real paths to stop symlink cycles. */
async function mirrorDir(
  state: PackState,
  source: string,
  target: string,
  tempDir: string,
  ancestors: Set<string>,
  top: boolean,
): Promise<void> {
  const real = await fs.realpath(source).catch(() => null);
  const names = real && !ancestors.has(real) ? await fs.readdir(source).catch(() => [] as string[]) : [];
  const within = new Set(ancestors).add(real ?? source);
  const kept = new Set<string>();
  for (const name of names) {
    const from = path.join(source, name);
    const to = path.join(target, name);
    const stat = await fs.stat(from).catch(() => null);
    if (stat?.isDirectory()) {
      if (top && EXCLUDED_DIRS.has(name)) continue;
      kept.add(name);
      await prepareTarget(to, "dir");
      await fs.mkdir(to, { recursive: true, mode: 0o700 });
      await mirrorDir(state, from, to, tempDir, within, false);
    } else if (stat?.isFile() && !excludedFile(name)) {
      kept.add(name);
      await prepareTarget(to, "file");
      if (name.endsWith(".db")) await snapshotDatabase(state, from, to, stat, tempDir);
      else await copyIfChanged(from, to, stat, tempDir);
    }
  }
  for (const name of await fs.readdir(target).catch(() => [] as string[])) {
    if (!kept.has(name)) await fs.rm(path.join(target, name), { recursive: true, force: true });
  }
}

/** Remove `to` when it exists as the other kind (a file where a folder goes, or the reverse). */
async function prepareTarget(to: string, kind: "dir" | "file"): Promise<void> {
  const existing = await fs.lstat(to).catch(() => null);
  if (!existing) return;
  const matches = kind === "dir" ? existing.isDirectory() : existing.isFile();
  if (!matches) await fs.rm(to, { recursive: true, force: true });
}

/** Snapshot a SQLite database unless its source (db + -wal) is unchanged since the last snapshot. */
async function snapshotDatabase(state: PackState, from: string, to: string, stat: Stats, tempDir: string): Promise<void> {
  const wal = await fs.stat(`${from}-wal`).catch(() => null);
  const stamp = `${stat.size}:${stat.mtimeMs}:${wal ? `${wal.size}:${wal.mtimeMs}` : "-"}`;
  if (state.dbStamps.get(to) === stamp && (await fs.stat(to).catch(() => null))) return;
  try {
    await snapshotSqlite(from, to);
    await fs.chmod(to, stat.mode & 0o777);
  } catch {
    // Not a SQLite database after all: ship it as a plain file.
    await copyIfChanged(from, to, stat, tempDir);
  }
  state.dbStamps.set(to, stamp);
}

/** Copy `from` over `to` (mode and mtime kept, atomic rename) unless size and mtime already match. */
async function copyIfChanged(from: string, to: string, stat: Stats, tempDir: string): Promise<void> {
  const existing = await fs.stat(to).catch(() => null);
  if (existing?.size === stat.size && Math.abs(existing.mtimeMs - stat.mtimeMs) < 1) return;
  const temp = path.join(tempDir, randomBytes(8).toString("hex"));
  await fs.copyFile(from, temp);
  await fs.chmod(temp, stat.mode & 0o777);
  await fs.utimes(temp, stat.atime, stat.mtime);
  await fs.rename(temp, to);
}

// ---------------------------------------------------------------------------------------------
// Replica: the primary's binary, downloaded

/** The binary a replica was last asked to provide, and how far it got. */
interface DownloadState {
  sha256: string;
  version: string;
  /** Uncompressed size; <= 0 when unknown. */
  size: number;
  status: "downloading" | "ready" | "failed";
  received: number;
  error: string | null;
}

let download: DownloadState | null = null;
const downloads = new Map<string, Promise<string>>();

/**
 * The primary's omp binary on this node: DATA_DIR/cluster/bin/omp-<sha256 prefix>, downloaded
 * (gzip) from `${primaryHttpUrl}/api/v1/cluster/runtime/omp` when missing, sha256-verified and made
 * executable. Concurrent calls for one sha share a download; the two newest binaries are kept.
 * `want.size` <= 0 means unknown (the sha256 check alone decides).
 */
export function ensureOmpBinary(
  primaryHttpUrl: string,
  want: { sha256: string; version: string; size: number },
): Promise<string> {
  const sha256 = want.sha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) return Promise.reject(new Error("Invalid omp binary checksum"));
  const existing = downloads.get(sha256);
  if (existing) return existing;
  const pending = installBinary(primaryHttpUrl, { ...want, sha256 }).finally(() => downloads.delete(sha256));
  downloads.set(sha256, pending);
  return pending;
}

async function installBinary(
  primaryHttpUrl: string,
  want: { sha256: string; version: string; size: number },
): Promise<string> {
  const state: DownloadState = { ...want, status: "downloading", received: 0, error: null };
  download = state;
  const dir = clusterPaths().bin;
  const target = path.join(dir, `omp-${want.sha256.slice(0, 12)}`);
  try {
    const installed = await fs.stat(target).catch(() => null);
    if (!installed?.isFile() || (want.size > 0 && installed.size !== want.size)) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const temp = path.join(dir, `.omp-${want.sha256.slice(0, 12)}.${randomBytes(6).toString("hex")}.tmp`);
      try {
        const url = `${primaryHttpUrl.replace(/\/+$/, "")}/api/v1/cluster/runtime/omp`;
        const actual = await downloadTo(url, temp, state);
        if (actual !== want.sha256) {
          throw new Error(
            `checksum mismatch (expected ${want.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
          );
        }
        await fs.chmod(temp, 0o755);
        await fs.rename(temp, target);
      } finally {
        await fs.rm(temp, { force: true });
      }
      await pruneBinaries(dir);
    }
  } catch (err) {
    state.status = "failed";
    state.error = err instanceof Error && err.message ? err.message : String(err);
    throw new Error(`Cannot get omp ${want.version} from the primary: ${state.error}`, { cause: err });
  }
  state.status = "ready";
  return target;
}

/** Stream the (gzip) body of `url` into `file`; resolves with the sha256 of the written bytes. */
async function downloadTo(url: string, file: string, state: DownloadState): Promise<string> {
  const controller = new AbortController();
  let idle: NodeJS.Timeout | undefined;
  const touch = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new Error("download stalled")), DOWNLOAD_IDLE_MS);
    idle.unref();
  };
  touch();
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const hash = createHash("sha256");
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      gunzipWhenCompressed,
      async function* measure(source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          touch();
          state.received += chunk.length;
          if (state.size > 0 && state.received > state.size) throw new Error("larger than announced");
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(file, { mode: 0o700 }),
    );
    return hash.digest("hex");
  } finally {
    clearTimeout(idle);
  }
}

/**
 * Gunzip the stream when it starts with the gzip magic bytes; pass it through otherwise (fetch has
 * already decoded it when the server sent `Content-Encoding: gzip`).
 */
async function* gunzipWhenCompressed(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const iterator = source[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) return;
  const head: Buffer = first.value;
  async function* rest(): AsyncGenerator<Buffer> {
    yield head;
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) yield next.value;
  }
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const gunzip = createGunzip();
    // Errors of either side destroy the gunzip stream, which ends the iteration below with them.
    pipeStreams(Readable.from(rest()), gunzip, () => {});
    yield* gunzip;
  } else {
    yield* rest();
  }
}

/** Delete all but the KEPT_BINARIES newest `omp-*` binaries. */
async function pruneBinaries(dir: string): Promise<void> {
  const names = (await fs.readdir(dir)).filter((name) => name.startsWith("omp-"));
  const dated = await Promise.all(
    names.map(async (name) => ({ name, mtime: (await fs.stat(path.join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })),
  );
  dated.sort((a, b) => b.mtime - a.mtime);
  for (const { name } of dated.slice(KEPT_BINARIES)) await fs.rm(path.join(dir, name), { force: true });
}

// ---------------------------------------------------------------------------------------------
// Replica: what it reports

/** Result of probing the node's own `omp` on PATH (refreshed while missing). */
let localProbe: { at: number; version: string | null; pending: boolean } | null = null;

function probeLocalOmp(): void {
  if (localProbe?.pending) return;
  if (localProbe && (localProbe.version || Date.now() - localProbe.at < LOCAL_PROBE_RETRY_MS)) return;
  const probe = { at: Date.now(), version: localProbe?.version ?? null, pending: true };
  localProbe = probe;
  void resolveExecutable("omp")
    .then((file) => (file ? ompVersion(file) : null))
    .then((version) => {
      probe.version = version;
      probe.at = Date.now();
      probe.pending = false;
    });
}

/**
 * The omp this node runs cards with, for register / node.status: the primary's binary once
 * downloaded (with progress while downloading), else the node's own `omp` on PATH.
 */
export function localOmpInfo(): NodeOmpInfo {
  if (download) {
    if (download.status === "ready") return { ready: true, version: download.version, source: "primary", reason: null };
    if (download.status === "downloading") {
      const progress =
        download.size > 0
          ? `${Math.min(99, Math.floor((download.received / download.size) * 100))}%`
          : `${Math.round(download.received / (1024 * 1024))} MB`;
      return {
        ready: false,
        version: download.version,
        source: "primary",
        reason: `Downloading omp ${download.version} from the primary (${progress})`,
      };
    }
    return { ready: false, version: download.version, source: "primary", reason: download.error };
  }
  probeLocalOmp();
  if (localProbe?.version) return { ready: true, version: localProbe.version, source: "local", reason: null };
  return {
    ready: false,
    version: null,
    source: null,
    reason: localProbe?.pending ? "Looking for omp on this machine" : "omp is not installed on this machine",
  };
}
