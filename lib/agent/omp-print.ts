// One-shot omp helper agents (the card writer, the advisor): `omp -p --mode json` with read-only
// tools in the project, streaming tool activity, resolving with the final assistant text.
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { clip } from "@/lib/card-draft";

/** Read-only tools: helper agents look things up, they never change the project. */
export const READ_ONLY_TOOLS = "read,grep,glob";
const STDERR_LIMIT = 4 * 1024;
const ACTIVITY_MAX = 160;

type Json = Record<string, unknown>;

export interface PrintRunOptions {
  command: string;
  cwd: string;
  /** Project folders besides `cwd` the agent may read (`--add-dir`). */
  addDirs: string[];
  model: string | null;
  thinking: string | null;
  /** omp stops the session itself after this long (`--max-time`); killed 30s later. */
  maxTimeSeconds: number;
  env: NodeJS.ProcessEnv;
  prompt: string;
  signal: AbortSignal;
  /** Names the agent in errors: "card agent" → "The card agent failed: …". */
  label: string;
  /** One-line progress ("Finding the new-card form") as the agent works. */
  onActivity?: (text: string) => void;
  /** Progress line once the agent starts writing its answer. */
  writing?: string;
}

/** `omp -p --mode json` arguments for a read-only helper run. */
export function printArgs(options: Pick<PrintRunOptions, "cwd" | "addDirs" | "model" | "thinking" | "maxTimeSeconds">): string[] {
  const args = [
    "-p",
    "--mode",
    "json",
    "--no-session",
    "--no-title",
    "--no-lsp",
    "--tools",
    READ_ONLY_TOOLS,
    "--max-time",
    String(options.maxTimeSeconds),
    "--cwd",
    options.cwd,
  ];
  for (const folder of options.addDirs) args.push("--add-dir", folder);
  if (options.model) args.push("--model", options.model);
  if (options.thinking) args.push("--thinking", options.thinking);
  const extra = process.env.OMP_EXTRA_ARGS?.trim();
  if (extra) args.push(...extra.split(/\s+/));
  return args;
}

/** Run the helper agent; resolves with its final assistant text. Rejects on failure, timeout or abort. */
export function runOmpPrint(options: PrintRunOptions): Promise<string> {
  const { command, cwd, env, prompt, signal, label, maxTimeSeconds } = options;
  const onActivity = options.onActivity ?? (() => undefined);
  const Label = label.charAt(0).toUpperCase() + label.slice(1);
  const killAfterMs = (maxTimeSeconds + 30) * 1000;
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn(command, printArgs(options), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let reply = "";
  let failure: string | null = null;
  let stderr = "";
  let buffer = "";
  let settled = false;

  const finish = (error: Error | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    if (error) reject(error);
    else resolve(reply);
  };
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  const onAbort = () => {
    kill();
    finish(signal.reason instanceof Error ? signal.reason : new Error("Cancelled"));
  };
  const timer = setTimeout(() => {
    kill();
    finish(new Error(`The ${label} took longer than ${maxTimeSeconds + 30}s.`));
  }, killAfterMs);
  if (signal.aborted) {
    onAbort();
    return promise;
  }
  signal.addEventListener("abort", onAbort);

  const onLine = (line: string) => {
    if (!line.startsWith("{")) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObject(frame)) return;
    if (frame.type === "tool_execution_start") {
      onActivity(describeTool(frame));
    } else if (frame.type === "message_update") {
      const event = isObject(frame.assistantMessageEvent) ? frame.assistantMessageEvent : null;
      if (event?.type === "text_start") onActivity(options.writing ?? "Writing the answer…");
    } else if (frame.type === "message_end" && isObject(frame.message) && frame.message.role === "assistant") {
      const message = frame.message;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        failure = typeof message.errorMessage === "string" ? message.errorMessage : "The model request failed.";
        return;
      }
      const text = textOf(message.content);
      if (text) {
        reply = text;
        failure = null;
      }
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      onLine(buffer.slice(0, newline).trim());
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_LIMIT);
  });
  child.stdin.on("error", () => undefined);
  child.on("error", (err: NodeJS.ErrnoException) => {
    finish(
      new Error(
        err.code === "ENOENT" ? `omp not found at ${command}. Install it from https://omp.sh or set OMP_PATH.` : err.message,
      ),
    );
  });
  child.on("close", (code) => {
    onLine(buffer.trim());
    if (failure) return finish(new Error(`The ${label} failed: ${failure}`));
    if (reply) return finish(null);
    const detail = stderr.trim().split("\n").slice(-3).join(" ").trim();
    finish(new Error(`${Label} stopped without an answer (exit code ${code ?? "unknown"})${detail ? `: ${detail}` : "."}`));
  });
  child.stdin.end(prompt);
  return promise;
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

/** Folders among `folders` that exist, without `except` (the working folder). */
export async function existingFolders(folders: readonly string[], except: string): Promise<string[]> {
  const found: string[] = [];
  for (const folder of folders) {
    if (folder !== except && (await isDirectory(folder))) found.push(folder);
  }
  return found;
}

export async function isDirectory(folder: string): Promise<boolean> {
  try {
    return (await stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

/** "Finding the new-card form" (omp's intent), else "grep: createCard". */
function describeTool(frame: Json): string {
  const name = typeof frame.toolName === "string" ? frame.toolName : "tool";
  const args = isObject(frame.args) ? frame.args : {};
  const filled = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
  const intent = [frame.intent, args.intent].find(filled);
  if (intent) return clip(intent.trim(), ACTIVITY_MAX);
  const target = [args.pattern, args.path].find(filled);
  return clip(target ? `${name}: ${target.trim()}` : name, ACTIVITY_MAX);
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isObject(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
