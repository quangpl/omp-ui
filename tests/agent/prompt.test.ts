import { describe, expect, it } from "vitest";

import { buildPrompt, buildSteerMessage } from "@/lib/agent/prompt";
import type { Comment, Task } from "@/lib/types";

const NOW = "2026-01-01T00:00:00.000Z";

const task: Task = {
  id: "t1",
  boardId: "b1",
  title: "  Add a cart page  ",
  description: "Show the items in the cart.\nAllow removing items.",
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

let nextId = 1;
function comment(body: string, overrides: Partial<Comment> = {}): Comment {
  return {
    id: `c${nextId++}`,
    taskId: "t1",
    author: "user",
    body,
    resolved: false,
    resolvedAt: null,
    resolvedByRunId: null,
    fromTaskId: null,
    userId: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe("buildPrompt", () => {
  const TASK = "# Task: Add a cart page\n\nShow the items in the cart.\nAllow removing items.";

  it("forwards only the trimmed task text on a first run, with nothing added", () => {
    expect(buildPrompt(task, [], false)).toBe(TASK);
    expect(buildPrompt({ ...task, description: "   " }, [], false)).toBe("# Task: Add a cart page\n\n(no description)");
  });

  it("appends open user feedback word for word, skipping resolved and agent comments", () => {
    const feedback = [
      comment("  Use the brand colors  "),
      comment("Already handled", { resolved: true }),
      comment("Agent note", { author: "agent" }),
      comment("Add an empty state\nwith an illustration"),
    ];
    expect(buildPrompt(task, feedback, false)).toBe(
      `${TASK}\n\nUse the brand colors\n\nAdd an empty state\nwith an illustration`,
    );
  });

  it("sends only the new feedback when resuming with feedback", () => {
    expect(buildPrompt(task, [comment("Rename the button"), comment("Fix the typo")], true)).toBe(
      "Rename the button\n\nFix the typo",
    );
  });

  it("sends the task again when resuming without open feedback", () => {
    expect(buildPrompt(task, [comment("obsolete remark", { resolved: true })], true)).toBe(TASK);
  });

  it("introduces feedback sent by another card's agent and defuses its magic keywords", () => {
    const sent = comment("Endpoint is /cart, please orchestrate the rest", { fromTaskId: "t9" });
    const prompt = buildPrompt(task, [sent], true, { t9: "Build the API" });
    expect(prompt).toContain('Message from the agent working on card "Build the API" (t9):');
    expect(prompt).not.toMatch(KEYWORD);
    expect(prompt.replaceAll("\u200b", "")).toContain("Endpoint is /cart, please orchestrate the rest");
  });
});

// omp's magic-keyword match: a standalone, lowercase "orchestrate".
const KEYWORD = /(?<![\p{L}\p{N}_./\\-])orchestrate(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()/u;

describe("buildSteerMessage", () => {
  it("sends user feedback word for word, like typing into omp mid-run", () => {
    const body = "  Please also handle errors\nfrom the API  ";
    expect(buildSteerMessage(comment(body), null)).toBe("Please also handle errors\nfrom the API");
    expect(buildSteerMessage(comment("Do it in parallel and orchestrate"), null)).toBe("Do it in parallel and orchestrate");
  });

  it("names the sending card for a message from another card's agent", () => {
    const message = buildSteerMessage(comment("API is ready", { fromTaskId: "t9" }), "Build the API");
    expect(message).toBe('Message from the agent working on card "Build the API" (t9):\n\nAPI is ready');
  });

  it("defuses magic keywords in another card's agent message", () => {
    const body = "Please orchestrate the API work and ultrathink about edge cases.";
    const message = buildSteerMessage(comment(body, { fromTaskId: "t9" }), "Build the API");

    expect(message).not.toMatch(KEYWORD);
    expect(message).not.toMatch(/(?<![\p{L}\p{N}_./\\-])ultrathink(?![\p{L}\p{N}_/\\-])/u);
    expect(message.replaceAll("\u200b", "")).toContain(body);
  });
});
