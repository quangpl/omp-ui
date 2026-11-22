import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { publish } from "@/lib/events";
import {
  exportTestSpan,
  flushTelemetry,
  parseModel,
  parseOtlpHeaders,
  startTelemetryExporter,
  stopTelemetryExporter,
} from "@/lib/server/telemetry";
import type { Run, RunEvent, RunEventKind, SubagentSnapshot, Task } from "@/lib/types";

interface Captured {
  headers: IncomingHttpHeaders;
  body: OtlpBody;
}

interface OtlpAttr {
  key: string;
  value: Record<string, unknown>;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttr[];
  events?: { name: string; attributes: OtlpAttr[] }[];
  status: { code: number; message?: string };
}

interface OtlpBody {
  resourceSpans: { resource: { attributes: OtlpAttr[] }; scopeSpans: { spans: OtlpSpan[] }[] }[];
}

let server: Server;
let endpoint = "";
let requests: Captured[] = [];
let answerStatus = 200;
let settings = { telemetryExport: false, telemetryEndpoint: "" };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(raw) as OtlpBody });
      res.statusCode = answerStatus;
      res.end(answerStatus === 200 ? "{}" : "collector down");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests = [];
  answerStatus = 200;
  settings = { telemetryExport: false, telemetryEndpoint: "" };
  startTelemetryExporter(async () => settings, { graceMs: 0 });
});

afterEach(() => {
  stopTelemetryExporter();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const T0 = Date.parse("2026-11-13T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
let seq = 0;

function run(status: Run["status"], extra: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    taskId: "task-1",
    status,
    prompt: "do it",
    summary: null,
    error: null,
    startedAt: iso(0),
    endedAt: null,
    userId: null,
    nodeId: null,
    nodeName: null,
    ...extra,
  };
}

function logLine(kind: RunEventKind, text: string, offsetMs: number): void {
  const event: RunEvent = { seq: ++seq, runId: "run-1", taskId: "task-1", kind, text, createdAt: iso(offsetMs) };
  publish({ type: "run.event", event, boardId: "board-1" });
}

/** A run with a model line, two tool calls, a subagent and an error line; ends as `status`. */
async function playRun(end: Run): Promise<void> {
  publish({ type: "run.updated", run: run("running"), boardId: "board-1" });
  publish({ type: "task.updated", task: { id: "task-1", boardId: "board-1", title: "Fix the login" } as Task });
  logLine("status", "Starting agent in /work/app (model anthropic/claude-sonnet-4-5, thinking high)", 100);
  logLine("tool", "▸ bash: pnpm test\nRun the tests", 1_000);
  logLine("text", "Tests fail", 3_000);
  logLine("tool", "▸ read: lib/login.ts", 4_000);
  const agent: SubagentSnapshot = {
    id: "Scout",
    agent: "scout",
    status: "completed",
    model: "anthropic/haiku",
    tokens: 1200,
    cost: 0.25,
    durationMs: 2_000,
  };
  logLine("agent", JSON.stringify(agent), 6_000);
  publish({
    type: "run.context",
    runId: "run-1",
    taskId: "task-1",
    boardId: "board-1",
    context: { tokens: 5000, contextWindow: 200000 },
    usage: { costUsd: 1.5, tokens: 30000 },
  });
  logLine("error", "Tool crashed", 7_000);
  publish({ type: "run.updated", run: end, boardId: "board-1" });
  await flushTelemetry();
}

function attr(span: OtlpSpan | { attributes: OtlpAttr[] }, key: string): unknown {
  const value = span.attributes.find((a) => a.key === key)?.value;
  return value ? Object.values(value)[0] : undefined;
}

function spansOf(body: OtlpBody): OtlpSpan[] {
  return body.resourceSpans[0]!.scopeSpans[0]!.spans;
}

describe("telemetry exporter", () => {
  it("sends nothing while telemetryExport is off", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    settings = { telemetryExport: false, telemetryEndpoint: endpoint };
    await playRun(run("succeeded", { endedAt: iso(10_000) }));
    expect(requests).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends nothing when the endpoint is empty", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    settings = { telemetryExport: true, telemetryEndpoint: "" };
    await playRun(run("succeeded", { endedAt: iso(10_000) }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts one OTLP trace per finished run with root, tool and subagent spans", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "x-api-key=abc%20123, x-team=core");
    settings = { telemetryExport: true, telemetryEndpoint: endpoint };
    await playRun(run("succeeded", { endedAt: iso(10_000) }));

    expect(requests).toHaveLength(1);
    const { headers, body } = requests[0]!;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-api-key"]).toBe("abc 123");
    expect(headers["x-team"]).toBe("core");
    expect(attr(body.resourceSpans[0]!.resource, "service.name")).toBe("omp-ui");

    const spans = spansOf(body);
    const root = spans.find((s) => !s.parentSpanId)!;
    expect(root.name).toBe("invoke_agent Fix the login");
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(root.startTimeUnixNano).toBe(`${T0}000000`);
    expect(root.endTimeUnixNano).toBe(`${T0 + 10_000}000000`);
    expect(root.status.code).toBe(1);
    expect(attr(root, "gen_ai.operation.name")).toBe("invoke_agent");
    expect(attr(root, "gen_ai.agent.name")).toBe("omp");
    expect(attr(root, "gen_ai.request.model")).toBe("anthropic/claude-sonnet-4-5");
    expect(attr(root, "omp_ui.task.id")).toBe("task-1");
    expect(attr(root, "omp_ui.board.id")).toBe("board-1");
    expect(attr(root, "omp_ui.run.id")).toBe("run-1");
    expect(attr(root, "omp_ui.run.status")).toBe("succeeded");
    // The whole run's spend: main session (1.5) plus the scout subagent (0.25).
    expect(attr(root, "omp_ui.cost_usd")).toBe(1.75);
    expect(attr(root, "omp_ui.session.cost_usd")).toBe(1.5);
    expect(attr(root, "omp_ui.session.tokens")).toBe("30000");
    expect(attr(root, "omp_ui.subagents.tokens")).toBe("1200");
    expect(attr(root, "omp_ui.context.tokens")).toBe("5000");
    expect(attr(root, "error.type")).toBeUndefined();
    expect(root.events?.map((e) => [e.name, attr(e, "exception.message")])).toEqual([["exception", "Tool crashed"]]);

    const tools = spans.filter((s) => s.name.startsWith("execute_tool"));
    expect(tools.map((s) => s.name)).toEqual(["execute_tool bash", "execute_tool read"]);
    for (const tool of tools) {
      expect(tool.traceId).toBe(root.traceId);
      expect(tool.parentSpanId).toBe(root.spanId);
    }
    // bash ends at the next log line; read ends at the error line (agent snapshots do not end tools).
    expect([tools[0]!.startTimeUnixNano, tools[0]!.endTimeUnixNano]).toEqual([`${T0 + 1_000}000000`, `${T0 + 3_000}000000`]);
    expect(tools[1]!.endTimeUnixNano).toBe(`${T0 + 7_000}000000`);
    expect(attr(tools[0]!, "gen_ai.tool.name")).toBe("bash");
    expect(attr(tools[0]!, "omp_ui.tool.detail")).toBe("pnpm test");

    const sub = spans.find((s) => s.name === "invoke_agent scout")!;
    expect(sub.parentSpanId).toBe(root.spanId);
    expect(sub.startTimeUnixNano).toBe(`${T0 + 4_000}000000`);
    expect(attr(sub, "gen_ai.request.model")).toBe("anthropic/haiku");
    expect(attr(sub, "omp_ui.subagent.tokens")).toBe("1200");
  });

  it("marks a failed run as an error", async () => {
    settings = { telemetryExport: true, telemetryEndpoint: endpoint };
    await playRun(run("failed", { endedAt: iso(9_000), error: "omp exited with code 1" }));
    expect(requests).toHaveLength(1);
    const root = spansOf(requests[0]!.body).find((s) => !s.parentSpanId)!;
    expect(root.status).toEqual({ code: 2, message: "omp exited with code 1" });
    expect(attr(root, "omp_ui.run.status")).toBe("failed");
    expect(attr(root, "error.type")).toBe("agent_failed");
    expect(attr(root, "error.message")).toBe("omp exited with code 1");
  });

  it("never throws when the collector fails, and warns at most once a minute", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    answerStatus = 503;
    settings = { telemetryExport: true, telemetryEndpoint: endpoint };
    await playRun(run("succeeded", { endedAt: iso(10_000) }));
    await playRun(run("succeeded", { id: "run-1", endedAt: iso(10_000) }));
    expect(requests).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("HTTP 503");
  });

  it("survives an unreachable endpoint", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    settings = { telemetryExport: true, telemetryEndpoint: "http://127.0.0.1:1/v1/traces" };
    await expect(playRun(run("succeeded", { endedAt: iso(10_000) }))).resolves.toBeUndefined();
  });
});

describe("exportTestSpan", () => {
  it("sends one span and reports the collector's answer", async () => {
    await expect(exportTestSpan(endpoint)).resolves.toEqual({ ok: true, status: 200, error: null });
    expect(requests).toHaveLength(1);
    expect(spansOf(requests[0]!.body).map((s) => s.name)).toEqual(["omp_ui.test"]);
  });

  it("reports failures instead of throwing", async () => {
    answerStatus = 401;
    await expect(exportTestSpan(endpoint)).resolves.toMatchObject({ ok: false, status: 401 });
    await expect(exportTestSpan("not a url")).resolves.toMatchObject({ ok: false, status: null });
  });
});

describe("parsers", () => {
  it("reads OTEL_EXPORTER_OTLP_HEADERS", () => {
    expect(parseOtlpHeaders("a=1,b=x%3Dy, bad ,=z")).toEqual({ a: "1", b: "x=y" });
    expect(parseOtlpHeaders(undefined)).toEqual({});
  });

  it("finds the run's model in status lines", () => {
    expect(parseModel("Starting agent in /w (model openai/gpt-5, thinking low)")).toBe("openai/gpt-5");
    expect(parseModel("Model auto-selected: anthropic/haiku (small edit)")).toBe("anthropic/haiku");
    expect(parseModel("Model auto-selected: omp default (no roles)")).toBeNull();
    expect(parseModel("Starting agent in /w")).toBeNull();
  });
});
