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
  it("describes the seven phases in order, with Planning, Implementation and Testing required", () => {
    expect(SDLC_PHASES.map((id) => [SDLC_PHASE_INFO[id].step, SDLC_PHASE_INFO[id].label])).toEqual([
      [1, "Planning"],
      [2, "Feasibility"],
      [3, "Design"],
      [4, "Implementation"],
      [5, "Testing"],
      [6, "Deployment"],
      [7, "Maintenance"],
    ]);
    expect(SDLC_PHASES.filter((id) => SDLC_PHASE_INFO[id].required)).toEqual(["planning", "implementation", "testing"]);
    expect(SDLC_PHASE_INFO.testing.gate).toBe(
      "build, type checks and the relevant tests pass and the change was verified end to end",
    );
  });
});

describe("classifySdlcPhase", () => {
  it("maps every alias to its phase", () => {
    const cases: [string, SdlcPhaseId][] = [
      ["Planning", "planning"],
      ["Plan", "planning"],
      ["Feasibility", "feasibility"],
      ["Feasibility analysis", "feasibility"],
      ["Feasibility study", "feasibility"],
      ["Design", "design"],
      ["System design", "design"],
      ["Implementation", "implementation"],
      ["Implement", "implementation"],
      ["Development", "implementation"],
      ["Testing", "testing"],
      ["Test", "testing"],
      ["Tests", "testing"],
      ["QA", "testing"],
      ["Verification", "testing"],
      ["Deployment", "deployment"],
      ["Deploy", "deployment"],
      ["Release", "deployment"],
      ["Maintenance", "maintenance"],
      ["Maintain", "maintenance"],
    ];
    for (const [name, id] of cases) expect(classifySdlcPhase(name), name).toBe(id);
  });

  it("strips numbering and leading symbols", () => {
    const cases: [string, SdlcPhaseId][] = [
      ["1. Planning", "planning"],
      ["2) Design", "design"],
      ["3 - Implementation", "implementation"],
      ["Phase 5: Testing & QA", "testing"],
      ["Step 2 — Feasibility analysis", "feasibility"],
      ["Stage 6 Deployment", "deployment"],
      ["✅ 4. Implementation", "implementation"],
      ["🚀 Deployment", "deployment"],
      ["  Phase 7 – Maintenance  ", "maintenance"],
    ];
    for (const [name, id] of cases) expect(classifySdlcPhase(name), name).toBe(id);
  });

  it("accepts detail after the alias when a non-letter follows it", () => {
    const cases: [string, SdlcPhaseId][] = [
      ["Plan the work", "planning"],
      ["Design (API + UI)", "design"],
      ["Test/verify", "testing"],
      ["Release, docs", "deployment"],
      ["Testing: unit + e2e", "testing"],
      ["Deploy-to-prod", "deployment"],
    ];
    for (const [name, id] of cases) expect(classifySdlcPhase(name), name).toBe(id);
  });

  it("rejects names that do not start with a whole alias", () => {
    for (const name of ["Build", "", "   ", "Planner", "Planned work", "Designer", "Tester", "Releases", "Unit testing", "Reimplement", "Phase"]) {
      expect(classifySdlcPhase(name), name).toBeNull();
    }
  });

  it("is case-insensitive", () => {
    expect(classifySdlcPhase("PLANNING")).toBe("planning");
    expect(classifySdlcPhase("pHaSe 3: DESIGN")).toBe("design");
    expect(classifySdlcPhase("qa")).toBe("testing");
  });
});

describe("inferSdlcPhase", () => {
  it("prefers the canonical name", () => {
    expect(inferSdlcPhase("Phase 5: Testing")).toBe("testing");
    expect(inferSdlcPhase("Design review")).toBe("design");
  });

  it("maps legacy phase names by keyword", () => {
    expect(inferSdlcPhase("Build")).toBe("implementation");
    expect(inferSdlcPhase("Ship")).toBe("deployment");
    expect(inferSdlcPhase("Verify")).toBe("testing");
    expect(inferSdlcPhase("Investigate")).toBe("planning");
  });

  it("picks the keyword appearing earliest, not the first table row", () => {
    expect(inferSdlcPhase("Run tests, then deploy")).toBe("testing");
    expect(inferSdlcPhase("Research the deploy options")).toBe("planning");
    expect(inferSdlcPhase("Code review")).toBe("implementation");
    expect(inferSdlcPhase("Review code")).toBe("testing");
    expect(inferSdlcPhase("Write the code")).toBe("implementation");
    expect(inferSdlcPhase("Add tests")).toBe("implementation");
  });

  it("breaks ties at the same position by table order", () => {
    // "wireframe" (design) and "wire" (implementation) both start at 0; design comes first in the table.
    expect(inferSdlcPhase("Wireframe the settings page")).toBe("design");
  });

  it("matches keywords only at word starts", () => {
    expect(inferSdlcPhase("Retest")).toBeNull();
    expect(inferSdlcPhase("Foo bar")).toBeNull();
    expect(inferSdlcPhase("")).toBeNull();
  });
});

describe("sdlcPhaseMap", () => {
  it("maps a legacy list by name", () => {
    expect(sdlcPhaseMap([phase("Build", item("Foo")), phase("Ship", item("Bar"))])).toEqual([
      "implementation",
      "deployment",
    ]);
  });

  it("prefers the canonical name and votes unnamed phases by item majority", () => {
    expect(
      sdlcPhaseMap([
        phase("1. Planning", item("Write code")),
        phase("Misc", item("Run tests"), item("Verify output"), item("Deploy")),
      ]),
    ).toEqual(["planning", "testing"]);
  });

  it("lets unresolved phases inherit the previous one, leading ones the first resolved", () => {
    expect(
      sdlcPhaseMap([
        phase("Misc", item("Foo")),
        phase("Build", item("Bar")),
        phase("Other", item("Baz")),
        phase("Ship"),
        phase("Notes"),
      ]),
    ).toEqual(["implementation", "implementation", "implementation", "deployment", "deployment"]);
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
      phase("Ship", item("Push branch")),
    ]);
    expect(progress).toEqual({
      phases: [
        skipped("planning"),
        skipped("feasibility"),
        skipped("design"),
        {
          id: "implementation",
          status: "done",
          done: 1,
          total: 1,
          current: null,
          startedAt: at(0),
          completedAt: at(5),
        },
        skipped("testing"),
        { id: "deployment", status: "pending", done: 0, total: 1, current: null, startedAt: null, completedAt: null },
        skipped("maintenance"),
      ],
      current: "deployment",
      completed: 1,
      included: 2,
      canonical: false,
      violations: [],
    });
  });

  it("is canonical only when every todo phase has a canonical name", () => {
    expect(progressOf([phase("1. Planning", item("a")), phase("Implementation", item("b"))]).canonical).toBe(true);
    expect(progressOf([phase("Planning", item("a")), phase("Build", item("b"))]).canonical).toBe(false);
  });

  it("falls back to a majority vote of the items for an unnamed phase, ties going to the earliest step", () => {
    const voted = progressOf([phase("", item("Write the parser"), item("Fix the lexer"), item("Run the tests"))]);
    expect(entry(voted, "implementation").total).toBe(3);
    expect(entry(voted, "testing").status).toBe("skipped");
    expect(voted.canonical).toBe(false);

    const tied = progressOf([phase("", item("Run the tests"), item("Write the parser"))]);
    expect(entry(tied, "implementation").total).toBe(2);
    expect(entry(tied, "testing").status).toBe("skipped");
  });

  it("lets unresolved phases inherit the previous resolved one, leading ones the first", () => {
    const progress = progressOf([
      phase("Planning", item("Read the code", "completed")),
      phase("", item("Foo")),
      phase("Testing", item("Run tests")),
      phase("Misc", item("Bar")),
    ]);
    expect(entry(progress, "planning")).toMatchObject({ status: "active", done: 1, total: 2 });
    expect(entry(progress, "testing")).toMatchObject({ status: "pending", done: 0, total: 2 });
    expect(progress.canonical).toBe(false);

    const leading = progressOf([phase("", item("Foo")), phase("Design", item("Sketch the API"))]);
    expect(entry(leading, "design").total).toBe(2);
    expect(entry(leading, "planning").status).toBe("skipped");
  });

  it("derives each phase's status, ignoring abandoned items", () => {
    const progress = progressOf([
      phase("Planning", item("Scope it", "completed"), item("Interview users", "abandoned")),
      phase("Feasibility", item("Spike", "abandoned"), item("Prototype", "abandoned")),
      phase("Design", item("Schema", "completed"), item("API", "pending")),
      phase("Implementation", item("Parser", "in_progress"), item("Printer", "pending")),
      phase("Testing", item("Unit tests", "pending")),
      phase("Maintenance"),
    ]);
    expect(statuses(progress)).toEqual({
      planning: "done",
      feasibility: "skipped",
      design: "active",
      implementation: "active",
      testing: "pending",
      deployment: "skipped",
      maintenance: "skipped",
    });
    expect(entry(progress, "planning")).toMatchObject({ done: 1, total: 1 });
    expect(entry(progress, "feasibility")).toMatchObject({ done: 0, total: 0 });
    expect(entry(progress, "implementation").current).toBe("Parser");
    expect(entry(progress, "design").current).toBeNull();
    expect(progress.current).toBe("implementation");
    expect(progress.completed).toBe(1);
    expect(progress.included).toBe(4);
  });

  it("puts the agent in the phase of the first in-progress item, in todo-list order", () => {
    const listOrder = progressOf([
      phase("Testing", item("Run tests", "in_progress")),
      phase("Implementation", item("Parser", "in_progress")),
    ]);
    expect(listOrder.current).toBe("testing");

    const laterPhase = progressOf([phase("Planning", item("Scope", "pending")), phase("Implementation", item("Parser", "in_progress"))]);
    expect(laterPhase.current).toBe("implementation");
  });

  it("falls back to the first open phase, and has no current phase once everything is done", () => {
    const open = progressOf([
      phase("Planning", item("Scope", "completed")),
      phase("Design", item("Schema", "pending")),
      phase("Testing", item("Run tests", "pending")),
    ]);
    expect(open.current).toBe("design");

    const finished = progressOf([phase("Planning", item("Scope", "completed")), phase("Implementation", item("Parser", "completed"))]);
    expect(finished.current).toBeNull();
    expect(finished.completed).toBe(2);
    expect(finished.included).toBe(2);
  });

  it("aggregates stamps across todo phases mapped to the same SDLC phase", () => {
    const progress = progressOf([
      phase("Implementation", item("Parser", "completed", { startedAt: at(3), completedAt: at(9) })),
      phase("Implement the UI", item("Form", "completed", { startedAt: at(1), completedAt: at(7) })),
      phase(
        "Testing",
        item("Unit tests", "completed", { startedAt: at(10), completedAt: at(12) }),
        item("E2E", "in_progress", { startedAt: at(13) }),
      ),
    ]);
    expect(entry(progress, "implementation")).toMatchObject({
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
    expect(entry(progress, "planning")).toMatchObject({ startedAt: null, completedAt: null });
  });
});

describe("sdlcProgress violations", () => {
  it("flags a phase started before an earlier one was complete", () => {
    const progress = progressOf([
      phase("Planning", item("Scope", "completed")),
      phase("Design", item("Schema", "pending")),
      phase("Implementation", item("Parser", "in_progress")),
    ]);
    expect(progress.violations).toEqual([
      { phase: "implementation", requires: "design", message: "Implementation started before Design was complete" },
    ]);
  });

  it("reports only the earliest unfinished earlier phase per started phase", () => {
    const progress = progressOf([
      phase("Planning", item("Scope", "in_progress")),
      phase("Design", item("Schema", "pending")),
      phase("Implementation", item("Parser", "completed")),
      phase("Testing", item("Run tests", "in_progress")),
    ]);
    expect(progress.violations).toEqual([
      { phase: "implementation", requires: "planning", message: "Implementation started before Planning was complete" },
      { phase: "testing", requires: "planning", message: "Testing started before Planning was complete" },
    ]);
  });

  it("flags Deployment without a Testing phase, but not when nothing was implemented", () => {
    const untested = progressOf([
      phase("Planning", item("Scope", "completed")),
      phase("Implementation", item("Parser", "completed")),
      phase("Deployment", item("Changelog", "in_progress")),
    ]);
    expect(untested.violations).toEqual([
      { phase: "deployment", requires: "testing", message: "Deployment started without a Testing phase" },
    ]);

    const docsOnly = progressOf([phase("Planning", item("Scope", "completed")), phase("Deployment", item("Docs", "completed"))]);
    expect(docsOnly.violations).toEqual([]);
  });

  it("has no violations for a sequential list, even with phases still pending", () => {
    const sequential = progressOf([
      phase("Planning", item("Scope", "completed")),
      phase("Feasibility", item("Spike", "completed")),
      phase("Design", item("Schema", "completed")),
      phase("Implementation", item("Parser", "completed")),
      phase("Testing", item("Run tests", "completed")),
      phase("Deployment", item("Changelog", "in_progress")),
    ]);
    expect(sequential.violations).toEqual([]);

    const early = progressOf([
      phase("Planning", item("Scope", "in_progress")),
      phase("Implementation", item("Parser", "pending")),
      phase("Testing", item("Run tests", "pending")),
    ]);
    expect(early.violations).toEqual([]);
  });
});

describe("releaseGate", () => {
  it("is null without progress or for a non-canonical list", () => {
    expect(releaseGate(null)).toBeNull();
    const legacy = progressOf([phase("Build", item("Write code", "completed")), phase("Ship", item("Push", "pending"))]);
    expect(legacy.canonical).toBe(false);
    expect(releaseGate(legacy)).toBeNull();
  });

  it("blocks an implementation that was never tested", () => {
    const progress = progressOf([phase("Planning", item("Scope", "completed")), phase("Implementation", item("Parser", "completed"))]);
    expect(releaseGate(progress)).toBe("No Testing phase: the implementation was never tested");
    expect(releaseGate(progressOf([phase("Planning", item("Scope", "completed"))]))).toBeNull();
  });

  it("blocks unfinished testing, counting items that are not abandoned", () => {
    const progress = progressOf([
      phase("Planning", item("Scope", "completed")),
      phase("Implementation", item("Parser", "completed")),
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
      phase("Planning", item("Scope", "completed")),
      phase("Implementation", item("Parser", "completed")),
      phase("Testing", item("Unit tests", "completed"), item("Flaky", "abandoned")),
      phase("Deployment", item("Changelog", "pending")),
    ]);
    expect(releaseGate(progress)).toBeNull();
  });
});

describe("sdlcChange", () => {
  it("reports the phase entered and the phases completed", () => {
    const before = progressOf([phase("Planning", item("Scope", "in_progress")), phase("Implementation", item("Parser"))]);
    const after = progressOf([phase("Planning", item("Scope", "completed")), phase("Implementation", item("Parser", "in_progress"))]);
    expect(sdlcChange(before, after)).toEqual({ entered: "implementation", completed: ["planning"], violations: [] });
    expect(sdlcChange(after, after)).toEqual({ entered: null, completed: [], violations: [] });
  });

  it("treats every done phase as completed when there was no previous snapshot", () => {
    const after = progressOf([
      phase("Planning", item("Scope", "completed")),
      phase("Design", item("Schema", "completed")),
      phase("Implementation", item("Parser", "in_progress")),
    ]);
    expect(sdlcChange(null, after)).toEqual({
      entered: "implementation",
      completed: ["planning", "design"],
      violations: [],
    });
  });

  it("reports only new violations", () => {
    const before = progressOf([
      phase("Planning", item("Scope", "completed")),
      phase("Design", item("Schema", "pending")),
      phase("Implementation", item("Parser", "in_progress")),
    ]);
    const after = progressOf([
      phase("Planning", item("Scope", "completed")),
      phase("Design", item("Schema", "pending")),
      phase("Implementation", item("Parser", "completed")),
      phase("Deployment", item("Changelog", "in_progress")),
    ]);
    expect(after.violations).toHaveLength(3);
    expect(sdlcChange(before, after)).toEqual({
      entered: "deployment",
      completed: ["implementation"],
      violations: [
        { phase: "deployment", requires: "design", message: "Deployment started before Design was complete" },
        { phase: "deployment", requires: "testing", message: "Deployment started without a Testing phase" },
      ],
    });
  });

  it("reports nothing without a current snapshot", () => {
    const before = progressOf([phase("Planning", item("Scope", "completed"))]);
    expect(sdlcChange(before, null)).toEqual({ entered: null, completed: [], violations: [] });
  });
});
