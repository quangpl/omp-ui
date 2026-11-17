// Server-only OpenTelemetry export of finished runs (Settings → `telemetryExport`). Listens to the
// in-process event bus (lib/events.ts) instead of hooking the run lifecycle: everything a trace
// needs is already published there (run status, persisted log lines, subagent snapshots, context
// usage and the main omp session's spend). Each finished run is POSTed as one OTLP/HTTP JSON
// trace following the OpenTelemetry GenAI semantic conventions: an `invoke_agent` root span,
// `execute_tool` child spans per tool call, `invoke_agent` child spans per subagent and
// `exception` span events for error lines.
// No SDK dependency: the OTLP JSON encoding is small and stable.
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { subscribe } from "@/lib/events";
import type { AppSettings, ContextUsage, Run, RunEvent, ServerEvent, SubagentSnapshot } from "@/lib/types";

/** Settings source, re-read when a run finishes so the toggle applies without a restart. */
export type TelemetrySettingsSource = () => Promise<Pick<AppSettings, "telemetryExport" | "telemetryEndpoint">>;

export interface TelemetryExporterOptions {
  /**
   * Wait this long after a run's terminal `run.updated` before exporting: the manager publishes
   * the final subagent snapshots and the closing log line ("Agent finished", the error) after it.
   */
  graceMs?: number;
}

/** Outcome of one OTLP POST; never thrown. `status` is the HTTP status, null when none arrived. */
export interface TelemetryPostResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

const DEFAULT_GRACE_MS = 3_000;
const POST_TIMEOUT_MS = 10_000;
const WARN_INTERVAL_MS = 60_000;
/** Run state is dropped past these bounds (a run whose end we never saw must not leak). */
const MAX_RUN_AGE_MS = 24 * 60 * 60_000;
const MAX_RUNS = 200;
/** Per-run caps: a runaway agent must not grow the exporter's memory without limit. */
const MAX_TOOLS_PER_RUN = 1_000;
const MAX_ERRORS_PER_RUN = 100;
const MAX_ATTR_TEXT = 500;
const SCOPE_NAME = "agentman";
const SERVICE_NAME = "agentman";
const AGENT_NAME = "omp";

/** OTLP span status codes. */
const STATUS_UNSET = 0;
const STATUS_OK = 1;
const STATUS_ERROR = 2;
/** OTLP SpanKind: INTERNAL for the tool calls, CLIENT for agent invocations (GenAI conventions). */
const KIND_INTERNAL = 1;
const KIND_CLIENT = 3;

interface ToolSpan {
  name: string;
  detail: string;
  start: number;
  /** Set when the next log line arrives; open tools end with the run. */
  end: number | null;
}

interface SubagentState {
  snapshot: SubagentSnapshot;
  /** When the latest snapshot arrived (ms): the subagent's end when it has finished. */
  seenAt: number;
}

/** What the exporter remembers about one run until it finishes. Times are epoch ms. */
interface RunTrace {
  runId: string;
  taskId: string;
  boardId: string;
  startedAt: number;
  lastSeen: number;
  title: string | null;
  model: string | null;
  tools: ToolSpan[];
  droppedTools: number;
  errors: { message: string; at: number }[];
  subagents: Map<string, SubagentState>;
  context: ContextUsage | null;
  /** The omp session's own spend (subagents excluded), from the latest `run.context` carrying it. */
  sessionUsage: { costUsd: number; tokens: number } | null;
  /** The terminal run row, once seen; the trace is then exporting and ignores a second end. */
  finished: Run | null;
}

interface ExporterState {
  getSettings: TelemetrySettingsSource;
  graceMs: number;
  runs: Map<string, RunTrace>;
  pending: Set<Promise<void>>;
  lastWarnAt: number;
  unsubscribe: () => void;
}

// On globalThis so dev hot reloads keep one subscription and one run map.
const g = globalThis as unknown as { __ompUiTelemetry?: ExporterState };

/**
 * Start exporting finished runs. Idempotent: later calls only swap the settings source and
 * options. While `telemetryExport` is off nothing is sent; only bounded in-memory run state is kept.
 */
export function startTelemetryExporter(getSettings: TelemetrySettingsSource, options: TelemetryExporterOptions = {}): void {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const existing = g.__ompUiTelemetry;
  if (existing) {
    existing.getSettings = getSettings;
    existing.graceMs = graceMs;
    return;
  }
  const state: ExporterState = {
    getSettings,
    graceMs,
    runs: new Map(),
    pending: new Set(),
    lastWarnAt: 0,
    unsubscribe: () => undefined,
  };
  state.unsubscribe = subscribe((event) => onEvent(state, event));
  g.__ompUiTelemetry = state;
}

/** Stop listening and forget all run state (tests). */
export function stopTelemetryExporter(): void {
  const state = g.__ompUiTelemetry;
  if (!state) return;
  state.unsubscribe();
  state.runs.clear();
  delete g.__ompUiTelemetry;
}

/** Resolves once every export started so far has been sent or dropped (tests). */
export async function flushTelemetry(): Promise<void> {
  const state = g.__ompUiTelemetry;
  while (state && state.pending.size > 0) await Promise.allSettled([...state.pending]);
}

// --- Event intake ---------------------------------------------------------------------------

function onEvent(state: ExporterState, event: ServerEvent): void {
  switch (event.type) {
    case "run.updated":
      onRunUpdated(state, event.run, event.boardId);
      return;
    case "run.event":
      onRunEvent(state, event.event);
      return;
    case "run.agent": {
      const trace = state.runs.get(event.runId);
      if (trace) recordSubagent(trace, event.agent, Date.now());
      return;
    }
    case "run.context": {
      const trace = state.runs.get(event.runId);
      if (trace) {
        trace.context = event.context;
        if (event.usage) trace.sessionUsage = event.usage;
        trace.lastSeen = Date.now();
      }
      return;
    }
    case "task.updated":
      // The run row has no title; the card's arrives with the `running` task update.
      for (const trace of state.runs.values()) {
        if (trace.taskId === event.task.id) trace.title = event.task.title;
      }
      return;
    default:
      return;
  }
}

function onRunUpdated(state: ExporterState, run: Run, boardId: string): void {
  let trace = state.runs.get(run.id);
  if (!trace) {
    // Only runs seen starting are tracked, so log lines trailing an exported run start nothing.
    if (run.status !== "running" && !run.endedAt) return;
    prune(state);
    trace = newTrace(run, boardId);
    state.runs.set(run.id, trace);
  }
  trace.lastSeen = Date.now();
  if (run.status === "running" || !run.endedAt || trace.finished) return;
  trace.finished = run;
  track(state, finishRun(state, trace));
}

function newTrace(run: Run, boardId: string): RunTrace {
  const now = Date.now();
  return {
    runId: run.id,
    taskId: run.taskId,
    boardId,
    startedAt: parseTime(run.startedAt) ?? now,
    lastSeen: now,
    title: null,
    model: null,
    tools: [],
    droppedTools: 0,
    errors: [],
    subagents: new Map(),
    context: null,
    sessionUsage: null,
    finished: null,
  };
}

function onRunEvent(state: ExporterState, event: RunEvent): void {
  // Only runs seen starting are tracked; lines of runs started before the exporter are ignored.
  const trace = state.runs.get(event.runId);
  if (!trace) return;
  const at = parseTime(event.createdAt) ?? Date.now();
  trace.lastSeen = Date.now();
  if (event.kind === "agent") {
    // Subagent snapshots arrive while the `task` tool runs; they do not end it.
    const snapshot = parseSnapshot(event.text);
    if (snapshot) recordSubagent(trace, snapshot, at);
    return;
  }
  const open = trace.tools.at(-1);
  if (open && open.end === null) open.end = at;
  switch (event.kind) {
    case "tool": {
      const tool = parseToolLine(event.text);
      if (!tool) return;
      if (trace.tools.length >= MAX_TOOLS_PER_RUN) {
        trace.droppedTools++;
        return;
      }
      trace.tools.push({ ...tool, start: at, end: null });
      return;
    }
    case "error":
      if (trace.errors.length < MAX_ERRORS_PER_RUN) trace.errors.push({ message: event.text, at });
      return;
    case "status":
      trace.model = parseModel(event.text) ?? trace.model;
      return;
    default:
      return;
  }
}

function recordSubagent(trace: RunTrace, snapshot: SubagentSnapshot, at: number): void {
  trace.subagents.set(snapshot.id, { snapshot, seenAt: at });
  trace.lastSeen = Date.now();
}

/** Drop runs whose end never arrived (older than a day) and the oldest beyond MAX_RUNS. */
function prune(state: ExporterState): void {
  const cutoff = Date.now() - MAX_RUN_AGE_MS;
  for (const [id, trace] of state.runs) {
    if (trace.lastSeen < cutoff && !trace.finished) state.runs.delete(id);
  }
  // Map order is insertion order: the first keys are the oldest runs.
  for (const [id, trace] of state.runs) {
    if (state.runs.size < MAX_RUNS) break;
    if (!trace.finished) state.runs.delete(id);
  }
}

function track(state: ExporterState, work: Promise<void>): void {
  state.pending.add(work);
  void work.finally(() => state.pending.delete(work));
}

async function finishRun(state: ExporterState, trace: RunTrace): Promise<void> {
  try {
    const settings = await state.getSettings();
    const endpoint = settings.telemetryExport ? settings.telemetryEndpoint.trim() : "";
    if (!endpoint) return;
    if (state.graceMs > 0) await sleep(state.graceMs, undefined, { ref: false });
    const result = await postOtlp(endpoint, buildRunPayload(trace));
    if (!result.ok) warn(state, `export of run ${trace.runId} failed: ${result.error ?? `HTTP ${result.status}`}`);
  } catch (err) {
    warn(state, `export of run ${trace.runId} failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    state.runs.delete(trace.runId);
  }
}

/** Export failures are logged at most once a minute: a down collector must not flood the log. */
function warn(state: ExporterState, message: string): void {
  const now = Date.now();
  if (now - state.lastWarnAt < WARN_INTERVAL_MS) return;
  state.lastWarnAt = now;
  console.warn(`[telemetry] ${message}`);
}

// --- Log line parsing -----------------------------------------------------------------------

/** `▸ name: detail` (manager.ts describeToolStart); the intent rides on a second line. */
export function parseToolLine(text: string): { name: string; detail: string } | null {
  const first = text.split("\n", 1)[0] ?? "";
  const match = /^▸\s*([^:]+?)(?::\s*(.*))?$/.exec(first.trim());
  if (!match?.[1]) return null;
  return { name: match[1], detail: match[2] ?? "" };
}

/**
 * Model of the run from its status lines: "Starting agent in … (model X, thinking Y)",
 * "Resuming agent session in … (model X)", "Model auto-selected: X (reason)" or
 * "Model kept from the resumed session: X[ (thinking Y)]".
 */
export function parseModel(text: string): string | null {
  const kept = /^Model kept from the resumed session: (\S+)/.exec(text);
  if (kept?.[1]) return kept[1];
  const auto = /^Model auto-selected: (\S+)/.exec(text);
  if (auto?.[1]) return auto[1] === "omp" ? null : auto[1];
  if (!/^(Starting agent|Resuming agent session)\b/.test(text)) return null;
  return /\(model ([^,)\s]+)/.exec(text)?.[1] ?? null;
}

function parseSnapshot(text: string): SubagentSnapshot | null {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && typeof (value as SubagentSnapshot).id === "string") {
      return value as SubagentSnapshot;
    }
  } catch {
    // Not a snapshot: ignore.
  }
  return null;
}

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// --- OTLP/HTTP JSON encoding ----------------------------------------------------------------

type AttrValue = string | number | boolean | null | undefined;
type OtlpAnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

interface OtlpAttribute {
  key: string;
  value: OtlpAnyValue;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  events?: { timeUnixNano: string; name: string; attributes: OtlpAttribute[] }[];
  status: { code: number; message?: string };
}

/** Attributes in OTLP JSON form; null/undefined/empty values are left out. */
function attributes(values: Record<string, AttrValue>): OtlpAttribute[] {
  const out: OtlpAttribute[] = [];
  for (const [key, raw] of Object.entries(values)) {
    if (raw === null || raw === undefined || raw === "") continue;
    let value: OtlpAnyValue;
    if (typeof raw === "string") value = { stringValue: truncate(raw) };
    else if (typeof raw === "boolean") value = { boolValue: raw };
    // OTLP JSON encodes 64-bit integers as decimal strings.
    else if (Number.isInteger(raw)) value = { intValue: String(raw) };
    else if (Number.isFinite(raw)) value = { doubleValue: raw };
    else continue;
    out.push({ key, value });
  }
  return out;
}

function truncate(text: string): string {
  return text.length > MAX_ATTR_TEXT ? `${text.slice(0, MAX_ATTR_TEXT - 1)}…` : text;
}

function nanos(ms: number): string {
  return (BigInt(Math.round(ms)) * BigInt(1_000_000)).toString();
}

function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

function payload(spans: OtlpSpan[]): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: attributes({ "service.name": SERVICE_NAME }) },
        scopeSpans: [{ scope: { name: SCOPE_NAME }, spans }],
      },
    ],
  };
}

/** The OTLP request body for one finished run. */
function buildRunPayload(trace: RunTrace): unknown {
  const run = trace.finished;
  if (!run) throw new Error("run has not finished");
  // Derived from the run id: one trace per run, so a re-sent run lands on the same trace.
  const traceId = createHash("sha256").update(trace.runId).digest("hex").slice(0, 32);
  const rootId = newSpanId();
  const start = parseTime(run.startedAt) ?? trace.startedAt;
  const end = Math.max(start, parseTime(run.endedAt) ?? Date.now());
  const clamp = (ms: number) => Math.min(end, Math.max(start, ms));

  const subagents = [...trace.subagents.values()];
  const costs = subagents.map((s) => s.snapshot.cost).filter((c): c is number => typeof c === "number");
  const tokens = subagents.map((s) => s.snapshot.tokens).filter((t): t is number => typeof t === "number");
  const failed = run.status !== "succeeded";
  const errorMessage = failed ? (run.error ?? trace.errors.at(-1)?.message ?? run.status) : null;

  const root: OtlpSpan = {
    traceId,
    spanId: rootId,
    name: `invoke_agent ${trace.title ?? AGENT_NAME}`,
    kind: KIND_CLIENT,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(end),
    attributes: attributes({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": AGENT_NAME,
      "gen_ai.request.model": trace.model,
      "agentman.task.id": trace.taskId,
      "agentman.task.title": trace.title,
      "agentman.board.id": trace.boardId,
      "agentman.run.id": trace.runId,
      "agentman.run.status": run.status,
      "error.type": failed ? (run.status === "aborted" ? "aborted" : "agent_failed") : null,
      "error.message": errorMessage,
      // `agentman.cost_usd` is the whole run's spend: the main omp session plus every subagent.
      // omp reports the session's tokens only as a total, so no gen_ai.usage.input/output split.
      "agentman.cost_usd":
        trace.sessionUsage || costs.length > 0
          ? (trace.sessionUsage?.costUsd ?? 0) + costs.reduce((a, b) => a + b, 0)
          : null,
      "agentman.session.cost_usd": trace.sessionUsage?.costUsd,
      "agentman.session.tokens": trace.sessionUsage?.tokens,
      "agentman.subagents.tokens": tokens.length > 0 ? tokens.reduce((a, b) => a + b, 0) : null,
      "agentman.subagents.count": subagents.length || null,
      "agentman.tools.count": trace.tools.length + trace.droppedTools || null,
      "agentman.tools.dropped": trace.droppedTools || null,
      "agentman.context.tokens": trace.context?.tokens,
      "agentman.context.window": trace.context?.contextWindow || null,
    }),
    events: trace.errors.map((e) => ({
      timeUnixNano: nanos(clamp(e.at)),
      name: "exception",
      attributes: attributes({ "exception.message": e.message }),
    })),
    status: failed ? { code: STATUS_ERROR, message: truncate(errorMessage ?? run.status) } : { code: STATUS_OK },
  };

  const toolSpans = trace.tools.map(
    (tool): OtlpSpan => ({
      traceId,
      spanId: newSpanId(),
      parentSpanId: rootId,
      name: `execute_tool ${tool.name}`,
      kind: KIND_INTERNAL,
      startTimeUnixNano: nanos(clamp(tool.start)),
      endTimeUnixNano: nanos(clamp(Math.max(tool.start, tool.end ?? end))),
      attributes: attributes({
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": tool.name,
        "agentman.tool.detail": tool.detail,
      }),
      status: { code: STATUS_UNSET },
    }),
  );

  const subagentSpans = subagents.map(({ snapshot, seenAt }): OtlpSpan => {
    const stop = clamp(seenAt);
    const statusCode =
      snapshot.status === "completed" ? STATUS_OK : snapshot.status === "failed" ? STATUS_ERROR : STATUS_UNSET;
    return {
      traceId,
      spanId: newSpanId(),
      parentSpanId: rootId,
      name: `invoke_agent ${snapshot.agent}`,
      kind: KIND_CLIENT,
      startTimeUnixNano: nanos(clamp(stop - (snapshot.durationMs ?? 0))),
      endTimeUnixNano: nanos(stop),
      attributes: attributes({
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": snapshot.agent,
        "gen_ai.agent.id": snapshot.id,
        "gen_ai.agent.description": snapshot.description,
        "gen_ai.request.model": snapshot.model,
        "agentman.subagent.status": snapshot.status,
        "agentman.subagent.tokens": snapshot.tokens,
        "agentman.subagent.requests": snapshot.requests,
        "agentman.subagent.tools.count": snapshot.toolCount,
        "agentman.cost_usd": snapshot.cost,
        "error.type": snapshot.status === "failed" ? "subagent_failed" : null,
      }),
      status:
        statusCode === STATUS_ERROR ? { code: statusCode, message: truncate(snapshot.error ?? "failed") } : { code: statusCode },
    };
  });

  return payload([root, ...toolSpans, ...subagentSpans]);
}

// --- Transport ------------------------------------------------------------------------------

/**
 * Extra request headers from OTEL_EXPORTER_OTLP_HEADERS (`k=v,k2=v2`, values URL-encoded), as
 * the OpenTelemetry exporter spec defines; malformed pairs are skipped.
 */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!key) continue;
    try {
      headers[key] = decodeURIComponent(value);
    } catch {
      headers[key] = value;
    }
  }
  return headers;
}

/** POST one OTLP/HTTP JSON body. Never throws: failures come back as `{ ok: false, error }`. */
async function postOtlp(endpoint: string, body: unknown): Promise<TelemetryPostResult> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, status: null, error: `Invalid endpoint URL: ${endpoint}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, status: null, error: "The endpoint must be an http(s) URL" };
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    // Drain the body so the connection is released.
    const text = await response.text().catch(() => "");
    if (response.ok) return { ok: true, status: response.status, error: null };
    const detail = text.trim().slice(0, 200);
    return { ok: false, status: response.status, error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
  } catch (err) {
    const reason =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
        ? `no answer within ${POST_TIMEOUT_MS / 1000} s`
        : err instanceof Error
          ? (err.cause instanceof Error ? err.cause.message : err.message)
          : String(err);
    return { ok: false, status: null, error: reason };
  }
}

/** Send one small span to `endpoint` (Settings → "Send test span"); reports the collector's answer. */
export async function exportTestSpan(endpoint: string): Promise<TelemetryPostResult> {
  const now = Date.now();
  const span: OtlpSpan = {
    traceId: randomBytes(16).toString("hex"),
    spanId: newSpanId(),
    name: "agentman.test",
    kind: KIND_INTERNAL,
    startTimeUnixNano: nanos(now - 1),
    endTimeUnixNano: nanos(now),
    attributes: attributes({ "agentman.test": true }),
    status: { code: STATUS_OK },
  };
  return postOtlp(endpoint.trim(), payload([span]));
}
