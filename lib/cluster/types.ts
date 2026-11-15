// Shared contracts of cluster mode (see docs/CLUSTER.md): node-local state, the messages of the
// encrypted cluster channel (lib/cluster/protocol.ts) and the run/sync/replication specs the
// cluster modules exchange. Server-only; the UI reads the DTOs in lib/types.ts.
import type { ClusterRole, NodeOmpInfo, NodeResources } from "@/lib/types";

export const CLUSTER_PROTOCOL_VERSION = 1;
/** TCP port of the cluster channel unless OMP_UI_CLUSTER_PORT says otherwise. */
export const DEFAULT_CLUSTER_PORT = 7790;

/** Liveness pings on every channel; a channel silent for CHANNEL_IDLE_TIMEOUT_MS is closed. */
export const HEARTBEAT_MS = 2_000;
export const CHANNEL_IDLE_TIMEOUT_MS = 10_000;
/** Replicas report resources, slots and per-run usage this often. */
export const NODE_STATUS_MS = 5_000;
/** A remote run whose node is gone this long is given up (and its card rescheduled). */
export const NODE_LOST_GRACE_MS = 30_000;
/** Replicas push a running card's file changes back at least this often (plus at flush barriers). */
export const RUN_SYNC_INTERVAL_MS = 5_000;
/** The primary ships a database snapshot (when changed) this often, and project files every FILE_REPLICATION_INTERVAL_MS. */
export const DB_REPLICATION_INTERVAL_MS = 15_000;
export const FILE_REPLICATION_INTERVAL_MS = 60_000;
/** Election: how long a probe of another node may take, and how long a lower-ranked replica waits for the winner. */
export const ELECTION_PROBE_TIMEOUT_MS = 2_000;
export const ELECTION_WAIT_MS = 5_000;
/** stdout a replica buffers per run while the primary is unreachable (for replay on reconnect). */
export const RUN_OUTPUT_BUFFER_BYTES = 32 * 1024 * 1024;

/** `code` of the RpcExitInfo.error a remote run ends with when its node is lost for good. */
export const NODE_LOST_CODE = "ENODELOST";

// --- Node-local state (DATA_DIR/cluster/node.json, mode 0600, never replicated) ---------------

/** How to reach a node. `host` is the address other nodes use (as the primary saw it). */
export interface PeerAddress {
  nodeId: string | null;
  name: string;
  host: string;
  /** Cluster channel port. */
  port: number;
  /** Base URL of the node's web server, e.g. http://10.0.0.7:3000. */
  httpUrl: string;
}

/** A cluster member as the primary last broadcast it (kept by every node for failover). */
export interface MemberInfo extends PeerAddress {
  nodeId: string;
  role: "primary" | "replica";
  joinedAt: string;
  /** Replication progress: sequence number of the last state snapshot the node applied. */
  replSeq: number;
  online: boolean;
}

export interface NodeState {
  nodeId: string;
  name: string;
  role: ClusterRole;
  /** Highest primary term this node has seen (fencing: a lower-term primary is never followed). */
  term: number;
  /** Shared cluster secret (the join token); null when standalone. */
  token: string | null;
  /** Cluster channel port this node listens on. */
  port: number;
  /** Replicas: the primary they follow. */
  primary: PeerAddress | null;
  /** Last membership broadcast by the primary. */
  members: MemberInfo[];
  /**
   * The cluster's home primary: the node that enabled cluster mode. After a failover it gets
   * control back (failback) once it is online again and has caught up. Replicated to every node.
   */
  preferredPrimaryId: string | null;
  joinedAt: string | null;
  /**
   * `OMP_UI_CLUSTER_JOIN_ID` of the join-script run whose join succeeded. The server joins from the
   * environment (retrying until it works) only while the env id differs from this, so a restart
   * never re-joins a cluster an admin left, and re-running the join script joins again.
   */
  envJoinId: string | null;
  /**
   * Secrets replicated from the primary that this server needs from boot on (applied to
   * process.env AUTH_SECRET / CREDENTIALS_KEY before use, so replicated tokens and sealed values
   * keep working here and after a promotion); `databaseUrl` for a shared postgres/mongo database.
   */
  secrets: { authSecret: string | null; databaseUrl: string | null; credentialsKey: string | null };
}

/** Folders and files on a node (DATA_DIR-relative there), reported at registration. */
export interface NodePaths {
  dataDir: string;
  /** Primary paths are mirrored at `<mirrorRoot><primary path>`. */
  mirrorRoot: string;
  /** The primary's omp agent dir is mirrored here (PI_CODING_AGENT_DIR of remote runs). */
  ompAgentDir: string;
}

// --- Channel messages (JSON; `t` is the type, `rid` correlates a request with its reply) -------

export interface WireMessage {
  t: string;
  rid?: string;
  [key: string]: unknown;
}

/** Header of a binary frame (file chunks); the payload travels next to it. */
export interface BinaryHeader {
  t: string;
  [key: string]: unknown;
}

/** Why a channel was opened (sent in the plaintext hello, before authentication). */
export type ChannelPurpose = "member" | "probe" | "test";

/** State of a run a replica still hosts, reported when it (re)registers. */
export interface RemoteRunState {
  runKey: string;
  /** Last stdout chunk sequence number produced. */
  outSeq: number;
  /** Last stdin chunk sequence number received. */
  inSeq: number;
  alive: boolean;
}

/** replica → primary, first message of a member channel. */
export interface RegisterMsg extends WireMessage {
  t: "register";
  nodeId: string;
  name: string;
  version: string;
  httpPort: number;
  /** The node's cluster port (other nodes probe it during elections). */
  port: number;
  paths: NodePaths;
  resources: NodeResources;
  slots: number;
  omp: NodeOmpInfo;
  replSeq: number;
  /** Fencing: the highest term (and its primary) this node knows. */
  knownTerm: number;
  knownPrimary: PeerAddress | null;
  runs: RemoteRunState[];
  /**
   * This server process: when it started and why bin/supervisor.mjs (re)started it
   * (OMP_UI_RESTART_REASON, null on a first start or without the supervisor). Absent from older
   * nodes. The primary posts a notice when a node comes back with a new `at`.
   */
  boot?: BootInfo;
}

/** When a server process started and why (see RegisterMsg.boot). */
export interface BootInfo {
  at: string;
  reason: string | null;
}

/** primary → replica, reply to register. */
export interface WelcomeMsg extends WireMessage {
  t: "welcome";
  primaryId: string;
  primaryName: string;
  primaryHttpUrl: string;
  term: number;
  members: MemberInfo[];
  /** NodeState.preferredPrimaryId of the cluster. */
  preferredPrimaryId: string | null;
  /** The replica's address as the primary sees it (what other nodes use). */
  observedHost: string;
  /** The primary's omp binary, which replicas download from `${primaryHttpUrl}/api/v1/cluster/runtime/omp`. */
  omp: { version: string; sha256: string; platform: string; arch: string; size: number } | null;
}

/** Sent instead of `welcome` (or to a lower-term primary) when the receiver is not the primary to follow. */
export interface RedirectMsg extends WireMessage {
  t: "redirect";
  reason: string;
  term: number;
  primary: PeerAddress | null;
}

/** A guard holding new runs on a node: its resource guard (`memory`, `cpu`) or the settings' load guard (`load`). */
export type NodeHold = "memory" | "cpu" | "load";

/** replica → primary every NODE_STATUS_MS. */
export interface NodeStatusMsg extends WireMessage {
  t: "node.status";
  resources: NodeResources;
  slots: number;
  omp: NodeOmpInfo;
  replSeq: number;
  /** Process-tree totals and stdin progress of each run the node hosts. */
  runs: Record<string, { memoryBytes: number; cpuSeconds: number; inSeq: number }>;
  /**
   * Guards holding new runs on the node now (empty: none); `slots` is capped at its running runs
   * meanwhile. Absent from older nodes: the primary then checks their reported memory use itself.
   */
  holding?: NodeHold[];
}

/** primary → replicas on every membership change. */
export interface MembersMsg extends WireMessage {
  t: "members";
  term: number;
  members: MemberInfo[];
  preferredPrimaryId: string | null;
}

/** primary → replicas: the join token was rotated; store it (connected nodes stay in). */
export interface TokenMsg extends WireMessage {
  t: "token";
  token: string;
}

/**
 * Failback, interim primary → the returned preferred primary, once it has caught up: "take over
 * with `term`". The receiver promotes itself (promoteSelf with that term) and answers
 * `handover.ack` (same rid); then the sender demotes itself to a replica of it.
 */
export interface HandoverMsg extends WireMessage {
  t: "handover";
  term: number;
  /** The sender (the interim primary), which becomes a replica of the receiver. */
  from: PeerAddress;
}
export interface HandoverAckMsg extends WireMessage {
  t: "handover.ack";
  ok: boolean;
  error: string | null;
}

/** Failback waits until the returned preferred primary stayed connected and caught up this long. */
export const FAILBACK_STABLE_MS = 30_000;
/** During a failback the interim primary starts no new runs and waits this long for running ones to finish. */
export const FAILBACK_DRAIN_MS = 120_000;

/** primary → replica: an admin removed the node; it becomes standalone. */
export interface RemovedMsg extends WireMessage {
  t: "removed";
  reason: string;
}

/** probe channel: request and reply (any role answers). */
export interface ProbeMsg extends WireMessage {
  t: "probe";
}
export interface ProbeReplyMsg extends WireMessage {
  t: "probe.reply";
  nodeId: string;
  name: string;
  role: ClusterRole;
  term: number;
  /** The primary this node follows (or itself when primary); null when unknown. */
  primary: PeerAddress | null;
  /** A replica currently connected to its primary. */
  primaryReachable: boolean;
  replSeq: number;
}
/** probe channel: a freshly promoted primary tells the others to follow it. */
export interface AnnounceMsg extends WireMessage {
  t: "announce";
  term: number;
  primary: PeerAddress;
}

/** test channel: request and reply. */
export interface TestMsg extends WireMessage {
  t: "test";
}
export interface TestReplyMsg extends WireMessage {
  t: "test.reply";
  nodeId: string;
  name: string;
  role: ClusterRole;
  term: number;
  version: string;
}

// --- Auto-healing (primary → replica; docs/CLUSTER.md "Auto-healing") ---------------------------

/** A replica whose last node.status is older than this fails its health check (3 missed reports). */
export const HEAL_STATUS_STALE_MS = 3 * NODE_STATUS_MS;
/** A node healthy this long after a restart gets its restart count reset (and a pause lifted). */
export const HEAL_STABLE_MS = 10 * 60_000;
/** Longest wait between two restart attempts of one node. */
export const HEAL_BACKOFF_MAX_MS = 15 * 60_000;
/** Env var bin/supervisor.mjs sets on the server it (re)starts: why (unset on the first start). */
export const RESTART_REASON_ENV = "OMP_UI_RESTART_REASON";

/** primary → replica (member channel): health check; the node answers `heal.status` (same rid). */
export interface HealCheckMsg extends WireMessage {
  t: "heal.check";
}
export interface HealStatusMsg extends WireMessage {
  t: "heal.status";
  /** False when one of the node's own checks failed (`problem` says which). */
  ok: boolean;
  problem: string | null;
  /** When this server process started. */
  bootedAt: string;
  /** Runs under bin/supervisor.mjs (OMP_UI_SUPERVISED=1), so a restart brings it back. */
  supervised: boolean;
}

/**
 * primary → replica: restart your server process. Sent on the member channel while the node is
 * online, on a fresh `probe` channel while it is offline. The node answers `heal.ack` (same rid)
 * and, when `outcome` is "restarting", exits with RESTART_EXIT_CODE so bin/supervisor.mjs starts
 * it again. It obeys only as a replica, only the primary it follows (probe channel: the hello's
 * nodeId) at `term` >= its own term, and only when supervised.
 */
export interface HealRestartMsg extends WireMessage {
  t: "heal.restart";
  /** Why, for the node's log and notice. */
  reason: string;
  /** The sender's primary term. */
  term: number;
  /**
   * The process meant: its BootInfo.at as the node last reported it (register / heal.status), so
   * no clocks are compared across machines. A process that booted at another time (it already
   * restarted) answers "already"; null = whichever process runs.
   */
  bootedAt: string | null;
}
export interface HealAckMsg extends WireMessage {
  t: "heal.ack";
  /** restarting: exits now; already: this process is not the one `bootedAt` names; refused: see `error`. */
  outcome: "restarting" | "already" | "refused";
  error: string | null;
  bootedAt: string;
}

// --- Remote runs (primary ↔ replica) ------------------------------------------------------------

export type SyncKind = "tree" | "raw";

/**
 * A folder kept identical on both sides. `tree`: a project working tree (git-aware listing:
 * tracked + untracked-not-ignored files, plus the `.git` directory or pointer file; without git,
 * every file except well-known dependency/cache folders). `raw`: every file.
 */
export interface SyncFolderSpec {
  /** Unique within its sync scope. */
  id: string;
  primaryPath: string;
  nodePath: string;
  kind: SyncKind;
  /** Node → primary changes are applied (remote runs). Replication and the omp agent dir are down-only. */
  upstream: boolean;
}

/** primary → replica: start one run. Paths, args and env are already node paths. */
export interface RunStartMsg extends WireMessage {
  t: "run.start";
  runKey: string;
  taskId: string;
  args: string[];
  cwd: string;
  /** Added to the node's own child environment (AI provider keys, MCP secrets, PI_CODING_AGENT_DIR, …). */
  env: Record<string, string>;
  /** Small generated files (the run's omp config overlay) written before omp starts. */
  files: { path: string; content: string }[];
  /** Synced down (sync scope `run:<runKey>`) before omp starts; upstream ones are pushed back while it runs. */
  folders: SyncFolderSpec[];
  /** Binary the node must run (the primary's, by checksum); null = the node's local `omp`. */
  omp: { sha256: string; version: string } | null;
}
/** replica → primary: omp is running (or failed to start: `run.exit` with `error`). */
export interface RunStartedMsg extends WireMessage {
  t: "run.started";
  runKey: string;
  pid: number;
}
/** replica → primary: omp stdout (utf8, arbitrary chunk boundaries). `seq` counts from 1 per run. */
export interface RunOutMsg extends WireMessage {
  t: "run.out";
  runKey: string;
  seq: number;
  data: string;
}
export interface RunErrMsg extends WireMessage {
  t: "run.err";
  runKey: string;
  data: string;
}
/** primary → replica: omp stdin. `seq` counts from 1 per run. */
export interface RunInMsg extends WireMessage {
  t: "run.in";
  runKey: string;
  seq: number;
  data: string;
}
/** primary → replica: close omp's stdin (graceful shutdown). */
export interface RunEndMsg extends WireMessage {
  t: "run.end";
  runKey: string;
}
export interface RunSignalMsg extends WireMessage {
  t: "run.signal";
  runKey: string;
  signal: NodeJS.Signals;
}
/** replica → primary, after its final upstream sync: omp exited (or never started). */
export interface RunExitMsg extends WireMessage {
  t: "run.exit";
  runKey: string;
  code: number | null;
  signal: string | null;
  error: string | null;
  stderr: string;
}
/** primary → replica after a reconnect: replay stdout after `outSeq`, expect stdin after the node's `inSeq`. */
export interface RunResumeMsg extends WireMessage {
  t: "run.resume";
  runKey: string;
  outSeq: number;
}
/** primary → replica: a run the primary does not know (any more): kill it and forget it. */
export interface RunKillMsg extends WireMessage {
  t: "run.kill";
  runKey: string;
}
/** primary → replica: push the run's file changes now; the node answers `run.flushed` (same rid) once applied. */
export interface RunFlushMsg extends WireMessage {
  t: "run.flush";
  runKey: string;
}
export interface RunFlushedMsg extends WireMessage {
  t: "run.flushed";
  runKey: string;
}
