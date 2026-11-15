// Replication of the primary's state to every replica (sync scope `repl`, down only), so any
// replica can be promoted with the primary's data. The primary pushes, per replica, a SQLite
// snapshot of its database (when the db or its -wal changed), DATA_DIR/files, the card worktrees,
// the cluster session dirs, every board's project folders (to the replica's mirror) and the omp
// agent dir pack, plus the secrets the replica needs (`repl.secrets`). Each completed round has
// a sequence number (`repl.seq`), which ranks replicas in elections. The replica swaps the
// received database snapshot in and records the round in DATA_DIR/cluster/replication.json.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { readNodeState, updateNodeState } from "@/lib/cluster/node";
import { buildOmpAgentPack } from "@/lib/cluster/omp-runtime";
import { canonicalPath, clusterPaths, mirrorPath } from "@/lib/cluster/paths";
import type { ClusterChannel } from "@/lib/cluster/protocol";
import { PathMap, snapshotSqlite, type SyncEndpoint } from "@/lib/cluster/sync";
import {
  DB_REPLICATION_INTERVAL_MS,
  FILE_REPLICATION_INTERVAL_MS,
  type NodePaths,
  type SyncFolderSpec,
  type WireMessage,
} from "@/lib/cluster/types";
import { describeDatabase, effectiveDatabaseConfig, getRepo, reopenDatabase, swapDatabase } from "@/lib/db";
import { dataDir } from "@/lib/files";

/** Sync scope of replication pushes. */
const REPL_SCOPE = "repl";
/** File name of the database snapshot, on both sides. */
const DB_SNAPSHOT_NAME = "omp-ui.db";
/** Folder id of the database snapshot within the scope. */
const DB_FOLDER_ID = "db";
const CREDENTIALS_KEY_FILE = "credentials.key";

/** primary → replica before each push: the folders it is about to send (node paths). */
interface ReplPlanMsg extends WireMessage {
  t: "repl.plan";
  folders: SyncFolderSpec[];
}

/** primary → replica after a completed round. `at`: when the round's state was captured. */
interface ReplSeqMsg extends WireMessage {
  t: "repl.seq";
  seq: number;
  at: string;
  primaryDataDir: string;
}

/** The secrets a replica needs. null: the primary has none to share. */
interface ReplSecrets {
  /** Content of DATA_DIR/credentials.key. */
  credentialsKeyFile: string | null;
  /** CREDENTIALS_KEY env (overrides the key file). */
  credentialsKey: string | null;
  authSecret: string | null;
  databaseUrl: string | null;
}

/** primary → replica on start and whenever one changes. */
interface ReplSecretsMsg extends WireMessage, ReplSecrets {
  t: "repl.secrets";
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

/** `child` is `parent` or lies inside it. */
function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function overlaps(a: string, b: string): boolean {
  return isWithin(a, b) || isWithin(b, a);
}

// ---------------------------------------------------------------------------------------------
// Replication state (DATA_DIR/cluster/replication.json)

interface ReplicationState {
  /** Replicas: last applied round. Primaries: last round number handed out. */
  seq: number;
  at: string | null;
  /** DATA_DIR of the primary the replicated data comes from (paths in it are rewritten on promotion). */
  primaryDataDir: string | null;
}

let replicationState: { file: string; state: ReplicationState } | null = null;

function replicationFile(): string {
  return path.join(clusterPaths().root, "replication.json");
}

function readReplicationState(): ReplicationState {
  const file = replicationFile();
  if (replicationState?.file === file) return replicationState.state;
  let state: ReplicationState = { seq: 0, at: null, primaryDataDir: null };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ReplicationState>;
    state = {
      seq: Number.isSafeInteger(raw.seq) && (raw.seq as number) > 0 ? (raw.seq as number) : 0,
      at: typeof raw.at === "string" ? raw.at : null,
      primaryDataDir: typeof raw.primaryDataDir === "string" ? raw.primaryDataDir : null,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[cluster] cannot read the replication state; starting from 0:", errorMessage(err));
    }
  }
  replicationState = { file, state };
  return state;
}

function writeReplicationState(state: ReplicationState): void {
  const file = replicationFile();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  replicationState = { file, state };
}

/** Sequence number of the last replication round applied on this node (0: none). */
export function replicatedSeq(): number {
  return readReplicationState().seq;
}

/** Where this node's replicated data came from: the DATA_DIR of the primary that sent it. */
export function replicationOrigin(): { primaryDataDir: string | null } {
  return { primaryDataDir: readReplicationState().primaryDataDir };
}

/** Forget the applied / handed-out seq (0): a demoted ex-primary must not rank by its old counter. */
export function resetReplicatedSeq(): void {
  writeReplicationState({ ...readReplicationState(), seq: 0 });
}

/**
 * Primary: number of a new round. Continues from the last seq this node knows (as a replica it
 * applied rounds of the previous primary), so seqs keep growing across promotions and restarts.
 */
function nextSeq(): number {
  const state = readReplicationState();
  const seq = state.seq + 1;
  writeReplicationState({ ...state, seq });
  return seq;
}

// ---------------------------------------------------------------------------------------------
// Primary: database snapshots (shared by every replica's loop)

/** A snapshot of the database at DATA_DIR/cluster/staging/db/<gen>/omp-ui.db. */
interface DbSnapshot {
  gen: number;
  dir: string;
  /** Size + mtime of the db and -wal files when it was taken. */
  stamp: string;
  /** Pushes using it; a replaced snapshot is deleted once none does. */
  refs: number;
}

const snapshots: { current: DbSnapshot | null; refreshing: Promise<DbSnapshot> | null; gen: number; cleaned: boolean } =
  { current: null, refreshing: null, gen: 0, cleaned: false };

function snapshotsRoot(): string {
  return path.join(clusterPaths().staging, "db");
}

async function sourceStamp(file: string): Promise<string> {
  const [db, wal] = await Promise.all([fs.stat(file).catch(() => null), fs.stat(`${file}-wal`).catch(() => null)]);
  return [db, wal].map((s) => (s ? `${s.size}:${s.mtimeMs}` : "-")).join("|");
}

/**
 * A snapshot of the SQLite database, taken now when `fresh` or when the database changed since
 * the current one; null when the database is not a SQLite file (a shared server needs none).
 * Release it with releaseDbSnapshot.
 */
async function acquireDbSnapshot(fresh: boolean): Promise<DbSnapshot | null> {
  const config = await effectiveDatabaseConfig();
  if (config.driver !== "sqlite" || config.file === ":memory:") return null;
  if (fresh && snapshots.refreshing) await snapshots.refreshing.catch(() => undefined);
  const stamp = await sourceStamp(config.file);
  let snapshot = snapshots.current;
  if (fresh || !snapshot || snapshot.stamp !== stamp) snapshot = await refreshDbSnapshot(config.file, stamp);
  snapshot.refs++;
  return snapshot;
}

/** Take a new snapshot (single-flight); the previous one is deleted once unused. */
function refreshDbSnapshot(file: string, stamp: string): Promise<DbSnapshot> {
  snapshots.refreshing ??= (async () => {
    const root = snapshotsRoot();
    if (!snapshots.cleaned) {
      // Left over by an earlier process.
      await fs.rm(root, { recursive: true, force: true });
      snapshots.cleaned = true;
    }
    const gen = ++snapshots.gen;
    const dir = path.join(root, String(gen));
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(clusterPaths().staging, 0o700);
    await snapshotSqlite(file, path.join(dir, DB_SNAPSHOT_NAME));
    const next: DbSnapshot = { gen, dir, stamp, refs: 0 };
    const previous = snapshots.current;
    snapshots.current = next;
    if (previous?.refs === 0) await fs.rm(previous.dir, { recursive: true, force: true });
    return next;
  })().finally(() => {
    snapshots.refreshing = null;
  });
  return snapshots.refreshing;
}

function releaseDbSnapshot(snapshot: DbSnapshot): void {
  snapshot.refs--;
  if (snapshot.refs === 0 && snapshot !== snapshots.current) {
    void fs.rm(snapshot.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Primary: what is replicated

/**
 * Board workdirs and extra folders, minus nested duplicates and those overlapping DATA_DIR (except
 * this node's mirrors: a primary promoted from a replica runs projects from its mirror root).
 */
async function projectFolders(): Promise<string[]> {
  const data = dataDir();
  const mirrorRoot = clusterPaths().mirror;
  const boards = await (await getRepo()).listBoards();
  const all = new Set<string>();
  for (const board of boards) {
    for (const folder of [board.workdir, ...(board.extraFolders ?? [])]) {
      if (folder && path.isAbsolute(folder)) all.add(path.resolve(folder));
    }
  }
  const folders = [...all].filter((p) => (p !== mirrorRoot && isWithin(p, mirrorRoot)) || !overlaps(p, data));
  return folders.filter((p) => !folders.some((other) => other !== p && isWithin(p, other)));
}

/** DATA_DIR/workspaces/<taskId>/<folder>: one git worktree each. */
async function workspaceFolders(): Promise<string[]> {
  const root = path.join(dataDir(), "workspaces");
  const tasks = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    tasks
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const taskDir = path.join(root, entry.name);
        const folders = await fs.readdir(taskDir, { withFileTypes: true }).catch(() => []);
        return folders.filter((f) => f.isDirectory()).map((f) => path.join(taskDir, f.name));
      }),
  );
  return nested.flat();
}

/**
 * The folders of one round for `node` (the database snapshot in `dbDir` when given, the files
 * when `withFiles`) and the path map that rewrites pointer files (.git) for the node.
 */
async function replicationPlan(
  node: NodePaths,
  dbDir: string | null,
  withFiles: boolean,
): Promise<{ folders: SyncFolderSpec[]; map: PathMap }> {
  const data = dataDir();
  const cluster = clusterPaths();
  const onNode = (p: string): string => path.join(node.dataDir, path.relative(data, p));
  const folders: SyncFolderSpec[] = [];
  const add = (id: string, primaryPath: string, nodePath: string, kind: SyncFolderSpec["kind"]): void => {
    folders.push({ id, primaryPath, nodePath, kind, upstream: false });
  };
  // Mirrored by canonical path, so a folder this node holds as a mirror is not nested in another mirror.
  const projects = (withFiles ? await projectFolders() : []).map((p): [string, string] => [
    p,
    mirrorPath(canonicalPath(p), node.mirrorRoot),
  ]);
  if (dbDir) add(DB_FOLDER_ID, dbDir, onNode(cluster.replicaDb), "raw");
  if (withFiles) {
    add("files", path.join(data, "files"), onNode(path.join(data, "files")), "raw");
    add("sessions", cluster.sessions, onNode(cluster.sessions), "raw");
    for (const folder of await workspaceFolders()) {
      add(`workspace:${path.relative(data, folder)}`, folder, onNode(folder), "tree");
    }
    for (const [folder, nodePath] of projects) {
      const id = createHash("sha256").update(canonicalPath(folder)).digest("hex").slice(0, 16);
      add(`project:${id}`, folder, nodePath, "tree");
    }
    add("omp-agent", await buildOmpAgentPack(), node.ompAgentDir, "raw");
  }
  // Longest prefix wins: mirrored project folders inside DATA_DIR map to their own node path.
  const map = new PathMap([[data, node.dataDir], ...projects]);
  return { folders, map };
}

/** The secrets a replica needs: the credentials key (file and env), AUTH_SECRET and a shared database URL. */
async function currentSecrets(): Promise<ReplSecrets> {
  const credentialsKeyFile = await fs.readFile(path.join(dataDir(), CREDENTIALS_KEY_FILE), "utf8").catch(() => null);
  const config = await effectiveDatabaseConfig();
  return {
    credentialsKeyFile,
    credentialsKey: process.env.CREDENTIALS_KEY?.trim() || null,
    authSecret: process.env.AUTH_SECRET || null,
    databaseUrl: config.driver === "sqlite" ? null : config.url,
  };
}

// ---------------------------------------------------------------------------------------------
// Primary: one replication loop per replica

/** Handle of a replica's replication loop. */
export interface ReplicationHandle {
  stop(): void;
  /** Seq of the last round the node applied (0 until the first one completes). */
  seq(): number;
  /**
   * Run a full round now (a database snapshot taken now, every folder, the secrets) and resolve
   * with its seq once the node applied it. Waits for a round in progress first.
   */
  flush(): Promise<number>;
}

/**
 * Primary: replicate this node's state to the replica behind `channel` until stop() or the
 * channel closes. A round runs at once and then every DB_REPLICATION_INTERVAL_MS: the database
 * snapshot when it changed, the files every FILE_REPLICATION_INTERVAL_MS.
 */
export function startReplicationTo(
  channel: ClusterChannel,
  endpoint: SyncEndpoint,
  node: { nodeId: string; paths: NodePaths },
): ReplicationHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let completedSeq = 0;
  let sentDbGen = -1;
  let filesSentAt = 0;
  let sentSecrets = "";
  let lastError = "";
  /** Rounds run one after another; `chain` settles when the latest queued one did. */
  let chain: Promise<unknown> = Promise.resolve();
  let queuedFlush: Promise<number> | null = null;

  const sendSecrets = async (): Promise<void> => {
    const secrets = await currentSecrets();
    const serialized = JSON.stringify(secrets);
    if (serialized === sentSecrets) return;
    if (channel.send({ t: "repl.secrets", ...secrets } satisfies ReplSecretsMsg)) sentSecrets = serialized;
  };

  const round = async (full: boolean): Promise<number> => {
    if (stopped) throw new Error("Replication stopped");
    await sendSecrets();
    const snapshot = await acquireDbSnapshot(full);
    try {
      const dbDue = snapshot !== null && snapshot.gen !== sentDbGen;
      const filesDue = full || Date.now() - filesSentAt >= FILE_REPLICATION_INTERVAL_MS;
      if (!dbDue && !filesDue) return completedSeq;
      const startedAt = Date.now();
      const seq = nextSeq();
      const { folders, map } = await replicationPlan(node.paths, dbDue ? snapshot.dir : null, filesDue);
      if (stopped) throw new Error("Replication stopped");
      channel.send({ t: "repl.plan", folders } satisfies ReplPlanMsg);
      await endpoint.push(REPL_SCOPE, folders, map, { deleteExtras: true });
      if (dbDue) sentDbGen = snapshot.gen;
      if (filesDue) filesSentAt = startedAt;
      completedSeq = seq;
      channel.send({
        t: "repl.seq",
        seq,
        at: new Date(startedAt).toISOString(),
        primaryDataDir: dataDir(),
      } satisfies ReplSeqMsg);
      return seq;
    } finally {
      if (snapshot) releaseDbSnapshot(snapshot);
    }
  };

  const enqueue = (full: boolean): Promise<number> => {
    const run = chain.then(() => {
      if (full) queuedFlush = null;
      return round(full);
    });
    chain = run.catch(() => undefined);
    return run;
  };

  const tick = (): void => {
    timer = null;
    enqueue(false)
      .then(
        () => {
          lastError = "";
        },
        (err: unknown) => {
          const message = errorMessage(err);
          if (stopped || message === lastError) return;
          lastError = message;
          console.error(`[cluster] replication to ${channel.peer.name} failed: ${message}`);
        },
      )
      .finally(() => {
        if (stopped) return;
        timer = setTimeout(tick, DB_REPLICATION_INTERVAL_MS);
        timer.unref();
      });
  };

  const stop = (): void => {
    stopped = true;
    clearTimeout(timer ?? undefined);
    timer = null;
  };

  channel.onClose(stop);
  timer = setTimeout(tick, 0);
  timer.unref();

  return {
    stop,
    seq: () => completedSeq,
    flush: () => {
      if (stopped) return Promise.reject(new Error("Replication stopped"));
      queuedFlush ??= enqueue(true);
      return queuedFlush;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Replica: receiving

/** Node paths replication must never write to (or replace a parent of). */
function protectedPaths(): string[] {
  const data = dataDir();
  const cluster = clusterPaths();
  const db = describeDatabase();
  return [
    cluster.root,
    replicationFile(),
    path.join(data, CREDENTIALS_KEY_FILE),
    ...(db.driver === "sqlite" ? [db.target] : []),
  ];
}

/**
 * The folders of a `repl.plan` this node accepts: absolute normalized node paths strictly inside
 * DATA_DIR that are not (and do not contain) node-local state; the database snapshot only into
 * its own folder. Always down-only.
 */
function acceptedFolders(raw: unknown): SyncFolderSpec[] {
  if (!Array.isArray(raw)) return [];
  const data = dataDir();
  const replicaDb = clusterPaths().replicaDb;
  const guarded = protectedPaths();
  const accepted: SyncFolderSpec[] = [];
  for (const item of raw as Partial<SyncFolderSpec>[]) {
    const { id, primaryPath, nodePath, kind } = item ?? {};
    if (typeof id !== "string" || !id || id.length > 300) continue;
    if (typeof primaryPath !== "string" || typeof nodePath !== "string") continue;
    if (kind !== "tree" && kind !== "raw") continue;
    if (nodePath.includes("\0") || !path.isAbsolute(nodePath) || path.resolve(nodePath) !== nodePath) continue;
    if (nodePath === data || !isWithin(nodePath, data)) continue;
    if (guarded.some((p) => isWithin(p, nodePath))) continue;
    if ((id === DB_FOLDER_ID) !== (nodePath === replicaDb)) continue;
    accepted.push({ id, primaryPath, nodePath, kind, upstream: false });
  }
  if (accepted.length < raw.length) {
    console.error(`[cluster] replication: refused ${raw.length - accepted.length} folder(s) outside the allowed paths`);
  }
  return accepted;
}

/** Replace a file atomically with `content` (mode 0600). */
async function writeSecretFile(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temp, content, { mode: 0o600 });
  await fs.rename(temp, file);
}

/** Drop the key lib/server/credentials.ts cached on globalThis for `file` (same shape as its declaration there). */
function forgetCachedCredentialKey(file: string): void {
  const credentialGlobals = globalThis as { __ompUiCredentialKeys?: Map<string, Buffer> };
  credentialGlobals.__ompUiCredentialKeys?.delete(file);
}

/** A non-empty string from the network, else null. */
function secretText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** Store the primary's secrets: the credentials key file, node.json secrets (+ env), the shared database. */
async function applySecrets(msg: ReplSecretsMsg): Promise<void> {
  const keyFile = path.join(dataDir(), CREDENTIALS_KEY_FILE);
  const keyFileContent = secretText(msg.credentialsKeyFile);
  if (keyFileContent) {
    const current = await fs.readFile(keyFile, "utf8").catch(() => null);
    if (current !== keyFileContent) {
      await writeSecretFile(keyFile, keyFileContent);
      forgetCachedCredentialKey(keyFile);
    }
  }
  const next = {
    authSecret: secretText(msg.authSecret),
    databaseUrl: secretText(msg.databaseUrl),
    credentialsKey: secretText(msg.credentialsKey),
  };
  const { secrets } = readNodeState();
  if (
    secrets.authSecret === next.authSecret &&
    secrets.databaseUrl === next.databaseUrl &&
    secrets.credentialsKey === next.credentialsKey
  ) {
    return;
  }
  updateNodeState({ secrets: next });
  if (next.authSecret) process.env.AUTH_SECRET = next.authSecret;
  if (next.credentialsKey && next.credentialsKey !== secrets.credentialsKey) {
    process.env.CREDENTIALS_KEY = next.credentialsKey;
    forgetCachedCredentialKey(keyFile);
  }
  if (secrets.databaseUrl !== next.databaseUrl) await reopenDatabase();
}

/**
 * Replica: apply the primary's replication rounds (scope `repl`) arriving on `channel` until
 * stop(). Folders overlapping `ctx.busyPaths()` (in use by hosted runs) are skipped; a received
 * database snapshot replaces the local database; `ctx.onApplied` runs after each round.
 */
export function startReplicationReceiver(
  channel: ClusterChannel,
  endpoint: SyncEndpoint,
  ctx: { busyPaths(): Set<string>; onApplied(seq: number, at: string): void },
): { stop(): void } {
  let plan: SyncFolderSpec[] = [];
  const snapshotFile = path.join(clusterPaths().replicaDb, DB_SNAPSHOT_NAME);
  /** Ids of `repl` pushes seen on the channel (to recognize their sync.abort). */
  const replPushes = new Set<string>();

  const offMessages = channel.on("repl.", (msg) => {
    if (msg.t === "repl.plan") {
      plan = acceptedFolders(msg.folders);
    } else if (msg.t === "repl.secrets") {
      applySecrets(msg as ReplSecretsMsg).catch((err: unknown) => {
        console.error("[cluster] cannot store the secrets from the primary:", errorMessage(err));
      });
    } else if (msg.t === "repl.seq") {
      const { seq, at, primaryDataDir } = msg as ReplSeqMsg;
      if (!Number.isSafeInteger(seq) || seq <= 0 || typeof at !== "string" || typeof primaryDataDir !== "string") return;
      try {
        writeReplicationState({ seq, at, primaryDataDir });
      } catch (err) {
        console.error("[cluster] cannot record the replication progress:", errorMessage(err));
      }
      ctx.onApplied(seq, at);
    }
  });

  const offSync = channel.on("sync.", (msg) => {
    const push = msg.push;
    if (typeof push !== "string") return;
    if (msg.t === "sync.begin" && msg.scope === REPL_SCOPE) replPushes.add(push);
    else if (msg.t === "sync.abort" && replPushes.delete(push)) applyEnded();
  });

  const offReceive = endpoint.receive(REPL_SCOPE, {
    folders(scope) {
      if (scope !== REPL_SCOPE) return null;
      applyStarted();
      const busy = [...ctx.busyPaths()];
      return plan.filter((folder) => !busy.some((p) => overlaps(folder.nodePath, p)));
    },
    async onApplied(scope) {
      if (scope !== REPL_SCOPE) return;
      replPushes.clear();
      try {
        // The snapshot is moved into place, so a file here is always one that just arrived.
        if (!(await fs.stat(snapshotFile).catch(() => null))) return;
        await swapDatabase(snapshotFile);
      } catch (err) {
        console.error("[cluster] cannot swap in the primary's database snapshot:", errorMessage(err));
      } finally {
        applyEnded();
      }
    },
  });

  const stop = (): void => {
    offMessages();
    offSync();
    offReceive();
    applyEnded();
  };
  channel.onClose(applyEnded);
  return { stop };
}

// ---------------------------------------------------------------------------------------------
// Replica: is a replication round being applied?

/**
 * A push whose apply failed on this side never reaches onApplied (and the receiver cannot see its
 * rejection), so a `repl` push counts as applying at most this long; the primary's next round or a
 * channel close normally ends it much sooner.
 */
const REPL_APPLY_STALL_MS = 10 * 60_000;

const applying: { active: boolean; waiters: Array<() => void>; timer: NodeJS.Timeout | undefined } = {
  active: false,
  waiters: [],
  timer: undefined,
};

function applyStarted(): void {
  applying.active = true;
  clearTimeout(applying.timer);
  applying.timer = setTimeout(applyEnded, REPL_APPLY_STALL_MS);
  applying.timer.unref();
}

function applyEnded(): void {
  applying.active = false;
  clearTimeout(applying.timer);
  for (const resolve of applying.waiters.splice(0)) resolve();
}

/** Resolves once no replication round (scope `repl`) is being applied on this node; at once when idle. */
export function replicationIdle(): Promise<void> {
  if (!applying.active) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  applying.waiters.push(resolve);
  return promise;
}
