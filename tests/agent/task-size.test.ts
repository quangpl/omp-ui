import { describe, expect, it } from "vitest";

import { isLargeTask } from "@/lib/agent/task-size";
import type { Comment, Task } from "@/lib/types";

const task = { title: "Add a cart page", description: "Show the items in the cart." } as Task;
const comment = (body: string) => ({ body }) as Comment;

describe("isLargeTask", () => {
  it("leaves small tasks to a single agent", () => {
    expect(isLargeTask(task, [])).toBe(false);
    expect(isLargeTask(task, [comment("Use the brand colors")])).toBe(false);
    expect(isLargeTask({ ...task, description: "Fix the typo and make sure all tests pass." }, [])).toBe(false);
  });

  it("counts description list entries as work items", () => {
    const big = { ...task, description: "Shop revamp:\n- Cart page\n- [ ] Checkout flow\n1. Order history\n2) Admin dashboard" };
    expect(isLargeTask(big, [])).toBe(true);
  });

  it("ignores list entries under reference headings and inside code fences", () => {
    const refs = {
      ...task,
      description: "Do X.\n\n## Acceptance criteria\n- a\n- b\n- c\n- d\n\n```\n- e\n- f\n```",
    };
    expect(isLargeTask(refs, [])).toBe(false);
  });

  it("counts feedback comments as work items", () => {
    const three = [comment("Rename the button"), comment("Fix the typo"), comment("Add a footer")];
    expect(isLargeTask(task, three)).toBe(false);
    expect(isLargeTask(task, [...three, comment("Dark mode")])).toBe(true);
  });

  it("flags explicit broad or parallel asks and long briefs", () => {
    for (const description of [
      "Replace moment with date-fns across the codebase.",
      "Add a loading skeleton to every page.",
      "Run these in parallel if you can.",
      "word ".repeat(300),
    ]) {
      expect(isLargeTask({ ...task, description }, [])).toBe(true);
    }
  });
});
