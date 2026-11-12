// Maps omp's subagent frames (orchestration via the `task` tool) to `SubagentSnapshot` patches.
//
// Sources, any of which may be missing depending on the omp version and async mode:
// - `subagent_lifecycle` / `subagent_progress` (after `set_subagent_subscription`)
// - `tool_execution_update` of the `task` tool: `partialResult.details.progress[]`
// - `tool_execution_end` of the `task` tool: `result.details.results[]` (final reports)
import type { SubagentSnapshot, SubagentStatus, SubagentToolCall } from "@/lib/types";

/** `null` clears a field (e.g. the current tool once it finished); `undefined` keeps it. */
export type SubagentPatch = { id: string } & {
  [K in Exclude<keyof SubagentSnapshot, "id">]?: SubagentSnapshot[K] | null;
};

type Json = Record<string, unknown>;

const MAX_TASK_TEXT = 4_000;
const MAX_OUTPUT_TEXT = 12_000;
const MAX_LINE_TEXT = 300;
const MAX_RECENT_OUTPUT = 8;

export function isTerminalSubagent(status: SubagentStatus): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

/** Apply a patch; a new subagent without a known status starts as running. */
export function mergeSubagent(prev: SubagentSnapshot | undefined, patch: SubagentPatch): SubagentSnapshot {
  const next: Record<string, unknown> = { ...(prev ?? { agent: "task", status: "running" }) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  const snapshot = next as unknown as SubagentSnapshot;
  // A late progress frame must not resurrect a subagent that already ended.
  if (prev && isTerminalSubagent(prev.status) && !isTerminalSubagent(snapshot.status)) {
    snapshot.status = prev.status;
  }
  return snapshot;
}

/** `subagent_lifecycle` payload. */
export function lifecyclePatch(payload: unknown): SubagentPatch | null {
  if (!isObject(payload)) return null;
  const id = asString(payload.id);
  if (!id) return null;
  return {
    id,
    agent: asString(payload.agent),
    index: asNumber(payload.index),
    description: clip(asString(payload.description), MAX_LINE_TEXT),
    status: subagentStatus(payload.status),
  };
}

/** A raw `AgentProgress` record (`subagent_progress.payload.progress`, task `details.progress[]`). */
export function progressPatch(progress: unknown): SubagentPatch | null {
  if (!isObject(progress)) return null;
  const id = asString(progress.id);
  if (!id) return null;
  const currentTool = asString(progress.currentTool);
  return {
    id,
    agent: asString(progress.agent),
    index: asNumber(progress.index),
    status: subagentStatus(progress.status),
    description: clip(asString(progress.description), MAX_LINE_TEXT),
    task: clip(asString(progress.assignment) ?? asString(progress.task), MAX_TASK_TEXT),
    model: asString(progress.resolvedModel) ?? asString(progress.modelOverride),
    intent: clip(asString(progress.lastIntent), MAX_LINE_TEXT),
    currentTool: currentTool ?? null,
    currentToolDetail: currentTool
      ? (clip(oneLine(asString(progress.currentToolIntent) ?? asString(progress.currentToolArgs)), MAX_LINE_TEXT) ?? null)
      : null,
    recentTools: Array.isArray(progress.recentTools) ? toolCalls(progress.recentTools) : undefined,
    recentOutput: Array.isArray(progress.recentOutput)
      ? progress.recentOutput
          .map((line) => clip(asString(line)?.trimEnd(), MAX_LINE_TEXT))
          .filter((line): line is string => Boolean(line))
          .slice(0, MAX_RECENT_OUTPUT)
      : undefined,
    toolCount: asNumber(progress.toolCount),
    requests: asNumber(progress.requests),
    tokens: asNumber(progress.tokens),
    cost: asNumber(progress.cost),
    durationMs: asNumber(progress.durationMs),
  };
}

/** One `SingleResult` of a finished `task` call (`result.details.results[]`). */
export function resultPatch(result: unknown): SubagentPatch | null {
  if (!isObject(result)) return null;
  const id = asString(result.id);
  if (!id) return null;
  const exitCode = asNumber(result.exitCode);
  const aborted = result.aborted === true;
  const status: SubagentStatus | undefined = aborted
    ? "aborted"
    : exitCode === 0
      ? "completed"
      : exitCode !== undefined
        ? "failed"
        : undefined;
  const error =
    asString(result.error) ??
    asString(result.abortReason) ??
    (status === "failed" ? asString(result.stderr)?.trim() || undefined : undefined);
  return {
    id,
    agent: asString(result.agent),
    index: asNumber(result.index),
    status,
    description: clip(asString(result.description), MAX_LINE_TEXT),
    task: clip(asString(result.assignment) ?? asString(result.task), MAX_TASK_TEXT),
    model: asString(result.resolvedModel) ?? asString(result.modelOverride),
    output: clip(asString(result.output)?.trim(), MAX_OUTPUT_TEXT),
    error: clip(error, MAX_LINE_TEXT * 4),
    tokens: asNumber(result.tokens),
    requests: asNumber(result.requests),
    durationMs: asNumber(result.durationMs),
    currentTool: status ? null : undefined,
    currentToolDetail: status ? null : undefined,
  };
}

/** Patches carried by a `task` tool frame: progress on updates, final reports on end. */
export function taskToolPatches(frame: Json): SubagentPatch[] {
  if (frame.toolName !== "task") return [];
  const source = frame.type === "tool_execution_end" ? frame.result : frame.partialResult;
  const details = isObject(source) ? source.details : undefined;
  if (!isObject(details)) return [];
  const patches: SubagentPatch[] = [];
  if (Array.isArray(details.progress)) {
    for (const progress of details.progress) {
      const patch = progressPatch(progress);
      if (patch) patches.push(patch);
    }
  }
  if (frame.type === "tool_execution_end" && Array.isArray(details.results)) {
    for (const result of details.results) {
      const patch = resultPatch(result);
      if (patch) patches.push(patch);
    }
  }
  return patches;
}

/** One-line `▸ task: …` log entry: the call's intent, or who it delegates to. */
export function describeTaskCall(args: Json | undefined, intent: string | undefined): string {
  const tasks = Array.isArray(args?.tasks) ? args.tasks.filter(isObject) : [];
  const names = tasks.map((t) => asString(t.name)).filter((n): n is string => Boolean(n));
  const count = tasks.length || (args?.task !== undefined ? 1 : 0);
  const who = count
    ? `delegating to ${count} subagent${count === 1 ? "" : "s"}${names.length ? ` (${names.join(", ")})` : ""}`
    : "";
  return [intent?.trim(), who].filter(Boolean).join(" — ");
}

function subagentStatus(value: unknown): SubagentStatus | undefined {
  switch (value) {
    case "started":
    case "running":
      return "running";
    case "pending":
    case "completed":
    case "failed":
    case "aborted":
      return value;
    default:
      return undefined;
  }
}

function toolCalls(entries: unknown[]): SubagentToolCall[] {
  const calls: SubagentToolCall[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const tool = asString(entry.tool);
    if (!tool) continue;
    const detail = clip(oneLine(asString(entry.intent) ?? asString(entry.args)), MAX_LINE_TEXT);
    calls.push({
      tool,
      ...(detail ? { detail } : {}),
      ...(entry.isError === true ? { isError: true } : {}),
    });
  }
  return calls;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function oneLine(text: string | undefined): string | undefined {
  const line = text?.replace(/\s+/g, " ").trim();
  return line || undefined;
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
