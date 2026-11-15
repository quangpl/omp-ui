import { describe, expect, it } from "vitest";

import { choosePlacement, computeCapacity, type PlacementCandidate } from "@/lib/cluster/placement";

function local(free: number, loadPerCore = 0): PlacementCandidate {
  return { nodeId: "primary", nodeName: "primary", local: true, free, loadPerCore };
}

function replica(nodeId: string, free: number, loadPerCore = 0): PlacementCandidate {
  return { nodeId, nodeName: nodeId, local: false, free, loadPerCore };
}

describe("choosePlacement", () => {
  it("prefers the card's previous node while it has a free slot", () => {
    const choice = choosePlacement({
      local: local(4),
      replicas: [replica("a", 1), replica("b", 3)],
      runLocal: true,
      preferNodeId: "a",
    });
    expect(choice.nodeId).toBe("a");
  });

  it("ignores the preferred node when it is full", () => {
    const choice = choosePlacement({
      local: local(1),
      replicas: [replica("a", 0), replica("b", 3)],
      runLocal: true,
      preferNodeId: "a",
    });
    expect(choice.nodeId).toBe("b");
  });

  it("can prefer the primary itself", () => {
    const choice = choosePlacement({
      local: local(1),
      replicas: [replica("a", 5)],
      runLocal: true,
      preferNodeId: "primary",
    });
    expect(choice.local).toBe(true);
  });

  it("picks the machine with the most free slots", () => {
    const choice = choosePlacement({
      local: local(1),
      replicas: [replica("a", 2), replica("b", 4), replica("c", 3)],
      runLocal: true,
      preferNodeId: null,
    });
    expect(choice.nodeId).toBe("b");
  });

  it("breaks ties in favour of the primary, then the lowest load per core", () => {
    const tiedWithLocal = choosePlacement({
      local: local(2, 0.9),
      replicas: [replica("a", 2, 0.1)],
      runLocal: true,
      preferNodeId: null,
    });
    expect(tiedWithLocal.local).toBe(true);

    const tiedReplicas = choosePlacement({
      local: local(0),
      replicas: [replica("a", 2, 0.8), replica("b", 2, 0.2), replica("c", 2, 0.5)],
      runLocal: true,
      preferNodeId: null,
    });
    expect(tiedReplicas.nodeId).toBe("b");
  });

  it("never places on the primary by preference when it does not run cards", () => {
    const choice = choosePlacement({
      local: local(8),
      replicas: [replica("a", 1)],
      runLocal: false,
      preferNodeId: "primary",
    });
    expect(choice.nodeId).toBe("a");
  });

  describe("lent slot (nobody has a free slot)", () => {
    it("runs on the primary when it runs cards", () => {
      const choice = choosePlacement({
        local: local(0),
        replicas: [replica("a", 0), replica("b", -1)],
        runLocal: true,
        preferNodeId: "a",
      });
      expect(choice.local).toBe(true);
    });

    it("runs on the replica with the most free slots when the primary does not run cards", () => {
      const choice = choosePlacement({
        local: local(0),
        replicas: [replica("a", -2), replica("b", 0), replica("c", -1)],
        runLocal: false,
        preferNodeId: null,
      });
      expect(choice.nodeId).toBe("b");
    });

    it("falls back to the primary when there is no replica at all", () => {
      const choice = choosePlacement({ local: local(0), replicas: [], runLocal: false, preferNodeId: null });
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
