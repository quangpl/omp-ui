import { describe, expect, it } from "vitest";

import { chooseModel, classifyTask } from "@/lib/agent/model-select";
import type { ProviderPick } from "@/lib/provider-priority";
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
    schedulerId: null,
    ignoreMemory: false,
    userId: null,
    pushedAt: null,
    autoRetries: 0,
    retryAt: null,
    todos: [],
    review: null,
    resources: null,
    usage: null,
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
    userId: null,
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
    expect(classifyTask(card(title, description), []).profile).toBe(profile);
  });

  it("does not treat a typo fix as quick when it also asks for hard work", () => {
    expect(classifyTask(card("Fix typo and the race condition in the worker"), []).profile).toBe("deep");
  });

  it("does not treat a long brief as quick", () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    expect(classifyTask(card("Fix typo", long), []).profile).toBe("standard");
  });

  it("judges a run with feedback by the task and the feedback together", () => {
    const hard = card("Debug the deadlock in the scheduler");
    expect(classifyTask(hard, [comment("Fix the typo in the log message")]).profile).toBe("deep");
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

  it("keeps the resumed session's model instead of auto-selecting one", () => {
    const resumed = input("Debug the deadlock", { isResume: true, feedback: [comment("Fix the typo in the log message")] });
    expect(chooseModel(resumed)).toEqual({
      model: null,
      thinking: null,
      source: "session",
      profile: null,
      reason: "resumed session keeps its model",
    });
    expect(chooseModel({ ...resumed, board: { model: "pinned" } })).toMatchObject({ model: "pinned", source: "board" });
    expect(chooseModel(input("Fix the typo in the log message"))).toMatchObject({ model: "@smol", source: "auto" });
  });

  describe("with a provider priority", () => {
    const main: ProviderPick = {
      entry: { provider: "anthropic", model: "anthropic/claude-sonnet" },
      index: 0,
      skipped: [],
      allOut: false,
      fallbacks: [],
    };
    const roles = { smol: "anthropic/claude-haiku:low", slow: "openai/gpt-5:xhigh" };

    it("runs the active provider's model instead of the default model", () => {
      expect(chooseModel(input("Add a settings page", { provider: main }))).toMatchObject({
        model: "anthropic/claude-sonnet",
        source: "auto",
      });
      expect(
        chooseModel(input("Debug the deadlock", { provider: main, settings: { defaultModel: "base", autoModel: false } })),
      ).toMatchObject({ model: "anthropic/claude-sonnet", thinking: null, source: "provider" });
    });

    it("keeps a role only when its model runs on the active provider", () => {
      expect(chooseModel(input("Fix the typo in the log message", { provider: main, roles }))).toMatchObject({
        model: "@smol",
      });
      expect(chooseModel(input("Debug the deadlock", { provider: main, roles }))).toMatchObject({
        model: "anthropic/claude-sonnet",
        thinking: "high",
        source: "auto",
      });
    });

    it("switches a resumed session only when the retried run ran out of quota", () => {
      const resumed = input("Debug the deadlock", { provider: main, isResume: true });
      expect(chooseModel(resumed)).toMatchObject({ model: null, source: "session" });
      expect(chooseModel({ ...resumed, quotaRetry: true })).toMatchObject({
        model: "anthropic/claude-sonnet",
        source: "provider",
      });
    });

    it("never overrides a board's pinned model", () => {
      expect(
        chooseModel(input("Debug the deadlock", { provider: main, quotaRetry: true, isResume: true, board: { model: "pinned" } })),
      ).toMatchObject({ model: "pinned", source: "board" });
    });
  });
});
