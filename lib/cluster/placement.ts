// Where the primary runs the next card and how many cards the cluster runs at once. Pure rules
// over candidate lists; lib/cluster/primary.ts gathers the candidates from its member registry.
// Cards are spread over every machine in proportion to its capacity (see placementScore), so a
// busy board uses all the cluster's resources instead of piling onto one machine.
import type { ConcurrencyInfo } from "@/lib/types";

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
}

/** Weight of the CPU-pressure term: a load of 1 per core counts as half a machine's slots. */
const CPU_WEIGHT = 0.5;
/** Load per core beyond which a machine is not penalised further (it still gets cards when others are fuller). */
const MAX_LOAD_PER_CORE = 2;
/** Scores closer than this are a tie. */
const SCORE_EPSILON = 1e-9;

/**
 * How busy a machine would be after taking the next run (lower is better): the share of its
 * slots in use once it takes this card, `(slots − free + 1) / max(slots, 1)`, plus a CPU-pressure
 * term `0.5 × min(loadPerCore, 2)`. Using the share rather than free slots makes machines fill in
 * proportion to their capacity: a 16-slot machine takes four cards for every one of a 4-slot one.
 */
export function placementScore(c: PlacementCandidate): number {
  return (c.slots - c.free + 1) / Math.max(c.slots, 1) + CPU_WEIGHT * Math.min(c.loadPerCore, MAX_LOAD_PER_CORE);
}

/**
 * The machine for the next run: the lowest {@link placementScore} among the machines with a free
 * slot, over the primary and the replicas when the primary runs cards, else the replicas only.
 * Ties go to the card's previous node (its files and session are warm there), then the primary,
 * then the machine with more free slots, then the lowest nodeId. When nobody has a free slot (a
 * slot lent by board_wait_for_cards) the run goes to the lowest score of that same pool; with an
 * empty pool (no replica, primary not running cards), to the primary.
 */
export function choosePlacement(input: PlacementInput): PlacementCandidate {
  const pool = input.runLocal ? [input.local, ...input.replicas] : input.replicas;
  const open = pool.filter((c) => c.free > 0);
  const candidates = open.length > 0 ? open : pool;
  if (candidates.length === 0) return input.local;
  return candidates.reduce((a, b) => better(a, b, input.preferNodeId));
}

/** The higher-ranked of two candidates: lower score, then previous node, primary, more free slots, lower nodeId. */
function better(a: PlacementCandidate, b: PlacementCandidate, preferNodeId: string | null): PlacementCandidate {
  const scoreA = placementScore(a);
  const scoreB = placementScore(b);
  if (Math.abs(scoreA - scoreB) >= SCORE_EPSILON) return scoreA < scoreB ? a : b;
  const preferA = a.nodeId === preferNodeId;
  if (preferA !== (b.nodeId === preferNodeId)) return preferA ? a : b;
  if (a.local !== b.local) return a.local ? a : b;
  if (a.free !== b.free) return a.free > b.free ? a : b;
  return a.nodeId <= b.nodeId ? a : b;
}

/** What capacity needs to know about a replica. */
export interface CapacityNode {
  online: boolean;
  /** omp can start on it. */
  ompReady: boolean;
  /** Runs it allows at once (its own automatic or manual limit). */
  slots: number;
}

/**
 * Runs the cluster allows at once: the primary's own limit (when it runs cards) plus the slots
 * of every online replica that can run omp.
 */
export function computeCapacity(
  localLimit: number,
  runLocal: boolean,
  replicas: CapacityNode[],
): { limit: number; info: NonNullable<ConcurrencyInfo["cluster"]> } {
  const usable = replicas.filter((n) => n.online && n.ompReady);
  const remoteSlots = usable.reduce((sum, n) => sum + Math.max(0, n.slots), 0);
  const local = runLocal ? Math.max(0, localLimit) : 0;
  return { limit: local + remoteSlots, info: { localLimit: local, nodes: usable.length, remoteSlots } };
}
