// Failover election of cluster mode (pure): which replica takes over when the primary is gone.
// The replica with the most replicated state wins (ties: the oldest member, then the lowest id),
// and nobody promotes itself while a reachable primary of the same or a newer term exists.
import type { PeerAddress } from "@/lib/cluster/types";

/** A replica taking part in an election. */
export interface Candidate {
  nodeId: string;
  /** Sequence number of the last replicated state the node applied. */
  replSeq: number;
  /** When the node joined the cluster (ISO 8601). */
  joinedAt: string;
}

/** What a replica does after a probe round. `wait.leader` is the node id expected to promote itself. */
export type ElectionDecision =
  | { action: "follow"; primary: PeerAddress }
  | { action: "promote" }
  | { action: "wait"; leader: string };

/** Unparsable join times rank last among equal replication progress. */
function joinedTime(candidate: Candidate): number {
  const time = Date.parse(candidate.joinedAt);
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.replSeq !== b.replSeq) return b.replSeq - a.replSeq;
  const joined = joinedTime(a) - joinedTime(b);
  if (joined !== 0 && !Number.isNaN(joined)) return joined;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

/** Best candidate first: replSeq descending, then joinedAt ascending, then nodeId ascending. */
export function rankCandidates(c: Candidate[]): Candidate[] {
  return [...c].sort(compareCandidates);
}

/**
 * The outcome of one election round. `alive` are the replicas that answered the probes (self is
 * added when missing); `primaryFound` a reachable primary some probe reported, of term
 * `primaryTerm`: it is followed unless its term is lower than ours (fencing).
 */
export function decideElection(input: {
  self: Candidate;
  alive: Candidate[];
  primaryFound: PeerAddress | null;
  primaryTerm: number;
  selfTerm: number;
}): ElectionDecision {
  const { self, alive, primaryFound, primaryTerm, selfTerm } = input;
  if (primaryFound && primaryFound.nodeId !== self.nodeId && primaryTerm >= selfTerm) {
    return { action: "follow", primary: primaryFound };
  }
  const others = alive.filter((candidate) => candidate.nodeId !== self.nodeId);
  const [leader] = rankCandidates([self, ...others]);
  return leader.nodeId === self.nodeId ? { action: "promote" } : { action: "wait", leader: leader.nodeId };
}
