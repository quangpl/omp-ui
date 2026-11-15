// Where the primary runs the next card and how many cards the cluster runs at once. Pure rules
// over candidate lists; lib/cluster/primary.ts gathers the candidates from its member registry.
// Replicas come first: a card goes to an available replica with a free slot, spread over the
// replicas in proportion to their capacity (see placementScore), with CPU load and memory use
// steering cards away from replicas short on headroom. The primary takes a card only when no
// available replica has a free slot. An unavailable node (stale status, failing health checks,
// restarting, or held by a memory/CPU/load guard) gets no card. A node without a free slot gets a
// card only to fill a slot lent by board_wait_for_cards; otherwise, or when no node can safely take
// one, the card stays queued.
import { HEAL_STATUS_STALE_MS, type NodeHold } from "@/lib/cluster/types";
import type { ClusterNodeHealth, ConcurrencyInfo } from "@/lib/types";

/** A machine that could take the next run. */
export interface PlacementCandidate {
  nodeId: string;
  nodeName: string;
  /** The primary itself (the run is spawned locally). */
  local: boolean;
  /** Runs it allows at once (its agent limit). */
  slots: number;
  /** Runs it can still start: its slots minus running and reserved runs (≤ 0 when full). */
  free: number;
  /** 1-minute load average per core (0 when unknown); weighs on its score. */
  loadPerCore: number;
  /** Share (0–1) of its memory in use (0/undefined when unknown); above half it weighs on its score. */
  memoryUsed?: number;
  /**
   * Can take new runs: a replica when {@link replicaAvailable}, the primary when no resource or
   * load guard holds it. An unavailable candidate gets no run, not even an overflow one.
   */
  available: boolean;
}

export interface PlacementInput {
  /** The primary's own candidate; `slots` = its local limit, `free` = that limit minus its active runs. */
  local: PlacementCandidate;
  /** Online replicas that can run omp. */
  replicas: PlacementCandidate[];
  /** `AppSettings.clusterRunLocal`: the primary runs cards too. */
  runLocal: boolean;
  /** Node of the card's previous run (its files and session are warm there); breaks score ties only. */
  preferNodeId: string | null;
  /**
   * The run fills a slot lent by board_wait_for_cards (the pump's active runs already reach its
   * limit), so it may go to a machine without a free slot. False otherwise: a machine count that
   * disagrees with the pump's (a remote run's transport still closing) then leaves the card queued.
   */
  overflow: boolean;
}

/** Weight of the CPU-pressure term: a load of 1 per core counts as half a machine's slots. */
const CPU_WEIGHT = 0.5;
/** Load per core beyond which a machine is not penalised further (it still gets cards when others are fuller). */
const MAX_LOAD_PER_CORE = 2;
/** Scores closer than this are a tie. */
const SCORE_EPSILON = 1e-9;
/** Weight of the memory-pressure term: a machine with all its memory in use counts as half its slots. */
const MEMORY_WEIGHT = 0.5;
/** Share of memory in use that is never penalised (page cache and idle services fill it anyway). */
const MEMORY_FREE_SHARE = 0.5;

/**
 * How busy a machine would be after taking the next run (lower is better): the share of its
 * slots in use once it takes this card, `(slots − free + 1) / max(slots, 1)`, plus a CPU-pressure
 * term `0.5 × min(loadPerCore, 2)`, plus a memory-pressure term
 * `0.5 × clamp01(memoryUsed − 0.5) / (1 − 0.5)` (nothing below half the memory in use; a full
 * machine costs as much as half its slots). Using the share rather than free slots makes machines
 * fill in proportion to their capacity: a 16-slot machine takes four cards for every one of a
 * 4-slot one.
 */
export function placementScore(c: PlacementCandidate): number {
  const slotShare = (c.slots - c.free + 1) / Math.max(c.slots, 1);
  const cpu = CPU_WEIGHT * Math.min(c.loadPerCore, MAX_LOAD_PER_CORE);
  return slotShare + cpu + memoryPressure(c.memoryUsed);
}

/** The memory term of {@link placementScore}: 0 up to MEMORY_FREE_SHARE in use, rising to MEMORY_WEIGHT when full. */
function memoryPressure(memoryUsed: number | undefined): number {
  if (!memoryUsed || !Number.isFinite(memoryUsed)) return 0;
  const over = Math.max(0, Math.min(1, memoryUsed) - MEMORY_FREE_SHARE);
  return (MEMORY_WEIGHT * over) / (1 - MEMORY_FREE_SHARE);
}

/** Share (0–1) of a machine's memory in use from its free and total bytes; 0 when the total is unknown. */
export function memoryUsedShare(freeMemoryBytes: number, totalMemoryBytes: number): number {
  if (!(totalMemoryBytes > 0) || !Number.isFinite(freeMemoryBytes)) return 0;
  return Math.min(1, Math.max(0, 1 - freeMemoryBytes / totalMemoryBytes));
}

/**
 * The machine for the next run, replica first; null when no machine can safely take it (the card
 * stays queued until a slot frees):
 * 1. the best available replica with a free slot;
 * 2. else the primary, when it runs cards, is available and has a free slot or `overflow` is set;
 * 3. else, when `overflow` is set, the best available replica even without a free slot;
 * 4. else null.
 * The best replica has the lowest {@link placementScore}; ties go to the card's previous node (its
 * files and session are warm there), then the replica with more free slots, then the lowest nodeId.
 */
export function choosePlacement(input: PlacementInput): PlacementCandidate | null {
  const replicas = input.replicas.filter((c) => c.available);
  const open = replicas.filter((c) => c.free > 0);
  if (open.length > 0) return open.reduce((a, b) => better(a, b, input.preferNodeId));
  // A lent slot goes to the primary before a full replica.
  if (input.runLocal && input.local.available && (input.local.free > 0 || input.overflow)) return input.local;
  if (!input.overflow || replicas.length === 0) return null;
  return replicas.reduce((a, b) => better(a, b, input.preferNodeId));
}

/** The higher-ranked of two candidates: lower score, then previous node, more free slots, lower nodeId. */
function better(a: PlacementCandidate, b: PlacementCandidate, preferNodeId: string | null): PlacementCandidate {
  const scoreA = placementScore(a);
  const scoreB = placementScore(b);
  if (Math.abs(scoreA - scoreB) >= SCORE_EPSILON) return scoreA < scoreB ? a : b;
  const preferA = a.nodeId === preferNodeId;
  if (preferA !== (b.nodeId === preferNodeId)) return preferA ? a : b;
  if (a.free !== b.free) return a.free > b.free ? a : b;
  return a.nodeId <= b.nodeId ? a : b;
}

/** What the primary knows about a replica's health and guards. */
export interface ReplicaHealthInput {
  /** ms since its last node.status (or registration). */
  statusAgeMs: number;
  /** Auto-healing view (HealMonitor.health); null when the node is not health-checked. */
  health: Pick<ClusterNodeHealth, "state" | "failures"> | null;
  /**
   * Guards the node reports holding (NodeStatusMsg.holding); null when it does not report them
   * (older node, no status yet).
   */
  holding: readonly NodeHold[] | null;
  /** Share (0–1) of its memory in use from its last report (0 when unknown). */
  memoryUsed: number;
  /** The primary's own memory hold % (0 = off); applied only when `holding` is null. */
  memoryHoldPct: number;
}

/**
 * Whether a replica may take new runs. Not when its status is stale (3 missed reports), its
 * health checks fail or it is restarting. A node that reports its guards decides for itself: it
 * may take runs when none holds it. An older node that does not report them is held by the
 * primary's memory hold % applied to its reported memory use. Auto-healing turned off or paused
 * with no failed check counts as healthy.
 */
export function replicaAvailable(input: ReplicaHealthInput): boolean {
  if (input.statusAgeMs > HEAL_STATUS_STALE_MS) return false;
  const health = input.health;
  if (health && (health.failures > 0 || health.state === "failing" || health.state === "restarting")) return false;
  if (input.holding !== null) return input.holding.length === 0;
  return !(input.memoryHoldPct > 0 && input.memoryUsed * 100 >= input.memoryHoldPct);
}

/** What capacity needs to know about a replica. */
export interface CapacityNode {
  online: boolean;
  /** omp can start on it. */
  ompReady: boolean;
  /** Runs it allows at once (its own automatic or manual limit). */
  slots: number;
  /** Takes new runs ({@link replicaAvailable}). */
  available: boolean;
  /** Runs on it now plus placements reserved for it. */
  occupied: number;
}

/**
 * Runs the cluster allows at once: the primary's own limit (when it runs cards) plus the slots
 * of every online replica that can run omp and takes new runs (`info.nodes`, `info.remoteSlots`).
 * An online, omp-ready replica that takes no new runs adds only its occupied slots: those runs
 * still count among the manager's active runs, and no new card should be counted against it.
 */
export function computeCapacity(
  localLimit: number,
  runLocal: boolean,
  replicas: CapacityNode[],
): { limit: number; info: NonNullable<ConcurrencyInfo["cluster"]> } {
  const usable = replicas.filter((n) => n.online && n.ompReady);
  const open = usable.filter((n) => n.available);
  const remoteSlots = open.reduce((sum, n) => sum + Math.max(0, n.slots), 0);
  const occupied = usable.reduce((sum, n) => sum + (n.available ? 0 : Math.max(0, n.occupied)), 0);
  const local = runLocal ? Math.max(0, localLimit) : 0;
  return { limit: local + remoteSlots + occupied, info: { localLimit: local, nodes: open.length, remoteSlots } };
}
