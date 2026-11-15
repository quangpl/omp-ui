// Replica role of cluster mode: keeps the member channel to the primary (register, status reports,
// replication receiver, hosted runs), follows redirects, stores membership/token updates, answers a
// failback handover and, when the primary stays unreachable for `clusterFailoverSeconds`, runs the
// failover election (lib/cluster/election.ts). One runtime per process (globalThis); node.ts starts
// and stops it.
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { readLoadHold, readMachineResources, resolveConcurrency } from "@/lib/agent/concurrency";
import { decideElection, rankCandidates, type Candidate } from "@/lib/cluster/election";
import {
  clusterHttpUrl,
  clusterNotice,
  disableCluster,
  promoteSelf,
  publishClusterStatus,
  readNodeState,
  updateNodeState,
} from "@/lib/cluster/node";
import { ensureOmpBinary, localOmpInfo } from "@/lib/cluster/omp-runtime";
import { clusterPaths } from "@/lib/cluster/paths";
import { connectChannel, type ClusterChannel } from "@/lib/cluster/protocol";
import { replicatedSeq, startReplicationReceiver } from "@/lib/cluster/replication";
import { runHost } from "@/lib/cluster/run-host";
import { SyncEndpoint } from "@/lib/cluster/sync";
import {
  ELECTION_PROBE_TIMEOUT_MS,
  ELECTION_WAIT_MS,
  NODE_STATUS_MS,
  type HandoverAckMsg,
  type HandoverMsg,
  type MemberInfo,
  type MembersMsg,
  type NodeState,
  type NodeStatusMsg,
  type PeerAddress,
  type ProbeReplyMsg,
  type RedirectMsg,
  type RegisterMsg,
  type RemovedMsg,
  type TokenMsg,
  type WelcomeMsg,
} from "@/lib/cluster/types";
import { getRepo } from "@/lib/db";
import { dataDir } from "@/lib/files";
import { getAppSettings } from "@/lib/settings";
import { DEFAULT_SETTINGS, type ClusterNodeStatus, type ClusterStatus, type NodeOmpInfo, type NodeResources } from "@/lib/types";
import { APP_VERSION } from "@/lib/version";

/** Reconnect backoff to the primary: doubles from the minimum up to the maximum. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
/** Connect + handshake deadline of the member channel. */
const CONNECT_TIMEOUT_MS = 10_000;
/** After a failback ack, the interim primary closes the channel itself; this is the fallback. */
const HANDOVER_CLOSE_MS = 2_000;
/** Retry backoff of the omp binary prefetch: doubles from the minimum up to the maximum. */
const PREFETCH_RETRY_MIN_MS = 30_000;
const PREFETCH_RETRY_MAX_MS = 5 * 60_000;

type Connection = NonNullable<ClusterStatus["connection"]>;
/** How one member channel ended: a welcomed session, a failed attempt, or a redirect to another primary. */
type Outcome = "session" | "failed" | "redirected";

interface Session {
  channel: ClusterChannel;
  endpoint: SyncEndpoint;
  receiver: { stop(): void };
  statusTimer: NodeJS.Timeout;
  /** Next attempt to download the primary's omp binary after a failed one. */
  prefetchTimer: NodeJS.Timeout | undefined;
  /** This node's address as the primary sees it. */
  observedHost: string;
  primary: PeerAddress;
}

interface ReplicaRuntime {
  /** Aborted by stopReplica: ends the connect loop, its waits and the election. */
  abort: AbortController;
  connection: Omit<Connection, "latencyMs">;
  session: Session | null;
  /** When the primary was last lost (boot counts as lost until the first welcome), ms epoch. */
  lostSince: number;
  replicationAt: string | null;
  /** When the last membership list arrived. */
  membersAt: string | null;
  /** A failback handover in progress: stopReplica leaves this channel open until the ack is sent. */
  handover: ClusterChannel | null;
  statusBusy: boolean;
}

const g = globalThis as unknown as { __ompUiReplica?: ReplicaRuntime; __ompUiReplicaSlots?: number };

/** Join the primary in state.primary (or the members by rank) and stay joined until stopReplica. Idempotent. */
export async function startReplica(): Promise<void> {
  if (g.__ompUiReplica) return;
  const rt: ReplicaRuntime = {
    abort: new AbortController(),
    connection: { state: "connecting", since: new Date().toISOString(), error: null },
    session: null,
    lostSince: Date.now(),
    replicationAt: null,
    membersAt: null,
    handover: null,
    statusBusy: false,
  };
  g.__ompUiReplica = rt;
  publishClusterStatus();
  supervise(rt).catch((err: unknown) => {
    clusterNotice("error", `The link to the primary stopped: ${errorMessage(err)}`);
  });
}

/**
 * Leave the replica role's runtime: the member channel is closed and hosted runs are killed. A
 * failback handover in progress keeps its channel open until its ack is sent (promoteSelf calls
 * this before promoting).
 */
export async function stopReplica(reason: string): Promise<void> {
  const rt = g.__ompUiReplica;
  if (!rt) return;
  g.__ompUiReplica = undefined;
  rt.abort.abort();
  endSession(rt, reason);
  runHost().shutdown();
  publishClusterStatus();
}

/** The link to the primary; null when the replica runtime is not running. */
export function replicaConnection(): ClusterStatus["connection"] {
  const rt = g.__ompUiReplica;
  if (!rt) return null;
  return { ...rt.connection, latencyMs: rt.session?.channel.latencyMs ?? null };
}

/** This node (live) and the other members as the primary last broadcast them. */
export function replicaNodeStatuses(): ClusterNodeStatus[] {
  const rt = g.__ompUiReplica;
  const state = readNodeState();
  const now = new Date().toISOString();
  const others = state.members
    .filter((member) => member.nodeId !== state.nodeId)
    .map((member) => memberStatus(member, rt, now));
  return [selfStatus(state, rt, now), ...others];
}

/** Node paths in use by hosted runs (replication leaves them alone). */
export function busyPaths(): Set<string> {
  return runHost().busyPaths();
}

// --- Connect loop -------------------------------------------------------------------------------

async function supervise(rt: ReplicaRuntime): Promise<void> {
  let backoff = RECONNECT_MIN_MS;
  for (let attempt = 0; !rt.abort.signal.aborted; attempt++) {
    const outcome = await connectOnce(rt, attempt);
    if (rt.abort.signal.aborted) return;
    if (outcome === "redirected") {
      backoff = RECONNECT_MIN_MS;
      continue;
    }
    if (outcome === "session") backoff = RECONNECT_MIN_MS;
    if (await failoverDue(rt)) {
      if ((await elect(rt)) === "done") return;
      backoff = RECONNECT_MIN_MS;
      continue;
    }
    await sleep(backoff, rt);
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  }
}

/** The primary to connect to: state.primary, else the members (primary first, then by rank) in turn. */
function pickTarget(state: NodeState, attempt: number): PeerAddress | null {
  if (state.primary) return state.primary;
  const others = state.members.filter((member) => member.nodeId !== state.nodeId);
  const byId = new Map(others.map((member) => [member.nodeId, member]));
  const replicas = rankCandidates(others.filter((member) => member.role === "replica")).flatMap(
    (candidate) => byId.get(candidate.nodeId) ?? [],
  );
  const pool = [...others.filter((member) => member.role === "primary"), ...replicas];
  return pool.length > 0 ? pool[attempt % pool.length] : null;
}

async function connectOnce(rt: ReplicaRuntime, attempt: number): Promise<Outcome> {
  const state = readNodeState();
  const target = pickTarget(state, attempt);
  if (!target || !state.token) {
    setConnection(rt, "connecting", target ? "No cluster token" : "No primary known");
    return "failed";
  }
  let channel: ClusterChannel;
  try {
    ({ channel } = await connectChannel({
      host: target.host,
      port: target.port,
      token: state.token,
      hello: { nodeId: state.nodeId, name: state.name, purpose: "member" },
      timeoutMs: CONNECT_TIMEOUT_MS,
    }));
  } catch (err) {
    setConnection(rt, "connecting", `${target.name}: ${errorMessage(err)}`);
    return "failed";
  }
  if (rt.abort.signal.aborted) {
    channel.close("replica stopped");
    return "failed";
  }
  return runSession(rt, channel, target);
}

/** Register on `channel` and serve it until it closes. */
async function runSession(rt: ReplicaRuntime, channel: ClusterChannel, target: PeerAddress): Promise<Outcome> {
  const { promise, resolve } = Promise.withResolvers<Outcome>();
  let outcome: Outcome = "failed";
  const current = () => g.__ompUiReplica === rt;
  const offs = [
    channel.on("welcome", (msg) => {
      if (current() && onWelcome(rt, channel, target, msg as WelcomeMsg)) outcome = "session";
    }),
    channel.on("redirect", (msg) => {
      if (!current()) return;
      outcome = onRedirect(rt, target, msg as RedirectMsg);
      channel.close("redirected");
    }),
    channel.on("members", (msg) => {
      if (current()) onMembers(rt, msg as MembersMsg);
    }),
    channel.on("token", (msg) => {
      const token = (msg as TokenMsg).token;
      if (current() && typeof token === "string" && token) updateNodeState({ token });
    }),
    channel.on("removed", (msg) => {
      if (current()) onRemoved(msg as RemovedMsg);
    }),
    channel.on("handover", (msg) => {
      if (msg.t === "handover" && current()) void onHandover(rt, channel, msg as HandoverMsg);
    }),
  ];
  channel.onClose((reason) => {
    for (const off of offs) off();
    if (rt.session?.channel === channel) {
      endSession(rt, reason);
      if (!rt.abort.signal.aborted) onPrimaryLost(rt, reason);
    } else if (outcome === "failed" && !rt.abort.signal.aborted) {
      setConnection(rt, "connecting", `${target.name}: ${reason}`);
    }
    resolve(outcome);
  });
  try {
    channel.send(await registerMessage(readNodeState()));
  } catch (err) {
    channel.close(`register failed: ${errorMessage(err)}`);
  }
  return promise;
}

async function registerMessage(state: NodeState): Promise<RegisterMsg> {
  const paths = clusterPaths();
  return {
    t: "register",
    nodeId: state.nodeId,
    name: state.name,
    version: APP_VERSION,
    httpPort: Number.parseInt(process.env.PORT ?? "", 10) || 3000,
    port: state.port,
    paths: { dataDir: dataDir(), mirrorRoot: paths.mirror, ompAgentDir: paths.ompAgent },
    resources: nodeResources(),
    slots: await refreshSlots(),
    omp: localOmpInfo(),
    replSeq: replicatedSeq(),
    knownTerm: state.term,
    knownPrimary: state.primary,
    runs: runHost().states(),
  };
}

/** Accept the primary: persist membership, start replication, runs and status reports. False when fenced. */
function onWelcome(rt: ReplicaRuntime, channel: ClusterChannel, target: PeerAddress, msg: WelcomeMsg): boolean {
  const state = readNodeState();
  if (typeof msg.term !== "number" || msg.term < state.term) {
    setConnection(rt, "connecting", `${msg.primaryName} is a stale primary (term ${msg.term} < ${state.term})`);
    channel.close("stale primary");
    return false;
  }
  const primary: PeerAddress = {
    nodeId: msg.primaryId,
    name: msg.primaryName,
    host: target.host,
    port: target.port,
    httpUrl: msg.primaryHttpUrl,
  };
  const self = msg.members.find((member) => member.nodeId === state.nodeId);
  updateNodeState({
    term: msg.term,
    members: msg.members,
    primary,
    preferredPrimaryId: msg.preferredPrimaryId ?? null,
    joinedAt: state.joinedAt ?? self?.joinedAt ?? new Date().toISOString(),
  });
  const host = runHost();
  const endpoint = new SyncEndpoint(channel, "node", host.baselines);
  host.attach(channel, endpoint, { primaryHttpUrl: msg.primaryHttpUrl, omp: msg.omp });
  const receiver = startReplicationReceiver(channel, endpoint, {
    busyPaths,
    onApplied: (_seq, at) => {
      rt.replicationAt = at;
      publishClusterStatus();
    },
  });
  const statusTimer = setInterval(() => void sendStatus(rt, channel), NODE_STATUS_MS);
  const session: Session = {
    channel,
    endpoint,
    receiver,
    statusTimer,
    prefetchTimer: undefined,
    observedHost: msg.observedHost,
    primary,
  };
  rt.session = session;
  rt.membersAt = new Date().toISOString();
  rt.lostSince = Date.now();
  setConnection(rt, "connected", null);
  clusterNotice("info", `Connected to the primary ${msg.primaryName} (term ${msg.term})`);
  prefetchOmp(rt, session, msg, PREFETCH_RETRY_MIN_MS);
  return true;
}

/**
 * Download the primary's omp binary ahead of the first run when it fits this machine. A failed
 * (or stalled) download is retried with backoff while the session lasts, so the node does not stay
 * omp-less until the next welcome.
 */
function prefetchOmp(rt: ReplicaRuntime, session: Session, msg: WelcomeMsg, retryMs: number): void {
  const omp = msg.omp;
  if (!omp || omp.platform !== process.platform || omp.arch !== process.arch) return;
  ensureOmpBinary(msg.primaryHttpUrl, omp).then(
    () => publishClusterStatus(),
    (err: unknown) => {
      if (rt.session !== session) return;
      const text = `Could not download the primary's omp binary (retrying in ${Math.round(retryMs / 1000)} s): ${errorMessage(err)}`;
      if (retryMs === PREFETCH_RETRY_MIN_MS) clusterNotice("warning", text);
      else console.warn(`[cluster] ${text}`);
      publishClusterStatus();
      session.prefetchTimer = setTimeout(() => {
        if (rt.session === session) prefetchOmp(rt, session, msg, Math.min(retryMs * 2, PREFETCH_RETRY_MAX_MS));
      }, retryMs);
      session.prefetchTimer.unref();
    },
  );
}

/** Follow a redirect to a primary of our term or newer; anything else is a failed attempt. */
function onRedirect(rt: ReplicaRuntime, target: PeerAddress, msg: RedirectMsg): Outcome {
  const state = readNodeState();
  const primary = msg.primary;
  const usable =
    primary !== null &&
    typeof primary === "object" &&
    primary.nodeId !== state.nodeId &&
    typeof msg.term === "number" &&
    msg.term >= state.term;
  if (!usable) {
    setConnection(rt, "connecting", `${target.name} redirected: ${String(msg.reason)}`);
    return "failed";
  }
  updateNodeState({ primary, term: msg.term });
  if (primary.host === target.host && primary.port === target.port) return "failed";
  clusterNotice("info", `Following primary ${primary.name} (term ${msg.term})`);
  return "redirected";
}

function onMembers(rt: ReplicaRuntime, msg: MembersMsg): void {
  const state = readNodeState();
  if (typeof msg.term !== "number" || msg.term < state.term || !Array.isArray(msg.members)) return;
  updateNodeState({ term: msg.term, members: msg.members, preferredPrimaryId: msg.preferredPrimaryId ?? null });
  rt.membersAt = new Date().toISOString();
  publishClusterStatus();
}

function onRemoved(msg: RemovedMsg): void {
  clusterNotice("warning", `This node was removed from the cluster: ${String(msg.reason)}`);
  disableCluster().catch((err: unknown) => {
    clusterNotice("error", `Could not leave the cluster after being removed: ${errorMessage(err)}`);
  });
}

/**
 * Failback: the interim primary hands control back to this (preferred) node. promoteSelf stops this
 * runtime first; stopReplica leaves the handover channel open (rt.handover) so the ack reports the
 * real outcome, then the channel is closed here.
 */
async function onHandover(rt: ReplicaRuntime, channel: ClusterChannel, msg: HandoverMsg): Promise<void> {
  const state = readNodeState();
  let error: string | null = null;
  if (rt.session?.channel !== channel) error = "Not connected to this primary";
  else if (typeof msg.term !== "number" || !Number.isInteger(msg.term) || msg.term <= state.term) {
    error = `Stale handover term ${String(msg.term)} (this node knows term ${state.term})`;
  }
  if (!error) {
    rt.handover = channel;
    try {
      await promoteSelf("failback", { term: msg.term });
    } catch (err) {
      error = errorMessage(err);
    }
  }
  const ack: HandoverAckMsg = { t: "handover.ack", ok: error === null, error };
  channel.reply(msg, ack);
  if (rt.handover !== channel) return;
  rt.handover = null;
  if (g.__ompUiReplica === rt) return;
  // stopReplica ran (promotion) and left the channel to us.
  setTimeout(() => channel.close("handed over"), HANDOVER_CLOSE_MS).unref();
  if (error && readNodeState().role === "replica") await startReplica();
}

/** Stop serving the current member channel (runs keep going). */
function endSession(rt: ReplicaRuntime, reason: string): void {
  const session = rt.session;
  if (!session) return;
  rt.session = null;
  clearInterval(session.statusTimer);
  clearTimeout(session.prefetchTimer);
  session.receiver.stop();
  runHost().detach();
  session.endpoint.close();
  if (session.channel !== rt.handover) session.channel.close(reason);
}

function onPrimaryLost(rt: ReplicaRuntime, reason: string): void {
  rt.lostSince = Date.now();
  const name = readNodeState().primary?.name ?? "the primary";
  setConnection(rt, "connecting", reason);
  clusterNotice("warning", `Lost the connection to the primary ${name}: ${reason}`);
}

async function sendStatus(rt: ReplicaRuntime, channel: ClusterChannel): Promise<void> {
  if (rt.statusBusy) return;
  rt.statusBusy = true;
  try {
    const msg: NodeStatusMsg = {
      t: "node.status",
      resources: nodeResources(),
      slots: await refreshSlots(),
      omp: localOmpInfo(),
      replSeq: replicatedSeq(),
      runs: await runHost().usage(),
    };
    if (rt.session?.channel === channel) channel.send(msg);
  } finally {
    rt.statusBusy = false;
  }
}

function setConnection(rt: ReplicaRuntime, state: Connection["state"], error: string | null): void {
  if (rt.abort.signal.aborted) return;
  const since = rt.connection.state === state ? rt.connection.since : new Date().toISOString();
  rt.connection = { state, since, error };
  publishClusterStatus();
}

/** Wait `ms`, or less when the replica is stopped. */
async function sleep(ms: number, rt: ReplicaRuntime): Promise<void> {
  await delay(ms, undefined, { signal: rt.abort.signal }).catch(() => undefined);
}

// --- Failover election --------------------------------------------------------------------------

async function failoverSeconds(): Promise<number> {
  try {
    return (await getAppSettings(await getRepo())).clusterFailoverSeconds;
  } catch {
    return DEFAULT_SETTINGS.clusterFailoverSeconds;
  }
}

/** The primary has been unreachable long enough (only for a node that was registered once). */
async function failoverDue(rt: ReplicaRuntime): Promise<boolean> {
  const state = readNodeState();
  if (!state.members.some((member) => member.nodeId === state.nodeId)) return false;
  return Date.now() - rt.lostSince >= (await failoverSeconds()) * 1000;
}

/** A node to probe: a member, or the lost primary when the member list does not hold it. */
interface ProbeTarget {
  address: PeerAddress & { nodeId: string };
  joinedAt: string;
}

interface ProbeResult {
  target: ProbeTarget;
  reply: ProbeReplyMsg;
}

function probeTargets(state: NodeState): ProbeTarget[] {
  const targets: ProbeTarget[] = state.members
    .filter((member) => member.nodeId !== state.nodeId)
    .map((member) => ({ address: member, joinedAt: member.joinedAt }));
  const primary = state.primary;
  if (primary?.nodeId && primary.nodeId !== state.nodeId && !targets.some((t) => t.address.nodeId === primary.nodeId)) {
    targets.push({ address: { ...primary, nodeId: primary.nodeId }, joinedAt: "" });
  }
  return targets;
}

async function probe(target: ProbeTarget, state: NodeState): Promise<ProbeResult | null> {
  if (!state.token) return null;
  let channel: ClusterChannel | null = null;
  try {
    ({ channel } = await connectChannel({
      host: target.address.host,
      port: target.address.port,
      token: state.token,
      hello: { nodeId: state.nodeId, name: state.name, purpose: "probe" },
      timeoutMs: ELECTION_PROBE_TIMEOUT_MS,
    }));
    const reply = await channel.request<ProbeReplyMsg>({ t: "probe" }, ELECTION_PROBE_TIMEOUT_MS);
    return reply.t === "probe.reply" && reply.nodeId === target.address.nodeId ? { target, reply } : null;
  } catch {
    return null;
  } finally {
    channel?.close("probe done");
  }
}

/** The highest-term reachable primary the probes reported (a primary itself, or one a connected replica follows). */
function foundPrimary(state: NodeState, results: ProbeResult[]): { primary: PeerAddress; term: number } | null {
  let best: { primary: PeerAddress; term: number } | null = null;
  for (const { target, reply } of results) {
    let primary: PeerAddress | null = null;
    if (reply.role === "primary") {
      const { nodeId, host, port, httpUrl } = target.address;
      primary = { nodeId, name: reply.name, host, port, httpUrl: reply.primary?.httpUrl ?? httpUrl };
    } else if (
      reply.primaryReachable &&
      reply.primary &&
      reply.primary.nodeId !== state.nodeId &&
      typeof reply.primary.host === "string" &&
      Number.isInteger(reply.primary.port)
    ) {
      primary = reply.primary;
    }
    if (primary && typeof reply.term === "number" && (!best || reply.term > best.term)) {
      best = { primary, term: reply.term };
    }
  }
  return best;
}

/**
 * Probe every other member until this node follows a primary ("follow": back to the connect loop),
 * promotes itself, or is stopped ("done"). Lower-ranked replicas wait ELECTION_WAIT_MS per round
 * for the leader; silent candidates drop out of the next round.
 */
async function elect(rt: ReplicaRuntime): Promise<"follow" | "done"> {
  const start = readNodeState();
  const lostName = start.primary?.name ?? "the primary";
  setConnection(rt, "electing", null);
  clusterNotice("warning", `${lostName} is unreachable: starting an election`);
  let waitingFor: string | null = null;
  while (!rt.abort.signal.aborted) {
    const state = readNodeState();
    // An announce (node.ts) or a redirect moved us to another primary meanwhile.
    if (state.term > start.term || state.primary?.nodeId !== start.primary?.nodeId) return "follow";
    const results = (await Promise.all(probeTargets(state).map((target) => probe(target, state)))).filter(
      (result) => result !== null,
    );
    if (rt.abort.signal.aborted) return "done";
    // The lost primary answers as standalone: an admin disabled the cluster there; leave it too.
    const disabled = results.some(
      ({ target, reply }) => target.address.nodeId === state.primary?.nodeId && reply.role === "standalone",
    );
    if (disabled) {
      clusterNotice("warning", `${lostName} is no longer in cluster mode: this node leaves the cluster`);
      await disableCluster().catch((err: unknown) => {
        clusterNotice("error", `Could not leave the cluster: ${errorMessage(err)}`);
      });
      return "done";
    }
    const found = foundPrimary(state, results);
    const self: Candidate = { nodeId: state.nodeId, replSeq: replicatedSeq(), joinedAt: state.joinedAt ?? "" };
    const alive: Candidate[] = results
      .filter(({ reply }) => reply.role === "replica")
      .map(({ target, reply }) => ({ nodeId: target.address.nodeId, replSeq: reply.replSeq, joinedAt: target.joinedAt }));
    const decision = decideElection({
      self,
      alive,
      primaryFound: found?.primary ?? null,
      primaryTerm: found?.term ?? 0,
      selfTerm: state.term,
    });
    if (decision.action === "follow") {
      const term = Math.max(state.term, found?.term ?? 0);
      updateNodeState({ primary: decision.primary, term });
      rt.lostSince = Date.now();
      setConnection(rt, "connecting", null);
      clusterNotice("info", `Following primary ${decision.primary.name} (term ${term})`);
      return "follow";
    }
    if (decision.action === "promote") return promote(rt, lostName, self.replSeq);
    if (waitingFor !== decision.leader) {
      waitingFor = decision.leader;
      const leader = results.find((r) => r.target.address.nodeId === decision.leader);
      clusterNotice("info", `Waiting for ${leader?.reply.name ?? decision.leader} to take over as primary`);
    }
    await sleep(ELECTION_WAIT_MS, rt);
  }
  return "done";
}

/** Become the primary; on failure (still a replica) retry the election after ELECTION_WAIT_MS. */
async function promote(rt: ReplicaRuntime, lostName: string, replSeq: number): Promise<"follow" | "done"> {
  try {
    await promoteSelf(`${lostName} unreachable; elected with replication seq ${replSeq}`);
    return "done";
  } catch {
    // node.ts posted the error notice.
    if (g.__ompUiReplica === rt) {
      await sleep(ELECTION_WAIT_MS, rt);
      return "follow";
    }
    if (readNodeState().role === "replica") await startReplica();
    return "done";
  }
}

// --- Status -------------------------------------------------------------------------------------

function nodeResources(): NodeResources {
  const machine = readMachineResources();
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    cpus: machine.cpus,
    loadAvg1: os.loadavg()[0],
    totalMemoryBytes: machine.totalMemoryBytes,
    freeMemoryBytes: machine.freeMemoryBytes,
    sampledAt: new Date().toISOString(),
  };
}

/** Agents this node accepts at once (its settings' limit given the hosted runs); the last value when settings fail. */
async function refreshSlots(): Promise<number> {
  try {
    const settings = await getAppSettings(await getRepo());
    g.__ompUiReplicaSlots = resolveConcurrency(
      settings.maxConcurrentAgents,
      runHost().activeCount(),
      readMachineResources(),
      readLoadHold(settings),
    ).limit;
  } catch (err) {
    console.warn(`[cluster] could not compute this node's slots: ${errorMessage(err)}`);
  }
  return g.__ompUiReplicaSlots ?? 0;
}

const UNKNOWN_OMP: NodeOmpInfo = { ready: false, version: null, source: null, reason: "Reported to the primary only" };

function selfStatus(state: NodeState, rt: ReplicaRuntime | undefined, now: string): ClusterNodeStatus {
  return {
    nodeId: state.nodeId,
    name: state.name,
    role: "replica",
    self: true,
    online: true,
    address: `${rt?.session?.observedHost ?? os.hostname()}:${state.port}`,
    httpUrl: clusterHttpUrl(),
    version: APP_VERSION,
    joinedAt: state.joinedAt ?? now,
    lastSeenAt: now,
    resources: nodeResources(),
    slots: g.__ompUiReplicaSlots ?? 0,
    runningTaskIds: runHost().taskIds(),
    omp: localOmpInfo(),
    replication: { seq: replicatedSeq(), at: rt?.replicationAt ?? null, lagSeconds: null },
    latencyMs: null,
  };
}

/** A member as last broadcast; the primary's liveness and latency come from our own link to it. */
function memberStatus(member: MemberInfo, rt: ReplicaRuntime | undefined, now: string): ClusterNodeStatus {
  const linked = rt?.session?.primary.nodeId === member.nodeId ? rt.session : null;
  return {
    nodeId: member.nodeId,
    name: member.name,
    role: member.role,
    self: false,
    online: member.role === "primary" ? linked !== null : member.online,
    address: `${member.host}:${member.port}`,
    httpUrl: member.httpUrl || null,
    version: "",
    joinedAt: member.joinedAt,
    lastSeenAt: linked ? now : (rt?.membersAt ?? member.joinedAt),
    resources: null,
    slots: 0,
    runningTaskIds: [],
    omp: UNKNOWN_OMP,
    replication: member.role === "replica" ? { seq: member.replSeq, at: null, lagSeconds: null } : null,
    latencyMs: linked ? linked.channel.latencyMs : null,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}
