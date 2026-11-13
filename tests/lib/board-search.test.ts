import { describe, expect, it } from "vitest";
import type { TasksByStatus } from "@/hooks/use-board";
import { filterColumns, matchTitle, normalizeSearchQuery } from "@/lib/board-search";
import type { Task, TaskStatus } from "@/lib/types";

const task = (id: string, title: string, status: TaskStatus) => ({ id, title, status }) as Task;

const board = (): TasksByStatus => ({
  todo: [task("a", "Fix the Login page", "todo"), task("b", "Fix signup", "todo"), task("c", "Write docs", "todo")],
  in_progress: [task("d", "Login rate limit", "in_progress"), task("e", "Refactor LOGIN flow", "in_progress")],
  done: [task("f", "Ship release notes", "done")],
});

/** `b` holds l..o..g..i..n only as a subsequence, so it is a loose-only match for "login". */
const tieredBoard = (): TasksByStatus => ({
  todo: [task("a", "Fix login redirect", "todo"), task("b", "Large ops guide in notes", "todo")],
  in_progress: [task("c", "Polish login copy", "in_progress"), task("d", "Write release notes", "in_progress")],
  done: [task("e", "Crème brûlée launch", "done")],
});

const ids = (columns: TasksByStatus) => [...columns.todo, ...columns.in_progress, ...columns.done].map((t) => t.id);

describe("normalizeSearchQuery", () => {
  it("splits on whitespace, lowercases and strips accents", () => {
    expect(normalizeSearchQuery("  Fix   LOGIN\tCrème ")).toEqual(["fix", "login", "creme"]);
  });

  it("returns no terms for a blank query", () => {
    expect(normalizeSearchQuery("")).toEqual([]);
    expect(normalizeSearchQuery(" \t\n ")).toEqual([]);
  });
});

describe("matchTitle", () => {
  it("requires every term (AND) and reports the worst tier", () => {
    expect(matchTitle("Fix the Login page", normalizeSearchQuery("fix login"))).toMatchObject({ tier: "exact" });
    expect(matchTitle("Fix signup", normalizeSearchQuery("fix login"))).toBeNull();
    expect(matchTitle("Fix the Login page", normalizeSearchQuery("fix lgoin"))).toMatchObject({
      tier: "typo",
      indices: [0, 1, 2, 8, 9, 10, 11, 12],
    });
  });
});

describe("filterColumns", () => {
  it("returns the same columns reference for a blank query", () => {
    const columns = board();
    for (const query of ["", "   "]) {
      const result = filterColumns(columns, query);
      expect(result.columns).toBe(columns);
      expect(result).toMatchObject({ active: false, fuzzy: false, matches: 6, total: 6 });
      expect(result.highlights.size).toBe(0);
    }
  });

  it("filters each column in order with exact matches and their highlights", () => {
    const result = filterColumns(board(), "LOGIN");
    expect(result).toMatchObject({ active: true, fuzzy: false, matches: 3, total: 6 });
    expect(result.columns.todo.map((t) => t.id)).toEqual(["a"]);
    expect(result.columns.in_progress.map((t) => t.id)).toEqual(["d", "e"]);
    expect(result.columns.done).toEqual([]);
    expect(Object.fromEntries(result.highlights)).toEqual({
      a: [8, 9, 10, 11, 12],
      d: [0, 1, 2, 3, 4],
      e: [9, 10, 11, 12, 13],
    });
  });

  it("reports zero matches when nothing fits", () => {
    const result = filterColumns(board(), "kubernetes");
    expect(result).toMatchObject({ active: true, fuzzy: false, matches: 0, total: 6 });
    expect(result.columns).toEqual({ todo: [], in_progress: [], done: [] });
  });

  it("keeps exact matches only, hiding loose subsequences", () => {
    const result = filterColumns(tieredBoard(), "login");
    expect(ids(result.columns)).toEqual(["a", "c"]);
    expect(result.fuzzy).toBe(false);
  });

  it("finds typos ahead of loose subsequences", () => {
    const result = filterColumns(tieredBoard(), "lgoin");
    expect(ids(result.columns)).toEqual(["a", "c"]);
    expect(result.fuzzy).toBe(true);
    expect(result.highlights.get("a")).toEqual([4, 5, 6, 7, 8]);
  });

  it("falls back to loose subsequences when nothing closer exists", () => {
    const result = filterColumns(tieredBoard(), "wrn");
    expect(ids(result.columns)).toEqual(["d"]);
    expect(result).toMatchObject({ fuzzy: true, matches: 1, total: 5 });
    expect(result.highlights.get("d")).toEqual([0, 1, 14]);
  });

  it("matches across accents", () => {
    const result = filterColumns(tieredBoard(), "creme");
    expect(ids(result.columns)).toEqual(["e"]);
    expect(result.highlights.get("e")).toEqual([0, 1, 2, 3, 4]);
  });
});
