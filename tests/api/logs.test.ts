import { writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, call, env, freshEnv, setupAdmin, teardown, tempDir } from "./helpers";

import * as exportRoute from "@/app/api/v1/logs/[source]/export/route";
import * as sourceRoute from "@/app/api/v1/logs/[source]/route";
import * as logsRoute from "@/app/api/v1/logs/route";
import { getRepo } from "@/lib/db";
import type { LogEntry, LogPage, LogSourcesResponse } from "@/lib/log-types";
import { flushLogEvents } from "@/lib/server/log-store";

// Fixtures. omp-ui.log.1 is the older (rotated) system log; line numbers matter for entry ids.
const SYSTEM_ARCHIVE = [
  "=== omp-ui start 2026-11-10T08:00:00.000Z · port 3000 ===",
  "[vinext] Production server running at http://0.0.0.0:3000",
  "[api] disk warning: almost full",
  "",
].join("\n");

const SYSTEM_CURRENT = [
  "",
  "=== omp-ui start 2026-11-12T12:00:00.000Z · port 3000 ===",
  "[vinext] Production server running at http://0.0.0.0:3000",
  "\u001b[31m[vinext] Server error: Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'x'\u001b[0m",
  "    at finalizeResolution (node:internal/modules/esm/resolve:271:11)",
  "    at moduleResolve (node:internal/modules/esm/resolve:861:10) {",
  "  code: 'ERR_MODULE_NOT_FOUND'",
  "}",
  "[supervisor 2026-11-12T12:05:00.000Z] health check failed (1/3)",
  "plain line without a time of its own",
  "",
].join("\n");

const TUNNEL = [
  "2026-11-12T14:33:51Z INF Requesting new quick Tunnel on trycloudflare.com...",
  "2026-11-12T14:33:58Z ERR Failed to connect",
  "2026-11-12T14:34:00Z WRN Retrying connection",
  "",
].join("\n");

const RESTART = ["=== restart requested 2026-11-13T06:52:29.773Z · cli ===", "› Rebuilding", ""].join("\n");

// Archived security events (the live security.log may receive events from the requests themselves).
const SECURITY_ARCHIVE = [
  JSON.stringify({ t: "2026-11-10T09:00:00.000Z", level: "info", category: "login", message: "Signed in" }),
  "{not json",
  JSON.stringify({
    t: "2026-11-10T10:00:00.000Z",
    level: "warn",
    category: "login",
    message: "Failed sign-in",
    meta: { ip: "203.0.113.7" },
  }),
  JSON.stringify({ t: "2026-11-10T10:00:00.000Z", level: "info", category: "credentials", message: "Key saved" }),
  "",
].join("\n");

async function page(source: string, query = ""): Promise<LogPage> {
  const res = await api<LogPage>(sourceRoute, "GET", `/logs/${source}${query}`, { params: { source } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

function ids(entries: LogEntry[]): string[] {
  return entries.map((e) => e.id);
}

afterAll(teardown);

describe("/logs", () => {
  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    await flushLogEvents();
    const dir = env().dataDir;
    writeFileSync(path.join(dir, "omp-ui.log.1"), SYSTEM_ARCHIVE);
    writeFileSync(path.join(dir, "omp-ui.log"), SYSTEM_CURRENT);
    writeFileSync(path.join(dir, "tunnel.log"), TUNNEL);
    writeFileSync(path.join(dir, "restart.log"), RESTART);
    writeFileSync(path.join(dir, "security.log.1"), SECURITY_ARCHIVE);
  });

  it("requires authentication", async () => {
    expect((await api(logsRoute, "GET", "/logs", { token: null })).status).toBe(401);
    const res = await api(sourceRoute, "GET", "/logs/system", { token: null, params: { source: "system" } });
    expect(res.status).toBe(401);
  });

  it("lists every source in tab order with current and archived files", async () => {
    const res = await api<LogSourcesResponse>(logsRoute, "GET", "/logs");
    expect(res.status).toBe(200);
    const sources = res.body.sources;
    expect(sources.map((s) => s.id)).toEqual(["system", "security", "access", "agent", "database", "restart", "tunnel"]);
    const system = sources.find((s) => s.id === "system");
    expect(system?.kind).toBe("file");
    expect(system?.files.map((f) => [f.name, f.archived])).toEqual([
      ["omp-ui.log", false],
      ["omp-ui.log.1", true],
    ]);
    expect(system?.files[0].size).toBe(Buffer.byteLength(SYSTEM_CURRENT));
    expect(sources.find((s) => s.id === "security")?.kind).toBe("events");
    expect(sources.find((s) => s.id === "agent")).toMatchObject({ kind: "runs", files: [] });
  });

  it("parses the system log newest first, current file before archives", async () => {
    const body = await page("system");
    expect(body.total).toBe(8);
    expect(body.nextOffset).toBeNull();
    expect(ids(body.entries)).toEqual([
      "omp-ui.log:10",
      "omp-ui.log:9",
      "omp-ui.log:4",
      "omp-ui.log:3",
      "omp-ui.log:2",
      "omp-ui.log.1:3",
      "omp-ui.log.1:2",
      "omp-ui.log.1:1",
    ]);
    expect(body.files.map((f) => f.name)).toEqual(["omp-ui.log", "omp-ui.log.1"]);
    const [plain, supervisor, serverError, running, marker] = body.entries;

    // Markers and timestamped lines carry their own time; the rest inherit it, approximately.
    expect(marker).toMatchObject({
      time: "2026-11-12T12:00:00.000Z",
      level: "info",
      message: "Server started (port 3000)",
      file: "omp-ui.log",
      source: "system",
    });
    expect(marker.approximateTime).toBeUndefined();
    expect(running).toMatchObject({ time: "2026-11-12T12:00:00.000Z", approximateTime: true, category: "vinext" });
    expect(supervisor).toMatchObject({
      time: "2026-11-12T12:05:00.000Z",
      level: "error",
      category: "supervisor",
      message: "health check failed (1/3)",
    });
    expect(plain).toMatchObject({ time: "2026-11-12T12:05:00.000Z", approximateTime: true, level: "info" });

    // ANSI codes stripped; the stack trace and error fields fold into details.
    expect(serverError.level).toBe("error");
    expect(serverError.category).toBe("vinext");
    expect(serverError.message).toBe("Server error: Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'x'");
    expect(serverError.details).toBe(
      [
        "    at finalizeResolution (node:internal/modules/esm/resolve:271:11)",
        "    at moduleResolve (node:internal/modules/esm/resolve:861:10) {",
        "  code: 'ERR_MODULE_NOT_FOUND'",
        "}",
      ].join("\n"),
    );

    expect(body.entries[5]).toMatchObject({ level: "warn", category: "api", file: "omp-ui.log.1" });
    expect(body.entries[7]).toMatchObject({ time: "2026-11-10T08:00:00.000Z", message: "Server started (port 3000)" });
  });

  it("filters by file, level, text and time", async () => {
    const archived = await page("system", "?file=omp-ui.log.1");
    expect(ids(archived.entries)).toEqual(["omp-ui.log.1:3", "omp-ui.log.1:2", "omp-ui.log.1:1"]);
    expect(archived.files).toHaveLength(2);

    expect(ids((await page("system", "?level=warn")).entries)).toEqual(["omp-ui.log.1:3"]);
    expect(ids((await page("system", "?level=warn,error")).entries)).toEqual([
      "omp-ui.log:9",
      "omp-ui.log:4",
      "omp-ui.log.1:3",
    ]);
    // q searches message, details and category, case-insensitively.
    expect(ids((await page("system", "?q=FINALIZERESOLUTION")).entries)).toEqual(["omp-ui.log:4"]);
    expect(ids((await page("system", "?q=supervisor")).entries)).toEqual(["omp-ui.log:9"]);

    const since = await page("system", `?since=${encodeURIComponent("2026-11-12T12:05:00.000Z")}`);
    expect(ids(since.entries)).toEqual(["omp-ui.log:10", "omp-ui.log:9"]);
    const until = await page("system", "?until=2026-11-11T00:00:00Z");
    expect(until.total).toBe(3);
    expect(until.entries.every((e) => e.file === "omp-ui.log.1")).toBe(true);
  });

  it("paginates with total and nextOffset", async () => {
    const first = await page("system", "?limit=3");
    expect(first).toMatchObject({ total: 8, offset: 0, limit: 3, nextOffset: 3 });
    expect(ids(first.entries)).toEqual(["omp-ui.log:10", "omp-ui.log:9", "omp-ui.log:4"]);
    const last = await page("system", "?limit=3&offset=6");
    expect(last).toMatchObject({ total: 8, offset: 6, nextOffset: null });
    expect(ids(last.entries)).toEqual(["omp-ui.log.1:2", "omp-ui.log.1:1"]);
    expect((await page("system", "?offset=20")).entries).toEqual([]);
  });

  it("rejects unknown sources and bad parameters", async () => {
    const unknown = await api(sourceRoute, "GET", "/logs/nope", { params: { source: "nope" } });
    expect(unknown.status).toBe(404);
    for (const query of [
      "?level=loud",
      "?since=yesterday",
      "?until=not-a-date",
      "?limit=0",
      "?limit=501",
      "?offset=-1",
      "?file=passwd",
      "?file=../omp-ui.log",
    ]) {
      const res = await api(sourceRoute, "GET", `/logs/system${query}`, { params: { source: "system" } });
      expect(res.status, query).toBe(400);
    }
    const missingArchive = await page("system", "?file=omp-ui.log.7");
    expect(missingArchive.total).toBe(0);
  });

  it("parses cloudflared tunnel output and restart markers", async () => {
    const tunnel = await page("tunnel");
    expect(tunnel.entries.map((e) => [e.time, e.level, e.category, e.message])).toEqual([
      ["2026-11-12T14:34:00.000Z", "warn", "cloudflared", "Retrying connection"],
      ["2026-11-12T14:33:58.000Z", "error", "cloudflared", "Failed to connect"],
      ["2026-11-12T14:33:51.000Z", "info", "cloudflared", "Requesting new quick Tunnel on trycloudflare.com..."],
    ]);

    const restart = await page("restart");
    expect(restart.entries.map((e) => e.message)).toEqual(["› Rebuilding", "Restart requested (cli)"]);
    expect(restart.entries[1]).toMatchObject({ time: "2026-11-13T06:52:29.773Z", level: "info" });
    expect(restart.entries[0]).toMatchObject({ time: "2026-11-13T06:52:29.773Z", approximateTime: true });
  });

  it("reads JSON-line event logs by time, skipping malformed lines", async () => {
    const body = await page("security", "?file=security.log.1");
    expect(body.total).toBe(3);
    // Same timestamp: the later line comes first.
    expect(ids(body.entries)).toEqual(["security.log.1:4", "security.log.1:3", "security.log.1:1"]);
    expect(body.entries[1]).toMatchObject({
      time: "2026-11-10T10:00:00.000Z",
      level: "warn",
      source: "security",
      category: "login",
      message: "Failed sign-in",
      details: null,
      meta: { ip: "203.0.113.7" },
      file: "security.log.1",
    });
    expect(body.files.find((f) => f.name === "security.log.1")?.archived).toBe(true);
    expect(ids((await page("security", "?file=security.log.1&level=warn")).entries)).toEqual(["security.log.1:3"]);
  });

  it("records page views in the access log", async () => {
    const post = (source: string, body: unknown) =>
      call(sourceRoute, "POST", `/logs/${source}`, { body, params: { source } });

    const res = await post("access", { path: "/boards/abc?token=s3cr3t#frag" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    await flushLogEvents();

    const body = await page("access", "?q=%2Fboards%2Fabc");
    const view = body.entries.find((e) => e.category === "page");
    expect(view).toMatchObject({ level: "info", message: "Viewed /boards/abc", source: "access", file: "access.log" });
    expect(view?.meta).toMatchObject({ path: "/boards/abc" });
    expect(JSON.stringify(body)).not.toContain("s3cr3t");

    expect((await post("system", { path: "/" })).status).toBe(405);
    expect((await post("nope", { path: "/" })).status).toBe(404);
    for (const bad of [{}, { path: 42 }, { path: "boards" }, { path: `/${"x".repeat(600)}` }]) {
      expect((await post("access", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const anonymous = await call(sourceRoute, "POST", "/logs/access", {
      body: { path: "/" },
      token: null,
      params: { source: "access" },
    });
    expect(anonymous.status).toBe(401);
  });

  it("lists agent runs with card and board names", async () => {
    const repo = await getRepo();
    const board = await repo.createBoard({ name: "Logs board", workdir: tempDir("project"), autoRun: false });
    const task = await repo.createTask({ boardId: board.id, title: "Fix login" });
    const failed = await repo.createRun({ taskId: task.id, prompt: "fix it" });
    await repo.updateRun(failed.id, {
      status: "failed",
      error: "Boom happened\n  at somewhere",
      endedAt: new Date(Date.parse(failed.startedAt) + 1500).toISOString(),
    });
    const ok = await repo.createRun({ taskId: task.id, prompt: "again" });
    await repo.updateRun(ok.id, { status: "succeeded", summary: "All good", endedAt: new Date().toISOString() });

    const body = await page("agent");
    expect(body.files).toEqual([]);
    const failedEntry = body.entries.find((e) => e.id === failed.id);
    expect(failedEntry).toMatchObject({
      level: "error",
      source: "agent",
      category: "Logs board",
      message: "Run failed — Fix login: Boom happened",
      details: "Boom happened\n  at somewhere",
      file: null,
    });
    expect(failedEntry?.meta).toMatchObject({
      runId: failed.id,
      taskId: task.id,
      boardId: board.id,
      status: "failed",
      durationMs: 1500,
    });
    expect(body.entries.find((e) => e.id === ok.id)).toMatchObject({
      level: "info",
      message: "Run succeeded — Fix login",
      details: "All good",
    });

    expect(ids((await page("agent", "?level=error")).entries)).toEqual([failed.id]);
    const search = await page("agent", "?q=logs%20board");
    expect(new Set(ids(search.entries))).toEqual(new Set([failed.id, ok.id]));
    const res = await api(sourceRoute, "GET", "/logs/agent?file=omp-ui.log", { params: { source: "agent" } });
    expect(res.status).toBe(400);
  });

  it("exports matching entries as a download", async () => {
    const txt = await call(exportRoute, "GET", "/logs/system/export?format=txt&level=error", {
      params: { source: "system" },
    });
    expect(txt.status).toBe(200);
    expect(txt.headers.get("content-type")).toContain("text/plain");
    expect(txt.headers.get("cache-control")).toBe("no-store");
    expect(txt.headers.get("content-disposition")).toMatch(
      /^attachment; filename="omp-ui-system-\d{8}-\d{6}\.txt"$/,
    );
    const text = await txt.text();
    expect(text.split("\n")[0]).toBe("2026-11-12T12:05:00.000Z  ERROR  [supervisor] health check failed (1/3)");
    expect(text).toContain("    at finalizeResolution");

    const ndjson = await call(exportRoute, "GET", "/logs/system/export?format=ndjson&limit=1", {
      params: { source: "system" },
    });
    const lines = (await ndjson.text()).trim().split("\n");
    expect(lines).toHaveLength(8);
    expect((JSON.parse(lines[0]) as LogEntry).id).toBe("omp-ui.log:10");

    const json = await api<LogEntry[]>(exportRoute, "GET", "/logs/tunnel/export?format=json", {
      params: { source: "tunnel" },
    });
    expect(json.status).toBe(200);
    expect(json.headers.get("content-disposition")).toContain(".json\"");
    expect(json.body.map((e) => e.level)).toEqual(["warn", "error", "info"]);

    const bad = await api(exportRoute, "GET", "/logs/system/export?format=xml", { params: { source: "system" } });
    expect(bad.status).toBe(400);
  });
});
