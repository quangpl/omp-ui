// Primary side of cluster mode (started by lib/cluster/node.ts): the registry of member nodes and
// their channels, replication to each of them, run placement and capacity for the agent manager,
// remote run transports (lib/cluster/remote-run.ts) and the failback to the cluster's preferred
// primary once it is back and caught up. Process-wide state lives on globalThis (dev hot reloads).
import os from "node:os";
import { readMachineResources } from "@/lib/agent/concurrency";
import { getAgentManager } from "@/lib/agent/manager";
import { currentResourcePressure, DEFAULT_RESOURCE_GUARD_CONFIG } from "@/lib/agent/resource-guard";
import type { RpcTransport } from "@/lib/agent/rpc";
import { dialPeer } from "@/lib/cluster/dial";
import { HealMonitor, healConfigFrom, type HealHost } from "@/lib/cluster/heal";
import {
  clusterHttpUrl,
  clusterNotice,
  demoteSelf,
  handOverPrimary,
  publishClusterStatus,
  readNodeState,
  updateNodeState,
} from "@/lib/cluster/node";
import { primaryOmpBinary, type OmpBinaryInfo } from "@/lib/cluster/omp-runtime";
import {
  choosePlacement,
  computeCapacity,
  memoryUsedShare,
  replicaAvailable,
  type PlacementCandidate,
} from "@/lib/cluster/placement";
import type { ClusterChannel } from "@/lib/cluster/protocol";
import {
  RemoteRunTransport,
  type RemoteNodeSession,
  type RemoteRunInfo,
  type RemoteRunSpec,
} from "@/lib/cluster/remote-run";
import { startReplicationTo, type ReplicationHandle } from "@/lib/cluster/replication";
import { SyncEndpoint } from "@/lib/cluster/sync";
import {
  FAILBACK_STABLE_MS,
  HEAL_STATUS_STALE_MS,
  type BootInfo,
  type HandoverAckMsg,
  type HandoverMsg,
  type HealAckMsg,
  type HealCheckMsg,
  type HealRestartMsg,
  type HealStatusMsg,
  type MemberInfo,
  type MembersMsg,
  type NodeHold,
  type NodePaths,
  type NodeState,
  type NodeStatusMsg,
  type PeerAddress,
  type RedirectMsg,
  type RegisterMsg,
  type RemoteRunState,
  type WelcomeMsg,
  type WireMessage,
} from "@/lib/cluster/types";
import { getRepo } from "@/lib/db";
import { getAppSettings } from "@/lib/settings";
import type { ClusterNodeStatus, ConcurrencyInfo, NodeOmpInfo, NodeResources } from "@/lib/types";
import { APP_VERSION } from "@/lib/version";

export type { RemoteRunInfo, RemoteRunSpec } from "@/lib/cluster/remote-run";

/** A member channel must register this soon after the handshake. */
const REGISTER_TIMEOUT_MS = 15_000;
/** How long the preferred primary may take to promote itself and acknowledge a handover. */
const HANDOVER_TIMEOUT_MS = 60_000;
/** The primary's own entry (settings, omp binary) is re-read this often. */
const SELF_REFRESH_MS = 60_000;
/** Longest node name accepted from a registration. */
const MAX_NAME_LENGTH = 200;
/** Longest `boot.at` / `boot.reason` accepted from a registration. */
const MAX_BOOT_FIELD_LENGTH = 500;

const UNKNOWN_OMP: NodeOmpInfo = { ready: false, version: null, source: null, reason: "Not connected yet" };

/** A replica's live link: its channel, the sync endpoint on it and the replication to it. */
interface MemberSession extends RemoteNodeSession {
  replication: ReplicationHandle | null;
  /** Replication seq when the node registered: failback waits for a round sent after it. */
  registeredSeq: number;
  failback: { timer: NodeJS.Timeout | null; readyAt: number; busy: boolean } | null;
  unsubscribe: Array<() => void>;
}

/** A replica known to the primary (online or not). */
interface Member {
  nodeId: string;
  name: string;
  /** Address of the node as the primary saw it. */
  host: string;
  /** Cluster channel port. */
  port: number;
  httpUrl: string;
  version: string;
  joinedAt: string;
  lastSeenAt: string;
  online: boolean;
  session: MemberSession | null;
  resources: NodeResources | null;
  slots: number;
  omp: NodeOmpInfo;
  /** Replication seq the node last reported as applied, and when it changed. */
  replSeq: number;
  replAt: string | null;
  /** Placements handed to the manager that have not opened a run yet. */
  reserved: number;
  /** BootInfo.at of the node's server process as it last registered (null: unknown or an older node). */
  bootedAt: string | null;
  /** Last node.status or registration (ms epoch), for the health check. */
  lastStatusAt: number;
  /** When the member went offline (ms epoch); null while online. */
  offlineSince: number | null;
  /** Its latest registration carried `boot`, so it answers heal.check/heal.restart (assumed for members from node.json). */
  healCapable: boolean;
  /** Guards holding new runs on it, from its last node.status; null until one carries them (older nodes never do). */
  holding: NodeHold[] | null;
}

/** What node.json keeps of a member (MemberInfo plus when it was last seen). */
interface StoredMember extends MemberInfo {
  lastSeenAt?: string;
}

interface PrimaryState {
  active: boolean;
  startedAt: string;
  members: Map<string, Member>;
  /** Remote runs by runKey, from openRemoteRun until they exit. */
  runs: Map<string, RemoteRunTransport>;
  /** What the manager reported of its own runs (the primary's self entry). */
  local: { taskIds: string[]; limit: number };
  /** Last known AppSettings.clusterRunLocal. */
  runLocal: boolean;
  selfOmp: NodeOmpInfo;
  timer: NodeJS.Timeout | null;
  /** Auto-healing of the members while this primary is active. */
  heal: HealMonitor | null;
}

const g = globalThis as unknown as { __ompUiClusterPrimary?: PrimaryState };

function state(): PrimaryState {
  return (g.__ompUiClusterPrimary ??= {
    active: false,
    startedAt: new Date().toISOString(),
    members: new Map(),
    runs: new Map(),
    local: { taskIds: [], limit: 0 },
    runLocal: true,
    selfOmp: UNKNOWN_OMP,
    timer: null,
    heal: null,
  });
}

// --- Lifecycle -----------------------------------------------------------------------------------

/** Become the primary: load the known members (offline until they reconnect) and accept registrations. */
export async function startPrimary(): Promise<void> {
  const s = state();
  if (s.active) return;
  s.active = true;
  s.startedAt = new Date().toISOString();
  const self = readNodeState();
  for (const info of self.members as StoredMember[]) {
    if (info.nodeId !== self.nodeId && !s.members.has(info.nodeId)) {
      s.members.set(info.nodeId, storedMember(info, Date.parse(s.startedAt)));
    }
  }
  s.timer = setInterval(() => void refreshSelf(), SELF_REFRESH_MS);
  s.timer.unref();
  s.heal = new HealMonitor(healHost());
  s.heal.start();
  await refreshSelf();
  membershipChanged();
}

/** Stop being the primary: remote runs end as node-lost, member channels are closed. */
export async function stopPrimary(reason: string): Promise<void> {
  const s = state();
  if (!s.active) return;
  s.active = false;
  clearInterval(s.timer ?? undefined);
  s.heal?.stop();
  s.heal = null;
  s.timer = null;
  for (const run of [...s.runs.values()]) run.lost(`The cluster primary stopped: ${reason}`);
  for (const member of s.members.values()) closeSession(member, reason);
  s.members.clear();
  publishClusterStatus();
}

export function isPrimaryActive(): boolean {
  return state().active;
}

/** A replica connected (hello purpose `member`): wait for its `register`. */
export function acceptMember(channel: ClusterChannel): void {
  if (!state().active) {
    channel.close("not the primary");
    return;
  }
  const timer = setTimeout(() => channel.close("no registration"), REGISTER_TIMEOUT_MS);
  const off = channel.on("register", (msg) => {
    if (msg.t !== "register") return;
    off();
    clearTimeout(timer);
    register(channel, msg).catch((err: unknown) => {
      console.error("[cluster] registration failed:", err instanceof Error ? err.message : err);
      channel.close("registration failed");
    });
  });
  channel.onClose(() => clearTimeout(timer));
}

/** An admin removed a node: tell it, close its channel, end its runs and forget it. */
export async function forgetNode(nodeId: string): Promise<void> {
  const s = state();
  const member = s.members.get(nodeId);
  if (!member) return;
  s.members.delete(nodeId);
  s.heal?.forget(nodeId);
  for (const run of runsOn(nodeId)) run.lost(`Node ${member.name} was removed from the cluster`);
  const channel = member.session?.channel;
  if (channel) {
    closeSession(member, null);
    channel.send({ t: "removed", reason: "Removed from the cluster by an admin" });
    await channel.drain().catch(() => undefined);
    channel.close("removed");
  }
  clusterNotice("info", `Node ${member.name} was removed from the cluster`);
  membershipChanged();
}

/** The join token was rotated: connected replicas store the new one. */
export function broadcastToken(token: string): void {
  for (const member of state().members.values()) member.session?.channel.send({ t: "token", token });
}

// --- Registration and member sessions ------------------------------------------------------------

async function register(channel: ClusterChannel, raw: WireMessage): Promise<void> {
  const msg = parseRegister(raw);
  let self = readNodeState();
  if (!msg || msg.nodeId !== channel.peer.nodeId || msg.nodeId === self.nodeId) {
    channel.close("invalid registration");
    return;
  }
  if (msg.knownTerm > self.term && msg.knownPrimary && msg.knownPrimary.nodeId !== self.nodeId) {
    fenced(channel, raw, msg, msg.knownPrimary);
    return;
  }
  if (msg.knownTerm > self.term && msg.knownPrimary?.nodeId === self.nodeId) {
    // The node follows this primary at a newer term than ours (it joined, or re-joined, with a term
    // kept from an earlier era, e.g. as an interim primary): move past that term, or the node
    // rejects our welcome as a stale primary's and never connects. Strictly above it, so we never
    // tie with another primary still running on that term (fencing compares terms strictly).
    updateNodeState({ term: msg.knownTerm + 1 });
    self = readNodeState();
    clusterNotice("info", `Node ${msg.name} follows this primary at term ${msg.knownTerm}: now term ${self.term}`);
  }
  const binary = await ompBinaryFor(msg.resources);
  const s = state();
  if (channel.closed) return;
  if (!s.active) {
    // Stopped while registering: close, or the node waits on this channel (heartbeats keep it open).
    channel.close("this primary stopped");
    return;
  }

  const previous = s.members.get(msg.nodeId);
  if (previous) closeSession(previous, "replaced by a new connection");
  const host = normalizeHost(channel.remote.host);
  const now = new Date().toISOString();
  const session: MemberSession = {
    channel,
    endpoint: new SyncEndpoint(channel, "primary"),
    paths: msg.paths,
    replication: null,
    registeredSeq: 0,
    failback: null,
    unsubscribe: [],
  };
  const member: Member = {
    nodeId: msg.nodeId,
    name: msg.name,
    host,
    port: msg.port,
    httpUrl: httpUrlOf(host, msg.httpPort),
    version: msg.version,
    joinedAt: previous?.joinedAt ?? now,
    lastSeenAt: now,
    online: true,
    session,
    resources: msg.resources,
    slots: msg.slots,
    omp: msg.omp,
    replSeq: msg.replSeq,
    replAt: previous && previous.replSeq === msg.replSeq ? previous.replAt : now,
    reserved: previous?.reserved ?? 0,
    bootedAt: msg.boot?.at ?? null,
    lastStatusAt: Date.now(),
    offlineSince: null,
    healCapable: msg.boot !== undefined,
    holding: null,
  };
  s.members.set(member.nodeId, member);
  session.unsubscribe.push(
    session.endpoint.receive("run:", { folders: (scope) => upstreamFolders(member.nodeId, scope) }),
    channel.on("node.status", (m) => onNodeStatus(member.nodeId, channel, m)),
    channel.on("run.", (m) => onRunMessage(member.nodeId, channel, m)),
  );

  const welcome: WelcomeMsg = {
    t: "welcome",
    primaryId: self.nodeId,
    primaryName: self.name,
    primaryHttpUrl: clusterHttpUrl(),
    term: self.term,
    members: memberInfos(self),
    preferredPrimaryId: self.preferredPrimaryId,
    observedHost: host,
    omp: binary && {
      version: binary.version,
      sha256: binary.sha256,
      platform: binary.platform,
      arch: binary.arch,
      size: binary.size,
    },
  };
  channel.reply(raw, welcome);
  membershipChanged();
  session.replication = startReplicationTo(channel, session.endpoint, { nodeId: member.nodeId, paths: msg.paths });
  session.registeredSeq = session.replication.seq();
  reattachRuns(member, session, msg.runs);
  armFailback(member);
  channel.onClose(() => onSessionClosed(member.nodeId, channel));
  if (!member.healCapable) {
    console.log(`[cluster] Node ${member.name} runs a version without auto-healing (${member.version}): not health-checked`);
  }
  const healNotice = s.heal?.onRegister(member.nodeId, msg.boot) ?? null;
  if (healNotice) clusterNotice(healNotice.level, healNotice.message);
  else clusterNotice("info", previous ? `Node ${member.name} reconnected` : `Node ${member.name} joined the cluster`);
  if (member.omp.ready && member.slots > 0) refreshAgentQueue();
}

/** The registering node follows a primary with a higher term: step down and let it follow that one. */
function fenced(channel: ClusterChannel, raw: WireMessage, msg: RegisterMsg, primary: PeerAddress): void {
  const redirect: RedirectMsg = { t: "redirect", reason: "A newer primary exists", term: msg.knownTerm, primary };
  channel.reply(raw, redirect);
  channel.close("fenced");
  clusterNotice(
    "warning",
    `Node ${msg.name} follows ${primary.name} (term ${msg.knownTerm}), newer than this primary: stepping down`,
  );
  demoteSelf(primary, msg.knownTerm, `node ${msg.name} knows a newer primary`).catch((err: unknown) =>
    console.error("[cluster] stepping down failed:", err instanceof Error ? err.message : err),
  );
}

/**
 * Runs the node still hosts are resumed (stdout replay, stdin resent); the ones the primary no
 * longer knows are killed, and runs it was given that it does not report any more are lost.
 */
function reattachRuns(member: Member, session: MemberSession, runs: RemoteRunState[]): void {
  const s = state();
  const reported = new Set<string>();
  for (const run of runs) {
    const transport = s.runs.get(run.runKey);
    if (transport?.nodeId === member.nodeId) {
      reported.add(run.runKey);
      transport.attach(run);
    } else {
      session.channel.send({ t: "run.kill", runKey: run.runKey });
    }
  }
  for (const transport of runsOn(member.nodeId)) {
    if (transport.launched && !reported.has(transport.runKey)) {
      transport.lost(`Node ${member.name} restarted and lost the run`);
    }
  }
}

function onNodeStatus(nodeId: string, channel: ClusterChannel, raw: WireMessage): void {
  const member = currentMember(nodeId, channel);
  const msg = parseNodeStatus(raw);
  if (!member || !msg) return;
  const now = new Date().toISOString();
  member.resources = msg.resources;
  // Capacity grew: omp became ready, more slots, the node stopped holding new runs, or its status
  // had gone stale (it took no runs meanwhile).
  const released = (member.holding?.length ?? 0) > 0 && !msg.holding?.length;
  const wasStale = Date.now() - member.lastStatusAt > HEAL_STATUS_STALE_MS;
  const grew = msg.omp.ready && (!member.omp.ready || msg.slots > member.slots || released || wasStale);
  member.holding = msg.holding ?? null;
  member.slots = msg.slots;
  member.omp = msg.omp;
  member.lastSeenAt = now;
  member.lastStatusAt = Date.now();
  if (msg.replSeq !== member.replSeq) {
    member.replSeq = msg.replSeq;
    member.replAt = now;
  }
  const s = state();
  for (const [runKey, entry] of Object.entries(msg.runs)) {
    const transport = s.runs.get(runKey);
    if (transport?.nodeId === nodeId) transport.updateStatus(entry);
  }
  checkFailback(nodeId);
  publishClusterStatus();
  if (grew) refreshAgentQueue();
}

/** Remote capacity grew: let the manager start queued cards now instead of at its next pump. */
function refreshAgentQueue(): void {
  void getAgentManager()
    .then((manager) => manager.refreshQueue())
    .catch(() => undefined);
}

function onRunMessage(nodeId: string, channel: ClusterChannel, msg: WireMessage): void {
  if (!currentMember(nodeId, channel) || typeof msg.runKey !== "string") return;
  const transport = state().runs.get(msg.runKey);
  if (transport?.nodeId === nodeId) transport.handle(msg);
  else if (msg.t === "run.started" || msg.t === "run.out") channel.send({ t: "run.kill", runKey: msg.runKey });
}

function onSessionClosed(nodeId: string, channel: ClusterChannel): void {
  const s = state();
  const member = s.members.get(nodeId);
  if (!member || member.session?.channel !== channel) return;
  closeSession(member, null);
  member.lastSeenAt = new Date().toISOString();
  member.offlineSince = Date.now();
  if (!s.active) return;
  for (const run of runsOn(nodeId)) run.detach();
  clusterNotice("warning", `Node ${member.name} went offline`);
  membershipChanged();
}

/** Tear down a member's session (stops replication and failback); closes the channel when `reason` is given. */
function closeSession(member: Member, reason: string | null): void {
  const session = member.session;
  if (!session) return;
  member.session = null;
  member.online = false;
  for (const off of session.unsubscribe) off();
  clearTimeout(session.failback?.timer ?? undefined);
  session.replication?.stop();
  session.endpoint.close();
  if (reason !== null) session.channel.close(reason);
}

/** The member whose live session is `channel` (messages of a replaced channel are ignored). */
function currentMember(nodeId: string, channel: ClusterChannel): Member | null {
  const member = state().members.get(nodeId);
  return member?.session?.channel === channel ? member : null;
}

/** Upstream pushes of a run are applied with the primary's own specs, and only from the run's node. */
function upstreamFolders(nodeId: string, scope: string) {
  const transport = state().runs.get(scope.slice("run:".length));
  return transport?.nodeId === nodeId ? transport.upstreamFolders() : null;
}

// --- Membership broadcast and persistence --------------------------------------------------------

/** Persist the member list (node.json), broadcast it to every connected replica and publish the status. */
function membershipChanged(): void {
  const self = readNodeState();
  const members = memberInfos(self);
  updateNodeState({ members });
  const msg: MembersMsg = { t: "members", term: self.term, members, preferredPrimaryId: self.preferredPrimaryId };
  for (const member of state().members.values()) member.session?.channel.send(msg);
  publishClusterStatus();
}

/** Every member as broadcast and persisted: this primary first, then the replicas. */
function memberInfos(self: NodeState): StoredMember[] {
  const httpUrl = clusterHttpUrl();
  const primary: StoredMember = {
    nodeId: self.nodeId,
    name: self.name,
    host: new URL(httpUrl).hostname.replace(/^\[(.*)\]$/, "$1"),
    port: self.port,
    httpUrl,
    role: "primary",
    joinedAt: self.joinedAt ?? state().startedAt,
    replSeq: 0,
    online: true,
    lastSeenAt: new Date().toISOString(),
  };
  const replicas = sortedMembers().map(
    (m): StoredMember => ({
      nodeId: m.nodeId,
      name: m.name,
      host: m.host,
      port: m.port,
      httpUrl: m.httpUrl,
      role: "replica",
      joinedAt: m.joinedAt,
      replSeq: m.replSeq,
      online: m.online,
      lastSeenAt: m.lastSeenAt,
    }),
  );
  return [primary, ...replicas];
}

/** A member loaded from node.json: offline (since `offlineSince`, the primary's start) until it registers again. */
function storedMember(info: StoredMember, offlineSince: number): Member {
  return {
    nodeId: info.nodeId,
    name: info.name,
    host: info.host,
    port: info.port,
    httpUrl: info.httpUrl,
    version: "",
    joinedAt: info.joinedAt,
    lastSeenAt: info.lastSeenAt ?? info.joinedAt,
    online: false,
    session: null,
    resources: null,
    slots: 0,
    omp: UNKNOWN_OMP,
    replSeq: info.replSeq,
    replAt: null,
    reserved: 0,
    bootedAt: null,
    lastStatusAt: offlineSince,
    offlineSince,
    healCapable: true,
    holding: null,
  };
}

function sortedMembers(): Member[] {
  return [...state().members.values()].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
}

// --- Failback ------------------------------------------------------------------------------------

/**
 * The cluster's preferred primary registered while another node is primary: once it stayed
 * connected FAILBACK_STABLE_MS and applied a replication round sent after it registered, hand
 * control back to it (node.ts handOverPrimary). A disconnect cancels this; a failed handover re-arms it.
 */
function armFailback(member: Member): void {
  const self = readNodeState();
  const session = member.session;
  if (!session || member.nodeId !== self.preferredPrimaryId || self.nodeId === self.preferredPrimaryId) return;
  const failback = (session.failback ??= { timer: null, readyAt: 0, busy: false });
  clearTimeout(failback.timer ?? undefined);
  failback.readyAt = Date.now() + FAILBACK_STABLE_MS;
  failback.timer = setTimeout(() => checkFailback(member.nodeId), FAILBACK_STABLE_MS);
  failback.timer.unref();
}

function checkFailback(nodeId: string): void {
  const s = state();
  const member = s.members.get(nodeId);
  const session = member?.session;
  const failback = session?.failback;
  if (!s.active || !member || !session?.replication || !failback || failback.busy) return;
  if (Date.now() < failback.readyAt) return;
  const seq = session.replication.seq();
  if (seq <= session.registeredSeq || member.replSeq < seq) return;
  failback.busy = true;
  handOverPrimary(nodeId)
    .catch((err: unknown) => console.error("[cluster] failback failed:", err instanceof Error ? err.message : err))
    .finally(() => {
      failback.busy = false;
      if (member.session === session) armFailback(member);
    });
}

/** Run a full replication round to the node now; resolves with its seq once the node applied it. */
export function replicationFlush(nodeId: string): Promise<number> {
  const member = state().members.get(nodeId);
  const replication = member?.session?.replication;
  if (!replication) return Promise.reject(new Error(`Node ${member?.name ?? nodeId} is not connected`));
  return replication.flush();
}

/** How other nodes reach a member; null for an unknown node. */
export function nodePeerAddress(nodeId: string): PeerAddress | null {
  const member = state().members.get(nodeId);
  if (!member) return null;
  return { nodeId: member.nodeId, name: member.name, host: member.host, port: member.port, httpUrl: member.httpUrl };
}

/** Ask a connected node to take over as primary; resolves with its acknowledgement. */
export function requestHandover(nodeId: string, msg: HandoverMsg): Promise<HandoverAckMsg> {
  const member = state().members.get(nodeId);
  const channel = member?.session?.channel;
  if (!channel) return Promise.reject(new Error(`Node ${member?.name ?? nodeId} is not connected`));
  return channel.request<HandoverAckMsg>(msg, HANDOVER_TIMEOUT_MS);
}

// --- Auto-healing --------------------------------------------------------------------------------

/** What the auto-healing monitor (lib/cluster/heal.ts) drives: the members, their channels, notices and status. */
function healHost(): HealHost {
  return {
    nodes: () =>
      [...state().members.values()].map((m) => ({
        nodeId: m.nodeId,
        name: m.name,
        address: memberAddress(m),
        online: m.online,
        offlineSince: m.offlineSince,
        capable: m.healCapable,
        lastStatusAt: m.lastStatusAt,
      })),
    config: async () => healConfigFrom(await getAppSettings(await getRepo())),
    check: (nodeId, timeoutMs) => {
      const channel = state().members.get(nodeId)?.session?.channel;
      if (!channel) return Promise.reject(new Error("not connected"));
      const msg: HealCheckMsg = { t: "heal.check" };
      return channel.request<HealStatusMsg>(msg, timeoutMs);
    },
    restart: restartNode,
    notice: clusterNotice,
    // A node passing its checks again can take cards now.
    changed: () => {
      publishClusterStatus();
      refreshAgentQueue();
    },
    term: () => readNodeState().term,
    now: () => Date.now(),
  };
}

/** Ask a member to restart: on its member channel while online, else on a fresh probe channel. Throws when unreachable or the answer is not a heal.ack. */
async function restartNode(nodeId: string, msg: HealRestartMsg, timeoutMs: number): Promise<HealAckMsg> {
  const member = state().members.get(nodeId);
  if (!member) throw new Error("not a member of the cluster");
  let reply: WireMessage;
  const session = member.session;
  if (session) {
    reply = await session.channel.request(msg, timeoutMs);
  } else {
    const self = readNodeState();
    if (!self.token) throw new Error("this node has no cluster token");
    const { channel } = await dialPeer(
      { host: member.host, port: member.port, httpUrl: member.httpUrl },
      { token: self.token, hello: { nodeId: self.nodeId, name: self.name, purpose: "probe" }, timeoutMs },
    );
    try {
      reply = await channel.request(msg, timeoutMs);
    } finally {
      channel.close("restart request finished");
    }
  }
  const ack = reply as Partial<HealAckMsg>;
  if (ack.t !== "heal.ack" || !(ack.outcome === "restarting" || ack.outcome === "already" || ack.outcome === "refused")) {
    throw new Error(`unexpected answer to the restart request (${reply.t})`);
  }
  return reply as HealAckMsg;
}

// --- Placement and capacity ----------------------------------------------------------------------

/** Where a run goes: the primary itself (`local`) or a replica node. */
export interface RunPlacement {
  nodeId: string;
  nodeName: string;
  local: boolean;
}

/**
 * Capacity for the manager's pump. `localLimit` = the manager's own resolveConcurrency limit.
 * Replicas that cannot take new runs (memberAvailable) add only the runs they already carry.
 */
export function clusterCapacity(
  localLimit: number,
  runLocal: boolean,
): { limit: number; info: NonNullable<ConcurrencyInfo["cluster"]> } {
  const s = state();
  s.runLocal = runLocal;
  const now = Date.now();
  const memoryHoldPct = currentResourcePressure()?.memoryHoldPct ?? DEFAULT_RESOURCE_GUARD_CONFIG.memoryHoldPct;
  const nodes = [...s.members.values()].map((m) => ({
    online: m.online,
    ompReady: m.omp.ready,
    slots: m.slots,
    available: memberAvailable(m, now, memoryHoldPct),
    occupied: runsOn(m.nodeId).length + m.reserved,
  }));
  return computeCapacity(localLimit, runLocal, nodes);
}

/**
 * Reserve a slot for a run about to launch, replica first: a healthy replica with a free slot
 * gets it before the primary. `localLimit` = the primary's own agent limit, `localFree` =
 * localLimit - local active runs, `localHeld` = a resource or load guard holds the primary,
 * `overflow` = the run fills a slot lent by board_wait_for_cards (the manager's active runs already
 * reach its limit), so the primary or a full replica may take it beyond its own limit.
 * Null when no node can safely take a run now: keep the card queued.
 */
export function placeRun(input: {
  taskId: string;
  localFree: number;
  localLimit: number;
  runLocal: boolean;
  localHeld: boolean;
  overflow: boolean;
  preferNodeId: string | null;
}): RunPlacement | null {
  const s = state();
  s.runLocal = input.runLocal;
  const self = readNodeState();
  // The primary is never scored against replicas (it only takes runs no replica can), so its own
  // load and memory are not sampled.
  const local: PlacementCandidate = {
    nodeId: self.nodeId,
    nodeName: self.name,
    local: true,
    slots: Math.max(0, input.localLimit),
    free: input.localFree,
    loadPerCore: 0,
    available: !input.localHeld,
  };
  const now = Date.now();
  const memoryHoldPct = currentResourcePressure()?.memoryHoldPct ?? DEFAULT_RESOURCE_GUARD_CONFIG.memoryHoldPct;
  const replicas = [...s.members.values()]
    .filter((m) => m.online && m.session && m.omp.ready)
    .map(
      (m): PlacementCandidate => ({
        nodeId: m.nodeId,
        nodeName: m.name,
        local: false,
        slots: m.slots,
        free: m.slots - runsOn(m.nodeId).length - m.reserved,
        loadPerCore: m.resources ? m.resources.loadAvg1 / Math.max(1, m.resources.cpus) : 0,
        memoryUsed: m.resources ? memoryUsedShare(m.resources.freeMemoryBytes, m.resources.totalMemoryBytes) : 0,
        available: memberAvailable(m, now, memoryHoldPct),
      }),
    );
  const choice = choosePlacement({
    local,
    replicas,
    runLocal: input.runLocal,
    overflow: input.overflow,
    preferNodeId: input.preferNodeId,
  });
  if (!choice) return null;
  if (!choice.local) s.members.get(choice.nodeId)!.reserved++;
  return { nodeId: choice.nodeId, nodeName: choice.nodeName, local: choice.local };
}

/**
 * Whether a replica may take new runs: a recent node.status, passing health checks and no guard
 * holding it. `memoryHoldPct` = the primary's own memory hold %, for nodes that do not report holds.
 */
function memberAvailable(m: Member, now: number, memoryHoldPct: number): boolean {
  return replicaAvailable({
    statusAgeMs: now - m.lastStatusAt,
    health: m.healCapable ? (state().heal?.health(m.nodeId) ?? null) : null,
    holding: m.holding,
    memoryUsed: m.resources ? memoryUsedShare(m.resources.freeMemoryBytes, m.resources.totalMemoryBytes) : 0,
    memoryHoldPct,
  });
}

/** A placement the manager will not use (the run was released before it opened). */
export function cancelPlacement(placement: RunPlacement): void {
  const member = placement.local ? undefined : state().members.get(placement.nodeId);
  if (member) member.reserved = Math.max(0, member.reserved - 1);
}

/** The manager reports its local runs (task ids) and its own limit whenever they change (for the primary's self entry). */
export function reportLocalRuns(taskIds: string[], localLimit: number): void {
  const s = state();
  const same =
    s.local.limit === localLimit &&
    s.local.taskIds.length === taskIds.length &&
    s.local.taskIds.every((id, i) => id === taskIds[i]);
  if (same) return;
  s.local = { taskIds: [...taskIds], limit: localLimit };
  publishClusterStatus();
}

/** Start a run on the placement's node; the transport consumes the placement's reservation. */
export function openRemoteRun(
  placement: RunPlacement,
  spec: RemoteRunSpec,
): RpcTransport & { remote: RemoteRunInfo } {
  const s = state();
  const nodeId = placement.nodeId;
  const member = s.members.get(nodeId);
  if (member) member.reserved = Math.max(0, member.reserved - 1);
  const transport: RemoteRunTransport = new RemoteRunTransport(
    {
      nodeId,
      nodeName: member?.name ?? placement.nodeName,
      session: () => s.members.get(nodeId)?.session ?? null,
      ompBinary: async () => {
        const binary = await ompBinaryFor(s.members.get(nodeId)?.resources ?? null);
        return binary && { sha256: binary.sha256, version: binary.version };
      },
      onFinished: () => {
        if (s.runs.get(spec.runKey) === transport) s.runs.delete(spec.runKey);
        publishClusterStatus();
        // The replica slot frees only now, after the manager already released the run: re-pump.
        if (s.active) refreshAgentQueue();
      },
    },
    spec,
  );
  s.runs.set(spec.runKey, transport);
  publishClusterStatus();
  return transport;
}

function runsOn(nodeId: string): RemoteRunTransport[] {
  return [...state().runs.values()].filter((run) => run.nodeId === nodeId);
}

// --- Node statuses -------------------------------------------------------------------------------

/** Self (role primary, local resources/limit/running from the manager) + replicas. */
export function primaryNodeStatuses(): ClusterNodeStatus[] {
  const self = readNodeState();
  return [selfStatus(self), ...sortedMembers().map(memberStatus)];
}

function selfStatus(self: NodeState): ClusterNodeStatus {
  const s = state();
  const httpUrl = clusterHttpUrl();
  const machine = readMachineResources();
  const now = new Date().toISOString();
  return {
    nodeId: self.nodeId,
    name: self.name,
    role: "primary",
    self: true,
    online: true,
    address: `${new URL(httpUrl).hostname}:${self.port}`,
    httpUrl,
    version: APP_VERSION,
    joinedAt: self.joinedAt ?? s.startedAt,
    lastSeenAt: now,
    resources: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      cpus: machine.cpus,
      loadAvg1: os.loadavg()[0],
      totalMemoryBytes: machine.totalMemoryBytes,
      freeMemoryBytes: machine.freeMemoryBytes,
      sampledAt: now,
    },
    slots: s.runLocal ? s.local.limit : 0,
    runningTaskIds: [...s.local.taskIds],
    omp: s.selfOmp,
    replication: null,
    latencyMs: null,
    health: null,
  };
}

function memberStatus(m: Member): ClusterNodeStatus {
  const replication = m.session?.replication;
  let lagSeconds: number | null = null;
  if (replication) {
    const behindSince = m.replAt ? Math.round((Date.now() - Date.parse(m.replAt)) / 1000) : null;
    lagSeconds = m.replSeq >= replication.seq() ? 0 : behindSince;
  }
  return {
    nodeId: m.nodeId,
    name: m.name,
    role: "replica",
    self: false,
    online: m.online,
    address: memberAddress(m),
    httpUrl: m.httpUrl,
    version: m.version,
    joinedAt: m.joinedAt,
    lastSeenAt: m.lastSeenAt,
    resources: m.resources,
    slots: m.slots,
    runningTaskIds: runsOn(m.nodeId).map((run) => run.taskId),
    omp: m.omp,
    replication: { seq: m.replSeq, at: m.replAt, lagSeconds },
    latencyMs: m.session?.channel.latencyMs ?? null,
    health: m.healCapable ? (state().heal?.health(m.nodeId) ?? null) : null,
  };
}

/** host:port of a member as shown and named in messages (IPv6 in brackets). */
function memberAddress(m: Member): string {
  return `${m.host.includes(":") ? `[${m.host}]` : m.host}:${m.port}`;
}

/** The primary's omp binary (settings.ompPath); also refreshes the self entry's omp info. */
async function primaryOmp(): Promise<OmpBinaryInfo | null> {
  const settings = await getAppSettings(await getRepo());
  const binary = await primaryOmpBinary(settings.ompPath);
  state().selfOmp = binary
    ? { ready: true, version: binary.version, source: "local", reason: null }
    : { ready: false, version: null, source: null, reason: `omp not found (${settings.ompPath})` };
  return binary;
}

/** The primary's omp binary when it runs on a node with `resources` (same OS and CPU architecture), else null: the node then uses its own omp. */
async function ompBinaryFor(resources: NodeResources | null): Promise<OmpBinaryInfo | null> {
  const binary = await primaryOmp();
  const compatible = binary && resources?.platform === binary.platform && resources.arch === binary.arch;
  return compatible ? binary : null;
}

/** Re-read the settings and omp binary behind the self entry. */
async function refreshSelf(): Promise<void> {
  try {
    const settings = await getAppSettings(await getRepo());
    state().runLocal = settings.clusterRunLocal;
    await primaryOmp();
    publishClusterStatus();
  } catch (err) {
    console.warn("[cluster] reading the primary's settings failed:", err instanceof Error ? err.message : err);
  }
}

// --- Validation and addresses --------------------------------------------------------------------

function parseRegister(msg: WireMessage): RegisterMsg | null {
  const m = msg as Partial<RegisterMsg>;
  const valid =
    isName(m.nodeId) &&
    isName(m.name) &&
    typeof m.version === "string" &&
    isPort(m.httpPort) &&
    isPort(m.port) &&
    isPaths(m.paths) &&
    isResources(m.resources) &&
    isOmpInfo(m.omp) &&
    isCount(m.slots) &&
    isCount(m.replSeq) &&
    isCount(m.knownTerm) &&
    Number.isSafeInteger(m.knownTerm) &&
    (m.knownPrimary === null || isPeer(m.knownPrimary)) &&
    Array.isArray(m.runs) &&
    m.runs.every(isRunState);
  if (!valid) return null;
  // An invalid boot is dropped, not a reason to reject the node.
  return { ...(m as RegisterMsg), boot: isBoot(m.boot) ? m.boot : undefined };
}

function parseNodeStatus(msg: WireMessage): NodeStatusMsg | null {
  const m = msg as Partial<NodeStatusMsg>;
  const valid =
    isResources(m.resources) &&
    isOmpInfo(m.omp) &&
    isCount(m.slots) &&
    isCount(m.replSeq) &&
    isObject(m.runs) &&
    Object.values(m.runs).every(
      (r: unknown) => isObject(r) && isCount(r.memoryBytes) && isCount(r.cpuSeconds) && isCount(r.inSeq),
    ) &&
    (m.holding === undefined || isHolding(m.holding));
  return valid ? (m as NodeStatusMsg) : null;
}

function isHolding(v: unknown): v is NodeHold[] {
  return Array.isArray(v) && v.length <= 3 && v.every((h) => h === "memory" || h === "cpu" || h === "load");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isName(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_NAME_LENGTH;
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function isPort(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536;
}

function isPaths(v: unknown): v is NodePaths {
  return isObject(v) && [v.dataDir, v.mirrorRoot, v.ompAgentDir].every((p) => typeof p === "string" && p.startsWith("/"));
}

function isResources(v: unknown): v is NodeResources {
  return (
    isObject(v) &&
    [v.hostname, v.platform, v.arch, v.sampledAt].every((s) => typeof s === "string") &&
    [v.cpus, v.loadAvg1, v.totalMemoryBytes, v.freeMemoryBytes].every(isCount)
  );
}

function isOmpInfo(v: unknown): v is NodeOmpInfo {
  return (
    isObject(v) &&
    typeof v.ready === "boolean" &&
    (v.version === null || typeof v.version === "string") &&
    (v.source === null || v.source === "primary" || v.source === "local") &&
    (v.reason === null || typeof v.reason === "string")
  );
}

function isPeer(v: unknown): v is PeerAddress {
  return (
    isObject(v) &&
    (v.nodeId === null || isName(v.nodeId)) &&
    typeof v.name === "string" &&
    typeof v.host === "string" &&
    isPort(v.port) &&
    typeof v.httpUrl === "string"
  );
}

function isBoot(v: unknown): v is BootInfo {
  return (
    isObject(v) &&
    typeof v.at === "string" &&
    v.at.length <= MAX_BOOT_FIELD_LENGTH &&
    (v.reason === null || (typeof v.reason === "string" && v.reason.length <= MAX_BOOT_FIELD_LENGTH))
  );
}

function isRunState(v: unknown): v is RemoteRunState {
  return isObject(v) && isName(v.runKey) && isCount(v.outSeq) && isCount(v.inSeq) && typeof v.alive === "boolean";
}

/** IPv4 peers on a dual-stack socket show up as `::ffff:a.b.c.d`. */
function normalizeHost(host: string): string {
  return host.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");
}

function httpUrlOf(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}
