import { describe, expect, it } from "vitest";

import { buildPrompt, buildSteerMessage, FAILURE_STREAK_NUDGE, needsOrchestration } from "@/lib/agent/prompt";
import { SDLC_PHASE_INFO } from "@/lib/sdlc";
import type { Board, Comment, Task, TodoPhase } from "@/lib/types";

const NOW = "2026-01-01T00:00:00.000Z";

const board: Board = {
  id: "b1",
  name: "Shop",
  workdir: "/work/shop",
  extraFolders: [],
  model: null,
  autoRun: true,
  worktrees: false,
  pushBranch: "main",
  defaultBranches: {},
  pinned: false,
  lastAccessedAt: null,
  userId: null,
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
  createdByTaskId: null,
  schedulerId: null,
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

describe("buildPrompt (first run)", () => {
  it("includes the board name, trimmed title, description and instructions", () => {
    const prompt = buildPrompt(task, board, [], false);

    expect(prompt).toContain('You are working on a task from the "Shop" board.');
    expect(prompt).toContain("# Task: Add a cart page\n\nShow the items in the cart.\nAllow removing items.");
    expect(prompt).toContain("## Instructions");
    expect(prompt).toContain("- Work in this repository (/work/shop) and make the change described above.");
    expect(prompt).not.toMatch(/scannable summary/);
    expect(prompt).not.toContain("## Report");
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

describe("buildPrompt system prompt off", () => {
  it("forwards only the task text, with nothing added", () => {
    const prompt = buildPrompt(task, board, [], false, undefined, false);
    expect(prompt).toBe("# Task: Add a cart page\n\nShow the items in the cart.\nAllow removing items.");
  });

  it("adds the open feedback to a first run's task, without instructions", () => {
    const prompt = buildPrompt(task, board, [comment("Use the brand colors"), comment("old", { resolved: true })], false, undefined, false);
    expect(prompt).toBe(
      "# Task: Add a cart page\n\nShow the items in the cart.\nAllow removing items.\n\n## Feedback from the user\n\nUse the brand colors",
    );
  });

  it("sends a resumed session only the new feedback, as typed", () => {
    expect(buildPrompt(task, board, [comment("  Use the brand colors\nand the logo ")], true, undefined, false)).toBe(
      "Use the brand colors\nand the logo",
    );
    expect(buildPrompt(task, board, [comment("Rename the button"), comment("Fix the typo")], true, undefined, false)).toBe(
      "1. Rename the button\n2. Fix the typo",
    );
  });
});

describe("buildPrompt (resumed session)", () => {
  it("sends only the new feedback when resuming with feedback", () => {
    const prompt = buildPrompt(task, board, [comment("Rename the button"), comment("Fix the typo")], true);

    expect(prompt.startsWith("New feedback on this task:\n\n1. Rename the button\n2. Fix the typo\n")).toBe(true);
    expect(prompt).toContain("Address all of the feedback above in this repository (/work/shop).");
    expect(prompt).not.toContain("# Task:");
    expect(prompt).not.toContain("Shop\" board");
    expect(prompt).not.toMatch(/scannable summary/);
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

describe("buildPrompt leaves parallelism and the final report to omp", () => {
  const big = {
    ...task,
    description: "Shop revamp:\n- Cart page\n- [ ] Checkout flow\n1. Order history\n2) Admin dashboard",
  };
  const feedback = [comment("Also:\n- Wishlist\n- Reviews\n- Search\n- Filters")];

  it("adds no parallel-subagent or orchestration text, however large the task", () => {
    for (const prompt of [
      buildPrompt(big, board, [], false),
      buildPrompt(big, board, [], true),
      buildPrompt(task, board, feedback, true),
    ]) {
      expect(prompt).not.toMatch(KEYWORD);
      expect(prompt).not.toContain("parallel subagent");
    }
  });

  it("asks for no summary or Report format", () => {
    for (const prompt of [
      buildPrompt(task, board, [], false),
      buildPrompt(task, board, feedback, true),
      buildPrompt(task, board, [], true),
    ]) {
      expect(prompt).not.toMatch(/scannable summary/);
      expect(prompt).not.toContain("## Report");
    }
  });
});

describe("needsOrchestration", () => {
  it("leaves small tasks to a single agent", () => {
    expect(needsOrchestration(task, [])).toBe(false);
    expect(needsOrchestration(task, [comment("Use the brand colors")])).toBe(false);
    expect(needsOrchestration({ ...task, description: "Fix the typo and make sure all tests pass." }, [])).toBe(false);
  });

  it("flags a task listing several work items", () => {
    const big = { ...task, description: "Shop revamp:\n- Cart page\n- [ ] Checkout flow\n1. Order history\n2) Admin dashboard" };
    expect(needsOrchestration(big, [])).toBe(true);
  });

  it("counts feedback comments as work items", () => {
    const three = [comment("Rename the button"), comment("Fix the typo"), comment("Add a footer")];
    expect(needsOrchestration(task, three)).toBe(false);
    expect(needsOrchestration(task, [...three, comment("Dark mode")])).toBe(true);
  });

  it("flags explicit broad or parallel asks and long briefs", () => {
    for (const description of [
      "Replace moment with date-fns across the codebase.",
      "Add a loading skeleton to every page.",
      "Run these in parallel if you can.",
      "word ".repeat(300),
    ]) {
      expect(needsOrchestration({ ...task, description }, [])).toBe(true);
    }
  });
});

describe("buildSteerMessage", () => {
  it("sends user feedback word for word, like typing into omp mid-run", () => {
    const body = "  Please also handle errors\nfrom the API  ";
    expect(buildSteerMessage(comment(body), null)).toBe("Please also handle errors\nfrom the API");
    const large = "Also:\n- Cart page\n- Checkout flow\n- Order history\n- Admin dashboard";
    expect(buildSteerMessage(comment(large), null)).toBe(large);
  });

  it("names the sending card for a message from another card's agent", () => {
    const message = buildSteerMessage(comment("API is ready", { fromTaskId: "t9" }), "Build the API");

    expect(message).toContain('New message from the agent working on card "Build the API" (t9):');
    expect(message).toContain("\n\nAPI is ready\n\n");
    expect(message).toMatch(/mention briefly how you addressed it in your final message/);
  });

  it("defuses magic keywords in another card's agent message", () => {
    const body = "Please orchestrate the API work and ultrathink about edge cases.\n- a\n- b\n- c\n- d";
    const message = buildSteerMessage(comment(body, { fromTaskId: "t9" }), "Build the API");

    expect(message).not.toMatch(KEYWORD);
    expect(message).not.toMatch(/(?<![\p{L}\p{N}_./\\-])ultrathink(?![\p{L}\p{N}_/\\-])/u);
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

describe("buildPrompt SDLC workflow", () => {
  const LABELS = ["Analyze", "Implement", "Testing"];
  const FRESH_ROUND = "run a fresh Analyze → Implement → Testing round";

  function phase(name: string, status: "pending" | "in_progress" | "completed"): TodoPhase {
    return { name, tasks: [{ content: `${name} work`, status }] };
  }

  it("names all three phases in order with the Testing gate in every prompt", () => {
    const prompt = buildPrompt(task, board, [], false);
    expect(prompt).toContain(`in this order: ${LABELS.join(", ")}.`);
    expect(prompt).toContain(SDLC_PHASE_INFO.testing.gate);
    expect(prompt).toContain("Testing must pass before the work ships.");
    expect(buildPrompt(task, board, [], true)).toContain(LABELS.join(", "));
    expect(buildPrompt(task, board, [comment("Fix it")], true)).toContain(LABELS.join(", "));
  });

  it("treats feedback on delivered work as a fresh round and otherwise continues the current phase", () => {
    const done = ["Analyze", "Implement", "Testing"].map((n) => phase(n, "completed"));
    const delivered = buildPrompt({ ...task, todos: done }, board, [comment("Tweak the color")], true);
    expect(delivered).toContain(FRESH_ROUND);

    const open = [phase("Analyze", "completed"), phase("Implement", "in_progress"), phase("Testing", "pending")];
    const ongoing = buildPrompt({ ...task, todos: open }, board, [comment("Tweak the color")], true);
    expect(ongoing).not.toContain(FRESH_ROUND);
    expect(ongoing).toContain("Continue in the current SDLC phase");

    expect(buildPrompt(task, board, [], true)).toContain("Continue from the SDLC phase your todo list shows.");
  });

  it("adds no magic keyword to small tasks", () => {
    for (const prompt of [
      buildPrompt(task, board, [], false),
      buildPrompt(task, board, [], true),
      buildPrompt(task, board, [comment("Fix it")], true),
    ]) {
      expect(prompt).not.toMatch(KEYWORD);
      expect(prompt).not.toMatch(/\b(?:ultrathink|chillax|workflowz|jevify)\b/);
    }
  });
});

describe("buildPrompt non-software tasks", () => {
  const poem = { ...task, title: "Write a poem about the ocean", description: "Four stanzas, free verse." };
  const PHASES = "Analyze, Implement, Testing";
  const DIRECT = "This is not a software-development task";

  it("runs straight instead of applying the SDLC workflow", () => {
    const prompt = buildPrompt(poem, board, [], false);
    expect(prompt).toContain(DIRECT);
    expect(prompt).toContain("do the task directly right away");
    expect(prompt).not.toContain(PHASES);
    expect(prompt).not.toContain("Testing must pass before the work ships.");
    // A software task still gets the lifecycle.
    expect(buildPrompt(task, board, [], false)).toContain(PHASES);
  });

  it("skips the SDLC phases on resume, with and without feedback", () => {
    const withFeedback = buildPrompt(poem, board, [comment("Make it shorter")], true);
    expect(withFeedback).toContain(DIRECT);
    expect(withFeedback).not.toContain(PHASES);
    expect(withFeedback).not.toContain("Continue in the current SDLC phase");
    expect(withFeedback).not.toContain("run a fresh Analyze → Implement → Testing round");

    const resume = buildPrompt(poem, board, [], true);
    expect(resume).toContain(DIRECT);
    expect(resume).not.toContain(PHASES);
    expect(resume).not.toContain("Continue from the SDLC phase your todo list shows.");
  });
});

describe("buildPrompt cleanup policy", () => {
  it("asks every run to clean up its temporary artifacts before pushing and before the final message", () => {
    const CLEANUP = "clean up everything you created only to do this task";
    for (const prompt of [
      buildPrompt(task, board, [], false),
      buildPrompt(task, board, [], true),
      buildPrompt(task, board, [comment("Fix it")], true),
    ]) {
      expect(prompt).toContain(CLEANUP);
      expect(prompt).toContain("Never delete or remove anything you did not create");
      expect(prompt).toContain("before you commit or push anything");
      expect(prompt.indexOf(CLEANUP)).toBeLessThan(prompt.indexOf("Do not push on your own"));
      expect(prompt).toContain("--label agentman.task=t1");
      expect(prompt).toContain("docker compose -p task-t1");
      expect(prompt).toContain("AgentMan also removes marked leftovers when a run moves the card to Done or the card is deleted");
      expect(prompt).toContain("do not mark it or the image it runs from");
    }
  });

  it("names the card's Docker label and compose project after the card id", () => {
    const prompt = buildPrompt({ ...task, id: "AB_9" }, board, [], false);
    expect(prompt).toContain("docker compose -p task-ab_9");
    expect(prompt).toContain("--label agentman.task=AB_9");
  });
});

describe("buildPrompt after a failed run", () => {
  const context = {
    taskFiles: "/data/files/tasks/t1",
    boardFiles: "/data/files/boards/b1",
    workspaceBranch: null,
    browser: "off" as const,
    senders: {},
  };
  const failed = (message: string, attempt = 1) => ({ ...context, previousFailure: { message, attempt } });
  const NOTE =
    "The previous run failed: npm test exited with code 1. Before continuing, find out why it failed, and do not repeat the step that failed.";

  it("adds the failure note to every prompt shape and leaves the rest byte-identical", () => {
    const error = "npm test exited\n   with code 1.";

    const first = buildPrompt(task, board, [], false, failed(error));
    const firstBase = buildPrompt(task, board, [], false, context);
    expect(first).toBe(firstBase.replace("\n\n## Instructions\n", `\n\n## Previous attempt\n\n${NOTE}\n\n## Instructions\n`));

    const resume = buildPrompt(task, board, [], true, failed(error));
    const resumeBase = buildPrompt(task, board, [], true, context);
    expect(resume).toBe(resumeBase.replace("\n\nCheck the current state", `\n\n${NOTE}\n\nCheck the current state`));
    expect(resume.indexOf(NOTE)).toBeGreaterThan(resume.indexOf("# Task: Add a cart page"));

    const feedback = [comment("Rename the button")];
    const withFeedback = buildPrompt(task, board, feedback, true, failed(error));
    const withFeedbackBase = buildPrompt(task, board, feedback, true, context);
    expect(withFeedback).toBe(
      withFeedbackBase.replace("\n\nAddress all of the feedback", `\n\n${NOTE}\n\nAddress all of the feedback`),
    );
  });

  it("asks for a different approach only from the failure-streak retry on", () => {
    const STREAK = "the same approach has failed repeatedly";
    expect(FAILURE_STREAK_NUDGE).toBe(3);
    for (const resume of [false, true]) {
      expect(buildPrompt(task, board, [], resume, failed("boom", 2))).not.toContain(STREAK);
      const prompt = buildPrompt(task, board, [], resume, failed("boom", 3));
      expect(prompt).toContain(`This is automatic retry 3 and ${STREAK}: step back and take a different approach`);
      expect(buildPrompt(task, board, [], resume, failed("boom", 5))).toContain("automatic retry 5");
    }
  });

  it("defuses magic keywords in the error text", () => {
    const prompt = buildPrompt(task, board, [], false, failed("agent said: orchestrate the rest"));
    expect(prompt).not.toMatch(KEYWORD);
    expect(prompt.replaceAll("\u200b", "")).toContain("The previous run failed: agent said: orchestrate the rest.");
  });

  it("clips a long error to 500 characters", () => {
    const prompt = buildPrompt(task, board, [], true, failed(`${"x".repeat(600)} TAILMARK`));
    expect(prompt).toContain(`The previous run failed: ${"x".repeat(499)}….`);
    expect(prompt).not.toContain("x".repeat(500));
    expect(prompt).not.toContain("TAILMARK");
  });
});
