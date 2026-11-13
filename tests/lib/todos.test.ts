import { describe, expect, it } from "vitest";
import { parseTodoPhases, progressFraction, todoProgress } from "@/lib/todos";

describe("parseTodoPhases", () => {
  it("keeps valid items, drops malformed ones and reads unknown statuses as pending", () => {
    const phases = parseTodoPhases(
      JSON.stringify([
        { name: "Build", tasks: [{ content: "Code", status: "completed" }, { content: " ", status: "pending" }, 42] },
        { name: "Empty", tasks: [] },
        { tasks: [{ content: "Ship", status: "weird" }] },
        "junk",
      ]),
    );
    expect(phases).toEqual([
      { name: "Build", tasks: [{ content: "Code", status: "completed" }] },
      { name: "", tasks: [{ content: "Ship", status: "pending" }] },
    ]);
    expect(parseTodoPhases("not json")).toEqual([]);
    expect(parseTodoPhases(null)).toEqual([]);
  });
});

describe("todoProgress", () => {
  it("counts completed items over the items not abandoned, and finds the current one", () => {
    const progress = todoProgress([
      { name: "A", tasks: [{ content: "one", status: "completed" }, { content: "two", status: "abandoned" }] },
      { name: "B", tasks: [{ content: "three", status: "in_progress" }, { content: "four", status: "pending" }] },
    ]);
    expect(progress).toEqual({ done: 1, total: 3, current: "three" });
    expect(progressFraction("in_progress", progress)).toBeCloseTo(1 / 3);
  });

  it("falls back to the card's column without a todo list, and a Done card is always full", () => {
    expect(todoProgress([])).toBeNull();
    expect(todoProgress([{ name: "", tasks: [{ content: "x", status: "abandoned" }] }])).toBeNull();
    expect(progressFraction("todo", null)).toBe(0);
    expect(progressFraction("in_progress", null)).toBe(0.5);
    expect(progressFraction("done", { done: 2, total: 5, current: null })).toBe(1);
  });
});
