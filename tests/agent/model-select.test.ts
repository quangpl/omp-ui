import { describe, expect, it } from "vitest";

import { chooseModel, classifyTask } from "@/lib/agent/model-select";
import type { Comment, Task } from "@/lib/types";

const NOW = "2026-01-01T00:00:00.000Z";

function card(title: string, description = ""): Task {
  return {
    id: "t1",
    boardId: "b1",
    title,
    description,
    status: "in_progress",
    position: 0,
    agentState: "queued",
    agentError: null,
    question: null,
    sessionFile: null,
    lastRunId: null,
    blockedBy: [],
    createdByTaskId: null,
    pushedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    commentCount: 0,
    openCommentCount: 0,
  };
}

function comment(body: string): Comment {
  return {
    id: `c-${body.length}`,
    taskId: "t1",
    author: "user",
    body,
    resolved: false,
    resolvedAt: null,
    resolvedByRunId: null,
    fromTaskId: null,
    createdAt: NOW,
  };
}

const ROLES = { smol: "fast:low", slow: "deep:xhigh", designer: "pretty:high" };
const AUTO = { defaultModel: "base", autoModel: true };

describe("classifyTask", () => {
  it.each([
    ["Fix typo in the settings page header", "", "quick"],
    ["Rename getUser to fetchUser", "", "quick"],
    ["Investigate why uploads time out", "", "deep"],
    ["Fix the crash", "The export fails with a stack trace when the cache is stale.", "deep"],
    ["Optimize the board query", "", "deep"],
    ["Redesign the landing page hero section", "", "design"],
    ["Add a CSV export endpoint", "Return the rows as text/csv.", "standard"],
    // A single bug hint is not enough for deep reasoning.
    ["Fix the broken link in the footer", "", "standard"],
  ] as const)("%s → %s", (title, description, profile) => {
    expect(classifyTask(card(title, description), [], false).profile).toBe(profile);
  });

  it("does not treat a typo fix as quick when it also asks for hard work", () => {
    expect(classifyTask(card("Fix typo and the race condition in the worker"), [], false).profile).toBe("deep");
  });

  it("does not treat a long brief as quick", () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    expect(classifyTask(card("Fix typo", long), [], false).profile).toBe("standard");
  });

  it("judges a resumed run with feedback by the feedback alone", () => {
    const hard = card("Debug the deadlock in the scheduler");
    expect(classifyTask(hard, [comment("Fix the typo in the log message")], true).profile).toBe("quick");
    expect(classifyTask(hard, [comment("Fix the typo in the log message")], false).profile).toBe("deep");
  });
});

describe("chooseModel", () => {
  const input = (title: string, overrides: Partial<Parameters<typeof chooseModel>[0]> = {}) => ({
    board: { model: null },
    settings: AUTO,
    task: card(title),
    feedback: [],
    isResume: false,
    roles: ROLES,
    ...overrides,
  });

  it("uses the role configured for the profile", () => {
    expect(chooseModel(input("Fix typo in README"))).toMatchObject({ model: "@smol", thinking: null, source: "auto" });
    expect(chooseModel(input("Debug the flaky login test"))).toMatchObject({ model: "@slow", thinking: null });
    expect(chooseModel(input("Polish the dashboard layout"))).toMatchObject({ model: "@designer", thinking: null });
    expect(chooseModel(input("Add a health endpoint"))).toMatchObject({ model: "base", thinking: null, profile: "standard" });
  });

  it("keeps the default model and adjusts thinking when the role is missing or roles are unknown", () => {
    expect(chooseModel(input("Debug the flaky login test", { roles: {} }))).toMatchObject({ model: "base", thinking: "high" });
    expect(chooseModel(input("Fix typo in README", { roles: null }))).toMatchObject({ model: "base", thinking: "low" });
    expect(chooseModel(input("Polish the dashboard layout", { roles: { smol: "x" } }))).toMatchObject({
      model: "base",
      thinking: null,
      profile: "design",
    });
  });

  it("never overrides a board's pinned model, and stays on the default when turned off", () => {
    expect(chooseModel(input("Debug the deadlock", { board: { model: " pinned " } }))).toMatchObject({
      model: "pinned",
      thinking: null,
      source: "board",
    });
    expect(
      chooseModel(input("Debug the deadlock", { settings: { defaultModel: "", autoModel: false } })),
    ).toMatchObject({ model: null, thinking: null, source: "default" });
  });
});
