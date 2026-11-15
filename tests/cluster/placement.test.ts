import { describe, expect, it } from "vitest";

import {
  choosePlacement,
  computeCapacity,
  type CapacityNode,
  memoryUsedShare,
  placementScore,
  type PlacementCandidate,
  type PlacementInput,
  replicaAvailable,
  type ReplicaHealthInput,
} from "@/lib/cluster/placement";
import { HEAL_STATUS_STALE_MS } from "@/lib/cluster/types";

function local(slots: number, free = slots, loadPerCore = 0): PlacementCandidate {
  return { nodeId: "primary", nodeName: "primary", local: true, slots, free, loadPerCore, available: true };
}

function replica(nodeId: string, slots: number, free = slots, loadPerCore = 0): PlacementCandidate {
  return { nodeId, nodeName: nodeId, local: false, slots, free, loadPerCore, available: true };
}

function withMemory(candidate: PlacementCandidate, memoryUsed: number): PlacementCandidate {
  return { ...candidate, memoryUsed };
}

function unavailable(candidate: PlacementCandidate): PlacementCandidate {
  return { ...candidate, available: false };
}

/** Place `cards` runs one after the other, taking a slot on the chosen machine each time; the chosen nodeIds in order. */
function placeAll(input: PlacementInput, cards: number): string[] {
  const order: string[] = [];
  for (let i = 0; i < cards; i++) {
    const choice = choosePlacement(input);
    if (!choice) throw new Error(`no machine for card ${i + 1}`);
    choice.free--;
    order.push(choice.nodeId);
  }
  return order;
}

function countBy(order: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const nodeId of order) counts[nodeId] = (counts[nodeId] ?? 0) + 1;
  return counts;
}

describe("placementScore", () => {
  it("is the share of slots in use after taking the card plus the CPU pressure", () => {
    expect(placementScore(replica("a", 8, 6))).toBe(3 / 8);
    expect(placementScore(replica("a", 8, 6, 1))).toBe(3 / 8 + 0.5);
  });

  it("caps the CPU pressure at a load of 2 per core", () => {
    expect(placementScore(replica("a", 4, 4, 10))).toBe(placementScore(replica("a", 4, 4, 2)));
  });

  it("treats a machine without slots as one slot", () => {
    expect(placementScore(local(0, 0))).toBe(1);
  });

  it("ignores memory use up to half the machine", () => {
    const base = placementScore(replica("a", 8, 6, 1));
    expect(placementScore(withMemory(replica("a", 8, 6, 1), 0))).toBe(base);
    expect(placementScore(withMemory(replica("a", 8, 6, 1), 0.3))).toBe(base);
    expect(placementScore(withMemory(replica("a", 8, 6, 1), 0.5))).toBe(base);
  });

  it("adds memory pressure above half, up to half the slots when memory is full", () => {
    expect(placementScore(withMemory(replica("a", 8, 6), 0.75))).toBeCloseTo(3 / 8 + 0.25);
    expect(placementScore(withMemory(replica("a", 8, 6), 1))).toBeCloseTo(3 / 8 + 0.5);
    expect(placementScore(withMemory(replica("a", 8, 6), 1.5))).toBeCloseTo(3 / 8 + 0.5);
  });

  it("scores a candidate without memory use like one with no memory pressure", () => {
    const known = withMemory(replica("a", 8, 6, 1), 0.2);
    expect(placementScore(replica("a", 8, 6, 1))).toBe(placementScore(known));
    expect(placementScore({ ...replica("a", 8, 6, 1), memoryUsed: undefined })).toBe(3 / 8 + 0.5);
  });
});

describe("choosePlacement", () => {
  it("fills every replica's free slots before the primary takes a card", () => {
    const order = placeAll(
      {
        local: local(8),
        replicas: [replica("a", 4), replica("b", 2)],
        runLocal: true,
        preferNodeId: null,
        overflow: false,
      },
      8,
    );
    expect(countBy(order.slice(0, 6))).toEqual({ a: 4, b: 2 });
    expect(order.slice(6)).toEqual(["primary", "primary"]);
  });

  it("spreads cards over the replicas in proportion to their capacity", () => {
    const order = placeAll(
      {
        local: local(8),
        replicas: [replica("a", 16), replica("b", 4)],
        runLocal: true,
        preferNodeId: null,
        overflow: false,
      },
      10,
    );
    expect(countBy(order)).toEqual({ a: 8, b: 2 });
  });

  it("gives fewer cards to a replica under heavy CPU load", () => {
    const order = placeAll(
      {
        local: local(8),
        replicas: [replica("a", 8), replica("b", 8, 8, 0.5)],
        runLocal: true,
        preferNodeId: null,
        overflow: false,
      },
      8,
    );
    expect(countBy(order)).toEqual({ a: 5, b: 3 });
  });

  it("prefers the replica with less memory in use when slots and load are equal", () => {
    const choice = choosePlacement({
      local: local(8),
      replicas: [withMemory(replica("a", 8), 0.8), withMemory(replica("b", 8), 0.6)],
      runLocal: false,
      preferNodeId: "a",
      overflow: false,
    });
    expect(choice?.nodeId).toBe("b");
  });

  it("weighs memory pressure against busy slots", () => {
    // a: 1/8 + 0.5 × 0.45 / 0.5 = 0.575 against b: 2/8 = 0.25.
    const nearlyFull = choosePlacement({
      local: local(8),
      replicas: [withMemory(replica("a", 8, 8), 0.95), withMemory(replica("b", 8, 7), 0.3)],
      runLocal: false,
      preferNodeId: null,
      overflow: false,
    });
    expect(nearlyFull?.nodeId).toBe("b");

    // a: 1/4 + 0.5 × 0.2 / 0.5 = 0.45 against b: 2/4 = 0.5.
    const moderate = choosePlacement({
      local: local(8),
      replicas: [withMemory(replica("a", 4, 4), 0.7), withMemory(replica("b", 4, 3), 0.3)],
      runLocal: false,
      preferNodeId: null,
      overflow: false,
    });
    expect(moderate?.nodeId).toBe("a");
  });

  it("spreads cards as before when no replica reports its memory", () => {
    const unknown = placeAll(
      {
        local: local(8),
        replicas: [replica("a", 16), replica("b", 4)],
        runLocal: true,
        preferNodeId: null,
        overflow: false,
      },
      10,
    );
    const relaxed = placeAll(
      {
        local: local(8),
        replicas: [withMemory(replica("a", 16), 0.4), withMemory(replica("b", 4), 0.1)],
        runLocal: true,
        preferNodeId: null,
        overflow: false,
      },
      10,
    );
    expect(relaxed).toEqual(unknown);
    expect(countBy(unknown)).toEqual({ a: 8, b: 2 });
  });

  it("gives fewer cards to a replica short on memory", () => {
    const order = placeAll(
      {
        local: local(8),
        replicas: [replica("a", 8), withMemory(replica("b", 8), 0.75)],
        runLocal: false,
        preferNodeId: null,
        overflow: false,
      },
      8,
    );
    expect(countBy(order)).toEqual({ a: 5, b: 3 });
  });

  it("skips a replica without a free slot, even with a better score", () => {
    // a: 9/8 (full) against b: 4/4 + 0.5 × 2 = 2 (one free slot).
    const choice = choosePlacement({
      local: local(8),
      replicas: [replica("a", 8, 0), replica("b", 4, 1, 2)],
      runLocal: true,
      preferNodeId: "a",
      overflow: false,
    });
    expect(choice?.nodeId).toBe("b");
  });

  it("skips unavailable replicas even with free slots", () => {
    const otherReplica = choosePlacement({
      local: local(8),
      replicas: [unavailable(replica("a", 8)), replica("b", 4, 1, 2)],
      runLocal: true,
      preferNodeId: "a",
      overflow: false,
    });
    expect(otherReplica?.nodeId).toBe("b");

    const primary = choosePlacement({
      local: local(8),
      replicas: [unavailable(replica("a", 8))],
      runLocal: true,
      preferNodeId: "a",
      overflow: false,
    });
    expect(primary?.local).toBe(true);
  });

  it("takes the primary only when no available replica has a free slot", () => {
    const choice = choosePlacement({
      local: local(8, 1, 1),
      replicas: [replica("a", 4, 0), unavailable(replica("b", 8))],
      runLocal: true,
      preferNodeId: null,
      overflow: false,
    });
    expect(choice?.local).toBe(true);
  });

  it("never places on the primary when it does not run cards", () => {
    const withFreeSlot = choosePlacement({
      local: local(16),
      replicas: [replica("a", 4, 1, 1.5)],
      runLocal: false,
      preferNodeId: "primary",
      overflow: false,
    });
    expect(withFreeSlot?.nodeId).toBe("a");

    const full = { local: local(16), replicas: [replica("a", 4, 0)], runLocal: false, preferNodeId: null };
    expect(choosePlacement({ ...full, overflow: false })).toBeNull();
    expect(choosePlacement({ ...full, overflow: true })?.nodeId).toBe("a");

    const noReplica = { local: local(16), replicas: [], runLocal: false, preferNodeId: null };
    expect(choosePlacement({ ...noReplica, overflow: false })).toBeNull();
    expect(choosePlacement({ ...noReplica, overflow: true })).toBeNull();
  });

  it("prefers the card's previous node only on a tie between replicas", () => {
    const idleOther = choosePlacement({
      local: local(8, 0),
      replicas: [replica("a", 8, 4), replica("b", 8)],
      runLocal: true,
      preferNodeId: "a",
      overflow: false,
    });
    expect(idleOther?.nodeId).toBe("b");

    const tiedReplicas = choosePlacement({
      local: local(8),
      replicas: [replica("a", 8), replica("b", 8)],
      runLocal: true,
      preferNodeId: "b",
      overflow: false,
    });
    expect(tiedReplicas?.nodeId).toBe("b");
  });

  it("breaks ties between replicas deterministically: more free slots, then nodeId", () => {
    // 2 of 4 and 4 of 8 slots in use after the card: same score, b has more free slots.
    const moreFree = choosePlacement({
      local: local(0),
      replicas: [replica("a", 4, 3), replica("b", 8, 5)],
      runLocal: false,
      preferNodeId: null,
      overflow: false,
    });
    expect(moreFree?.nodeId).toBe("b");

    const byNodeId = choosePlacement({
      local: local(0),
      replicas: [replica("c", 4), replica("a", 4), replica("b", 4)],
      runLocal: false,
      preferNodeId: null,
      overflow: false,
    });
    expect(byNodeId?.nodeId).toBe("a");
  });

  describe("no free slot anywhere", () => {
    // Scores: primary 9/8, a 5/4, b 2.
    const full = { local: local(8, 0), replicas: [replica("a", 4, 0), replica("b", 2, -1)], preferNodeId: null };

    it("is null without a lent slot, even though the primary is available and runs cards", () => {
      // The pump counted a free slot that the machines do not show yet (a remote run's transport still closing).
      expect(choosePlacement({ ...full, runLocal: true, overflow: false })).toBeNull();
      expect(choosePlacement({ ...full, runLocal: false, overflow: false })).toBeNull();

      const busyPrimary = choosePlacement({
        local: local(4, -2),
        replicas: [replica("a", 8, 0)],
        runLocal: true,
        preferNodeId: null,
        overflow: false,
      });
      expect(busyPrimary).toBeNull();
    });

    it("runs a lent slot on the primary when it runs cards and is available", () => {
      expect(choosePlacement({ ...full, runLocal: true, overflow: true })?.local).toBe(true);

      // Even when a replica scores better and the primary is already over its limit.
      const busyPrimary = choosePlacement({
        local: local(4, -2),
        replicas: [replica("a", 8, 0)],
        runLocal: true,
        preferNodeId: null,
        overflow: true,
      });
      expect(busyPrimary?.local).toBe(true);
    });

    it("runs a lent slot on the best available replica when the primary does not run cards", () => {
      expect(choosePlacement({ ...full, runLocal: false, overflow: true })?.nodeId).toBe("a");
    });

    it("runs a lent slot on the best available replica when the primary is unavailable", () => {
      const unavailablePrimary = { ...full, local: unavailable(local(8, 0)), runLocal: true };
      expect(choosePlacement({ ...unavailablePrimary, overflow: true })?.nodeId).toBe("a");

      const otherReplica = choosePlacement({
        local: unavailable(local(8, 0)),
        replicas: [unavailable(replica("a", 4, 0)), replica("b", 2, -1)],
        runLocal: true,
        preferNodeId: "a",
        overflow: true,
      });
      expect(otherReplica?.nodeId).toBe("b");
    });

    it("is null for a lent slot when no machine is available", () => {
      const choice = choosePlacement({
        local: unavailable(local(8, 0)),
        replicas: [unavailable(replica("a", 4, 0))],
        runLocal: true,
        preferNodeId: null,
        overflow: true,
      });
      expect(choice).toBeNull();
    });
  });

  it("is null when no machine can safely take the card", () => {
    for (const overflow of [false, true]) {
      const unavailablePrimary = choosePlacement({
        local: unavailable(local(8)),
        replicas: [unavailable(replica("a", 8))],
        runLocal: true,
        preferNodeId: null,
        overflow,
      });
      expect(unavailablePrimary).toBeNull();

      const noReplica = { local: unavailable(local(8)), replicas: [], runLocal: true, preferNodeId: null, overflow };
      expect(choosePlacement(noReplica)).toBeNull();
      const noSlots = { local: local(0, 0), replicas: [], runLocal: false, preferNodeId: null, overflow };
      expect(choosePlacement(noSlots)).toBeNull();
    }
  });
});

describe("replicaAvailable", () => {
  const healthy: ReplicaHealthInput = {
    statusAgeMs: 1_000,
    health: { state: "ok", failures: 0 },
    holding: [],
    memoryUsed: 0.2,
    memoryHoldPct: 90,
  };

  it("is true for a fresh, healthy replica", () => {
    expect(replicaAvailable(healthy)).toBe(true);
    expect(replicaAvailable({ ...healthy, health: null })).toBe(true);
  });

  it("is false once its status is stale", () => {
    expect(replicaAvailable({ ...healthy, statusAgeMs: HEAL_STATUS_STALE_MS })).toBe(true);
    expect(replicaAvailable({ ...healthy, statusAgeMs: HEAL_STATUS_STALE_MS + 1 })).toBe(false);
  });

  it("is false while its health checks fail or it restarts", () => {
    expect(replicaAvailable({ ...healthy, health: { state: "ok", failures: 1 } })).toBe(false);
    expect(replicaAvailable({ ...healthy, health: { state: "failing", failures: 0 } })).toBe(false);
    expect(replicaAvailable({ ...healthy, health: { state: "restarting", failures: 0 } })).toBe(false);
  });

  it("is true with auto-healing off or paused and no failed check", () => {
    expect(replicaAvailable({ ...healthy, health: { state: "off", failures: 0 } })).toBe(true);
    expect(replicaAvailable({ ...healthy, health: { state: "paused", failures: 0 } })).toBe(true);
  });

  it("follows the guards the replica reports", () => {
    expect(replicaAvailable({ ...healthy, holding: ["memory"] })).toBe(false);
    expect(replicaAvailable({ ...healthy, holding: ["load"] })).toBe(false);
    // The replica's own guard wins over the primary's memory hold %.
    expect(replicaAvailable({ ...healthy, holding: [], memoryUsed: 0.99 })).toBe(true);
  });

  it("applies the primary's memory hold % to a replica that does not report its guards", () => {
    expect(replicaAvailable({ ...healthy, holding: null, memoryUsed: 0.95 })).toBe(false);
    expect(replicaAvailable({ ...healthy, holding: null, memoryUsed: 0.5, memoryHoldPct: 50 })).toBe(false);
    expect(replicaAvailable({ ...healthy, holding: null, memoryUsed: 0.85 })).toBe(true);
    expect(replicaAvailable({ ...healthy, holding: null, memoryUsed: 1, memoryHoldPct: 0 })).toBe(true);
  });
});

describe("computeCapacity", () => {
  function node(slots: number, extra: Partial<CapacityNode> = {}): CapacityNode {
    return { online: true, ompReady: true, slots, available: true, occupied: 0, ...extra };
  }

  it("sums the local limit and the slots of online, omp-ready replicas only", () => {
    const capacity = computeCapacity(4, true, [
      node(3),
      node(8, { online: false }),
      node(5, { ompReady: false }),
      node(2),
    ]);
    expect(capacity).toEqual({ limit: 9, info: { localLimit: 4, nodes: 2, remoteSlots: 5 } });
  });

  it("counts only the occupied slots of a replica that takes no new runs", () => {
    const capacity = computeCapacity(4, true, [
      node(3),
      node(6, { available: false, occupied: 2 }),
      node(8, { available: false, occupied: 3, online: false }),
      node(5, { available: false, occupied: 1, ompReady: false }),
    ]);
    expect(capacity).toEqual({ limit: 9, info: { localLimit: 4, nodes: 1, remoteSlots: 3 } });
  });

  it("does not count the local limit when the primary does not run cards", () => {
    const capacity = computeCapacity(4, false, [node(3)]);
    expect(capacity).toEqual({ limit: 3, info: { localLimit: 0, nodes: 1, remoteSlots: 3 } });
  });

  it("is the local limit alone without replicas", () => {
    expect(computeCapacity(6, true, []).limit).toBe(6);
    expect(computeCapacity(6, false, []).limit).toBe(0);
  });
});

describe("memoryUsedShare", () => {
  it("is the share of memory not free", () => {
    expect(memoryUsedShare(4 * 1024 ** 3, 16 * 1024 ** 3)).toBe(0.75);
    expect(memoryUsedShare(16 * 1024 ** 3, 16 * 1024 ** 3)).toBe(0);
  });

  it("is 0 when the total is unknown", () => {
    expect(memoryUsedShare(0, 0)).toBe(0);
    expect(memoryUsedShare(1024, Number.NaN)).toBe(0);
  });

  it("stays within 0 and 1 for inconsistent samples", () => {
    expect(memoryUsedShare(32, 16)).toBe(0);
    expect(memoryUsedShare(-1, 16)).toBe(1);
  });
});
