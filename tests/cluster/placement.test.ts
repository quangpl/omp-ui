import { describe, expect, it } from "vitest";

import {
  choosePlacement,
  computeCapacity,
  placementScore,
  type PlacementCandidate,
  type PlacementInput,
} from "@/lib/cluster/placement";

function local(slots: number, free = slots, loadPerCore = 0): PlacementCandidate {
  return { nodeId: "primary", nodeName: "primary", local: true, slots, free, loadPerCore };
}

function replica(nodeId: string, slots: number, free = slots, loadPerCore = 0): PlacementCandidate {
  return { nodeId, nodeName: nodeId, local: false, slots, free, loadPerCore };
}

/** Place `cards` runs one after the other, taking a slot on the chosen machine each time; the chosen nodeIds in order. */
function placeAll(input: PlacementInput, cards: number): string[] {
  const order: string[] = [];
  for (let i = 0; i < cards; i++) {
    const choice = choosePlacement(input);
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
});

describe("choosePlacement", () => {
  it("alternates between two equal machines", () => {
    const order = placeAll({ local: local(8), replicas: [replica("a", 8)], runLocal: true, preferNodeId: null }, 6);
    expect(order).toEqual(["primary", "a", "primary", "a", "primary", "a"]);
  });

  it("fills machines in proportion to their capacity", () => {
    const order = placeAll({ local: local(16), replicas: [replica("a", 4)], runLocal: true, preferNodeId: null }, 10);
    expect(countBy(order)).toEqual({ primary: 8, a: 2 });
  });

  it("gives fewer cards to a machine under heavy CPU load", () => {
    const order = placeAll(
      { local: local(8), replicas: [replica("a", 8), replica("b", 8, 8, 0.5)], runLocal: false, preferNodeId: null },
      8,
    );
    expect(countBy(order)).toEqual({ a: 5, b: 3 });
  });

  it("prefers the card's previous node only on a tie", () => {
    const idleOther = choosePlacement({
      local: local(8, 0),
      replicas: [replica("a", 8, 4), replica("b", 8)],
      runLocal: true,
      preferNodeId: "a",
    });
    expect(idleOther.nodeId).toBe("b");

    const tiedReplicas = choosePlacement({
      local: local(8),
      replicas: [replica("a", 8), replica("b", 8)],
      runLocal: false,
      preferNodeId: "b",
    });
    expect(tiedReplicas.nodeId).toBe("b");

    const tiedWithPrimary = choosePlacement({
      local: local(8),
      replicas: [replica("a", 8)],
      runLocal: true,
      preferNodeId: "a",
    });
    expect(tiedWithPrimary.nodeId).toBe("a");
  });

  it("never places on the primary when it does not run cards and replicas exist", () => {
    const choice = choosePlacement({
      local: local(16),
      replicas: [replica("a", 4, 1, 1.5)],
      runLocal: false,
      preferNodeId: "primary",
    });
    expect(choice.nodeId).toBe("a");
  });

  it("breaks ties deterministically: primary, then more free slots, then nodeId", () => {
    const withPrimary = choosePlacement({
      local: local(4),
      replicas: [replica("a", 4)],
      runLocal: true,
      preferNodeId: null,
    });
    expect(withPrimary.local).toBe(true);

    // 2 of 4 and 4 of 8 slots in use after the card: same score, b has more free slots.
    const moreFree = choosePlacement({
      local: local(0),
      replicas: [replica("a", 4, 3), replica("b", 8, 5)],
      runLocal: false,
      preferNodeId: null,
    });
    expect(moreFree.nodeId).toBe("b");

    const byNodeId = choosePlacement({
      local: local(0),
      replicas: [replica("c", 4), replica("a", 4), replica("b", 4)],
      runLocal: false,
      preferNodeId: null,
    });
    expect(byNodeId.nodeId).toBe("a");
  });

  describe("lent slot (nobody has a free slot)", () => {
    // Scores: primary 9/8, a 5/4, b 2.
    const full = { local: local(8, 0), replicas: [replica("a", 4, 0), replica("b", 2, -1)], preferNodeId: null };

    it("runs on the least-loaded machine of the pool", () => {
      expect(choosePlacement({ ...full, runLocal: true }).local).toBe(true);

      const replicaWins = choosePlacement({
        local: local(4, 0),
        replicas: [replica("a", 4, -1), replica("b", 8, 0)],
        runLocal: true,
        preferNodeId: null,
      });
      expect(replicaWins.nodeId).toBe("b");
    });

    it("runs on the least-loaded replica when the primary does not run cards", () => {
      expect(choosePlacement({ ...full, runLocal: false }).nodeId).toBe("a");
    });

    it("falls back to the primary when the pool is empty", () => {
      const choice = choosePlacement({ local: local(0, 0), replicas: [], runLocal: false, preferNodeId: null });
      expect(choice.local).toBe(true);
    });
  });
});

describe("computeCapacity", () => {
  it("sums the local limit and the slots of online, omp-ready replicas only", () => {
    const capacity = computeCapacity(4, true, [
      { online: true, ompReady: true, slots: 3 },
      { online: false, ompReady: true, slots: 8 },
      { online: true, ompReady: false, slots: 5 },
      { online: true, ompReady: true, slots: 2 },
    ]);
    expect(capacity).toEqual({ limit: 9, info: { localLimit: 4, nodes: 2, remoteSlots: 5 } });
  });

  it("does not count the local limit when the primary does not run cards", () => {
    const capacity = computeCapacity(4, false, [{ online: true, ompReady: true, slots: 3 }]);
    expect(capacity).toEqual({ limit: 3, info: { localLimit: 0, nodes: 1, remoteSlots: 3 } });
  });

  it("is the local limit alone without replicas", () => {
    expect(computeCapacity(6, true, []).limit).toBe(6);
    expect(computeCapacity(6, false, []).limit).toBe(0);
  });
});
