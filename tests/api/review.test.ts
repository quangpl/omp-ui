import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { api, freshEnv, ompLaunches, setupAdmin, teardown, tempDir, waitFor } from "./helpers";

import * as boardTasksRoute from "@/app/api/v1/boards/[id]/tasks/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import * as healthRoute from "@/app/api/v1/health/route";
import * as taskReviewRoute from "@/app/api/v1/tasks/[id]/review/route";
import * as taskRoute from "@/app/api/v1/tasks/[id]/route";
import { getRepo } from "@/lib/db";
import type { Board, Comment, Run, Task, TaskReviewResult } from "@/lib/types";

interface TaskDetail {
  task: Task;
  comments: Comment[];
  runs: Run[];
}

const MISSING_ID = "00000000-0000-0000-0000-000000000000";
const AGENT_TIMEOUT = 20_000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HASH = "3f2a9c";

let board: Board;

async function createTask(input: Record<string, unknown>): Promise<Task> {
  const res = await api<Task>(boardTasksRoute, "POST", `/boards/${board.id}/tasks`, {
    body: input,
    params: { id: board.id },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function detail(id: string): Promise<TaskDetail> {
  const res = await api<TaskDetail>(taskRoute, "GET", `/tasks/${id}`, { params: { id } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

function review(id: string, body: unknown) {
  return api<TaskReviewResult & { error?: string }>(taskReviewRoute, "POST", `/tasks/${id}/review`, {
    body,
    params: { id },
  });
}

/** Wait until no agent is running or queued (a finished run is released right after its last write). */
function waitIdle(): Promise<boolean> {
  return waitFor(async () => {
    const res = await api<{ agents: { running: string[]; queued: string[] } }>(healthRoute, "GET", "/health", {
      token: null,
    });
    return res.body.agents.running.length === 0 && res.body.agents.queued.length === 0;
  }, AGENT_TIMEOUT);
}

beforeAll(async () => {
  await freshEnv();
  await setupAdmin();
  const res = await api<Board>(boardsRoute, "POST", "/boards", {
    body: { name: "Reviewed", workdir: tempDir("review-project"), autoRun: false },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  board = res.body;
});

beforeEach(async () => {
  await waitIdle();
});

afterAll(teardown);

describe("POST /tasks/:id/review", () => {
  it("starts with no review on a new card", async () => {
    const task = await createTask({ title: "Fresh card" });
    expect(task.review).toBeNull();
    expect((await detail(task.id)).task.review).toBeNull();
  });

  it("approve moves an idle In progress card to Done and stores the review", async () => {
    const task = await createTask({ title: "Ship the cart", status: "in_progress" });
    expect(task.agentState).toBe("idle");

    const res = await review(task.id, { decision: "approve", hash: HASH });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.comment).toBeNull();
    expect(res.body.task.status).toBe("done");
    expect(res.body.task.review).toMatchObject({ decision: "approved", hash: HASH, note: null });
    expect(res.body.task.review?.at).toMatch(ISO);

    const stored = await detail(task.id);
    expect(stored.task).toEqual(res.body.task);
    expect(stored.comments).toEqual([]);
  });

  it("approve puts the card on top of Done, above cards already there", async () => {
    const earlier = await createTask({ title: "Shipped before", status: "done" });
    const task = await createTask({ title: "Ship the footer", status: "in_progress" });

    const res = await review(task.id, { decision: "approve", hash: HASH });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.task.status).toBe("done");

    const done = (await detail(earlier.id)).task;
    expect(res.body.task.position).toBeLessThan(done.position);
    const repo = await getRepo();
    const column = (await repo.listTasks(board.id)).filter((t) => t.status === "done");
    expect(Math.min(...column.map((t) => t.position))).toBe(res.body.task.position);
  });

  it("approve keeps a Done card in Done and stores the optional note; blank note and hash read as null", async () => {
    const task = await createTask({ title: "Already done", status: "done" });

    const noted = await review(task.id, { decision: "approve", note: "  Looks good  ", hash: HASH });
    expect(noted.status, JSON.stringify(noted.body)).toBe(200);
    expect(noted.body.task.status).toBe("done");
    expect(noted.body.task.review).toMatchObject({ decision: "approved", hash: HASH, note: "Looks good" });

    const blank = await review(task.id, { decision: "approve", note: "   ", hash: "" });
    expect(blank.status, JSON.stringify(blank.body)).toBe(200);
    expect(blank.body.task.review).toMatchObject({ decision: "approved", hash: null, note: null });
  });

  it("refuses to approve while the agent is running or queued", async () => {
    const task = await createTask({ title: "Busy card", status: "in_progress" });
    const repo = await getRepo();

    for (const agentState of ["running", "queued"] as const) {
      await repo.updateTask(task.id, { agentState });
      const res = await review(task.id, { decision: "approve", hash: HASH });
      expect(res.status, agentState).toBe(409);
      expect(res.body).toEqual({ error: "The agent is still working; stop it or wait before approving" });
    }
    await repo.updateTask(task.id, { agentState: "idle" });

    const unchanged = await detail(task.id);
    expect(unchanged.task.status).toBe("in_progress");
    expect(unchanged.task.review).toBeNull();
  });

  it("request_changes requires a note", async () => {
    const task = await createTask({ title: "Needs a note", status: "in_progress" });

    for (const body of [
      { decision: "request_changes" },
      { decision: "request_changes", note: null },
      { decision: "request_changes", note: "   " },
      { decision: "request_changes", note: 42 },
      { decision: "request_changes", note: "x".repeat(10_001) },
    ]) {
      const res = await review(task.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(typeof res.body.error).toBe("string");
    }

    const unchanged = await detail(task.id);
    expect(unchanged.task.review).toBeNull();
    expect(unchanged.comments).toEqual([]);
  });

  it(
    "request_changes stores the review and posts the note as feedback that resumes the agent",
    async () => {
      const task = await createTask({ title: "Polish the header", status: "in_progress" });
      const launchesBefore = ompLaunches().length;

      const res = await review(task.id, { decision: "request_changes", note: "  Use the brand colour  ", hash: HASH });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.task.review).toMatchObject({
        decision: "changes_requested",
        hash: HASH,
        note: "Use the brand colour",
      });
      expect(res.body.task.review?.at).toMatch(ISO);
      expect(res.body.comment).toMatchObject({ taskId: task.id, author: "user" });
      expect(res.body.comment?.body.startsWith("**Changes requested**")).toBe(true);
      expect(res.body.comment?.body).toBe("**Changes requested**\n\nUse the brand colour");

      // The feedback starts a run that picks the note up.
      await waitIdle();
      expect(ompLaunches().length).toBeGreaterThan(launchesBefore);
      const after = await detail(task.id);
      expect(after.comments.find((c) => c.id === res.body.comment?.id)).toMatchObject({ author: "user" });
      expect(after.runs.some((r) => r.prompt.includes("Use the brand colour"))).toBe(true);
      expect(after.task.review).toEqual(res.body.task.review);
    },
    60_000,
  );

  it("rejects an unknown decision", async () => {
    const task = await createTask({ title: "Bad decision" });
    for (const decision of [undefined, "approved", "reject", 1]) {
      const res = await review(task.id, { decision });
      expect(res.status, String(decision)).toBe(400);
      expect(typeof res.body.error).toBe("string");
    }
  });

  it("rejects a hash that is not a short string", async () => {
    const task = await createTask({ title: "Bad hash" });
    for (const hash of [42, "h".repeat(129)]) {
      const res = await review(task.id, { decision: "approve", hash });
      expect(res.status).toBe(400);
    }
  });

  it("answers 404 for an unknown card", async () => {
    const res = await review(MISSING_ID, { decision: "approve" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Task not found" });
  });
});
