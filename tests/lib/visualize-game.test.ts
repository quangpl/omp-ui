import { describe, expect, it } from "vitest";
import { crewLevel, workerIdentity } from "@/components/visualize/game";

describe("crewLevel", () => {
  it("levels up at 2, 6, 12 done cards and reports progress through the level", () => {
    expect(crewLevel(0)).toMatchObject({ level: 1, xp: 0, levelStartXp: 0, nextLevelXp: 200, progress: 0 });
    expect(crewLevel(1)).toMatchObject({ level: 1, progress: 0.5 });
    expect(crewLevel(2)).toMatchObject({ level: 2, levelStartXp: 200, nextLevelXp: 600, progress: 0 });
    expect(crewLevel(5)).toMatchObject({ level: 2, progress: 0.75 });
    expect(crewLevel(6).level).toBe(3);
    expect(crewLevel(12).level).toBe(4);
  });

  it("caps the rank at the last one for huge crews", () => {
    expect(crewLevel(10_000).rank).toBe("Legends");
  });
});

describe("workerIdentity", () => {
  it("gives a card the same worker on every call", () => {
    expect(workerIdentity("card-a")).toEqual(workerIdentity("card-a"));
  });
});
