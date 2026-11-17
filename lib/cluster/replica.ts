// Replica role of cluster mode: keeps the member channel to the primary (register, status reports,
// replication receiver, hosted runs), follows redirects, stores membership/token updates, answers a
// failback handover and, when the primary stays unreachable for `clusterFailoverSeconds`, runs the
// failover election (lib/cluster/election.ts). Its disconnect watchdog relaunches a dead connect
// loop and, after a long time without a session (lib/cluster/auto-restart.ts), restarts the server
// through bin/supervisor.mjs. It also runs this machine's resource guard: the status reports carry
// its holds (and the load guard's), so the primary sends no new runs here while they hold. One
// runtime per process (globalThis); node.ts starts and stops it.
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { readLoadHold, readMachineResources, resolveConcurrency } from "@/lib/agent/concurrency";
import { currentResourcePressure, startResourceGuard } from "@/lib/agent/resource-guard";
import {
  autoRestartConfigFrom,
  decideAutoRestart,
  DEFAULT_AUTO_RESTART,
  WATCHDOG_MS,
  type AutoRestartConfig,
} from "@/lib/cluster/auto-restart";
import { dialPeer } from "@/lib/cluster/dial";
import { decideElection, rankCandidates, type Candidate } from "@/lib/cluster/election";
import {
  answerHealRestart,
  bootInfo,
  clusterHttpUrl,
  clusterNotice,
  disableCluster,
  isSupervised,
  promoteSelf,
  publishClusterStatus,
  readNodeState,
  restartWithReason,
  updateNodeState,
} from "@/lib/cluster/node";
import { ensureOmpBinary, localOmpInfo } from "@/lib/cluster/omp-runtime";
import { clusterPaths } from "@/lib/cluster/paths";
import type { ClusterChannel } from "@/lib/cluster/protocol";
import { replicatedSeq, startReplicationReceiver } from "@/lib/cluster/replication";
import { runHost } from "@/lib/cluster/run-host";
import { SyncEndpoint } from "@/lib/cluster/sync";
import {
  ELECTION_PROBE_TIMEOUT_MS,
  ELECTION_WAIT_MS,
  NODE_STATUS_MS,
  type HandoverAckMsg,
  type HandoverMsg,
  type HealStatusMsg,
  type MemberInfo,
  type MembersMsg,
  type NodeHold,
  type NodeState,
  type NodeStatusMsg,
  type PeerAddress,
  type ProbeReplyMsg,
  type RedirectMsg,
  type RegisterMsg,
  type RemovedMsg,
  type TokenMsg,
  type WelcomeMsg,
  type WireMessage,
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
/**
 * Deadline for the primary's answer (welcome or redirect) to our registration. The primary hashes
 * its omp binary before the first welcome, so this is generous; heartbeats keep a registered but
 * unanswered channel open forever, so without it the connect loop could wait indefinitely.
 */
const WELCOME_TIMEOUT_MS = 30_000;
/**
 * Failed connect attempts with an unchanged reason are logged at most this often, so a primary
 * that stays down for days does not flood the log (a new reason is logged at once).
 */
const RECONNECT_LOG_MS = 60_000;
/** After a failback ack, the interim primary closes the channel itself; this is the fallback. */
const HANDOVER_CLOSE_MS = 2_000;
/** Retry backoff of the omp binary prefetch: doubles from the minimum up to the maximum. */
const PREFETCH_RETRY_MIN_MS = 30_000;
const PREFETCH_RETRY_MAX_MS = 5 * 60_000;
/**
 * The watchdog relaunches a dead connect loop at most this often: the delay doubles from
 * WATCHDOG_MS per relaunch in a row, so a loop that throws on every launch (node.json on a full
 * disk) does not churn every few seconds.
 */
const RELAUNCH_MAX_MS = 5 * 60_000;

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
  /** The disconnect watchdog's interval (checkLink every WATCHDOG_MS); cleared by stopReplica. */
  watchdog: NodeJS.Timeout;
  /** A checkLink is in flight: the next tick skips instead of overlapping it. */
  watchdogBusy: boolean;
  /** The connect loop (supervise) runs; the watchdog relaunches it when it died. */
  looping: boolean;
  /** Relaunches of a dead connect loop in a row (checkLink); a welcomed session resets them. */
  relaunches: number;
  /** checkLink relaunches a dead connect loop no earlier than this, ms epoch. */
  nextRelaunchAt: number;
  /** reconnectReplica asked for an attempt at once with the backoff reset (supervise consumes it). */
  retryNow: boolean;
  /** Aborted by reconnectReplica to cut the loop's current sleep short; replaced after each use. */
  wake: AbortController;
  replicationAt: string | null;
  /** When the last membership list arrived. */
  membersAt: string | null;
  /** A failback handover in progress: stopReplica leaves this channel open until the ack is sent. */
  handover: ClusterChannel | null;
  statusBusy: boolean;
  /** A status was requested while another was in flight: sendStatus sends one more right after it. */
  statusAgain: boolean;
}

/**
 * One disconnect episode of this process: from its first startReplica (or a lost session) until a
 * welcomed session. Process-level rather than on the runtime: a failed promotion
 * (rollBackPromotion), a failed failback handover and a new primary's announce replace the
 * runtime, and a replica that keeps failing that way must still reach the watchdog's restart wait
 * (and not repeat its notice) instead of starting the clock over each time.
 */
interface Unlinked {
  /** When the episode started, ms epoch: the watchdog's restart wait counts from it. */
  since: number;
  /** The "runs without bin/supervisor.mjs" notice was posted. */
  unsupervisedNoticed: boolean;
}

const g = globalThis as unknown as {
  __ompUiReplica?: ReplicaRuntime;
  __ompUiReplicaSlots?: number;
  __ompUiReplicaHolding?: NodeHold[];
  /** The disconnect episode in progress; undefined while a welcomed session is up. */
  __ompUiReplicaUnlinked?: Unlinked;
};

/** Join the primary in state.primary (or the members by rank) and stay joined until stopReplica. Idempotent. */
export async function startReplica(): Promise<void> {
  if (g.__ompUiReplica) return;
  const rt: ReplicaRuntime = {
    abort: new AbortController(),
    connection: { state: "connecting", since: new Date().toISOString(), error: null },
    session: null,
    lostSince: Date.now(),
    watchdog: setInterval(() => void checkLink(rt), WATCHDOG_MS).unref(),
    watchdogBusy: false,
    looping: false,
    relaunches: 0,
    nextRelaunchAt: 0,
    retryNow: false,
    wake: new AbortController(),
    replicationAt: null,
    membersAt: null,
    handover: null,
    statusBusy: false,
    statusAgain: false,
  };
  g.__ompUiReplica = rt;
  // A runtime replacing another keeps the episode (and its clock) of the one it replaces.
  g.__ompUiReplicaUnlinked ??= { since: Date.now(), unsupervisedNoticed: false };
  // Samples this machine like the primary's manager does. queuedCount 0: a replica queues nothing,
  // so the guard never restarts its server. stopReplica leaves it running (a promotion's manager
  // replaces these hooks), hence the hooks look up the live runtime.
  startResourceGuard({
    onChange: () => {
      const live = g.__ompUiReplica;
      if (live?.session) void sendStatus(live, live.session.channel);
    },
    activeRunCount: () => runHost().activeCount(),
    queuedCount: () => 0,
  });
  publishClusterStatus();
  launchLoop(rt);
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
  clearInterval(rt.watchdog);
  endSession(rt, reason);
  runHost().shutdown();
  publishClusterStatus();
}

/**
 * Reconnect to the primary now (restore by an admin): the current session is closed with `reason`,
 * the connect loop's next attempt starts at once with the backoff starting over, and a dead loop
 * is relaunched (the admin asked, so the watchdog's relaunch backoff does not apply).
 * False when the replica runtime is not running.
 */
export function reconnectReplica(reason: string): boolean {
  const rt = g.__ompUiReplica;
  if (!rt) return false;
  rt.retryNow = true;
  const wake = rt.wake;
  rt.wake = new AbortController();
  wake.abort();
  // The channel's onClose ends the session and reports the primary lost; a failback handover keeps its channel.
  if (rt.session && rt.session.channel !== rt.handover) rt.session.channel.close(reason);
  if (!rt.looping) launchLoop(rt);
  return true;
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

/**
 * Run the connect loop. `looping` tells the watchdog whether it still runs (supervise only returns
 * once stopped or promoted, but a thrown error would otherwise leave the replica unlinked for good).
 * Only the first failure of a disconnect episode posts a notice: a loop that throws on every
 * relaunch would otherwise post one per relaunch.
 */
function launchLoop(rt: ReplicaRuntime): void {
  rt.looping = true;
  rt.retryNow = false;
  supervise(rt)
    .catch((err: unknown) => {
      const message = `The link to the primary stopped: ${errorMessage(err)}`;
      if (rt.relaunches === 0) clusterNotice("error", message);
      else console.warn(`[cluster] ${message} (relaunch ${rt.relaunches})`);
    })
    .finally(() => {
      rt.looping = false;
    });
}

/** Connect to the primary until stopped: reconnect with backoff, follow redirects, elect on failover. */
async function supervise(rt: ReplicaRuntime): Promise<void> {
  let backoff = RECONNECT_MIN_MS;
  /** Consecutive failed attempts since the last session, redirect or election. */
  let failures = 0;
  /** The last logged failure, and how many failures were not logged since. */
  let logged: { reason: string; at: number } | null = null;
  let unlogged = 0;
  const reset = () => {
    backoff = RECONNECT_MIN_MS;
    failures = 0;
    logged = null;
    unlogged = 0;
    rt.retryNow = false;
  };
  /** reconnectReplica asked for an attempt at once: start over with the minimum backoff. */
  const retryNow = () => {
    if (!rt.retryNow) return false;
    reset();
    return true;
  };
  const logFailure = () => {
    const reason = rt.connection.error ?? "unknown error";
    const now = Date.now();
    if (logged && logged.reason === reason && now - logged.at < RECONNECT_LOG_MS) {
      unlogged++;
      return;
    }
    const skipped = unlogged > 0 ? ` (${unlogged} similar failure${unlogged === 1 ? "" : "s"} not logged)` : "";
    console.warn(
      `[cluster] connecting to the primary failed (attempt ${failures}): ${reason}; retrying in ${Math.round(backoff / 1000)} s${skipped}`,
    );
    logged = { reason, at: now };
    unlogged = 0;
  };
  for (let attempt = 0; !rt.abort.signal.aborted; attempt++) {
    const outcome = await connectOnce(rt, attempt);
    if (rt.abort.signal.aborted) return;
    if (retryNow()) continue;
    if (outcome === "redirected") {
      reset();
      continue;
    }
    if (outcome === "session") reset();
    else failures++;
    if (await failoverDue(rt)) {
      // elect() posts its own notice.
      if ((await elect(rt)) === "done") return;
      reset();
      continue;
    }
    if (outcome === "failed") logFailure();
    await sleep(backoff, rt);
    if (retryNow()) continue;
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
  let via: "tcp" | "ws";
  try {
    ({ channel, via } = await dialPeer(
      { host: target.host, port: target.port, httpUrl: target.httpUrl || null },
      {
        token: state.token,
        hello: { nodeId: state.nodeId, name: state.name, purpose: "member" },
        timeoutMs: CONNECT_TIMEOUT_MS,
      },
    ));
  } catch (err) {
    setConnection(rt, "connecting", `${target.name}: ${errorMessage(err)}`);
    return "failed";
  }
  if (rt.abort.signal.aborted) {
    channel.close("replica stopped");
    return "failed";
  }
  return runSession(rt, channel, target, via);
}

/** Register on `channel` (dialed `via` TCP or the web URL's WebSocket) and serve it until it closes. */
async function runSession(
  rt: ReplicaRuntime,
  channel: ClusterChannel,
  target: PeerAddress,
  via: "tcp" | "ws",
): Promise<Outcome> {
  const { promise, resolve } = Promise.withResolvers<Outcome>();
  let outcome: Outcome = "failed";
  /** Why the primary's answer was refused; kept over the generic close reason. */
  let detail: string | null = null;
  let welcomeTimer: NodeJS.Timeout | undefined;
  const current = () => g.__ompUiReplica === rt;
  const offs = [
    channel.on("welcome", (msg) => {
      clearTimeout(welcomeTimer);
      if (!current()) {
        // Stopped while this channel registered: close it, heartbeats would keep it open.
        channel.close("replica stopped");
        return;
      }
      const refused = onWelcome(rt, channel, target, via, msg as WelcomeMsg);
      if (refused === null) {
        outcome = "session";
        return;
      }
      detail = refused;
      channel.close("stale primary");
    }),
    channel.on("redirect", (msg) => {
      clearTimeout(welcomeTimer);
      if (!current()) return;
      const result = onRedirect(target, msg as RedirectMsg);
      outcome = result.outcome;
      detail = result.error;
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
    channel.on("heal.check", (msg) => {
      if (msg.t === "heal.check" && current() && rt.session?.channel === channel) void answerHealCheck(channel, msg);
    }),
    channel.on("heal.restart", (msg) => {
      // The requester is the primary this session registered with (its identity from the handshake).
      if (msg.t === "heal.restart" && current() && rt.session?.channel === channel) {
        answerHealRestart(channel, msg, channel.peer.nodeId);
      }
    }),
  ];
  channel.onClose((reason) => {
    clearTimeout(welcomeTimer);
    for (const off of offs) off();
    if (rt.session?.channel === channel) {
      endSession(rt, reason);
      if (!rt.abort.signal.aborted) onPrimaryLost(rt, reason);
    } else if (outcome === "failed" && !rt.abort.signal.aborted) {
      setConnection(rt, "connecting", detail ?? `${target.name}: ${reason}`);
    }
    resolve(outcome);
  });
  try {
    channel.send(await registerMessage(readNodeState()));
    if (!channel.closed) {
      welcomeTimer = setTimeout(
        () => channel.close(`no answer to the registration within ${WELCOME_TIMEOUT_MS / 1000} s`),
        WELCOME_TIMEOUT_MS,
      );
      welcomeTimer.unref();
    }
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
    slots: (await refreshCapacity()).slots,
    omp: localOmpInfo(),
    replSeq: replicatedSeq(),
    knownTerm: state.term,
    knownPrimary: state.primary,
    runs: runHost().states(),
    boot: bootInfo(),
  };
}

/** The primary's health check (auto-healing): this node's own checks, its boot time and supervision. */
async function answerHealCheck(channel: ClusterChannel, msg: WireMessage): Promise<void> {
  let problem: string | null = null;
  try {
    await (await getRepo()).getSetting("app_settings");
  } catch (err) {
    problem = `database: ${errorMessage(err)}`;
  }
  const status: HealStatusMsg = {
    t: "heal.status",
    ok: problem === null,
    problem,
    bootedAt: bootInfo().at,
    supervised: isSupervised(),
  };
  channel.reply(msg, status);
}

/**
 * Accept the primary: persist membership, start replication, runs and status reports. Returns why
 * the welcome is refused (a stale primary, the caller closes the channel), null once accepted.
 */
function onWelcome(
  rt: ReplicaRuntime,
  channel: ClusterChannel,
  target: PeerAddress,
  via: "tcp" | "ws",
  msg: WelcomeMsg,
): string | null {
  const state = readNodeState();
  if (typeof msg.term !== "number" || msg.term < state.term) {
    return `${msg.primaryName} is a stale primary (term ${msg.term} < ${state.term})`;
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
    // A session: the watchdog's restarts in a row start over (and so does its wait).
    autoRestarts: 0,
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
  // A session ends the disconnect episode: the watchdog's clock and its relaunch backoff start over.
  g.__ompUiReplicaUnlinked = undefined;
  rt.relaunches = 0;
  rt.nextRelaunchAt = 0;
  setConnection(rt, "connected", null);
  const over = via === "ws" ? " over the web URL (WebSocket)" : "";
  clusterNotice("info", `Connected to the primary ${msg.primaryName} (term ${msg.term})${over}`);
  prefetchOmp(rt, session, msg, PREFETCH_RETRY_MIN_MS);
  return null;
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

/**
 * Follow a redirect to a primary of our term or newer; anything else is a failed attempt, with the
 * reason to report when the redirect is unusable.
 */
function onRedirect(target: PeerAddress, msg: RedirectMsg): { outcome: Outcome; error: string | null } {
  const state = readNodeState();
  const primary = msg.primary;
  const usable =
    primary !== null &&
    typeof primary === "object" &&
    primary.nodeId !== state.nodeId &&
    typeof msg.term === "number" &&
    msg.term >= state.term;
  if (!usable) return { outcome: "failed", error: `${target.name} redirected: ${String(msg.reason)}` };
  updateNodeState({ primary, term: msg.term });
  if (primary.host === target.host && primary.port === target.port) return { outcome: "failed", error: null };
  clusterNotice("info", `Following primary ${primary.name} (term ${msg.term})`);
  return { outcome: "redirected", error: null };
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
  g.__ompUiReplicaUnlinked = { since: Date.now(), unsupervisedNoticed: false };
  const name = readNodeState().primary?.name ?? "the primary";
  setConnection(rt, "connecting", reason);
  clusterNotice("warning", `Lost the connection to the primary ${name}: ${reason}`);
}

async function sendStatus(rt: ReplicaRuntime, channel: ClusterChannel): Promise<void> {
  // Not dropped: a guard hold or resume during an in-flight status must still reach the primary.
  if (rt.statusBusy) {
    rt.statusAgain = true;
    return;
  }
  rt.statusBusy = true;
  try {
    const { slots, holding } = await refreshCapacity();
    const msg: NodeStatusMsg = {
      t: "node.status",
      resources: nodeResources(),
      slots,
      holding,
      omp: localOmpInfo(),
      replSeq: replicatedSeq(),
      runs: await runHost().usage(),
    };
    if (rt.session?.channel === channel) channel.send(msg);
  } finally {
    rt.statusBusy = false;
    // One follow-up covers every request made while this status was in flight.
    if (rt.statusAgain) {
      rt.statusAgain = false;
      if (rt.session?.channel === channel && !channel.closed) void sendStatus(rt, channel);
    }
  }
}

function setConnection(rt: ReplicaRuntime, state: Connection["state"], error: string | null): void {
  if (rt.abort.signal.aborted) return;
  const since = rt.connection.state === state ? rt.connection.since : new Date().toISOString();
  rt.connection = { state, since, error };
  publishClusterStatus();
}

/** Wait `ms`, or less when the replica is stopped or reconnectReplica wakes the loop. */
async function sleep(ms: number, rt: ReplicaRuntime): Promise<void> {
  const signal = AbortSignal.any([rt.abort.signal, rt.wake.signal]);
  await delay(ms, undefined, { signal }).catch(() => undefined);
}

// --- Disconnect watchdog ------------------------------------------------------------------------

/** The watchdog's settings; the defaults when the settings cannot be read. */
async function autoRestartConfig(): Promise<AutoRestartConfig> {
  try {
    return autoRestartConfigFrom(await getAppSettings(await getRepo()));
  } catch {
    return DEFAULT_AUTO_RESTART;
  }
}

/**
 * One watchdog check (every WATCHDOG_MS): relaunch a dead connect loop (with backoff, see
 * RELAUNCH_MAX_MS), then restart this server through bin/supervisor.mjs once it has had no session
 * with its primary for autoRestartWaitMs (a node without the supervisor gets one notice per
 * disconnect episode instead and keeps reconnecting). Does nothing once the runtime was stopped
 * (also mid-check) or during a failback.
 */
async function checkLink(rt: ReplicaRuntime): Promise<void> {
  const current = () => g.__ompUiReplica === rt && !rt.abort.signal.aborted && rt.handover === null;
  if (!current() || rt.watchdogBusy) return;
  rt.watchdogBusy = true;
  try {
    const now = Date.now();
    if (!rt.looping && now >= rt.nextRelaunchAt) {
      const message = "The connect loop to the primary had stopped: starting it again";
      if (rt.relaunches === 0) clusterNotice("warning", message);
      else console.warn(`[cluster] ${message} (relaunch ${rt.relaunches + 1})`);
      rt.nextRelaunchAt = now + Math.min(WATCHDOG_MS * 2 ** rt.relaunches, RELAUNCH_MAX_MS);
      rt.relaunches++;
      launchLoop(rt);
    }
    const config = await autoRestartConfig();
    if (!current()) return;
    const state = readNodeState();
    if (state.role !== "replica") return;
    const unlinked = g.__ompUiReplicaUnlinked;
    const decision = decideAutoRestart({
      config,
      connected: rt.session !== null,
      unlinkedSince: unlinked?.since ?? Date.now(),
      now: Date.now(),
      restarts: state.autoRestarts,
      supervised: isSupervised(),
      primary: state.primary?.name ?? null,
      error: rt.connection.error,
    });
    if (decision.action === "restart") {
      console.warn(`[cluster] disconnect watchdog: ${decision.reason}; restarting the server`);
      try {
        updateNodeState({ autoRestarts: state.autoRestarts + 1 });
      } catch (err) {
        // The restart still helps; only the next wait does not double.
        console.warn(`[cluster] could not record the auto-restart in node.json: ${errorMessage(err)}`);
      }
      clusterNotice("warning", `Restarting this node: ${decision.reason}`);
      restartWithReason(`auto-restart: ${decision.reason}`);
    } else if (decision.action === "notice" && unlinked && !unlinked.unsupervisedNoticed) {
      unlinked.unsupervisedNoticed = true;
      clusterNotice(
        "warning",
        `Not restarting this node (${decision.reason}): it runs without bin/supervisor.mjs, so it keeps reconnecting; restart it by hand`,
      );
    }
  } catch (err) {
    console.warn(`[cluster] disconnect watchdog check failed: ${errorMessage(err)}`);
  } finally {
    rt.watchdogBusy = false;
  }
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
    ({ channel } = await dialPeer(
      { host: target.address.host, port: target.address.port, httpUrl: target.address.httpUrl || null },
      {
        token: state.token,
        hello: { nodeId: state.nodeId, name: state.name, purpose: "probe" },
        timeoutMs: ELECTION_PROBE_TIMEOUT_MS,
      },
    ));
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

/**
 * Agents this node accepts at once (its settings' limit given the hosted runs) and the guards
 * holding new runs: the resource guard's held resources plus "load" when the load guard trips.
 * While any holds, slots are capped at the hosted runs. The last values when settings fail.
 */
async function refreshCapacity(): Promise<{ slots: number; holding: NodeHold[] }> {
  try {
    const settings = await getAppSettings(await getRepo());
    const pressure = currentResourcePressure();
    const loadHold = readLoadHold(settings);
    g.__ompUiReplicaSlots = resolveConcurrency(
      settings.maxConcurrentAgents,
      runHost().activeCount(),
      readMachineResources(),
      loadHold,
      pressure,
    ).limit;
    g.__ompUiReplicaHolding = [...(pressure?.holding ?? []), ...(loadHold ? (["load"] as const) : [])];
  } catch (err) {
    console.warn(`[cluster] could not compute this node's slots: ${errorMessage(err)}`);
  }
  return { slots: g.__ompUiReplicaSlots ?? 0, holding: g.__ompUiReplicaHolding ?? [] };
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
    health: null,
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
    health: null,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}
