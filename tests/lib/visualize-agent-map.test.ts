import { describe, expect, it } from "vitest";
import {
  CONTACT_TTL_MS,
  ROLE_PHASE,
  activitySystem,
  boardContact,
  buildLinks,
  floorPlan,
  type SdlcPipeline,
  sdlcPipeline,
  sdlcStation,
  toolSystem,
} from "@/components/visualize/agent-map";
import type { AgentRole } from "@/components/visualize/roles";
import { EMPTY_STATS, type LiveAgent } from "@/components/visualize/use-live-agents";
import { SDLC_PHASES, type SdlcPhaseId, type SdlcPhaseStatus, type SdlcProgress, type SdlcViolation } from "@/lib/sdlc";
import type { Dashboard, QueueEntry, QueueSnapshot, SubagentSnapshot } from "@/lib/types";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

function entry(taskId: string, state: QueueEntry["state"], extra: Partial<QueueEntry> = {}): QueueEntry {
  return {
    taskId,
    boardId: "board",
    boardName: "Project",
    title: `Card ${taskId}`,
    state,
    waitingFor: [],
    planning: false,
    planNote: null,
    createdByTaskId: null,
    sdlc: null,
    node: null,
    ...extra,
  };
}

function queue(running: QueueEntry[], queued: QueueEntry[] = []): QueueSnapshot {
  return { limit: 4, concurrency: {} as QueueSnapshot["concurrency"], running, queued, planning: [] };
}

function liveAgent(extra: Partial<LiveAgent> = {}): LiveAgent {
  return { helpers: {}, contacts: [], stats: EMPTY_STATS, ...extra };
}

function helper(id: string, status: SubagentSnapshot["status"], currentTool?: string, agent = "task"): SubagentSnapshot {
  return { id, agent, status, currentTool };
}

/** SDLC progress: listed phases get their status, the rest are skipped. */
function progress(
  statuses: Partial<Record<SdlcPhaseId, SdlcPhaseStatus>>,
  current: SdlcPhaseId | null,
  violations: SdlcViolation[] = [],
): SdlcProgress {
  const phases = SDLC_PHASES.map((id) => {
    const status = statuses[id] ?? "skipped";
    return { id, status, done: status === "done" ? 2 : 0, total: status === "skipped" ? 0 : 2, current: null, startedAt: null, completedAt: null };
  });
  return {
    phases,
    current,
    completed: phases.filter((p) => p.status === "done").length,
    included: phases.filter((p) => p.status !== "skipped").length,
    canonical: true,
    violations,
  };
}

describe("toolSystem", () => {
  it("maps tools to the system they touch", () => {
    expect(toolSystem("bash")).toBe("shell");
    expect(toolSystem("eval")).toBe("shell");
    expect(toolSystem("edit")).toBe("files");
    expect(toolSystem("lsp")).toBe("files");
    expect(toolSystem("web_search")).toBe("web");
    expect(toolSystem("browser")).toBe("web");
    expect(toolSystem("memory_search")).toBe("memory");
    expect(toolSystem("mcp__agentmemory_memory_recall")).toBe("memory");
    expect(toolSystem("board_create_card")).toBe("board");
    expect(toolSystem("ask_advisor")).toBe("advisor");
    expect(toolSystem("task")).toBe("helpers");
    expect(toolSystem("wait")).toBe("helpers");
    expect(toolSystem("todo")).toBe("model");
  });

  it("returns null for unknown tools", () => {
    expect(toolSystem("mystery")).toBeNull();
    expect(toolSystem("constructor")).toBeNull();
  });
});

describe("activitySystem", () => {
  it("uses the tool, else the model while thinking or writing", () => {
    expect(activitySystem({ icon: "terminal", label: "Running a command", tool: "bash" })).toBe("shell");
    expect(activitySystem({ icon: "think", label: "Thinking" })).toBe("model");
    expect(activitySystem({ icon: "write", label: "Writing a reply" })).toBe("model");
    expect(activitySystem({ icon: "status", label: "Starting" })).toBeNull();
    expect(activitySystem(undefined)).toBeNull();
  });
});

describe("boardContact", () => {
  it("reads card ids from the recorded JSON arguments", () => {
    expect(boardContact("board_message_card", JSON.stringify({ cardId: A, message: "ping" }))).toEqual({
      kind: "message",
      cardIds: [A],
    });
    expect(boardContact("board_wait_for_cards", JSON.stringify({ cardIds: [A, B, A] }))).toEqual({
      kind: "wait",
      cardIds: [A, B],
    });
    expect(boardContact("board_read_card", JSON.stringify({ cardId: "short-id" }))).toEqual({
      kind: "inspect",
      cardIds: ["short-id"],
    });
  });

  it("falls back to the card ids a truncated detail mentions", () => {
    expect(boardContact("board_wait_for_cards", `{"cardIds":["${A}","${B}","${A}","3333…`)).toEqual({
      kind: "wait",
      cardIds: [A, B],
    });
    expect(boardContact("board_message_card", `{"cardId":"${C}","message":"Please rebase on…`)).toEqual({
      kind: "message",
      cardIds: [C],
    });
  });

  it("returns null for other tools or when no card is named", () => {
    expect(boardContact("bash", JSON.stringify({ cardId: A }))).toBeNull();
    expect(boardContact("board_create_card", JSON.stringify({ title: "x" }))).toBeNull();
    expect(boardContact("board_message_card", "Asking the API card about the schema")).toBeNull();
    expect(boardContact("board_message_card", undefined)).toBeNull();
  });
});

describe("buildLinks", () => {
  const now = Date.parse("2026-11-13T12:00:00.000Z");
  const recent = new Date(now - 60_000).toISOString();
  const expired = new Date(now - CONTACT_TTL_MS - 1).toISOString();

  it("links dependencies, delegations and recent contacts", () => {
    const q = queue([entry(A, "running"), entry(B, "running", { createdByTaskId: A })], [
      entry(C, "queued", { waitingFor: [A, B], createdByTaskId: A }),
    ]);
    const live = {
      [A]: liveAgent({
        contacts: [
          { kind: "message", cardIds: [B], at: recent },
          { kind: "wait", cardIds: [C], at: expired },
        ],
      }),
      [B]: liveAgent({ contacts: [{ kind: "inspect", cardIds: [A], at: recent }] }),
    };
    expect(buildLinks(q, live, now)).toEqual(
      expect.arrayContaining([
        { kind: "depends", from: A, to: C },
        { kind: "depends", from: B, to: C },
        { kind: "delegate", from: A, to: B },
        { kind: "delegate", from: A, to: C },
        { kind: "message", from: A, to: B },
        { kind: "inspect", from: B, to: A },
      ]),
    );
    expect(buildLinks(q, live, now)).toHaveLength(6);
  });

  it("drops expired contacts and self-links and dedupes repeats", () => {
    const q = queue([entry(A, "running", { createdByTaskId: A })]);
    const live = {
      [A]: liveAgent({
        contacts: [
          { kind: "message", cardIds: [B], at: expired },
          { kind: "wait", cardIds: [A], at: recent },
          { kind: "inspect", cardIds: [B, B], at: recent },
          { kind: "inspect", cardIds: [B], at: new Date(now - 30_000).toISOString() },
        ],
      }),
    };
    expect(buildLinks(q, live, now)).toEqual([{ kind: "inspect", from: A, to: B }]);
  });
});

describe("floorPlan", () => {
  const card = (id: string) => ({ id, boardId: "board", boardName: "Project", title: `Card ${id}` }) as Dashboard["finished"][number];
  const ids = (workers: { id: string }[]) => workers.map((worker) => worker.id);

  it("puts running agents and busy subagents in the room of the system they use", () => {
    const q = queue([entry(A, "running"), entry(B, "running")]);
    const live = {
      [A]: liveAgent({
        activity: { icon: "terminal", label: "Running a command", tool: "bash" },
        helpers: {
          h1: helper("h1", "running", "read"),
          h2: helper("h2", "pending"),
          h3: helper("h3", "completed", "bash"),
        },
      }),
      [B]: liveAgent({ activity: { icon: "think", label: "Thinking" } }),
    };
    const { rooms, placed } = floorPlan({ queue: q, attention: [], finished: [] }, live, new Map());
    expect(ids(rooms.shell)).toEqual([`card:${A}`]);
    expect(ids(rooms.files)).toEqual([`sub:${A}:h1`]);
    // A busy subagent without a tool waits in the subagent room; finished ones leave the floor.
    expect(ids(rooms.helpers)).toEqual([`sub:${A}:h2`]);
    expect(ids(rooms.model)).toEqual([`card:${B}`]);
    expect(placed.get(`card:${A}`)).toBe("shell");
  });

  it("keeps an agent in its previous room while its activity names no system, else starts at the model", () => {
    const q = queue([entry(A, "running"), entry(B, "running")]);
    const live = { [A]: liveAgent({ activity: { icon: "error", label: "Error" } }) };
    const { rooms } = floorPlan({ queue: q, attention: [], finished: [] }, live, new Map([[`card:${A}`, "web"]]));
    expect(ids(rooms.web)).toEqual([`card:${A}`]);
    expect(ids(rooms.model)).toEqual([`card:${B}`]);
  });

  it("queues in intake, attention in rework, finished on the dock, each card once", () => {
    const q = queue([entry(A, "running")], [entry(B, "queued"), entry(C, "queued")]);
    const D = "44444444-4444-4444-8444-444444444444";
    const { rooms } = floorPlan(
      { queue: q, attention: [{ ...card(A), reason: "failed" }, { ...card(D), reason: "stalled" }], finished: [card(C), card(D)] },
      {},
      new Map(),
    );
    expect(rooms.intake.map((w) => (w.kind === "queued" ? w.position : null))).toEqual([1, 2]);
    expect(ids(rooms.intake)).toEqual([`card:${B}`, `card:${C}`]);
    expect(ids(rooms.rework)).toEqual([`card:${D}`]);
    expect(ids(rooms.shipping)).toEqual([]);
  });
});

describe("ROLE_PHASE", () => {
  it("staffs each SDLC phase with the roles that work in it", () => {
    const byPhase = (phase: SdlcPhaseId | null) =>
      (Object.keys(ROLE_PHASE) as AgentRole[]).filter((role) => ROLE_PHASE[role] === phase).sort();
    expect(byPhase("planning")).toEqual(["oracle", "planner", "scout"]);
    expect(byPhase("design")).toEqual(["designer"]);
    expect(byPhase("implementation")).toEqual(["sprinter", "worker"]);
    expect(byPhase("testing")).toEqual(["guard", "reviewer"]);
    expect(byPhase(null)).toEqual(["helper", "lead"]);
  });
});

describe("sdlcPipeline", () => {
  const ids = (pipeline: SdlcPipeline, phase: SdlcPhaseId) =>
    pipeline.stations[phase].workers.map((worker) => worker.id);

  it("puts a running card at its current phase, at Planning without a plan, at its last included phase when all are done", () => {
    const D = "44444444-4444-4444-8444-444444444444";
    const q = queue(
      [
        entry(A, "running", { sdlc: progress({ planning: "done", implementation: "active", testing: "pending" }, "implementation") }),
        entry(B, "running"),
        entry(C, "running", { sdlc: progress({ planning: "done", implementation: "done", testing: "done" }, null) }),
      ],
      [entry(D, "queued")],
    );
    const pipeline = sdlcPipeline(q, {});
    expect(ids(pipeline, "implementation")).toEqual([`card:${A}`]);
    expect(ids(pipeline, "planning")).toEqual([`card:${B}`]);
    expect(ids(pipeline, "testing")).toEqual([`card:${C}`]);
    expect(ids(pipeline, "deployment")).toEqual([]);
    expect(pipeline.backlog).toBe(1);
  });

  it("puts busy subagents at their role's phase, helpers at their lead's phase, after the leads", () => {
    const q = queue([
      entry(A, "running", { sdlc: progress({ planning: "done", design: "active" }, "design") }),
      entry(B, "running", { sdlc: progress({ planning: "active" }, "planning") }),
    ]);
    const live = {
      [A]: liveAgent({
        helpers: {
          s: helper("s", "running", undefined, "scout"),
          w: helper("w", "pending", undefined, "task"),
          r: helper("r", "running", undefined, "reviewer"),
          h: helper("h", "running", undefined, "my-custom-agent"),
          done: helper("done", "completed", undefined, "task"),
        },
      }),
    };
    const pipeline = sdlcPipeline(q, live);
    expect(ids(pipeline, "planning")).toEqual([`card:${B}`, `sub:${A}:s`]);
    expect(ids(pipeline, "design")).toEqual([`card:${A}`, `sub:${A}:h`]);
    expect(ids(pipeline, "implementation")).toEqual([`sub:${A}:w`]);
    expect(ids(pipeline, "testing")).toEqual([`sub:${A}:r`]);
  });

  it("counts early starts per phase and breaches per quality gate crossed", () => {
    const early: SdlcViolation = { phase: "deployment", requires: "testing", message: "Deployment started before Testing was complete" };
    const skipped: SdlcViolation = { phase: "implementation", requires: "planning", message: "Implementation started before Planning was complete" };
    const q = queue([
      entry(A, "running", { sdlc: progress({ planning: "done", implementation: "done", testing: "active", deployment: "active" }, "testing", [early]) }),
      entry(B, "running", { sdlc: progress({ planning: "active", implementation: "active" }, "planning", [skipped]) }),
      entry(C, "running", { sdlc: progress({ planning: "done", implementation: "active" }, "implementation") }),
    ]);
    const { stations } = sdlcPipeline(q, {});
    expect(stations.deployment.alerts).toBe(1);
    expect(stations.implementation.alerts).toBe(1);
    expect(stations.testing.alerts).toBe(0);
    // The release gate (Testing → Deployment) was crossed by A only.
    expect(stations.testing.breaches.map((breach) => breach.entry.taskId)).toEqual([A]);
    // B skipped past the Planning, Feasibility and Design gates.
    expect(stations.planning.breaches.map((breach) => breach.entry.taskId)).toEqual([B]);
    expect(stations.feasibility.breaches.map((breach) => breach.violation)).toEqual([skipped]);
    expect(stations.design.breaches.map((breach) => breach.entry.taskId)).toEqual([B]);
    expect(stations.implementation.breaches).toEqual([]);
    expect(stations.maintenance.breaches).toEqual([]);
  });

  it("lists visible phases: the required ones plus when-needed phases a card includes or a subagent executes", () => {
    // No running cards: only the required phases.
    expect(sdlcPipeline(queue([]), {}).visible).toEqual(["planning", "implementation", "testing"]);
    // A minimal plan (and a card without a plan) adds nothing.
    const minimal = queue([
      entry(A, "running", { sdlc: progress({ planning: "done", implementation: "active", testing: "pending" }, "implementation") }),
      entry(B, "running"),
    ]);
    expect(sdlcPipeline(minimal, {}).visible).toEqual(["planning", "implementation", "testing"]);
    // A plan that includes Design reveals it, in SDLC order.
    const withDesign = queue([
      entry(A, "running", { sdlc: progress({ planning: "done", design: "active", implementation: "pending", testing: "pending" }, "design") }),
    ]);
    expect(sdlcPipeline(withDesign, {}).visible).toEqual(["planning", "design", "implementation", "testing"]);
    // A busy designer subagent reveals Design even when no plan includes it.
    const live = { [A]: liveAgent({ helpers: { d: helper("d", "running", undefined, "designer") } }) };
    expect(sdlcPipeline(queue([entry(A, "running")]), live).visible).toEqual(["planning", "design", "implementation", "testing"]);
  });
});

describe("sdlcStation", () => {
  it("falls back to Planning when nothing is included", () => {
    expect(sdlcStation(progress({}, null))).toBe("planning");
    expect(sdlcStation(null)).toBe("planning");
  });
});
