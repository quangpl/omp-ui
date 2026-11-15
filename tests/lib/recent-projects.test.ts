import { describe, expect, it } from "vitest";

import { recentProjects } from "@/lib/recent-projects";

const board = (id: string, lastAccessedAt: string | null = null) => ({ id, lastAccessedAt });

describe("recentProjects", () => {
  it("lists opened projects newest first, then never-opened ones in API order", () => {
    const boards = [
      board("new"),
      board("old-open", "2026-01-01T00:00:00.000Z"),
      board("older"),
      board("latest-open", "2026-03-01T00:00:00.000Z"),
      board("mid-open", "2026-02-01T00:00:00.000Z"),
    ];
    expect(recentProjects(boards).map((b) => b.id)).toEqual(["latest-open", "mid-open", "old-open", "new", "older"]);
  });

  it("caps the list at 10 by default", () => {
    const boards = Array.from({ length: 12 }, (_, i) => board(`b${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`));
    const listed = recentProjects(boards);
    expect(listed).toHaveLength(10);
    expect(listed[0].id).toBe("b11");
    expect(listed[9].id).toBe("b2");
  });

  it("keeps the active project in place of the last entry when it falls past the limit", () => {
    const boards = [board("a", "2026-03-01T00:00:00.000Z"), board("b", "2026-02-01T00:00:00.000Z"), board("c")];
    expect(recentProjects(boards, "c", 2).map((b) => b.id)).toEqual(["a", "c"]);
    expect(recentProjects(boards, "a", 2).map((b) => b.id)).toEqual(["a", "b"]);
  });
});
