import { describe, expect, it } from "vitest";

import { isNewCompletion } from "@/lib/notifications";
import type { TaskStatus } from "@/lib/types";

describe("isNewCompletion", () => {
  it.each<[TaskStatus | undefined, TaskStatus, boolean]>([
    [undefined, "done", false],
    ["todo", "done", true],
    ["in_progress", "done", true],
    ["done", "done", false],
    ["in_progress", "in_progress", false],
  ])("%s → %s is %s", (previous, next, expected) => {
    expect(isNewCompletion(previous, { status: next })).toBe(expected);
  });
});
