// Where the primary runs the next card and how many cards the cluster runs at once. Pure rules
// over candidate lists; lib/cluster/primary.ts gathers the candidates from its member registry.
import type { ConcurrencyInfo } from "@/lib/types";

/** A machine that could take the next run. */
export interface PlacementCandidate {
  nodeId: string;
  nodeName: string;
  /** The primary itself (the run is spawned locally). */
  local: boolean;
  /** Runs it can still start: its slots minus running and reserved runs (≤ 0 when full). */
  free: number;
  /** 1-minute load average per core (0 when unknown); the lighter machine wins a tie. */
  loadPerCore: number;
}

export interface PlacementInput {
  /** The primary's own candidate; `free` = its local limit minus its active runs. */
  local: PlacementCandidate;
  /** Online replicas that can run omp. */
  replicas: PlacementCandidate[];
  /** `AppSettings.clusterRunLocal`: the primary runs cards too. */
  runLocal: boolean;
  /** Node of the card's previous run (its files and session are warm there). */
  preferNodeId: string | null;
}

/**
 * The machine for the next run: the preferred node while it has a free slot, else the one with
 * the most free slots (ties: the primary, then the lowest load per core). When nobody has a free
 * slot (a slot lent by board_wait_for_cards) the run goes to the primary when it runs cards,
 * else to the replica with the most free slots; with no replica at all, to the primary.
 */
export function choosePlacement(input: PlacementInput): PlacementCandidate {
  const pool = input.runLocal ? [input.local, ...input.replicas] : input.replicas;
  const preferred = pool.find((c) => c.nodeId === input.preferNodeId && c.free > 0);
  if (preferred) return preferred;
  const open = pool.filter((c) => c.free > 0);
  if (open.length > 0) return open.reduce(better);
  if (input.runLocal || input.replicas.length === 0) return input.local;
  return input.replicas.reduce(better);
}

/** The higher-ranked of two candidates: more free slots, then local, then lighter load. */
function better(a: PlacementCandidate, b: PlacementCandidate): PlacementCandidate {
  if (a.free !== b.free) return a.free > b.free ? a : b;
  if (a.local !== b.local) return a.local ? a : b;
  return b.loadPerCore < a.loadPerCore ? b : a;
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
