import { describe, expect, it } from "vitest";

import { decideElection, rankCandidates, type Candidate } from "@/lib/cluster/election";
import type { PeerAddress } from "@/lib/cluster/types";

const self: Candidate = { nodeId: "node-b", replSeq: 10, joinedAt: "2026-01-02T00:00:00.000Z" };

const PRIMARY: PeerAddress = {
  nodeId: "node-p",
  name: "primary",
  host: "10.0.0.1",
  port: 7790,
  httpUrl: "http://10.0.0.1:3000",
};

describe("rankCandidates", () => {
  it("orders by replSeq descending, then joinedAt ascending, then nodeId ascending", () => {
    const candidates: Candidate[] = [
      { nodeId: "c", replSeq: 5, joinedAt: "2026-01-01T00:00:00.000Z" },
      { nodeId: "b", replSeq: 9, joinedAt: "2026-01-03T00:00:00.000Z" },
      { nodeId: "a", replSeq: 9, joinedAt: "2026-01-03T00:00:00.000Z" },
      { nodeId: "d", replSeq: 9, joinedAt: "2026-01-02T00:00:00.000Z" },
    ];
    expect(rankCandidates(candidates).map((c) => c.nodeId)).toEqual(["d", "a", "b", "c"]);
  });

  it("does not mutate its input", () => {
    const candidates: Candidate[] = [
      { nodeId: "x", replSeq: 1, joinedAt: "2026-01-01T00:00:00.000Z" },
      { nodeId: "y", replSeq: 2, joinedAt: "2026-01-01T00:00:00.000Z" },
    ];
    rankCandidates(candidates);
    expect(candidates.map((c) => c.nodeId)).toEqual(["x", "y"]);
  });

  it("ranks an unknown join time after a known one", () => {
    const ranked = rankCandidates([
      { nodeId: "a", replSeq: 3, joinedAt: "" },
      { nodeId: "b", replSeq: 3, joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(ranked.map((c) => c.nodeId)).toEqual(["b", "a"]);
  });
});

describe("decideElection", () => {
  it("promotes when this node ranks first among the live replicas", () => {
    const alive: Candidate[] = [
      { nodeId: "node-c", replSeq: 9, joinedAt: "2026-01-01T00:00:00.000Z" },
      { nodeId: "node-d", replSeq: 10, joinedAt: "2026-01-03T00:00:00.000Z" },
    ];
    expect(decideElection({ self, alive, primaryFound: null, primaryTerm: 0, selfTerm: 3 })).toEqual({
      action: "promote",
    });
  });

  it("promotes when no other replica answered", () => {
    expect(decideElection({ self, alive: [], primaryFound: null, primaryTerm: 0, selfTerm: 3 })).toEqual({
      action: "promote",
    });
  });

  it("waits for a better-ranked live replica", () => {
    const alive: Candidate[] = [
      { nodeId: "node-c", replSeq: 12, joinedAt: "2026-01-05T00:00:00.000Z" },
      { nodeId: "node-a", replSeq: 10, joinedAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect(decideElection({ self, alive, primaryFound: null, primaryTerm: 0, selfTerm: 3 })).toEqual({
      action: "wait",
      leader: "node-c",
    });
  });

  it("waits for an older member with the same replication progress", () => {
    const alive: Candidate[] = [{ nodeId: "node-z", replSeq: 10, joinedAt: "2026-01-01T00:00:00.000Z" }];
    expect(decideElection({ self, alive, primaryFound: null, primaryTerm: 0, selfTerm: 3 })).toEqual({
      action: "wait",
      leader: "node-z",
    });
  });

  it("ignores its own entry among the live replicas", () => {
    expect(decideElection({ self, alive: [self], primaryFound: null, primaryTerm: 0, selfTerm: 3 })).toEqual({
      action: "promote",
    });
  });

  it("follows a reachable primary of the same term", () => {
    const alive: Candidate[] = [{ nodeId: "node-c", replSeq: 1, joinedAt: "2026-01-05T00:00:00.000Z" }];
    expect(decideElection({ self, alive, primaryFound: PRIMARY, primaryTerm: 3, selfTerm: 3 })).toEqual({
      action: "follow",
      primary: PRIMARY,
    });
  });

  it("follows a reachable primary of a newer term even when it would rank first", () => {
    expect(decideElection({ self, alive: [], primaryFound: PRIMARY, primaryTerm: 5, selfTerm: 3 })).toEqual({
      action: "follow",
      primary: PRIMARY,
    });
  });

  it("ignores a primary of a lower term (fencing)", () => {
    expect(decideElection({ self, alive: [], primaryFound: PRIMARY, primaryTerm: 2, selfTerm: 3 })).toEqual({
      action: "promote",
    });
    const better: Candidate[] = [{ nodeId: "node-c", replSeq: 20, joinedAt: "2026-01-05T00:00:00.000Z" }];
    expect(decideElection({ self, alive: better, primaryFound: PRIMARY, primaryTerm: 2, selfTerm: 3 })).toEqual({
      action: "wait",
      leader: "node-c",
    });
  });
});
