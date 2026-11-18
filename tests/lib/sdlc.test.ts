import { describe, expect, it } from "vitest";
import {
  classifySdlcPhase,
  inferSdlcPhase,
  releaseGate,
  SDLC_PHASE_INFO,
  SDLC_PHASES,
  sdlcChange,
  sdlcPhaseMap,
  sdlcProgress,
  type SdlcPhaseId,
  type SdlcPhaseProgress,
  type SdlcProgress,
} from "@/lib/sdlc";
import type { TodoItem, TodoItemStatus, TodoPhase } from "@/lib/types";

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString();
const item = (content: string, status: TodoItemStatus = "pending", stamps: Partial<TodoItem> = {}): TodoItem => ({
  content,
  status,
  ...stamps,
});
const phase = (name: string, ...tasks: TodoItem[]): TodoPhase => ({ name, tasks });
const progressOf = (todos: TodoPhase[]): SdlcProgress => {
  const progress = sdlcProgress(todos);
  if (!progress) throw new Error("expected SDLC progress");
  return progress;
};
const entry = (progress: SdlcProgress, id: SdlcPhaseId): SdlcPhaseProgress => {
  const found = progress.phases.find((p) => p.id === id);
  if (!found) throw new Error(`missing phase ${id}`);
  return found;
};
const statuses = (progress: SdlcProgress) => Object.fromEntries(progress.phases.map((p) => [p.id, p.status]));
const skipped = (id: SdlcPhaseId): SdlcPhaseProgress => ({
  id,
  status: "skipped",
  done: 0,
  total: 0,
  current: null,
  startedAt: null,
  completedAt: null,
});

describe("SDLC_PHASE_INFO", () => {
  it("describes the three phases in order, all required", () => {
    expect(SDLC_PHASES.map((id) => [SDLC_PHASE_INFO[id].step, SDLC_PHASE_INFO[id].label])).toEqual([
      [1, "Analyze"],
      [2, "Implement"],
      [3, "Testing"],
    ]);
    expect(SDLC_PHASES.filter((id) => SDLC_PHASE_INFO[id].required)).toEqual(["analyze", "implement", "testing"]);
  });
});

describe("classifySdlcPhase", () => {
  it("maps every alias to its phase", () => {
    const cases: [string, SdlcPhaseId][] = [
      ["Analyze", "analyze"],
      ["Analysis", "analyze"],
      ["Implement", "implement"],
      ["Implementation", "implement"],
      ["Development", "implement"],
      ["Testing", "testing"],
      ["Test", "testing"],
      ["Tests", "testing"],
      ["QA", "testing"],
      ["Verification", "testing"],
    ];
    for (const [name, id] of cases) expect(classifySdlcPhase(name), name).toBe(id);
  });

  it("strips numbering and leading symbols", () => {
    const cases: [string, SdlcPhaseId][] = [
      ["1. Analyze", "analyze"],
      ["2) Implement", "implement"],
      ["3 - Implementation", "implement"],
      ["Phase 3: Testing & QA", "testing"],
      ["Step 1 — Analysis", "analyze"],
      ["✅ 2. Implement", "implement"],
      ["  Phase 3 – Testing  ", "testing"],
    ];
    for (const [name, id] of cases) expect(classifySdlcPhase(name), name).toBe(id);
  });

  it("accepts detail after the alias when a non-letter follows it", () => {
    const cases: [string, SdlcPhaseId][] = [
      ["Analyze the work", "analyze"],
      ["Implement (API + UI)", "implement"],
      ["Test/verify", "testing"],
      ["Testing: unit + e2e", "testing"],
      ["Analysis of the codebase", "analyze"],
    ];
    for (const [name, id] of cases) expect(classifySdlcPhase(name), name).toBe(id);
  });

  it("rejects names that do not start with a whole alias", () => {
    for (const name of ["Build", "", "   ", "Planner", "Analyzer", "Tester", "Unit testing", "Reimplement", "Phase"]) {
      expect(classifySdlcPhase(name), name).toBeNull();
    }
  });

  it("is case-insensitive", () => {
    expect(classifySdlcPhase("ANALYZE")).toBe("analyze");
    expect(classifySdlcPhase("pHaSe 2: IMPLEMENT")).toBe("implement");
    expect(classifySdlcPhase("qa")).toBe("testing");
  });
});

describe("inferSdlcPhase", () => {
  it("prefers the canonical name", () => {
    expect(inferSdlcPhase("Phase 3: Testing")).toBe("testing");
    expect(inferSdlcPhase("Implement the parser")).toBe("implement");
  });

  it("maps legacy phase names by keyword", () => {
    expect(inferSdlcPhase("Build")).toBe("implement");
    expect(inferSdlcPhase("Ship")).toBe("implement");
    expect(inferSdlcPhase("Verify")).toBe("testing");
    expect(inferSdlcPhase("Investigate")).toBe("analyze");
  });

  it("picks the keyword appearing earliest, not the first table row", () => {
    expect(inferSdlcPhase("Run tests, then deploy")).toBe("testing");
    expect(inferSdlcPhase("Research the deploy options")).toBe("analyze");
    expect(inferSdlcPhase("Code review")).toBe("implement");
    expect(inferSdlcPhase("Review code")).toBe("testing");
    expect(inferSdlcPhase("Write the code")).toBe("implement");
    expect(inferSdlcPhase("Add tests")).toBe("implement");
  });

  it("breaks ties at the same position by table order", () => {
    // "wireframe" (analyze) and "wire" (implement) both start at 0; analyze comes first in the table.
    expect(inferSdlcPhase("Wireframe the settings page")).toBe("analyze");
  });

  it("matches keywords only at word starts", () => {
    expect(inferSdlcPhase("Retest")).toBeNull();
    expect(inferSdlcPhase("Foo bar")).toBeNull();
    expect(inferSdlcPhase("")).toBeNull();
  });
});

describe("sdlcPhaseMap", () => {
  it("maps a legacy list by name", () => {
    expect(sdlcPhaseMap([phase("Build", item("Foo")), phase("Verify", item("Bar"))])).toEqual([
      "implement",
      "testing",
    ]);
  });

  it("prefers the canonical name and votes unnamed phases by item majority", () => {
    expect(
      sdlcPhaseMap([
        phase("1. Analyze", item("Write code")),
        phase("Misc", item("Run tests"), item("Verify output"), item("Deploy")),
      ]),
    ).toEqual(["analyze", "testing"]);
  });

  it("lets unresolved phases inherit the previous one, leading ones the first resolved", () => {
    expect(
      sdlcPhaseMap([
        phase("Misc", item("Foo")),
        phase("Build", item("Bar")),
        phase("Other", item("Baz")),
        phase("Verify"),
        phase("Notes"),
      ]),
    ).toEqual(["implement", "implement", "implement", "testing", "testing"]);
  });

  it("is null when no todo phase resolves", () => {
    expect(sdlcPhaseMap([])).toBeNull();
    expect(sdlcPhaseMap([phase("Misc", item("Foo")), phase("", item("Bar baz"))])).toBeNull();
  });
});

describe("sdlcProgress", () => {
  it("is null for an empty list and for a list nothing maps", () => {
    expect(sdlcProgress([])).toBeNull();
    expect(sdlcProgress([phase("Misc", item("Foo")), phase("", item("Bar baz"))])).toBeNull();
  });

  it("maps a legacy list by keyword, without making it canonical", () => {
    const progress = sdlcProgress([
      phase("Build", item("Write code", "completed", { startedAt: at(0), completedAt: at(5) })),
      phase("Verify", item("Run the tests")),
    ]);
    expect(progress).toEqual({
      phases: [
        skipped("analyze"),
        {
          id: "implement",
          status: "done",
          done: 1,
          total: 1,
          current: null,
          startedAt: at(0),
          completedAt: at(5),
        },
        { id: "testing", status: "pending", done: 0, total: 1, current: null, startedAt: null, completedAt: null },
      ],
      current: "testing",
      completed: 1,
      included: 2,
      canonical: false,
      violations: [],
    });
  });

  it("is canonical only when every todo phase has a canonical name", () => {
    expect(progressOf([phase("1. Analyze", item("a")), phase("Implement", item("b"))]).canonical).toBe(true);
    expect(progressOf([phase("Analyze", item("a")), phase("Build", item("b"))]).canonical).toBe(false);
  });

  it("falls back to a majority vote of the items for an unnamed phase, ties going to the earliest step", () => {
    const voted = progressOf([phase("", item("Write the parser"), item("Fix the lexer"), item("Run the tests"))]);
    expect(entry(voted, "implement").total).toBe(3);
    expect(entry(voted, "testing").status).toBe("skipped");
    expect(voted.canonical).toBe(false);

    const tied = progressOf([phase("", item("Run the tests"), item("Write the parser"))]);
    expect(entry(tied, "implement").total).toBe(2);
    expect(entry(tied, "testing").status).toBe("skipped");
  });

  it("lets unresolved phases inherit the previous resolved one, leading ones the first", () => {
    const progress = progressOf([
      phase("Planning", item("Read the code", "completed")),
      phase("", item("Foo")),
      phase("Testing", item("Run tests")),
      phase("Misc", item("Bar")),
    ]);
    expect(entry(progress, "analyze")).toMatchObject({ status: "active", done: 1, total: 2 });
    expect(entry(progress, "testing")).toMatchObject({ status: "pending", done: 0, total: 2 });
    expect(progress.canonical).toBe(false);

    const leading = progressOf([phase("", item("Foo")), phase("Design", item("Sketch the API"))]);
    expect(entry(leading, "analyze").total).toBe(2);
    expect(entry(leading, "implement").status).toBe("skipped");
  });

  it("derives each phase's status, ignoring abandoned items", () => {
    const progress = progressOf([
      phase("Analyze", item("Scope it", "completed"), item("Interview users", "abandoned")),
      phase("Implement", item("Parser", "in_progress"), item("Printer", "pending")),
      phase("Testing", item("Unit tests", "pending")),
    ]);
    expect(statuses(progress)).toEqual({
      analyze: "done",
      implement: "active",
      testing: "pending",
    });
    expect(entry(progress, "analyze")).toMatchObject({ done: 1, total: 1 });
    expect(entry(progress, "implement").current).toBe("Parser");
    expect(progress.current).toBe("implement");
    expect(progress.completed).toBe(1);
    expect(progress.included).toBe(3);
  });

  it("puts the agent in the phase of the first in-progress item, in todo-list order", () => {
    const listOrder = progressOf([
      phase("Testing", item("Run tests", "in_progress")),
      phase("Implement", item("Parser", "in_progress")),
    ]);
    expect(listOrder.current).toBe("testing");

    const laterPhase = progressOf([phase("Analyze", item("Scope", "pending")), phase("Implement", item("Parser", "in_progress"))]);
    expect(laterPhase.current).toBe("implement");
  });

  it("falls back to the first open phase, and has no current phase once everything is done", () => {
    const open = progressOf([
      phase("Analyze", item("Scope", "completed")),
      phase("Implement", item("Schema", "pending")),
      phase("Testing", item("Run tests", "pending")),
    ]);
    expect(open.current).toBe("implement");

    const finished = progressOf([phase("Analyze", item("Scope", "completed")), phase("Implement", item("Parser", "completed"))]);
    expect(finished.current).toBeNull();
    expect(finished.completed).toBe(2);
    expect(finished.included).toBe(2);
  });

  it("aggregates stamps across todo phases mapped to the same SDLC phase", () => {
    const progress = progressOf([
      phase("Implement", item("Parser", "completed", { startedAt: at(3), completedAt: at(9) })),
      phase("Implement the UI", item("Form", "completed", { startedAt: at(1), completedAt: at(7) })),
      phase(
        "Testing",
        item("Unit tests", "completed", { startedAt: at(10), completedAt: at(12) }),
        item("E2E", "in_progress", { startedAt: at(13) }),
      ),
    ]);
    expect(entry(progress, "implement")).toMatchObject({
      status: "done",
      done: 2,
      total: 2,
      startedAt: at(1),
      completedAt: at(9),
    });
    expect(entry(progress, "testing")).toMatchObject({
      status: "active",
      startedAt: at(10),
      completedAt: null,
    });
    expect(entry(progress, "analyze")).toMatchObject({ startedAt: null, completedAt: null });
  });
});

describe("sdlcProgress violations", () => {
  it("flags a phase started before an earlier one was complete", () => {
    const progress = progressOf([
      phase("Analyze", item("Scope", "completed")),
      phase("Implement", item("Parser", "pending")),
      phase("Testing", item("Run tests", "in_progress")),
    ]);
    expect(progress.violations).toEqual([
      { phase: "testing", requires: "implement", message: "Testing started before Implement was complete" },
    ]);
  });

  it("reports only the earliest unfinished earlier phase per started phase", () => {
    const progress = progressOf([
      phase("Analyze", item("Scope", "in_progress")),
      phase("Implement", item("Parser", "completed")),
      phase("Testing", item("Run tests", "in_progress")),
    ]);
    expect(progress.violations).toEqual([
      { phase: "implement", requires: "analyze", message: "Implement started before Analyze was complete" },
      { phase: "testing", requires: "analyze", message: "Testing started before Analyze was complete" },
    ]);
  });

  it("has no violations for a sequential list, even with phases still pending", () => {
    const sequential = progressOf([
      phase("Analyze", item("Scope", "completed")),
      phase("Implement", item("Parser", "completed")),
      phase("Testing", item("Run tests", "in_progress")),
    ]);
    expect(sequential.violations).toEqual([]);

    const early = progressOf([
      phase("Analyze", item("Scope", "in_progress")),
      phase("Implement", item("Parser", "pending")),
      phase("Testing", item("Run tests", "pending")),
    ]);
    expect(early.violations).toEqual([]);
  });
});

describe("releaseGate", () => {
  it("is null without progress or for a non-canonical list", () => {
    expect(releaseGate(null)).toBeNull();
    const legacy = progressOf([phase("Build", item("Write code", "completed")), phase("Verify", item("Run", "pending"))]);
    expect(legacy.canonical).toBe(false);
    expect(releaseGate(legacy)).toBeNull();
  });

  it("blocks a change that was never tested", () => {
    const progress = progressOf([phase("Analyze", item("Scope", "completed")), phase("Implement", item("Parser", "completed"))]);
    expect(releaseGate(progress)).toBe("No Testing phase: the change was never tested");
    expect(releaseGate(progressOf([phase("Analyze", item("Scope", "completed"))]))).toBeNull();
  });

  it("blocks unfinished testing, counting items that are not abandoned", () => {
    const progress = progressOf([
      phase("Analyze", item("Scope", "completed")),
      phase("Implement", item("Parser", "completed")),
      phase(
        "Testing",
        item("Unit tests", "completed"),
        item("E2E", "pending"),
        item("Typecheck", "in_progress"),
        item("Load test", "abandoned"),
      ),
    ]);
    expect(releaseGate(progress)).toBe("Testing is not complete (1 of 3 items done)");
  });

  it("lets the card ship once testing is done", () => {
    const progress = progressOf([
      phase("Analyze", item("Scope", "completed")),
      phase("Implement", item("Parser", "completed")),
      phase("Testing", item("Unit tests", "completed"), item("Flaky", "abandoned")),
    ]);
    expect(releaseGate(progress)).toBeNull();
  });
});

describe("sdlcChange", () => {
  it("reports the phase entered and the phases completed", () => {
    const before = progressOf([phase("Analyze", item("Scope", "in_progress")), phase("Implement", item("Parser"))]);
    const after = progressOf([phase("Analyze", item("Scope", "completed")), phase("Implement", item("Parser", "in_progress"))]);
    expect(sdlcChange(before, after)).toEqual({ entered: "implement", completed: ["analyze"], violations: [] });
    expect(sdlcChange(after, after)).toEqual({ entered: null, completed: [], violations: [] });
  });

  it("treats every done phase as completed when there was no previous snapshot", () => {
    const after = progressOf([
      phase("Analyze", item("Scope", "completed")),
      phase("Implement", item("Schema", "completed")),
      phase("Testing", item("Parser", "in_progress")),
    ]);
    expect(sdlcChange(null, after)).toEqual({
      entered: "testing",
      completed: ["analyze", "implement"],
      violations: [],
    });
  });

  it("reports only new violations", () => {
    const before = progressOf([
      phase("Analyze", item("Scope", "completed")),
      phase("Implement", item("Parser", "in_progress")),
    ]);
    const after = progressOf([
      phase("Analyze", item("Scope", "completed")),
      phase("Implement", item("Parser", "in_progress")),
      phase("Testing", item("Run tests", "in_progress")),
    ]);
    expect(after.violations).toHaveLength(1);
    expect(sdlcChange(before, after)).toEqual({
      entered: null,
      completed: [],
      violations: [
        { phase: "testing", requires: "implement", message: "Testing started before Implement was complete" },
      ],
    });
  });

  it("reports nothing without a current snapshot", () => {
    const before = progressOf([phase("Analyze", item("Scope", "completed"))]);
    expect(sdlcChange(before, null)).toEqual({ entered: null, completed: [], violations: [] });
  });
});
