import { describe, expect, it } from "vitest";
import {
  CONTACT_TTL_MS,
  SYSTEMS,
  activitySystem,
  boardContact,
  buildLinks,
  systemLoad,
  toolSystem,
} from "@/components/visualize/agent-map";
import type { LiveAgent } from "@/components/visualize/use-live-agents";
import type { QueueEntry, QueueSnapshot, SubagentSnapshot } from "@/lib/types";

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
    drafting: false,
    planNote: null,
    createdByTaskId: null,
    ...extra,
  };
}

function queue(running: QueueEntry[], queued: QueueEntry[] = []): QueueSnapshot {
  return { limit: 4, concurrency: {} as QueueSnapshot["concurrency"], running, queued, planning: [] };
}

function liveAgent(extra: Partial<LiveAgent> = {}): LiveAgent {
  return { helpers: {}, contacts: [], ...extra };
}

function helper(id: string, status: SubagentSnapshot["status"], currentTool?: string): SubagentSnapshot {
  return { id, agent: "task", status, currentTool };
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

describe("systemLoad", () => {
  it("counts running agents and their busy helpers per system", () => {
    const q = queue([entry(A, "running"), entry(B, "running")], [entry(C, "queued")]);
    const live = {
      [A]: liveAgent({
        activity: { icon: "terminal", label: "Running a command", tool: "bash" },
        helpers: {
          h1: helper("h1", "running", "read"),
          h2: helper("h2", "pending", "grep"),
          h3: helper("h3", "completed", "bash"),
          h4: helper("h4", "running"),
        },
      }),
      [B]: liveAgent({
        activity: { icon: "think", label: "Thinking" },
        helpers: { h5: helper("h5", "running", "bash") },
      }),
      [C]: liveAgent({ activity: { icon: "terminal", label: "Running a command", tool: "bash" } }),
    };
    const load = systemLoad(q, live);
    expect(Object.keys(load)).toEqual(SYSTEMS.map((s) => s.id));
    expect(load.shell).toEqual({ taskIds: [A, B], helpers: 1 });
    expect(load.files).toEqual({ taskIds: [A], helpers: 2 });
    expect(load.model).toEqual({ taskIds: [B], helpers: 0 });
    expect(load.web).toEqual({ taskIds: [], helpers: 0 });
  });
});
