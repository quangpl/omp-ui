import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, freshEnv, setupAdmin, teardown, tempDir, waitFor } from "./helpers";

import * as boardsRoute from "@/app/api/v1/boards/route";
import * as schedulerLogsRoute from "@/app/api/v1/schedulers/[id]/logs/route";
import * as schedulerRoute from "@/app/api/v1/schedulers/[id]/route";
import * as schedulerRunRoute from "@/app/api/v1/schedulers/[id]/run/route";
import * as schedulerRunsRoute from "@/app/api/v1/schedulers/[id]/runs/route";
import * as schedulersRoute from "@/app/api/v1/schedulers/route";
import * as taskRoute from "@/app/api/v1/tasks/[id]/route";
import { getAgentManager } from "@/lib/agent/manager";
import { getRepo } from "@/lib/db";
import { subscribe } from "@/lib/events";
import { runDueSchedulers } from "@/lib/scheduler";
import type { Board, Scheduler, SchedulerLogEntry, SchedulerRunView, ServerEvent, Task } from "@/lib/types";

const UNKNOWN_ID = "deadbeef-0000-4000-8000-0000000000aa";
/** A short single line: the card starts right away, without the card writer. */
const PROMPT = "Rename the save button";
/**
 * Every test schedule fires on January 1st only, so the background due check (real time) never
 * fires one while the suite runs; due runs are driven through runDueSchedulers with a later `now`.
 */
const NEW_YEAR = "0 0 1 1 *";

let board: Board;
let otherBoard: Board;

/** Next January 1st 00:00 UTC strictly after `after`. */
function nextNewYear(after: Date): string {
  return new Date(Date.UTC(after.getUTCFullYear() + 1, 0, 1)).toISOString();
}

async function createBoard(name: string): Promise<Board> {
  const res = await api<Board>(boardsRoute, "POST", "/boards", {
    body: { name, workdir: tempDir(name.toLowerCase()), autoRun: false },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function createScheduler(body: Record<string, unknown>): Promise<Scheduler> {
  const res = await api<Scheduler>(schedulersRoute, "POST", "/schedulers", {
    body: { boardId: board.id, prompt: PROMPT, cron: NEW_YEAR, ...body },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function getScheduler(id: string): Promise<Scheduler> {
  const res = await api<Scheduler>(schedulerRoute, "GET", `/schedulers/${id}`, { params: { id } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

function patchScheduler(id: string, body: unknown) {
  return api<Scheduler & { error?: string }>(schedulerRoute, "PATCH", `/schedulers/${id}`, { body, params: { id } });
}

async function listRuns(id: string): Promise<SchedulerRunView[]> {
  const res = await api<SchedulerRunView[]>(schedulerRunsRoute, "GET", `/schedulers/${id}/runs`, { params: { id } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function getTask(id: string): Promise<Task> {
  const res = await api<{ task: Task }>(taskRoute, "GET", `/tasks/${id}`, { params: { id } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.task;
}

/** Wait for the card's fake agent run to finish so no work leaks into the next test. */
async function settle(taskId: string): Promise<Task> {
  return waitFor(async () => {
    const task = await getTask(taskId);
    return task.status === "done" && task.agentState !== "running" && task.agentState !== "queued" ? task : null;
  });
}

/** Delete every scheduler, so due checks only see the ones a test creates. */
async function clearSchedulers(): Promise<void> {
  const all = (await api<Scheduler[]>(schedulersRoute, "GET", "/schedulers")).body;
  for (const s of all) await api(schedulerRoute, "DELETE", `/schedulers/${s.id}`, { params: { id: s.id } });
}

async function due(now: Date): Promise<number> {
  return runDueSchedulers(await getRepo(), await getAgentManager(), now);
}

beforeAll(async () => {
  await freshEnv();
  await setupAdmin();
  board = await createBoard("Shop");
  otherBoard = await createBoard("Blog");
});

afterAll(teardown);

describe("/schedulers CRUD", () => {
  it("POST validates its input", async () => {
    for (const [body, status] of [
      [{ cron: "nope" }, 400],
      [{ cron: "61 * * * *" }, 400],
      [{ cron: "" }, 400],
      [{ timezone: "Mars/Olympus_Mons" }, 400],
      [{ maxRuns: 0 }, 400],
      [{ maxRuns: 1.5 }, 400],
      [{ enabled: "yes" }, 400],
      [{ prompt: "   " }, 400],
      [{ name: "" }, 400],
      [{ boardId: "" }, 400],
      [{ boardId: UNKNOWN_ID }, 404],
    ] as const) {
      const res = await api(schedulersRoute, "POST", "/schedulers", {
        body: { boardId: board.id, prompt: PROMPT, cron: NEW_YEAR, ...body },
      });
      expect(res.status, JSON.stringify(body)).toBe(status);
    }
    expect((await api<Scheduler[]>(schedulersRoute, "GET", "/schedulers")).body).toEqual([]);
  });

  it("POST defaults the name, time zone, enabled and maxRuns and computes the next fire time", async () => {
    const before = new Date();
    const events: ServerEvent[] = [];
    const unsubscribe = subscribe((event) => events.push(event));
    const res = await api<Scheduler>(schedulersRoute, "POST", "/schedulers", {
      body: { boardId: board.id, prompt: `\n  Weekly dependency check  \nbump what is outdated`, cron: NEW_YEAR },
    });
    unsubscribe();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      boardId: board.id,
      name: "Weekly dependency check",
      prompt: "Weekly dependency check  \nbump what is outdated",
      cron: NEW_YEAR,
      timezone: "UTC",
      enabled: true,
      maxRuns: null,
      runCount: 0,
      lastRunAt: null,
      lastStatus: null,
      lastTaskId: null,
      lastError: null,
      nextRunAt: nextNewYear(before),
    });
    expect(Date.parse(res.body.nextRunAt!)).toBeGreaterThan(before.getTime());
    expect(events).toContainEqual({ type: "scheduler.updated", scheduler: res.body });
    expect(await getScheduler(res.body.id)).toEqual(res.body);

    const long = await createScheduler({ prompt: "x".repeat(150) });
    expect(long.name).toBe("x".repeat(100));
    const named = await createScheduler({ name: "  Nightly  ", enabled: false, maxRuns: 3 });
    expect(named).toMatchObject({ name: "Nightly", enabled: false, maxRuns: 3, nextRunAt: null });
    await clearSchedulers();
  });

  it("evaluates the cron expression in the scheduler's time zone", async () => {
    const s = await createScheduler({ cron: "30 9 * * *", timezone: "Europe/Berlin" });
    const next = new Date(s.nextRunAt!);
    // 09:30 in Berlin is 08:30 UTC in winter (CET) and 07:30 UTC in summer (CEST).
    expect(next.getUTCMinutes()).toBe(30);
    expect([7, 8]).toContain(next.getUTCHours());
    expect(next.getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(next.getTime()).toBeLessThanOrEqual(Date.now() + 25 * 60 * 60_000);
    await clearSchedulers();
  });

  it("GET lists schedulers, optionally of one project", async () => {
    const a = await createScheduler({ name: "A" });
    const b = await createScheduler({ name: "B", boardId: otherBoard.id });
    const all = (await api<Scheduler[]>(schedulersRoute, "GET", "/schedulers")).body;
    expect(all.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    const mine = await api<Scheduler[]>(schedulersRoute, "GET", `/schedulers?boardId=${board.id}`);
    expect(mine.status).toBe(200);
    expect(mine.body.map((s) => s.id)).toEqual([a.id]);
    const other = (await api<Scheduler[]>(schedulersRoute, "GET", `/schedulers?boardId=${otherBoard.id}`)).body;
    expect(other.map((s) => s.id)).toEqual([b.id]);
    expect((await api(schedulersRoute, "GET", `/schedulers?boardId=${UNKNOWN_ID}`)).status).toBe(404);
    await clearSchedulers();
  });

  it("answers 404 for an unknown scheduler", async () => {
    const params = { id: UNKNOWN_ID };
    expect((await api(schedulerRoute, "GET", `/schedulers/${UNKNOWN_ID}`, { params })).status).toBe(404);
    expect((await api(schedulerRoute, "PATCH", `/schedulers/${UNKNOWN_ID}`, { params, body: { name: "x" } })).status).toBe(
      404,
    );
    expect((await api(schedulerRoute, "DELETE", `/schedulers/${UNKNOWN_ID}`, { params })).status).toBe(404);
    expect((await api(schedulerRunRoute, "POST", `/schedulers/${UNKNOWN_ID}/run`, { params })).status).toBe(404);
    expect((await api(schedulerRunsRoute, "GET", `/schedulers/${UNKNOWN_ID}/runs`, { params })).status).toBe(404);
    expect((await api(schedulerLogsRoute, "GET", `/schedulers/${UNKNOWN_ID}/logs`, { params })).status).toBe(404);
  });

  it("PATCH edits fields, validates them and recomputes the next fire time when the schedule changes", async () => {
    const s = await createScheduler({});
    const renamed = await patchScheduler(s.id, { name: "Renamed", prompt: "Tidy the footer" });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: "Renamed", prompt: "Tidy the footer", nextRunAt: s.nextRunAt });

    for (const [body, status] of [
      [{ cron: "* * *" }, 400],
      [{ timezone: "Nowhere/Here" }, 400],
      [{ maxRuns: 0 }, 400],
      [{ enabled: 1 }, 400],
      [{ name: "  " }, 400],
      [{ boardId: UNKNOWN_ID }, 404],
    ] as const) {
      expect((await patchScheduler(s.id, body)).status, JSON.stringify(body)).toBe(status);
    }

    const disabled = await patchScheduler(s.id, { enabled: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({ enabled: false, nextRunAt: null });

    const before = new Date();
    const enabled = await patchScheduler(s.id, { enabled: true });
    expect(enabled.body).toMatchObject({ enabled: true, nextRunAt: nextNewYear(before) });

    const daily = await patchScheduler(s.id, { cron: "@daily" });
    expect(daily.status).toBe(200);
    const next = Date.parse(daily.body.nextRunAt!);
    expect(next).toBeGreaterThan(Date.now() - 1000);
    expect(next).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60_000);
    expect(new Date(next).toISOString()).toMatch(/T00:00:00\.000Z$/);

    const moved = await patchScheduler(s.id, { boardId: otherBoard.id, cron: NEW_YEAR });
    expect(moved.body).toMatchObject({ boardId: otherBoard.id, cron: NEW_YEAR, nextRunAt: nextNewYear(new Date()) });
    await clearSchedulers();
  });

  it("DELETE publishes scheduler.deleted", async () => {
    const s = await createScheduler({});
    const events: ServerEvent[] = [];
    const unsubscribe = subscribe((event) => events.push(event));
    const res = await api(schedulerRoute, "DELETE", `/schedulers/${s.id}`, { params: { id: s.id } });
    unsubscribe();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(events).toContainEqual({ type: "scheduler.deleted", schedulerId: s.id, boardId: board.id });
    expect((await api(schedulerRoute, "GET", `/schedulers/${s.id}`, { params: { id: s.id } })).status).toBe(404);
  });
});

describe("running schedulers", () => {
  it("a manual run creates a card linked to the scheduler, also while disabled", async () => {
    const s = await createScheduler({ enabled: false });
    const res = await api<SchedulerRunView>(schedulerRunRoute, "POST", `/schedulers/${s.id}/run`, {
      params: { id: s.id },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      schedulerId: s.id,
      trigger: "manual",
      status: "created",
      error: null,
      task: { title: PROMPT },
    });
    const taskId = res.body.taskId!;
    expect(res.body.task?.id).toBe(taskId);

    const card = await getTask(taskId);
    expect(card).toMatchObject({ boardId: board.id, title: PROMPT, schedulerId: s.id });

    const after = await getScheduler(s.id);
    expect(after).toMatchObject({
      enabled: false,
      nextRunAt: null,
      runCount: 1,
      lastStatus: "created",
      lastTaskId: taskId,
      lastError: null,
    });
    expect(after.lastRunAt).not.toBeNull();

    await settle(taskId);
    const runs = await listRuns(s.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: res.body.id, taskId, trigger: "manual", task: { id: taskId, status: "done" } });
    expect(runs[0].runStatus).not.toBeNull();
    await clearSchedulers();
  });

  it("runDueSchedulers fires a due scheduler exactly once and advances its next fire time", async () => {
    const s = await createScheduler({});
    const slot = s.nextRunAt!;
    const now = new Date(Date.parse(slot) + 60_000);

    expect(await due(new Date(Date.parse(slot) - 60_000))).toBe(0);
    expect(await due(now)).toBe(1);
    const after = await getScheduler(s.id);
    expect(after).toMatchObject({ enabled: true, runCount: 1, lastStatus: "created", nextRunAt: nextNewYear(now) });
    expect(after.lastRunAt).toBe(now.toISOString());
    expect(await due(now)).toBe(0);

    const runs = await listRuns(s.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "scheduled", scheduledFor: slot, status: "created" });
    expect((await getTask(runs[0].taskId!)).schedulerId).toBe(s.id);
    await settle(runs[0].taskId!);

    // Slots missed while the server was down fire once, then it moves on to the next one.
    const later = new Date(Date.parse(after.nextRunAt!) + 3 * 365 * 24 * 60 * 60_000);
    expect(await due(later)).toBe(1);
    expect(await due(later)).toBe(0);
    const caughtUp = await getScheduler(s.id);
    expect(caughtUp).toMatchObject({ runCount: 2, nextRunAt: nextNewYear(later) });
    const [latest] = await listRuns(s.id);
    expect(latest.scheduledFor).toBe(after.nextRunAt);
    await settle(latest.taskId!);
    await clearSchedulers();
  });

  it("never fires a disabled scheduler", async () => {
    const off = await createScheduler({ enabled: false });
    const paused = await createScheduler({});
    await patchScheduler(paused.id, { enabled: false });
    const farFuture = new Date(Date.UTC(2100, 0, 2));
    expect(await due(farFuture)).toBe(0);
    for (const s of [off, paused]) {
      expect(await getScheduler(s.id)).toMatchObject({ runCount: 0, lastRunAt: null, nextRunAt: null });
      expect(await listRuns(s.id)).toEqual([]);
    }
    await clearSchedulers();
  });

  it("disables itself once maxRuns is reached and refuses to be enabled again until it is raised", async () => {
    const s = await createScheduler({ maxRuns: 1 });
    const now = new Date(Date.parse(s.nextRunAt!) + 60_000);
    expect(await due(now)).toBe(1);
    const done = await getScheduler(s.id);
    expect(done).toMatchObject({ enabled: false, runCount: 1, maxRuns: 1, nextRunAt: null });
    expect(await due(new Date(Date.UTC(2100, 0, 2)))).toBe(0);

    const refused = await patchScheduler(s.id, { enabled: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("Run limit reached: raise or clear maxRuns to enable");
    expect((await getScheduler(s.id)).enabled).toBe(false);

    const raised = await patchScheduler(s.id, { enabled: true, maxRuns: 2 });
    expect(raised.status).toBe(200);
    expect(raised.body).toMatchObject({ enabled: true, maxRuns: 2 });
    expect(raised.body.nextRunAt).not.toBeNull();

    const [run] = await listRuns(s.id);
    await settle(run.taskId!);
    await clearSchedulers();
  });

  it("logs a line per run plus the card's agent run events, oldest first", async () => {
    const s = await createScheduler({});
    const run = (
      await api<SchedulerRunView>(schedulerRunRoute, "POST", `/schedulers/${s.id}/run`, { params: { id: s.id } })
    ).body;
    await settle(run.taskId!);
    const res = await api<SchedulerLogEntry[]>(schedulerLogsRoute, "GET", `/schedulers/${s.id}/logs`, {
      params: { id: s.id },
    });
    expect(res.status).toBe(200);
    const logs = res.body;
    // The card's run starts before the history row is written, so its first events may come first.
    expect(logs.filter((e) => e.kind === "scheduler")).toEqual([
      {
        at: run.createdAt,
        kind: "scheduler",
        text: `Manual run created card "${PROMPT}"`,
        schedulerRunId: run.id,
        taskId: run.taskId,
        runId: null,
      },
    ]);
    const agentEntries = logs.filter((e) => e.kind !== "scheduler");
    expect(agentEntries.length).toBeGreaterThan(0);
    for (const entry of agentEntries) {
      expect(["status", "text", "tool", "error"]).toContain(entry.kind);
      expect(entry).toMatchObject({ schedulerRunId: run.id, taskId: run.taskId });
      expect(entry.runId).not.toBeNull();
    }
    const times = logs.map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    await clearSchedulers();
  });

  it("deleting a scheduler keeps its cards, unlinked, and drops its run history", async () => {
    const s = await createScheduler({});
    const run = (
      await api<SchedulerRunView>(schedulerRunRoute, "POST", `/schedulers/${s.id}/run`, { params: { id: s.id } })
    ).body;
    const taskId = run.taskId!;
    await settle(taskId);
    expect((await getTask(taskId)).schedulerId).toBe(s.id);

    const res = await api(schedulerRoute, "DELETE", `/schedulers/${s.id}`, { params: { id: s.id } });
    expect(res.body).toEqual({ ok: true });
    expect(await getTask(taskId)).toMatchObject({ id: taskId, schedulerId: null });
    expect(await (await getRepo()).listSchedulerRuns(s.id)).toEqual([]);
    expect((await api(schedulerRunsRoute, "GET", `/schedulers/${s.id}/runs`, { params: { id: s.id } })).status).toBe(
      404,
    );
  });
});
