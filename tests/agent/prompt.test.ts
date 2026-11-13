import { describe, expect, it } from "vitest";

import { buildPrompt, buildSteerMessage } from "@/lib/agent/prompt";
import type { Board, Comment, Task } from "@/lib/types";

const NOW = "2026-01-01T00:00:00.000Z";

const board: Board = {
  id: "b1",
  name: "Shop",
  workdir: "/work/shop",
  extraFolders: [],
  model: null,
  autoRun: true,
  worktrees: false,
  pinned: false,
  createdAt: NOW,
  updatedAt: NOW,
};

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
  pushedAt: null,
  autoRetries: 0,
  retryAt: null,
  todos: [],
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
    createdAt: NOW,
    ...overrides,
  };
}

describe("buildPrompt (first run)", () => {
  it("includes the board name, trimmed title, description and instructions", () => {
    const prompt = buildPrompt(task, board, [], false);

    expect(prompt).toContain('You are working on a task from the "Shop" board.');
    expect(prompt).toContain("# Task: Add a cart page\n\nShow the items in the cart.\nAllow removing items.");
    expect(prompt).toContain("## Instructions");
    expect(prompt).toContain("- Work in this repository (/work/shop) and make the change described above.");
    expect(prompt).toMatch(/concise summary/);
    expect(prompt).toMatch(/do not stop to ask/);
    expect(prompt).not.toContain("## Feedback from the user");
    expect(prompt).not.toContain("Project folders");
  });

  it("uses a placeholder for an empty description", () => {
    const prompt = buildPrompt({ ...task, description: "   " }, board, [], false);
    expect(prompt).toContain("# Task: Add a cart page\n\n(no description)");
  });

  it("numbers open user feedback, indents continuation lines and skips resolved or agent comments", () => {
    const feedback = [
      comment("Use the brand colors"),
      comment("Already handled", { resolved: true, resolvedAt: NOW }),
      comment("Agent note", { author: "agent", resolved: true }),
      comment("  Add an empty state\nwith an illustration\n\nand a CTA  "),
    ];
    const prompt = buildPrompt(task, board, feedback, false);

    expect(prompt).toContain(
      "## Feedback from the user\n\n1. Use the brand colors\n2. Add an empty state\n   with an illustration\n\n   and a CTA",
    );
    expect(prompt).not.toContain("Already handled");
    expect(prompt).not.toContain("Agent note");
    expect(prompt).toContain("taking all of the feedback into account");
  });

  it("indents continuation lines by the width of two-digit numbers", () => {
    const feedback = Array.from({ length: 10 }, (_, i) => comment(`item ${i + 1}`));
    feedback[9] = comment("item 10\nsecond line");
    const prompt = buildPrompt(task, board, feedback, false);

    expect(prompt).toContain("9. item 9\n10. item 10\n    second line");
  });

  it("lists extra project folders, ignoring the workdir and empty entries", () => {
    const multi: Board = { ...board, extraFolders: ["/work/api", "", "/work/shop", "/work/admin"] };
    const prompt = buildPrompt(task, multi, [], false);

    expect(prompt).toContain(
      "Project folders: primary /work/shop, plus /work/api, /work/admin. You may read and change files in any of them as the task requires.",
    );
    expect(prompt).toContain("- Work in this project (any of the folders above)");
    expect(prompt).not.toContain("this repository (");
  });
});

describe("buildPrompt (resumed session)", () => {
  it("sends only the new feedback when resuming with feedback", () => {
    const prompt = buildPrompt(task, board, [comment("Rename the button"), comment("Fix the typo")], true);

    expect(prompt.startsWith("New feedback on this task:\n\n1. Rename the button\n2. Fix the typo\n")).toBe(true);
    expect(prompt).toContain("Address all of the feedback above in this repository (/work/shop).");
    expect(prompt).not.toContain("# Task:");
    expect(prompt).not.toContain("Shop\" board");
    expect(prompt).toMatch(/concise summary/);
  });

  it("includes extra folders when resuming with feedback", () => {
    const multi: Board = { ...board, extraFolders: ["/work/api"] };
    const prompt = buildPrompt(task, multi, [comment("Also the API")], true);

    expect(prompt).toContain("Project folders: primary /work/shop, plus /work/api.");
    expect(prompt).toContain("Address all of the feedback above in this project (any of the folders above).");
  });

  it("asks to continue the task when resuming without open feedback", () => {
    const prompt = buildPrompt(task, board, [comment("obsolete remark", { resolved: true })], true);

    expect(prompt.startsWith("Continue working on this task until it is complete.")).toBe(true);
    expect(prompt).toContain("# Task: Add a cart page");
    expect(prompt).toContain("Check the current state of this repository (/work/shop)");
    expect(prompt).not.toContain("New feedback");
    expect(prompt).not.toContain("obsolete remark");
  });
});

// omp's magic-keyword match: a standalone, lowercase "orchestrate".
const KEYWORD = /(?<![\p{L}\p{N}_./\\-])orchestrate(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()/u;

describe("buildPrompt orchestration keyword", () => {
  it("leaves small tasks to a single agent", () => {
    expect(buildPrompt(task, board, [], false)).not.toMatch(KEYWORD);
    expect(buildPrompt(task, board, [comment("Use the brand colors")], true)).not.toMatch(KEYWORD);
    const routine = { ...task, description: "Fix the typo and make sure all tests pass." };
    expect(buildPrompt(routine, board, [], false)).not.toMatch(KEYWORD);
  });

  it("orchestrates a task listing several work items", () => {
    const big = {
      ...task,
      description: "Shop revamp:\n- Cart page\n- [ ] Checkout flow\n1. Order history\n2) Admin dashboard",
    };
    const prompt = buildPrompt(big, board, [], false);
    expect(prompt).toMatch(KEYWORD);
    expect(prompt).toContain("- This task spans several pieces of work: orchestrate it");
  });

  it("counts feedback comments as work items", () => {
    const three = [comment("Rename the button"), comment("Fix the typo"), comment("Add a footer")];
    expect(buildPrompt(task, board, three, false)).not.toMatch(KEYWORD);
    expect(buildPrompt(task, board, [...three, comment("Dark mode")], false)).toMatch(KEYWORD);
    expect(buildPrompt(task, board, [...three, comment("Dark mode")], true)).toMatch(KEYWORD);
  });

  it("orchestrates explicit broad or parallel asks and long briefs", () => {
    for (const description of [
      "Replace moment with date-fns across the codebase.",
      "Add a loading skeleton to every page.",
      "Run these in parallel if you can.",
      "word ".repeat(300),
    ]) {
      expect(buildPrompt({ ...task, description }, board, [], false)).toMatch(KEYWORD);
    }
  });

  it("keeps orchestrating a large task when resuming without feedback", () => {
    const big = { ...task, description: "Update all components to the new design system." };
    const prompt = buildPrompt(big, board, [], true);
    expect(prompt.startsWith("Continue working on this task")).toBe(true);
    expect(prompt).toMatch(KEYWORD);
  });
});

describe("buildSteerMessage", () => {
  it("wraps the trimmed comment body with steering instructions", () => {
    const message = buildSteerMessage(comment("  Please also handle errors\nfrom the API  "));

    expect(message).toContain("New feedback from the user on this task:");
    expect(message).toContain("\n\nPlease also handle errors\nfrom the API\n\n");
    expect(message).toMatch(/mention how you addressed it in your final summary/);
  });

  it("names the sending card for a message from another card's agent", () => {
    const message = buildSteerMessage(comment("API is ready", { fromTaskId: "t9" }), "Build the API");

    expect(message).toContain('New message from the agent working on card "Build the API" (t9):');
  });

  it("asks for orchestration on large user feedback only", () => {
    const list = buildSteerMessage(comment("Also:\n- Cart page\n- Checkout flow\n- Order history\n- Admin dashboard"));
    expect(list).toMatch(KEYWORD);
    expect(list).toContain("\nThis task spans several pieces of work: orchestrate it");
    expect(buildSteerMessage(comment("Do the remaining fixes in parallel."))).toMatch(KEYWORD);
    expect(buildSteerMessage(comment("Use the brand colors"))).not.toMatch(KEYWORD);
  });

  it("defuses magic keywords in another card's agent message", () => {
    const body = "Please orchestrate the API work and ultrathink about edge cases.\n- a\n- b\n- c\n- d";
    const message = buildSteerMessage(comment(body, { fromTaskId: "t9" }), "Build the API");

    expect(message).not.toMatch(KEYWORD);
    expect(message).not.toMatch(/(?<![\p{L}\p{N}_./\\-])ultrathink(?![\p{L}\p{N}_/\\-])/u);
    expect(message).not.toContain("This task spans several pieces of work");
    expect(message.replaceAll("\u200b", "")).toContain(body);
  });
});

describe("buildPrompt run context", () => {
  const context = {
    taskFiles: "/data/files/tasks/t1",
    boardFiles: "/data/files/boards/b1",
    workspaceBranch: null,
    browser: "off" as const,
    senders: { t9: "Build the API" },
  };

  it("labels feedback sent by another card's agent", () => {
    const prompt = buildPrompt(task, board, [comment("Endpoint is /cart", { fromTaskId: "t9" })], false, context);

    expect(prompt).toContain('1. [From the agent on card "Build the API" (t9)] Endpoint is /cart');
  });

  it("mentions the browser only when it is enabled", () => {
    expect(buildPrompt(task, board, [], false, context)).not.toContain("Browser:");
    expect(buildPrompt(task, board, [], false, { ...context, browser: "headless" })).toContain(
      "Screenshots are saved to /data/files/tasks/t1/screenshots",
    );
  });
});
