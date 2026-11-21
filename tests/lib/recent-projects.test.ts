import { describe, expect, it } from "vitest";

import { recentProjects } from "@/lib/recent-projects";

const board = (id: string, lastAccessedAt: string | null = null) => ({ id, lastAccessedAt });

describe("recentProjects", () => {
  it("picks the most recently opened projects but keeps the given order", () => {
    const boards = [
      board("a", "2026-01-01T00:00:00.000Z"),
      board("b", "2026-03-01T00:00:00.000Z"),
      board("c", "2026-02-01T00:00:00.000Z"),
      board("d", "2025-12-01T00:00:00.000Z"),
    ];
    expect(recentProjects(boards, undefined, 3).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("uses never-opened projects only to fill leftover spots", () => {
    const boards = [board("new"), board("open", "2026-01-01T00:00:00.000Z"), board("older")];
    expect(recentProjects(boards, undefined, 2).map((x) => x.id)).toEqual(["new", "open"]);
  });

  it("caps the list at 10 by default", () => {
    const boards = Array.from({ length: 12 }, (_, i) => board(`b${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`));
    const listed = recentProjects(boards).map((x) => x.id);
    expect(listed).toHaveLength(10);
    expect(listed).not.toContain("b0");
    expect(listed).not.toContain("b1");
  });

  it("keeps the active project in place of the least recent entry when it falls past the limit", () => {
    const boards = [board("a", "2026-03-01T00:00:00.000Z"), board("b", "2026-02-01T00:00:00.000Z"), board("c")];
    expect(recentProjects(boards, "c", 2).map((x) => x.id)).toEqual(["a", "c"]);
    expect(recentProjects(boards, "a", 2).map((x) => x.id)).toEqual(["a", "b"]);
  });
});
