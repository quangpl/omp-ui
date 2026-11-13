import { describe, expect, it } from "vitest";
import { parseTodoPhases, progressFraction, stampTodos, todoEta, todoProgress } from "@/lib/todos";
import type { TodoPhase } from "@/lib/types";

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

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString();
const list = (...tasks: TodoPhase["tasks"]): TodoPhase[] => [{ name: "", tasks }];

describe("stampTodos", () => {
  it("stamps items as they start and finish, and keeps stamps across updates", () => {
    const clock = { runStart: at(0), lastUpdate: at(0) };
    const first = stampTodos([], list({ content: "a", status: "in_progress" }, { content: "b", status: "pending" }), {
      ...clock,
      now: at(1),
    });
    expect(first).toEqual(list({ content: "a", status: "in_progress", startedAt: at(1) }, { content: "b", status: "pending" }));
    // "a" done and "b" done in one update: "b" was never seen in progress, so it started at the previous update.
    const second = stampTodos(first, list({ content: "a", status: "completed" }, { content: "b", status: "completed" }), {
      runStart: at(0),
      lastUpdate: at(1),
      now: at(5),
    });
    expect(second).toEqual(
      list(
        { content: "a", status: "completed", startedAt: at(1), completedAt: at(5) },
        { content: "b", status: "completed", startedAt: at(1), completedAt: at(5) },
      ),
    );
    const third = stampTodos(second, list({ content: "a", status: "completed" }), { runStart: at(0), lastUpdate: at(5), now: at(9) });
    expect(third[0]!.tasks[0]).toEqual({ content: "a", status: "completed", startedAt: at(1), completedAt: at(5) });
  });

  it("drops an in-progress stamp from an earlier run, so the pause between runs is not work", () => {
    const stored = list({ content: "a", status: "in_progress", startedAt: at(1) }, { content: "b", status: "in_progress", startedAt: at(1) });
    const resumed = stampTodos(stored, list({ content: "a", status: "completed" }, { content: "b", status: "in_progress" }), {
      runStart: at(30),
      lastUpdate: at(30),
      now: at(32),
    });
    expect(resumed).toEqual(
      list(
        { content: "a", status: "completed", startedAt: at(30), completedAt: at(32) },
        { content: "b", status: "in_progress", startedAt: at(32) },
      ),
    );
  });
});

describe("todoEta", () => {
  const minute = 60_000;

  it("projects the pace of completed items onto the ones left, crediting the current item", () => {
    const phases = list(
      { content: "a", status: "completed", startedAt: at(0), completedAt: at(4) },
      { content: "b", status: "completed", startedAt: at(4), completedAt: at(10) },
      { content: "c", status: "in_progress", startedAt: at(10) },
      { content: "d", status: "pending" },
      { content: "x", status: "abandoned" },
    );
    // Pace 5 min/item, 2 left, 1 min into "c".
    expect(todoEta(phases, Date.parse(at(11)))).toBe(9 * minute);
    // Overrunning "c" credits at most one item's worth.
    expect(todoEta(phases, Date.parse(at(30)))).toBe(5 * minute);
  });

  it("counts overlapping work once: items completed together share its time", () => {
    const phases = list(
      { content: "a", status: "completed", startedAt: at(0), completedAt: at(6) },
      { content: "b", status: "completed", startedAt: at(0), completedAt: at(6) },
      { content: "c", status: "pending" },
    );
    expect(todoEta(phases, Date.parse(at(6)))).toBe(3 * minute);
  });

  it("has no estimate before a timed completed item or once nothing is left", () => {
    expect(todoEta(list({ content: "a", status: "in_progress", startedAt: at(0) }), Date.parse(at(5)))).toBeNull();
    expect(todoEta(list({ content: "a", status: "completed" }, { content: "b", status: "pending" }), Date.parse(at(5)))).toBeNull();
    expect(
      todoEta(list({ content: "a", status: "completed", startedAt: at(0), completedAt: at(2) }), Date.parse(at(5))),
    ).toBeNull();
  });

  it("survives storage: parsing keeps valid stamps and drops malformed ones", () => {
    const parsed = parseTodoPhases(
      JSON.stringify(list({ content: "a", status: "completed", startedAt: at(0), completedAt: "soon" } as never)),
    );
    expect(parsed).toEqual(list({ content: "a", status: "completed", startedAt: at(0) }));
  });
});
