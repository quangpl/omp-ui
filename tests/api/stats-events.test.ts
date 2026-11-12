import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, call, env, freshEnv, setupAdmin, teardown, tempDir, waitFor, writeScript } from "./helpers";

import * as boardRoute from "@/app/api/v1/boards/[id]/route";
import * as boardTasksRoute from "@/app/api/v1/boards/[id]/tasks/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import * as eventsRoute from "@/app/api/v1/events/route";
import * as settingsRoute from "@/app/api/v1/settings/route";
import * as statsAiRoute from "@/app/api/v1/stats/ai/route";
import * as statsSystemRoute from "@/app/api/v1/stats/system/route";
import * as taskCommentsRoute from "@/app/api/v1/tasks/[id]/comments/route";
import * as taskRoute from "@/app/api/v1/tasks/[id]/route";
import * as taskRunRoute from "@/app/api/v1/tasks/[id]/run/route";
import * as taskStopRoute from "@/app/api/v1/tasks/[id]/stop/route";
import { publish } from "@/lib/events";
import type { AiStats, Board, ServerEvent, SystemStats, Task } from "@/lib/types";
import { APP_VERSION } from "@/lib/version";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

async function createBoard(input: Record<string, unknown>): Promise<Board> {
  const res = await api<Board>(boardsRoute, "POST", "/boards", { body: input });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function createTask(boardId: string, input: Record<string, unknown>): Promise<Task> {
  const res = await api<Task>(boardTasksRoute, "POST", `/boards/${boardId}/tasks`, {
    body: input,
    params: { id: boardId },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function systemStats(): Promise<SystemStats> {
  const res = await api<SystemStats>(statsSystemRoute, "GET", "/stats/system");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function aiStats(query = ""): Promise<AiStats> {
  const res = await api<AiStats>(statsAiRoute, "GET", `/stats/ai${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function setOmpPath(ompPath: string): Promise<void> {
  const res = await api(settingsRoute, "PATCH", "/settings", { body: { ompPath } });
  expect(res.status).toBe(200);
}

afterAll(teardown);

// ---------------------------------------------------------------------------------------------

describe("GET /stats/system", () => {
  let manual: Board;

  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    manual = await createBoard({ name: "Stats", workdir: tempDir("stats-project"), autoRun: false });
    const other = await createBoard({ name: "Other", workdir: tempDir("other-project"), autoRun: false });
    await createTask(manual.id, { title: "todo 1" });
    await createTask(manual.id, { title: "todo 2" });
    await createTask(manual.id, { title: "doing", status: "in_progress" });
    await createTask(manual.id, { title: "shipped", status: "done" });
    await createTask(other.id, { title: "todo 3" });
  });

  it("reports host, cpu, memory, disk, process and app counts with sane values", async () => {
    const stats = await systemStats();
    expect(stats.generatedAt).toMatch(ISO);

    expect(stats.host).toMatchObject({
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
    });
    expect(stats.host.uptimeSec).toBeGreaterThanOrEqual(0);

    expect(Number.isInteger(stats.cpu.cores)).toBe(true);
    expect(stats.cpu.cores).toBeGreaterThanOrEqual(1);
    expect(typeof stats.cpu.model).toBe("string");
    expect(stats.cpu.loadAvg).toHaveLength(3);
    for (const load of stats.cpu.loadAvg) expect(load).toBeGreaterThanOrEqual(0);
    expect(stats.cpu.usagePercent).toBeGreaterThanOrEqual(0);
    expect(stats.cpu.usagePercent).toBeLessThanOrEqual(100);

    expect(stats.memory.totalBytes).toBeGreaterThan(0);
    expect(stats.memory.usedBytes).toBeGreaterThanOrEqual(0);
    expect(stats.memory.usedBytes).toBeLessThanOrEqual(stats.memory.totalBytes);
    expect(stats.memory.usedBytes + stats.memory.freeBytes).toBe(stats.memory.totalBytes);

    if (stats.disk !== null) {
      expect(stats.disk.path).toBe(env().dataDir);
      expect(stats.disk.totalBytes).toBeGreaterThan(0);
      expect(stats.disk.usedBytes).toBeLessThanOrEqual(stats.disk.totalBytes);
      expect(stats.disk.freeBytes).toBeLessThanOrEqual(stats.disk.totalBytes);
    }

    expect(stats.process.pid).toBe(process.pid);
    expect(stats.process.rssBytes).toBeGreaterThan(0);
    expect(stats.process.heapUsedBytes).toBeGreaterThan(0);
    expect(stats.process.uptimeSec).toBeGreaterThanOrEqual(0);

    expect(stats.app).toEqual({
      version: APP_VERSION,
      db: "sqlite",
      boards: 2,
      tasks: { todo: 3, in_progress: 1, done: 1 },
      agentsRunning: 0,
      agentsQueued: 0,
    });
  });

  it("tracks task changes and running agents", async () => {
    const task = await createTask(manual.id, { title: "Agent at work [fake:slow]" });
    expect((await systemStats()).app.tasks).toEqual({ todo: 4, in_progress: 1, done: 1 });

    await api(taskRunRoute, "POST", `/tasks/${task.id}/run`, { params: { id: task.id } });
    await waitFor(async () => {
      const res = await api<{ task: Task }>(taskRoute, "GET", `/tasks/${task.id}`, { params: { id: task.id } });
      return res.body.task.agentState === "running";
    }, 20_000);
    const busy = await systemStats();
    expect(busy.app.agentsRunning).toBe(1);
    expect(busy.app.agentsQueued).toBe(0);
    expect(busy.app.tasks).toEqual({ todo: 3, in_progress: 2, done: 1 });

    await api(taskStopRoute, "POST", `/tasks/${task.id}/stop`, { params: { id: task.id } });
    await api(taskRoute, "DELETE", `/tasks/${task.id}`, { params: { id: task.id } });
    const after = await systemStats();
    expect(after.app.agentsRunning).toBe(0);
    expect(after.app.tasks).toEqual({ todo: 3, in_progress: 1, done: 1 });
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------

describe("GET /stats/ai", () => {
  it("answers 200 with available: false when omp is not installed", async () => {
    await freshEnv({ OMP_PATH: "/nonexistent/bin/omp" });
    await setupAdmin();
    const stats = await aiStats();
    expect(stats.generatedAt).toMatch(ISO);
    expect(stats.quota).toEqual({ available: false, error: "omp is not installed", providers: [] });
    expect(stats.usage).toEqual({ available: false, error: "omp is not installed", totals: null, byModel: [] });
  });

  describe("with a stand-in omp CLI", () => {
    let callLog: string;

    beforeAll(async () => {
      await freshEnv();
      await setupAdmin();
      callLog = path.join(env().root, "omp-calls.log");
    });

    function invocations(): string[] {
      return existsSync(callLog) ? readFileSync(callLog, "utf8").split("\n").filter(Boolean) : [];
    }

    it("maps quota and usage, caches for 60s and refreshes on ?refresh=1", async () => {
      const usage = {
        reports: [
          {
            provider: "anthropic",
            metadata: { email: "dev@example.com" },
            fetchedAt: Date.parse("2026-11-12T09:00:00Z"),
            limits: [
              {
                id: "five-hour",
                label: "5 Hour",
                window: { label: "5 Hour", resetsAt: "2026-11-12T20:00:00Z" },
                amount: { used: 30, limit: 120, unit: "requests" },
                status: "ok",
              },
              { window: { label: "7 Day" }, amount: { remainingFraction: 0.25, unit: "percent" } },
              { id: "over", amount: { used: 150, limit: 100 } },
            ],
          },
        ],
      };
      const stats = {
        overall: {
          totalRequests: 12,
          failedRequests: 1,
          totalInputTokens: 1000,
          totalOutputTokens: 500,
          totalCacheReadTokens: 200,
          totalCost: 1.5,
          firstTimestamp: Date.parse("2026-11-01T00:00:00Z"),
          lastTimestamp: "2026-11-12T10:00:00Z",
        },
        byModel: [
          { provider: "anthropic", model: "cheap", totalRequests: 10, totalInputTokens: 800, totalOutputTokens: 400, totalCacheReadTokens: 200, totalCost: 0.5 },
          { provider: "openai", model: "pricey", totalRequests: 2, totalInputTokens: 200, totalOutputTokens: 100, totalCacheReadTokens: 0, totalCost: 1.0 },
        ],
      };
      const stub = writeScript(
        path.join(tempDir("bin"), "omp-ok"),
        [
          'const fs = require("node:fs");',
          `fs.appendFileSync(${JSON.stringify(callLog)}, process.argv.slice(2).join(" ") + "\\n");`,
          `if (process.argv[2] === "usage") console.log(${JSON.stringify(JSON.stringify(usage))});`,
          `else if (process.argv[2] === "stats") console.log(${JSON.stringify(JSON.stringify(stats))});`,
          "else process.exit(2);",
        ].join("\n"),
      );
      await setOmpPath(stub);

      const first = await aiStats();
      expect(invocations().sort()).toEqual(["stats --json", "usage --json"]);

      expect(first.quota.available).toBe(true);
      expect(first.quota.error).toBeNull();
      expect(first.quota.providers).toHaveLength(1);
      const [provider] = first.quota.providers;
      expect(provider).toMatchObject({
        provider: "anthropic",
        account: "dev@example.com",
        fetchedAt: "2026-11-12T09:00:00.000Z",
      });
      expect(provider.limits).toHaveLength(3);
      expect(provider.limits[0]).toMatchObject({
        windowLabel: "5 Hour",
        resetsAt: "2026-11-12T20:00:00.000Z",
        used: 30,
        limit: 120,
        usedFraction: 0.25,
        unit: "requests",
        status: "ok",
      });
      expect(provider.limits[1]).toMatchObject({ windowLabel: "7 Day", resetsAt: null, usedFraction: 0.75 });
      // usedFraction stays within 0–1 even when usage exceeds the limit.
      expect(provider.limits[2].usedFraction).toBe(1);
      expect(new Set(provider.limits.map((l) => l.id)).size).toBe(3);

      expect(first.usage.available).toBe(true);
      expect(first.usage.error).toBeNull();
      expect(first.usage.totals).toEqual({
        requests: 12,
        failedRequests: 1,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        costUsd: 1.5,
        firstAt: "2026-11-01T00:00:00.000Z",
        lastAt: "2026-11-12T10:00:00.000Z",
      });
      expect(first.usage.byModel.map((m) => m.model)).toEqual(["pricey", "cheap"]);
      expect(first.usage.byModel[1]).toEqual({
        provider: "anthropic",
        model: "cheap",
        requests: 10,
        inputTokens: 800,
        outputTokens: 400,
        cacheReadTokens: 200,
        costUsd: 0.5,
      });

      const cached = await aiStats();
      expect(cached).toEqual(first);
      expect(invocations()).toHaveLength(2);

      const refreshed = await aiStats("?refresh=1");
      expect(invocations()).toHaveLength(4);
      expect(refreshed.quota.providers).toEqual(first.quota.providers);
    });

    it("reports a failing or unreadable omp command per section without failing the request", async () => {
      const stub = writeScript(
        path.join(tempDir("bin"), "omp-broken"),
        [
          'if (process.argv[2] === "usage") { process.stderr.write("warming up\\nboom: not signed in\\n"); process.exit(1); }',
          'console.log("this is not json");',
        ].join("\n"),
      );
      await setOmpPath(stub);
      const stats = await aiStats();
      expect(stats.quota).toEqual({
        available: false,
        error: "omp usage failed: boom: not signed in",
        providers: [],
      });
      expect(stats.usage).toEqual({
        available: false,
        error: "omp stats returned output that could not be read",
        totals: null,
        byModel: [],
      });
    });
  });
});

// ---------------------------------------------------------------------------------------------

/** Incremental reader over an SSE response body. */
class EventStream {
  text = "";
  done = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  constructor(
    readonly res: Response,
    readonly controller: AbortController,
  ) {
    if (!res.body) throw new Error("SSE response has no body");
    this.reader = res.body.getReader();
  }

  /** Read until `predicate()` holds, the stream ends, or the timeout passes. */
  async readUntil(predicate: () => boolean, timeout = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      const remaining = deadline - Date.now();
      if (this.done || remaining <= 0) return false;
      this.pending ??= this.reader.read();
      // Deadline guard only: cleared as soon as data arrives; an unanswered read is reused next call.
      const timer = Promise.withResolvers<"timeout">();
      const handle = setTimeout(() => timer.resolve("timeout"), remaining);
      const result = await Promise.race([this.pending, timer.promise]);
      clearTimeout(handle);
      if (result === "timeout") return predicate();
      this.pending = null;
      if (result.done) this.done = true;
      else this.text += this.decoder.decode(result.value, { stream: true });
    }
    return true;
  }

  /** Every complete `data:` frame received so far. */
  events(): ServerEvent[] {
    const frames = this.text.split("\n\n").slice(0, -1);
    return frames.flatMap((frame) =>
      frame
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)) as ServerEvent),
    );
  }

  /** Read until an event matching `match` arrives; returns it. */
  async next<T extends ServerEvent>(match: (event: ServerEvent) => event is T, timeout?: number): Promise<T>;
  async next(match: (event: ServerEvent) => boolean, timeout?: number): Promise<ServerEvent>;
  async next(match: (event: ServerEvent) => boolean, timeout = 5_000): Promise<ServerEvent> {
    const found = () => this.events().find(match);
    if (!(await this.readUntil(() => found() !== undefined, timeout))) {
      throw new Error(`expected event not received; got:\n${this.text}`);
    }
    return found() as ServerEvent;
  }

  close(): void {
    this.controller.abort();
  }
}

async function openEvents(query = ""): Promise<EventStream> {
  const controller = new AbortController();
  const res = await call(eventsRoute, "GET", `/events${query}`, { signal: controller.signal });
  expect(res.status).toBe(200);
  return new EventStream(res, controller);
}

describe("GET /events (SSE)", () => {
  let boardA: Board;
  let boardB: Board;
  const streams: EventStream[] = [];

  async function open(query = ""): Promise<EventStream> {
    const stream = await openEvents(query);
    streams.push(stream);
    return stream;
  }

  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    boardA = await createBoard({ name: "Board A", workdir: tempDir("board-a"), autoRun: true });
    boardB = await createBoard({ name: "Board B", workdir: tempDir("board-b"), autoRun: false });
  });

  afterAll(() => {
    for (const stream of streams) stream.close();
  });

  it("starts with a connected comment and streams task updates as data frames", async () => {
    const stream = await open();
    expect(stream.res.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.res.headers.get("cache-control")).toContain("no-cache");
    expect(await stream.readUntil(() => stream.text.includes(": connected\n"))).toBe(true);
    expect(stream.text.startsWith("retry: 3000\n")).toBe(true);

    const task = await createTask(boardB.id, { title: "Streamed task" });
    const event = await stream.next((e) => e.type === "task.updated" && e.task.id === task.id);
    expect(event).toEqual({ type: "task.updated", task });
    expect(stream.text).toContain(`data: ${JSON.stringify(event)}\n\n`);

    const comment = await api(taskCommentsRoute, "POST", `/tasks/${task.id}/comments`, {
      body: { body: "streamed feedback" },
      params: { id: task.id },
    });
    const added = await stream.next((e) => e.type === "comment.added" && e.comment.id === comment.body.id);
    expect(added).toMatchObject({ type: "comment.added", boardId: boardB.id, comment: { body: "streamed feedback" } });

    await api(taskRoute, "DELETE", `/tasks/${task.id}`, { params: { id: task.id } });
    const deleted = await stream.next((e) => e.type === "task.deleted" && e.taskId === task.id);
    expect(deleted).toEqual({ type: "task.deleted", taskId: task.id, boardId: boardB.id });
    stream.close();
  });

  it("?boardId= only delivers that board's events", async () => {
    const stream = await open(`?boardId=${boardB.id}`);
    expect(await stream.readUntil(() => stream.text.includes(": connected\n"))).toBe(true);

    const elsewhere = await createTask(boardA.id, { title: "Not for this stream" });
    await api(boardRoute, "PATCH", `/boards/${boardA.id}`, { body: { name: "Board A renamed" }, params: { id: boardA.id } });
    const mine = await createTask(boardB.id, { title: "For this stream" });
    await api(boardRoute, "PATCH", `/boards/${boardB.id}`, { body: { name: "Board B renamed" }, params: { id: boardB.id } });

    await stream.next((e) => e.type === "task.updated" && e.task.id === mine.id);
    await stream.next((e) => e.type === "board.updated" && e.board.name === "Board B renamed");

    const events = stream.events();
    expect(events.length).toBeGreaterThan(0);
    expect(stream.text).not.toContain(elsewhere.id);
    expect(stream.text).not.toContain(boardA.id);
    for (const event of events) {
      const boardId =
        event.type === "board.updated" ? event.board.id : event.type === "task.updated" ? event.task.boardId : event.boardId;
      expect(boardId).toBe(boardB.id);
    }
    stream.close();
  });

  it("forwards live run.delta frames unbuffered, filtered by board", async () => {
    const onlyA = await open(`?boardId=${boardA.id}`);
    const onlyB = await open(`?boardId=${boardB.id}`);
    // no-transform keeps vinext's production server from compressing (and so buffering) the stream.
    expect(onlyA.res.headers.get("cache-control")).toContain("no-transform");
    expect(onlyA.res.headers.get("x-accel-buffering")).toBe("no");
    expect(await onlyA.readUntil(() => onlyA.text.includes(": connected\n"))).toBe(true);
    expect(await onlyB.readUntil(() => onlyB.text.includes(": connected\n"))).toBe(true);

    const delta = (boardId: string, runId: string, text: string): ServerEvent => ({
      type: "run.delta",
      runId,
      taskId: `task-${runId}`,
      boardId,
      kind: "text",
      text,
    });
    const a1 = delta(boardA.id, "run-a1", "Hel");
    const b1 = delta(boardB.id, "run-b1", "Other board");
    const a2 = delta(boardA.id, "run-a2", "Hello");
    publish(a1);
    publish(b1);
    publish(a2);

    // Frames arrive in publish order, so anything that leaked would precede the awaited frame.
    expect(await onlyA.next((e) => e.type === "run.delta" && e.runId === "run-a2")).toEqual(a2);
    expect(onlyA.events().filter((e) => e.type === "run.delta")).toEqual([a1, a2]);
    expect(onlyA.text).not.toContain("run-b1");

    expect(await onlyB.next((e) => e.type === "run.delta" && e.runId === "run-b1")).toEqual(b1);
    expect(onlyB.text).not.toContain("run-a1");
    onlyA.close();
    onlyB.close();
  });

  it(
    "streams the agent run of a board: run updates, run events and the final task state",
    async () => {
      const stream = await open(`?boardId=${boardA.id}`);
      const task = await createTask(boardA.id, { title: "Live run", status: "in_progress" });

      const finished = await stream.next(
        (e) => e.type === "task.updated" && e.task.id === task.id && e.task.status === "done" && e.task.agentState === "idle",
        20_000,
      );
      expect(finished.type).toBe("task.updated");

      const events = stream.events();
      const runUpdates = events.filter((e) => e.type === "run.updated" && e.run.taskId === task.id);
      expect(runUpdates.length).toBeGreaterThanOrEqual(2);
      expect(runUpdates.at(-1)).toMatchObject({ run: { status: "succeeded" }, boardId: boardA.id });
      const runEvents = events.filter((e) => e.type === "run.event" && e.event.taskId === task.id);
      expect(runEvents.length).toBeGreaterThan(0);
      expect(runEvents.every((e) => e.type === "run.event" && e.boardId === boardA.id)).toBe(true);
      expect(events.some((e) => e.type === "comment.added" && e.comment.author === "agent" && e.comment.taskId === task.id)).toBe(true);
      stream.close();
    },
    60_000,
  );

  it("closes the stream when the client aborts the request", async () => {
    const stream = await open();
    expect(await stream.readUntil(() => stream.text.includes(": connected\n"))).toBe(true);

    stream.close();
    expect(await stream.readUntil(() => stream.done, 5_000)).toBe(true);

    // Publishing after the client left is harmless.
    const res = await api(boardTasksRoute, "POST", `/boards/${boardB.id}/tasks`, {
      body: { title: "After disconnect" },
      params: { id: boardB.id },
    });
    expect(res.status).toBe(201);
  });

  it("aborted before the handler runs: the stream is closed right away", async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await call(eventsRoute, "GET", "/events", { signal: controller.signal });
    expect(res.status).toBe(200);
    const stream = new EventStream(res, controller);
    expect(await stream.readUntil(() => stream.done, 5_000)).toBe(true);
    expect(stream.text).toContain(": connected");
  });
});
