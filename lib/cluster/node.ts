// This server's place in a cluster (docs/CLUSTER.md): the node-local state file
// (DATA_DIR/cluster/node.json), the cluster channel listener every clustered node runs, and the
// role transitions: enable (→ primary), join (→ replica), leave/disable (→ standalone), promotion
// of a replica after a failover, demotion of a returning primary (fencing) and the failback
// handover to the cluster's home primary. The runtimes themselves live in primary.ts / replica.ts.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { activeRunCount, getAgentManager, holdNewRuns, resetAgentManager } from "@/lib/agent/manager";
import { clusterPaths } from "@/lib/cluster/paths";
import {
  acceptMember,
  broadcastToken,
  forgetNode,
  isPrimaryActive,
  nodePeerAddress,
  primaryNodeStatuses,
  replicationFlush,
  requestHandover,
  startPrimary,
  stopPrimary,
} from "@/lib/cluster/primary";
import { migrateForPromotion, useReplicatedOmpAgentDir } from "@/lib/cluster/promote";
import {
  type ClusterChannel,
  ClusterAuthError,
  type ChannelListener,
  connectChannel,
  generateClusterToken,
  type HelloInfo,
  listenChannels,
} from "@/lib/cluster/protocol";
import { replicaConnection, replicaNodeStatuses, startReplica, stopReplica } from "@/lib/cluster/replica";
import { replicatedSeq, resetReplicatedSeq } from "@/lib/cluster/replication";
import { snapshotSqlite } from "@/lib/cluster/sync";
import {
  type AnnounceMsg,
  CLUSTER_PROTOCOL_VERSION,
  DEFAULT_CLUSTER_PORT,
  ELECTION_PROBE_TIMEOUT_MS,
  FAILBACK_DRAIN_MS,
  type HandoverMsg,
  type MemberInfo,
  type NodeState,
  type PeerAddress,
  type ProbeReplyMsg,
  type RedirectMsg,
  type TestReplyMsg,
  type WireMessage,
} from "@/lib/cluster/types";
import { describeDatabase, getRepo } from "@/lib/db";
import { publish } from "@/lib/events";
import { HttpError } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log-store";
import { getAppSettings } from "@/lib/settings";
import type { ClusterInfo, ClusterNotice, ClusterRole, ClusterStatus, ClusterTestResult } from "@/lib/types";
import { APP_VERSION } from "@/lib/version";

/** Exit code that makes bin/supervisor.mjs restart the server (role change that needs a fresh process). */
const RESTART_EXIT_CODE = 75;
/** Lets the HTTP response that triggered the restart reach the browser first. */
const RESTART_DELAY_MS = 500;
const MAX_NOTICES = 20;
const PUBLISH_DELAY_MS = 250;
/** GET <primary>/api/v1/cluster/info before authenticating. */
const INFO_TIMEOUT_MS = 5_000;
/** Connect + `test` round trip of a connection test. */
const TEST_TIMEOUT_MS = 10_000;
/** Probe and test channels are short-lived; a client that keeps one open longer is cut off. */
const SHORT_CHANNEL_MS = 30_000;
/** How often a failback checks whether the local runs have finished. */
const DRAIN_POLL_MS = 1_000;
const ROLES: readonly ClusterRole[] = ["standalone", "primary", "replica"];

const g = globalThis as unknown as {
  __ompUiClusterNode?: { file: string; state: NodeState };
  __ompUiClusterListener?: Promise<ChannelListener>;
  __ompUiClusterStart?: Promise<void>;
  __ompUiClusterNotices?: ClusterNotice[];
  __ompUiClusterPublish?: NodeJS.Timeout;
  __ompUiClusterPromotion?: Promise<void>;
  __ompUiClusterDemotion?: Promise<void>;
  __ompUiClusterHandover?: Promise<void>;
  __ompUiClusterRestarting?: boolean;
  /** node.json path this process created (it did not exist at boot): a fresh node. */
  __ompUiClusterCreated?: string;
};

// --- Node state (DATA_DIR/cluster/node.json) ----------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function validPort(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536 ? value : null;
}

/** OMP_UI_CLUSTER_PORT when it is a valid port; it wins over the stored port. */
function envPort(): number | null {
  const raw = process.env.OMP_UI_CLUSTER_PORT?.trim();
  return raw ? validPort(Number(raw)) : null;
}

/** A PeerAddress from untrusted JSON (node.json, wire messages); null when malformed. */
function parsePeer(value: unknown): PeerAddress | null {
  if (!isRecord(value)) return null;
  const name = text(value.name);
  const host = text(value.host);
  const port = validPort(value.port);
  const httpUrl = text(value.httpUrl);
  if (!name || !host || !port || !httpUrl) return null;
  return { nodeId: text(value.nodeId), name, host, port, httpUrl };
}

/** A stored member entry; keeps the optional `lastSeenAt` primary.ts records (offline nodes after a restart). */
function parseMember(value: unknown): MemberInfo | null {
  const peer = parsePeer(value);
  if (!peer?.nodeId || !isRecord(value)) return null;
  if (value.role !== "primary" && value.role !== "replica") return null;
  const joinedAt = text(value.joinedAt);
  if (!joinedAt || typeof value.replSeq !== "number" || typeof value.online !== "boolean") return null;
  const member: MemberInfo & { lastSeenAt?: string } = {
    ...peer,
    nodeId: peer.nodeId,
    role: value.role,
    joinedAt,
    replSeq: value.replSeq,
    online: value.online,
  };
  const lastSeenAt = text(value.lastSeenAt);
  if (lastSeenAt) member.lastSeenAt = lastSeenAt;
  return member;
}

function defaultState(): NodeState {
  return {
    nodeId: randomUUID(),
    name: os.hostname(),
    role: "standalone",
    term: 0,
    token: null,
    port: envPort() ?? DEFAULT_CLUSTER_PORT,
    primary: null,
    members: [],
    preferredPrimaryId: null,
    joinedAt: null,
    secrets: { authSecret: null, databaseUrl: null, credentialsKey: null },
  };
}

/** Stored JSON → NodeState (malformed fields fall back to their defaults); null without a nodeId. */
function normalizeState(raw: unknown): NodeState | null {
  if (!isRecord(raw)) return null;
  const nodeId = text(raw.nodeId);
  if (!nodeId) return null;
  const secrets = isRecord(raw.secrets) ? raw.secrets : {};
  const term = typeof raw.term === "number" && Number.isInteger(raw.term) && raw.term > 0 ? raw.term : 0;
  return {
    nodeId,
    name: text(raw.name) ?? os.hostname(),
    role: ROLES.includes(raw.role as ClusterRole) ? (raw.role as ClusterRole) : "standalone",
    term,
    token: text(raw.token),
    port: envPort() ?? validPort(raw.port) ?? DEFAULT_CLUSTER_PORT,
    primary: parsePeer(raw.primary),
    members: Array.isArray(raw.members)
      ? raw.members.map(parseMember).filter((m): m is MemberInfo => m !== null)
      : [],
    preferredPrimaryId: text(raw.preferredPrimaryId),
    joinedAt: text(raw.joinedAt),
    secrets: {
      authSecret: text(secrets.authSecret),
      databaseUrl: text(secrets.databaseUrl),
      credentialsKey: text(secrets.credentialsKey),
    },
  };
}

/** Write a secrets-bearing file: temp file (0600) + rename, its directory created 0700. */
function writePrivateFile(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

function saveState(file: string, state: NodeState): NodeState {
  writePrivateFile(file, `${JSON.stringify(state, null, 2)}\n`);
  g.__ompUiClusterNode = { file, state };
  return state;
}

function loadState(file: string): NodeState {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    g.__ompUiClusterCreated = file;
    return saveState(file, defaultState());
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // handled below: unparsable = corrupt
  }
  const state = normalizeState(parsed);
  if (state) return state;
  const corrupt = `${file}.corrupt`;
  copyFileSync(file, corrupt);
  chmodSync(corrupt, 0o600);
  console.error(`[cluster] ${file} is unreadable; kept it as ${path.basename(corrupt)} and reset this node to standalone`);
  return saveState(file, defaultState());
}

/**
 * Clustered nodes run with the primary's AUTH_SECRET and CREDENTIALS_KEY (replicated into
 * node.json), so its session tokens and sealed credential values stay valid here, also after a
 * promotion. An explicit, non-empty value in the environment wins.
 */
function applyReplicatedSecrets(state: NodeState): void {
  if (state.role === "standalone") return;
  const pairs: Array<[env: string, value: string | null]> = [
    ["AUTH_SECRET", state.secrets.authSecret],
    ["CREDENTIALS_KEY", state.secrets.credentialsKey],
  ];
  for (const [env, value] of pairs) {
    if (value && !process.env[env]?.trim()) process.env[env] = value;
  }
}

/**
 * This node's cluster state (sync). Created with defaults on first use (standalone, random
 * nodeId, name = hostname, port = OMP_UI_CLUSTER_PORT or DEFAULT_CLUSTER_PORT, term 0); a corrupt
 * file is kept as `node.json.corrupt` and replaced by defaults. Cached per DATA_DIR; treat the
 * result as read-only and change it through updateNodeState(). The first load applies the
 * replicated secrets to the environment.
 */
export function readNodeState(): NodeState {
  const file = clusterPaths().nodeFile;
  const cached = g.__ompUiClusterNode;
  if (cached?.file === file) return cached.state;
  const state = loadState(file);
  g.__ompUiClusterNode = { file, state };
  applyReplicatedSecrets(state);
  return state;
}

/** Merge `patch` into the state and persist it atomically (mode 0600). */
export function updateNodeState(patch: Partial<NodeState>): NodeState {
  return saveState(clusterPaths().nodeFile, { ...readNodeState(), ...patch });
}

/** This server's role (cached; cheap enough for every request). */
export function clusterRole(): ClusterRole {
  return readNodeState().role;
}

/** What a standalone node keeps: its identity and the highest term it has seen. */
const STANDALONE: Partial<NodeState> = {
  role: "standalone",
  token: null,
  primary: null,
  members: [],
  preferredPrimaryId: null,
  joinedAt: null,
};

// --- Notices and status ---------------------------------------------------------------------

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause.message : null;
  return cause && err.message === "fetch failed" ? cause : err.message;
}

/** Record something an operator should see: last 20 kept, logged, pushed to the UI. */
export function clusterNotice(level: ClusterNotice["level"], message: string): void {
  const notice: ClusterNotice = { id: randomUUID(), level, message, at: new Date().toISOString() };
  const notices = (g.__ompUiClusterNotices ??= []);
  notices.unshift(notice);
  notices.splice(MAX_NOTICES);
  const line = `[cluster] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warning") console.warn(line);
  else console.log(line);
  publish({ type: "cluster.notice", notice });
  publishClusterStatus();
}

/** Publish `cluster.updated` with the current status; calls within 250 ms are coalesced. */
export function publishClusterStatus(): void {
  if (g.__ompUiClusterPublish) return;
  const timer = setTimeout(() => {
    g.__ompUiClusterPublish = undefined;
    getClusterStatus().then(
      (status) => publish({ type: "cluster.updated", status }),
      (err: unknown) => console.error("[cluster] could not publish the cluster status", err),
    );
  }, PUBLISH_DELAY_MS);
  timer.unref();
  g.__ompUiClusterPublish = timer;
}

/** This server's view of the cluster (GET /cluster). */
export async function getClusterStatus(): Promise<ClusterStatus> {
  const state = readNodeState();
  const nodes =
    state.role === "primary" ? primaryNodeStatuses() : state.role === "replica" ? replicaNodeStatuses() : [];
  const online = nodes.filter((n) => n.online);
  const settings = await getAppSettings(await getRepo());
  return {
    role: state.role,
    nodeId: state.nodeId,
    nodeName: state.name,
    term: state.role === "standalone" ? 0 : state.term,
    preferredPrimaryId: state.role === "standalone" ? null : state.preferredPrimaryId,
    port: state.port,
    primary:
      state.role === "replica" && state.primary
        ? { nodeId: state.primary.nodeId, name: state.primary.name, httpUrl: state.primary.httpUrl }
        : null,
    connection: state.role === "replica" ? replicaConnection() : null,
    runLocal: settings.clusterRunLocal,
    nodes,
    totals: {
      nodes: nodes.length,
      online: online.length,
      cpus: online.reduce((sum, n) => sum + (n.resources?.cpus ?? 0), 0),
      totalMemoryBytes: online.reduce((sum, n) => sum + (n.resources?.totalMemoryBytes ?? 0), 0),
      freeMemoryBytes: online.reduce((sum, n) => sum + (n.resources?.freeMemoryBytes ?? 0), 0),
      slots: online.reduce((sum, n) => sum + n.slots, 0),
      running: online.reduce((sum, n) => sum + n.runningTaskIds.length, 0),
    },
    notices: [...(g.__ompUiClusterNotices ?? [])],
  };
}

// --- Addresses --------------------------------------------------------------------------------

function firstLanIpv4(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

/** This server's base URL for other nodes: OMP_UI_PUBLIC_URL, else http://<first LAN IPv4>:<PORT||3000>. */
export function clusterHttpUrl(): string {
  const configured = process.env.OMP_UI_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return `http://${firstLanIpv4() ?? os.hostname()}:${process.env.PORT?.trim() || "3000"}`;
}

/** Host part of a URL, without IPv6 brackets. */
function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^\[(.*)\]$/, "$1");
}

/** How other nodes reach this one (the host the primary observed for us, when known). */
function selfAddress(state: NodeState = readNodeState()): PeerAddress {
  const httpUrl = clusterHttpUrl();
  const member = state.members.find((m) => m.nodeId === state.nodeId);
  return { nodeId: state.nodeId, name: state.name, host: member?.host ?? hostOf(httpUrl), port: state.port, httpUrl };
}

/** A primary base URL typed by a person: http(s) only, no credentials, no trailing slash. */
function parseClusterUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new HttpError(400, `"${url}" is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, "The primary URL must start with http:// or https://");
  }
  if (parsed.username || parsed.password) throw new HttpError(400, "The primary URL must not contain credentials");
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

// --- Listener ---------------------------------------------------------------------------------

function probeReply(): ProbeReplyMsg {
  const state = readNodeState();
  const primaryActive = state.role === "primary" && isPrimaryActive();
  return {
    t: "probe.reply",
    nodeId: state.nodeId,
    name: state.name,
    role: state.role,
    term: state.term,
    primary: state.role === "primary" ? selfAddress(state) : state.primary,
    primaryReachable: primaryActive || (state.role === "replica" && replicaConnection()?.state === "connected"),
    replSeq: replicatedSeq(),
  };
}

function testReply(): TestReplyMsg {
  const state = readNodeState();
  return { t: "test.reply", nodeId: state.nodeId, name: state.name, role: state.role, term: state.term, version: APP_VERSION };
}

/** A replica asks to join: the active primary takes it, anyone else points it at the primary. */
function admitMember(channel: ClusterChannel): void {
  const state = readNodeState();
  if (state.role === "primary" && isPrimaryActive()) {
    acceptMember(channel);
    return;
  }
  const redirect: RedirectMsg = {
    t: "redirect",
    reason: state.role === "primary" ? "This primary is still starting" : `${state.name} is not the primary`,
    term: state.term,
    primary: state.role === "replica" ? state.primary : null,
  };
  channel.send(redirect);
  void channel.drain().finally(() => channel.close("redirected"));
}

/** A promoted primary announces itself: replicas follow it, a lower-term primary steps down. */
async function onAnnounce(channel: ClusterChannel, msg: WireMessage): Promise<void> {
  const primary = parsePeer(msg.primary);
  const term = msg.term;
  const state = readNodeState();
  if (!primary || typeof term !== "number" || !Number.isInteger(term) || primary.nodeId === state.nodeId) return;
  channel.reply(msg, probeReply());
  if (term <= state.term) return;
  if (state.role === "primary") {
    await demoteSelf(primary, term, `${primary.name} was promoted to primary (term ${term})`);
    return;
  }
  if (state.role !== "replica") return;
  updateNodeState({ primary, term });
  clusterNotice("info", `Following ${primary.name}, the new primary (term ${term})`);
  await stopReplica(`Following ${primary.name}`);
  await startReplica();
}

function onChannel(channel: ClusterChannel, hello: HelloInfo): void {
  if (hello.purpose === "member") {
    admitMember(channel);
    return;
  }
  const timer = setTimeout(() => channel.close("timeout"), SHORT_CHANNEL_MS);
  timer.unref();
  channel.onClose(() => clearTimeout(timer));
  if (hello.purpose === "probe") {
    channel.on("probe", (msg) => {
      if (msg.t === "probe") channel.reply(msg, probeReply());
    });
    channel.on("announce", (msg) => {
      if (msg.t !== "announce") return;
      onAnnounce(channel, msg).catch((err: unknown) => {
        clusterNotice("error", `Could not follow the announced primary: ${errorText(err)}`);
      });
    });
  } else if (hello.purpose === "test") {
    channel.on("test", (msg) => {
      if (msg.t === "test") channel.reply(msg, testReply());
    });
  } else {
    channel.close("unknown purpose");
  }
}

function onAuthFailure(remote: { host: string; port: number }, reason: string): void {
  void logEvent("security", {
    level: "warn",
    category: "cluster",
    message: `Rejected a cluster connection from ${remote.host}:${remote.port}: ${reason}`,
  });
}

/** Open this process's cluster listener (once; later calls share it). */
async function openListener(): Promise<void> {
  if (!g.__ompUiClusterListener) {
    const pending = listenChannels({
      port: readNodeState().port,
      token: () => readNodeState().token,
      identity: () => {
        const { nodeId, name, role, term } = readNodeState();
        return { nodeId, name, role, term };
      },
      onChannel,
      onAuthFailure,
    });
    g.__ompUiClusterListener = pending;
    pending.catch(() => {
      if (g.__ompUiClusterListener === pending) g.__ompUiClusterListener = undefined;
    });
  }
  await g.__ompUiClusterListener;
}

async function closeListener(): Promise<void> {
  const pending = g.__ompUiClusterListener;
  g.__ompUiClusterListener = undefined;
  if (!pending) return;
  try {
    await (await pending).close();
  } catch {
    // never opened (port in use): nothing to close
  }
}

// --- Probes -----------------------------------------------------------------------------------

/** One request on a fresh probe channel to `peer`; null when it is unreachable or silent. */
async function probePeer(peer: PeerAddress, msg: WireMessage): Promise<WireMessage | null> {
  const state = readNodeState();
  if (!state.token) return null;
  try {
    const { channel } = await connectChannel({
      host: peer.host,
      port: peer.port,
      token: state.token,
      hello: { nodeId: state.nodeId, name: state.name, purpose: "probe" },
      timeoutMs: ELECTION_PROBE_TIMEOUT_MS,
    });
    try {
      return await channel.request(msg, ELECTION_PROBE_TIMEOUT_MS);
    } finally {
      channel.close("probe finished");
    }
  } catch {
    return null;
  }
}

function otherMembers(state: NodeState): MemberInfo[] {
  return state.members.filter((m) => m.nodeId !== state.nodeId);
}

/**
 * Boot fencing of a primary: the highest-term primary another member names (itself as primary,
 * or the one a replica follows) when that term is above ours; null when we are still in charge.
 */
async function findHigherPrimary(): Promise<{ primary: PeerAddress; term: number } | null> {
  const state = readNodeState();
  const replies = await Promise.all(
    otherMembers(state).map(async (member) => ({ member, reply: await probePeer(member, { t: "probe" }) })),
  );
  let best: { primary: PeerAddress; term: number } | null = null;
  for (const { member, reply } of replies) {
    const term = reply?.t === "probe.reply" ? reply.term : null;
    if (!reply || typeof term !== "number" || term <= state.term || (best && term <= best.term)) continue;
    const named = parsePeer(reply.primary);
    let primary: PeerAddress | null = null;
    if (reply.role === "primary") {
      const httpUrl = named?.httpUrl ?? member.httpUrl;
      primary = { nodeId: member.nodeId, name: member.name, host: member.host, port: member.port, httpUrl };
    } else if (reply.role === "replica" && named && named.nodeId !== state.nodeId) {
      primary = named;
    }
    if (primary) best = { primary, term };
  }
  return best;
}

// --- Boot -------------------------------------------------------------------------------------

/**
 * First boot of a node started by the join script: join the primary named in the environment.
 * Only a fresh node (no node.json before this boot) joins: the script keeps the variables in the
 * node's environment for good, and a node an admin made leave must not re-join on its next restart.
 */
async function joinFromEnv(): Promise<void> {
  const url = process.env.OMP_UI_CLUSTER_JOIN?.trim();
  const token = process.env.OMP_UI_CLUSTER_TOKEN?.trim();
  const state = readNodeState();
  if (!url || !token || state.role !== "standalone" || g.__ompUiClusterCreated !== clusterPaths().nodeFile) return;
  try {
    await joinCluster(url, token, { boot: true });
  } catch (err) {
    clusterNotice("error", `Could not join the cluster at ${url}: ${errorText(err)}`);
  }
}

/** A primary coming back first checks that nobody took over while it was away. */
async function bootPrimary(): Promise<void> {
  const higher = await findHigherPrimary();
  if (higher) {
    await demoteSelf(
      higher.primary,
      higher.term,
      `${higher.primary.name} became the primary (term ${higher.term}) while this node was away`,
    );
    return;
  }
  useReplicatedOmpAgentDir();
  await startPrimary();
}

async function bootCluster(): Promise<void> {
  await joinFromEnv();
  const state = readNodeState();
  if (state.role === "standalone") return;
  applyReplicatedSecrets(state);
  const role = state.role;
  try {
    await openListener();
  } catch (err) {
    clusterNotice("error", `Cannot listen on cluster port ${readNodeState().port}: ${errorText(err)}`);
  }
  if (role === "primary") await bootPrimary();
  else await startReplica();
  publishClusterStatus();
}

/**
 * Boot cluster mode (idempotent; createAgentManager calls it first): join from the environment
 * when a fresh node was started by the join script, then run this node's role.
 */
export function startCluster(): Promise<void> {
  g.__ompUiClusterStart ??= bootCluster().catch((err: unknown) => {
    g.__ompUiClusterStart = undefined;
    throw err;
  });
  return g.__ompUiClusterStart;
}

// --- Role changes -----------------------------------------------------------------------------

/** Exit so bin/supervisor.mjs starts the server again in its new role. */
function restartProcess(reason: string): void {
  if (g.__ompUiClusterRestarting) return;
  g.__ompUiClusterRestarting = true;
  console.log(`[cluster] restarting the server: ${reason}`);
  setTimeout(() => process.exit(RESTART_EXIT_CODE), RESTART_DELAY_MS);
}

/** Timestamped copy of the SQLite database before the primary's data replaces it (other drivers: nothing). */
async function backupDatabase(label: string): Promise<void> {
  const { driver, target } = describeDatabase();
  if (driver !== "sqlite" || target === ":memory:" || !existsSync(target)) return;
  const dir = clusterPaths().backups;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `omp-ui-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  await snapshotSqlite(target, file);
  await fs.chmod(file, 0o600);
  console.log(`[cluster] backed up the database to ${file}`);
}

/** Standalone → primary of a new cluster (new token, next term; this node becomes the home primary). */
export async function enableCluster(): Promise<ClusterStatus> {
  const before = readNodeState();
  if (before.role === "primary") return getClusterStatus();
  if (before.role === "replica") throw new HttpError(409, "This node is a replica; leave the cluster first");
  updateNodeState({
    role: "primary",
    token: generateClusterToken(),
    term: Math.max(before.term, 0) + 1,
    primary: null,
    members: [],
    preferredPrimaryId: before.nodeId,
    joinedAt: new Date().toISOString(),
  });
  try {
    await openListener();
  } catch (err) {
    updateNodeState({ ...STANDALONE, term: before.term });
    throw new HttpError(500, `Cannot listen on cluster port ${before.port}: ${errorText(err)}`);
  }
  await startPrimary();
  clusterNotice("info", `Cluster mode enabled: this node is the primary (cluster port ${readNodeState().port})`);
  return getClusterStatus();
}

/**
 * Primary/replica → standalone. A replica leaves (see leaveCluster); a primary first removes every
 * connected replica (they become standalone instead of electing a successor that would resume the
 * same cards), then stops coordinating.
 */
export async function disableCluster(): Promise<ClusterStatus> {
  const role = clusterRole();
  if (role === "standalone") return getClusterStatus();
  if (role === "replica") return leaveCluster();
  const replicas = primaryNodeStatuses().filter((n) => !n.self && n.online);
  await Promise.all(
    replicas.map((n) =>
      forgetNode(n.nodeId).catch((err: unknown) => {
        clusterNotice("warning", `Could not remove ${n.name} from the cluster: ${errorText(err)}`);
      }),
    ),
  );
  await stopPrimary("Cluster mode disabled");
  await closeListener();
  updateNodeState(STANDALONE);
  clusterNotice("info", "Cluster mode disabled: this node runs on its own");
  return getClusterStatus();
}

/** Check a primary (URL + token) and return its cluster port alongside the test result. */
async function testTarget(base: string, token: string): Promise<{ result: ClusterTestResult; port: number | null }> {
  let port: number | null = null;
  try {
    port = (await fetchClusterInfo(base)).port;
    const state = readNodeState();
    const { channel } = await connectChannel({
      host: hostOf(base),
      port,
      token,
      hello: { nodeId: state.nodeId, name: state.name, purpose: "test" },
      timeoutMs: TEST_TIMEOUT_MS,
    });
    try {
      const started = performance.now();
      const reply = await channel.request<TestReplyMsg>({ t: "test" }, TEST_TIMEOUT_MS);
      if (reply.t !== "test.reply" || !ROLES.includes(reply.role)) throw new Error("Unexpected answer to the test");
      const latencyMs = channel.latencyMs ?? Math.round(performance.now() - started);
      const node = { nodeId: reply.nodeId, name: reply.name, role: reply.role, term: reply.term, version: reply.version };
      return { port, result: { ok: true, latencyMs, node, error: null } };
    } finally {
      channel.close("test finished");
    }
  } catch (err) {
    const error = err instanceof ClusterAuthError ? `Authentication failed: ${err.message}` : errorText(err);
    return { port, result: { ok: false, latencyMs: null, node: null, error } };
  }
}

async function fetchClusterInfo(base: string): Promise<ClusterInfo> {
  const res = await fetch(`${base}/api/v1/cluster/info`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${base} answered HTTP ${res.status}; is it an omp-ui server with cluster mode?`);
  const info = (await res.json()) as Partial<ClusterInfo>;
  if (info.protocol !== CLUSTER_PROTOCOL_VERSION) {
    throw new Error(
      `${base} speaks cluster protocol ${String(info.protocol)}, this node ${CLUSTER_PROTOCOL_VERSION}; run the same omp-ui version on both`,
    );
  }
  const port = validPort(info.port);
  if (!port) throw new Error(`${base} reports no cluster port`);
  return { ...(info as ClusterInfo), port };
}

/**
 * Can this server reach and authenticate with the node at `url`? An empty `token` uses this
 * node's stored token (a replica testing its primary).
 */
export async function testClusterConnection(url: string, token: string): Promise<ClusterTestResult> {
  const secret = token.trim() || readNodeState().token;
  if (!secret) return { ok: false, latencyMs: null, node: null, error: "A join token is required" };
  let base: string;
  try {
    base = parseClusterUrl(url);
  } catch (err) {
    return { ok: false, latencyMs: null, node: null, error: errorText(err) };
  }
  return (await testTarget(base, secret)).result;
}

/**
 * Standalone → replica of the primary at `url`: tested first, the local database backed up, the
 * state persisted; then the process restarts as a replica (exit 75 after the response). At boot
 * (`boot`, joined from the environment) the server simply continues: its manager starts dormant.
 */
export async function joinCluster(url: string, token: string, opts: { boot?: boolean } = {}): Promise<ClusterStatus> {
  const state = readNodeState();
  if (state.role === "primary") throw new HttpError(409, "This node is a cluster primary; disable cluster mode first");
  if (state.role === "replica") throw new HttpError(409, "This node already belongs to a cluster; leave it first");
  const base = parseClusterUrl(url);
  const secret = token.trim();
  if (!secret) throw new HttpError(400, "A join token is required");
  const { result, port } = await testTarget(base, secret);
  if (!result.ok || !result.node || !port) throw new HttpError(400, result.error ?? "Could not reach the primary");
  const target = result.node;
  if (target.role !== "primary") throw new HttpError(400, `${target.name} is not a primary (it is ${target.role})`);
  if (target.nodeId === state.nodeId) throw new HttpError(400, "A node cannot join itself");
  await backupDatabase("join");
  updateNodeState({
    role: "replica",
    token: secret,
    term: Math.max(state.term, target.term),
    primary: { nodeId: target.nodeId, name: target.name, host: hostOf(base), port, httpUrl: base },
    members: [],
    joinedAt: new Date().toISOString(),
  });
  if (opts.boot) {
    clusterNotice("info", `Joined the cluster of ${target.name} as a replica`);
  } else {
    clusterNotice("info", `Joined the cluster of ${target.name}; restarting as a replica`);
    restartProcess(`joined the cluster of ${target.name}`);
  }
  return getClusterStatus();
}

/**
 * Cards the primary was running or about to run (queued, or failed with a retry scheduled) are not
 * this node's work: set them idle in the kept database so the standalone manager's recovery does
 * not resume them next to the cluster.
 */
async function releaseInheritedCards(): Promise<void> {
  const repo = await getRepo();
  const tasks = await repo.listTasksByAgentState(["running", "queued", "error"]);
  const inherited = tasks.filter((t) => t.agentState !== "error" || t.retryAt !== null);
  for (const task of inherited) await repo.updateTask(task.id, { agentState: "idle", retryAt: null });
  if (inherited.length > 0) {
    clusterNotice("info", `${inherited.length} card(s) the primary was running or had queued were set idle here`);
  }
}

/** Replica → standalone, keeping the replicated data as this node's own. */
export async function leaveCluster(): Promise<ClusterStatus> {
  const state = readNodeState();
  if (state.role !== "replica") throw new HttpError(409, "This node is not a replica");
  await stopReplica("Left the cluster");
  await closeListener();
  // A shared database (postgres/mongo of the primary) is not ours to keep: reopen our own after a restart.
  const sharedDb = state.secrets.databaseUrl !== null;
  updateNodeState({ ...STANDALONE, secrets: { ...state.secrets, databaseUrl: null } });
  if (sharedDb) {
    clusterNotice("info", "This node left the cluster; restarting to reopen its own database");
    restartProcess("left the cluster");
  } else {
    clusterNotice("info", "This node left the cluster and keeps the replicated data as its own");
    try {
      await releaseInheritedCards();
    } catch (err) {
      clusterNotice("error", `Could not set the primary's running and queued cards idle: ${errorText(err)}`);
    }
    resetAgentManager();
  }
  return getClusterStatus();
}

/** Primary: issue a new join token; connected replicas receive it and stay in. */
export async function rotateClusterToken(): Promise<string> {
  if (clusterRole() !== "primary") throw new HttpError(409, "Only the cluster primary can rotate the join token");
  const token = generateClusterToken();
  updateNodeState({ token });
  broadcastToken(token);
  clusterNotice("info", "The join token was rotated");
  return token;
}

/** Primary: remove a replica from the cluster (it becomes standalone). */
export async function removeClusterNode(nodeId: string): Promise<void> {
  const state = readNodeState();
  if (state.role !== "primary") throw new HttpError(409, "Only the cluster primary can remove nodes");
  if (nodeId === state.nodeId) throw new HttpError(400, "The primary cannot remove itself; disable cluster mode instead");
  if (!primaryNodeStatuses().some((n) => n.nodeId === nodeId)) throw new HttpError(404, "Unknown node");
  await forgetNode(nodeId);
  updateNodeState({ members: readNodeState().members.filter((m) => m.nodeId !== nodeId) });
  publishClusterStatus();
}

// --- Promotion, demotion, failback ------------------------------------------------------------

async function announcePromotion(term: number): Promise<void> {
  const state = readNodeState();
  const msg: AnnounceMsg = { t: "announce", term, primary: selfAddress(state) };
  await Promise.all(otherMembers(state).map((member) => probePeer(member, msg)));
}

/** A failed promotion: back to the replica we were, so the replica runtime resumes (never two primaries). */
async function rollBackPromotion(previous: NodeState): Promise<void> {
  await stopPrimary("Promotion failed").catch((err: unknown) => {
    console.error("[cluster] could not stop the primary runtime after a failed promotion", err);
  });
  updateNodeState({ role: "replica", primary: previous.primary, term: previous.term });
  resetAgentManager();
  await startReplica().catch((err: unknown) => {
    clusterNotice("error", `Could not restart the replica runtime: ${errorText(err)}`);
  });
}

async function promote(reason: string, minTerm: number): Promise<void> {
  if (clusterRole() !== "replica") return;
  await stopReplica(`Promoting this node to primary: ${reason}`);
  const previous = readNodeState();
  const term = Math.max(minTerm, previous.term + 1);
  updateNodeState({ role: "primary", primary: null, term });
  try {
    await migrateForPromotion(await getRepo());
    resetAgentManager();
    // Before the manager boots: its recovery requeues interrupted runs, which placement needs the primary for.
    await startPrimary();
    await getAgentManager();
  } catch (err) {
    clusterNotice("error", `Promotion to primary (term ${term}) failed, staying a replica: ${errorText(err)}`);
    await rollBackPromotion(previous);
    throw err;
  }
  await announcePromotion(term);
  clusterNotice("info", `This node was promoted to primary (term ${term}): ${reason}`);
}

/**
 * Replica → primary in this process (failover election or failback handover): term = max(opts.term,
 * known term + 1), data paths migrated, the manager rebooted fully, members told to follow.
 * Single-flight; does nothing unless this node is a replica. Never changes preferredPrimaryId.
 */
export function promoteSelf(reason: string, opts: { term?: number } = {}): Promise<void> {
  g.__ompUiClusterPromotion ??= promote(reason, opts.term ?? 0).finally(() => {
    g.__ompUiClusterPromotion = undefined;
  });
  return g.__ompUiClusterPromotion;
}

async function demote(primary: PeerAddress, term: number, reason: string): Promise<void> {
  const state = readNodeState();
  if (state.role !== "primary") return;
  holdNewRuns(true);
  try {
    await backupDatabase("demote");
  } catch (err) {
    clusterNotice("error", `Could not back up the database before stepping down: ${errorText(err)}`);
  }
  // Our replication round counter belongs to an older era: it must not rank us high in elections.
  resetReplicatedSeq();
  updateNodeState({ role: "replica", primary, term: Math.max(term, state.term) });
  clusterNotice("warning", `This node is no longer the primary (${reason}); restarting as a replica of ${primary.name}`);
  restartProcess(`demoted to a replica of ${primary.name}`);
}

/** Primary → replica of `primary` (fencing, failback): back up the DB, persist, restart (exit 75). */
export function demoteSelf(primary: PeerAddress, term: number, reason: string): Promise<void> {
  g.__ompUiClusterDemotion ??= demote(primary, term, reason).catch((err: unknown) => {
    g.__ompUiClusterDemotion = undefined;
    throw err;
  });
  return g.__ompUiClusterDemotion;
}

/** Wait until the manager has no active runs, at most FAILBACK_DRAIN_MS; true when drained. */
async function drainRuns(): Promise<boolean> {
  const deadline = Date.now() + FAILBACK_DRAIN_MS;
  while (activeRunCount() > 0) {
    if (Date.now() >= deadline) return false;
    await sleep(DRAIN_POLL_MS);
  }
  return true;
}

async function handOver(nodeId: string): Promise<void> {
  const state = readNodeState();
  const target = nodePeerAddress(nodeId);
  if (state.role !== "primary" || nodeId === state.nodeId || !target) return;
  clusterNotice("info", `Primary ${target.name} is back: handing control back`);
  holdNewRuns(true);
  try {
    if (!(await drainRuns())) {
      clusterNotice("warning", `Cards still running after ${FAILBACK_DRAIN_MS / 1000}s; ${target.name} resumes them`);
    }
    await replicationFlush(nodeId);
    const term = readNodeState().term + 1;
    const handover: HandoverMsg = { t: "handover", term, from: selfAddress() };
    const ack = await requestHandover(nodeId, handover);
    if (!ack.ok) throw new Error(ack.error ?? `${target.name} refused to take over`);
    await demoteSelf(target, term, `failback to ${target.name}`);
  } catch (err) {
    holdNewRuns(false);
    clusterNotice("warning", `Handing control back to ${target.name} failed: ${errorText(err)}; retrying later`);
  }
}

/**
 * Failback (primary): give control back to the returned home primary `nodeId` — hold new runs,
 * drain running ones (FAILBACK_DRAIN_MS), flush replication, `handover`, then demote. On failure
 * runs resume here and primary.ts retries later. Single-flight; never rejects.
 */
export function handOverPrimary(nodeId: string): Promise<void> {
  g.__ompUiClusterHandover ??= handOver(nodeId).finally(() => {
    g.__ompUiClusterHandover = undefined;
  });
  return g.__ompUiClusterHandover;
}
