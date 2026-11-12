// Short read-only omp helper agents (the card writer, the advisor, the queue planner) over omp's
// native RPC protocol (`omp --mode rpc`, JSONL on stdio), on warm pooled workers: streaming tool
// activity, optionally steering the agent to answer, resolving with its final assistant text.
import { stat } from "node:fs/promises";
import { describeExit } from "@/lib/agent/rpc";
import { acquireWorker } from "@/lib/agent/rpc-pool";
import { clip } from "@/lib/card-draft";

/** Read-only tools: helper agents look things up, they never change the project. */
export const READ_ONLY_TOOLS = "read,grep,glob";
const ACTIVITY_MAX = 160;
/** omp must report `ready` within this long. */
const READY_TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;

export interface HelperRunOptions {
  command: string;
  cwd: string;
  /** Project folders besides `cwd` the agent may read (`--add-dir`). */
  addDirs: string[];
  model: string | null;
  thinking: string | null;
  /** The call is cancelled (and its worker killed) after this long. */
  timeoutSeconds: number;
  env: NodeJS.ProcessEnv;
  prompt: string;
  signal: AbortSignal;
  /** Names the agent in errors: "card agent" → "The card agent failed: …". */
  label: string;
  /** One-line progress ("Finding the new-card form") as the agent works. */
  onActivity?: (text: string) => void;
  /** Progress line once the agent starts writing its answer. */
  writing?: string;
  /** After `afterTools` tool calls, steer the agent with `message` to answer with what it found. */
  steer?: { afterTools: number; message: string; activity: string };
  /** Keep the worker warm for later calls with the same arguments (default true). */
  reusable?: boolean;
}

/**
 * omp arguments of a read-only helper worker. No `--max-time`: omp counts it from process start,
 * which a warm worker outlives; the host enforces `timeoutSeconds` per call instead.
 */
export function helperArgs(options: Pick<HelperRunOptions, "cwd" | "addDirs" | "model" | "thinking">): string[] {
  const args = ["--mode", "rpc", "--no-session", "--no-title", "--no-lsp", "--tools", READ_ONLY_TOOLS, "--cwd", options.cwd];
  for (const folder of options.addDirs) args.push("--add-dir", folder);
  if (options.model) args.push("--model", options.model);
  if (options.thinking) args.push("--thinking", options.thinking);
  const extra = process.env.OMP_EXTRA_ARGS?.trim();
  if (extra) args.push(...extra.split(/\s+/));
  return args;
}

/** Run the helper agent; resolves with its final assistant text. Rejects on failure, timeout or abort. */
export async function runOmpHelper(options: HelperRunOptions): Promise<string> {
  const { command, signal, label, timeoutSeconds, steer } = options;
  const onActivity = options.onActivity ?? (() => undefined);
  signal.throwIfAborted();
  const worker = acquireWorker({
    command,
    args: helperArgs(options),
    cwd: options.cwd,
    env: options.env,
    reusable: options.reusable ?? true,
  });
  const proc = worker.proc;
  const ended = Promise.withResolvers<void>();
  let reply = "";
  let failure: string | null = null;
  let tools = 0;
  let timedOut = false;
  const onFrame = (frame: Json) => {
    if (frame.type === "tool_execution_start") {
      onActivity(describeTool(frame));
      tools += 1;
      if (steer && tools === steer.afterTools) {
        onActivity(steer.activity);
        proc.send({ type: "steer", message: steer.message }).catch(() => undefined);
      }
    } else if (frame.type === "message_update") {
      const event = frame.assistantMessageEvent;
      if (isObject(event) && event.type === "text_start") onActivity(options.writing ?? "Writing the answer…");
    } else if (frame.type === "message_end" && isObject(frame.message) && frame.message.role === "assistant") {
      const message = frame.message;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        failure = typeof message.errorMessage === "string" ? message.errorMessage : "The model request failed.";
      } else if (textOf(message.content)) {
        reply = textOf(message.content);
        failure = null;
      }
    } else if (frame.type === "agent_end" && frame.isTerminal !== false) {
      ended.resolve();
    }
  };
  const onExit = () => ended.resolve();
  proc.on("frame", onFrame);
  proc.on("exit", onExit);
  // Killing the worker settles everything below: readiness and the prompt reject, `ended` resolves.
  const onAbort = () => worker.discard();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    worker.discard();
  }, timeoutSeconds * 1000);
  let clean = false;
  try {
    await proc.waitReady(READY_TIMEOUT_MS);
    const response = await proc.send({ type: "prompt", message: options.prompt });
    if (isObject(response.data) && response.data.agentInvoked === false) throw new Error(`The ${label} did not start.`);
    await ended.promise;
    clean = !proc.exited;
  } catch (err) {
    if (!signal.aborted && !timedOut) {
      const code = isObject(err) ? err.code : undefined;
      throw code === "ENOENT" ? new Error(`omp not found at ${command}. Install it from https://omp.sh or set OMP_PATH.`) : err;
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    proc.off("frame", onFrame);
    proc.off("exit", onExit);
    if (clean && !signal.aborted && !timedOut) worker.release();
    else worker.discard();
  }
  signal.throwIfAborted();
  if (timedOut) throw new Error(`The ${label} took longer than ${timeoutSeconds}s.`);
  if (reply) return reply;
  if (failure) throw new Error(`The ${label} failed: ${failure}`);
  const exit = proc.exited ? describeExit(await proc.waitExit()) : "it ended without a reply";
  throw new Error(`The ${label} stopped without an answer (${exit}).`);
}

/** The JSON object in an agent's reply, possibly fenced or surrounded by prose; null when none. */
export function extractJsonObject(reply: string): Json | null {
  const text = reply.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1").trim();
  const candidates = [text];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (isObject(value)) return value;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** Folders among `folders` that exist, without `except` (the working folder); checked in parallel. */
export async function existingFolders(folders: readonly string[], except: string): Promise<string[]> {
  const candidates = folders.filter((folder) => folder !== except);
  const found = await Promise.all(candidates.map(isDirectory));
  return candidates.filter((_, index) => found[index]);
}

export async function isDirectory(folder: string): Promise<boolean> {
  try {
    return (await stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

/** "Finding the new-card form" (omp's intent), else "grep: createCard". */
export function describeTool(frame: Json): string {
  const name = typeof frame.toolName === "string" ? frame.toolName : "tool";
  const args = isObject(frame.args) ? frame.args : {};
  const filled = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
  const intent = [frame.intent, args.intent].find(filled);
  if (intent) return clip(intent.trim(), ACTIVITY_MAX);
  const target = [args.pattern, args.path].find(filled);
  return clip(target ? `${name}: ${target.trim()}` : name, ACTIVITY_MAX);
}

/** The text blocks of an assistant message's `content`, joined and trimmed. */
export function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isObject(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
