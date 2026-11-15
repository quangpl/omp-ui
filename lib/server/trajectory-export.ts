// Shared I/O for the trajectory export routes (`GET /tasks/:id/trajectory`, `GET /boards/:id/trajectories`):
// query parsing, a bounded read of a card's omp session file, the secret values to redact, the
// export slots (at most MAX_CONCURRENT_EXPORTS at once) and the streamed NDJSON download response.
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { AI_PROVIDERS } from "@/lib/ai-providers";
import { compressTrajectory, redactTrajectory, sessionToConversations, type Trajectory } from "@/lib/agent/trajectory";
import { childEnv, SECRET_ENV_KEYS } from "@/lib/child-env";
import type { Repository } from "@/lib/db/types";
import { HttpError } from "@/lib/server/http";
import { mcpAgentEnv } from "@/lib/server/mcp-env";
import type { Run, Task } from "@/lib/types";

/** Largest session file one card's export reads. */
export const MAX_SESSION_BYTES = 64 * 1024 ** 2;
/** Session input a board's batch export reads in total; cards beyond it are left out. */
export const MAX_BATCH_SESSION_BYTES = 256 * 1024 ** 2;
/** Trajectory exports running at once (both routes); more are answered 429. */
export const MAX_CONCURRENT_EXPORTS = 2;

const MIN_MAX_TOKENS = 1_000;
const MAX_MAX_TOKENS = 1_000_000;

/** Git host and registry tokens agents inherit from the host environment (see lib/cluster/auth-pack.ts). */
const HOST_TOKEN_ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN", "GL_TOKEN", "NPM_TOKEN"];

export interface TrajectoryOptions {
  /** Compress to `maxTokens` (Hermes trajectory compressor). */
  compress: boolean;
  /** Compression target; undefined → TRAJECTORY_TARGET_TOKENS. */
  maxTokens: number | undefined;
}

/** `compress` (`1`/`true`) and `maxTokens` (integer 1,000–1,000,000, else 400) from the query. */
export function parseTrajectoryOptions(params: URLSearchParams): TrajectoryOptions {
  const compress = params.get("compress");
  const rawMax = params.get("maxTokens");
  let maxTokens: number | undefined;
  if (rawMax !== null) {
    maxTokens = Number(rawMax);
    if (!/^\d+$/.test(rawMax.trim()) || maxTokens < MIN_MAX_TOKENS || maxTokens > MAX_MAX_TOKENS) {
      throw new HttpError(400, `maxTokens must be an integer from ${MIN_MAX_TOKENS} to ${MAX_MAX_TOKENS}`);
    }
  }
  return { compress: compress === "1" || compress === "true", maxTokens };
}

// On globalThis so dev hot reloads share one count.
const g = globalThis as unknown as { __ompUiTrajectoryExports?: { active: number } };

/**
 * Claim one of the MAX_CONCURRENT_EXPORTS export slots; 429 when all are taken. The returned
 * function frees the slot; calling it again does nothing.
 */
export function acquireExportSlot(): () => void {
  const slots = (g.__ompUiTrajectoryExports ??= { active: 0 });
  if (slots.active >= MAX_CONCURRENT_EXPORTS) {
    throw new HttpError(429, "Another trajectory export is running; try again shortly");
  }
  slots.active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    slots.active--;
  };
}

export type SessionRead =
  | { kind: "ok"; text: string; bytes: number }
  | { kind: "missing" }
  | { kind: "too-large"; bytes: number };

// Non-blocking so a FIFO at the path cannot hang the open; no effect on regular files.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/**
 * A card's session file read through one handle: `missing` unless `file` names a `.jsonl` regular
 * file that can be opened, `too-large` (its size) when it is over `maxBytes`, else at most the
 * size checked on that handle (a file still growing is cut there).
 */
export async function readSessionFile(file: string | null, maxBytes: number): Promise<SessionRead> {
  if (!file || !file.endsWith(".jsonl")) return { kind: "missing" };
  let handle: FileHandle;
  try {
    handle = await open(file, OPEN_FLAGS);
  } catch {
    return { kind: "missing" };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { kind: "missing" };
    if (info.size > maxBytes) return { kind: "too-large", bytes: info.size };
    const buffer = Buffer.allocUnsafe(info.size);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { kind: "ok", text: buffer.toString("utf8", 0, filled), bytes: filled };
  } catch {
    return { kind: "missing" };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Secret values an agent may have seen, to redact from exported trajectories: AI provider keys
 * (inherited or saved in Settings → AI Providers), MCP credentials, git host and registry tokens,
 * and AgentMan's own secrets.
 */
export async function exportSecrets(): Promise<string[]> {
  const env = childEnv();
  const values: (string | undefined)[] = Object.values(await mcpAgentEnv());
  for (const provider of AI_PROVIDERS) {
    for (const field of provider.fields) {
      if (field.secret) values.push(env[field.envVar], process.env[field.envVar]);
    }
  }
  for (const [key, value] of Object.entries(process.env)) if (key.startsWith("OMPUI_MCP_")) values.push(value);
  for (const key of [...HOST_TOKEN_ENV_KEYS, ...SECRET_ENV_KEYS]) values.push(process.env[key]);
  return [...new Set(values.filter((value): value is string => !!value))];
}

/** Whether the card's whole session ended well: the agent is idle and its last run succeeded. */
export async function sessionCompleted(repo: Repository, task: Task): Promise<boolean> {
  if (task.agentState !== "idle" || !task.lastRunId) return false;
  const run = await repo.getRun(task.lastRunId);
  return run?.status === "succeeded";
}

/**
 * Trajectory of a card's session: one run's time window (startedAt .. endedAt, or now while it
 * runs) when `run` is given, else the whole session; `secrets` redacted, then compressed when asked.
 */
export function buildTrajectory(input: {
  jsonl: string;
  task: Task;
  run: Run | null;
  completed: boolean;
  options: TrajectoryOptions;
  secrets: readonly string[];
}): Trajectory {
  const now = new Date().toISOString();
  const { run } = input;
  const window = run ? { from: run.startedAt, to: run.endedAt ?? now } : undefined;
  const { conversations, model } = sessionToConversations(input.jsonl, window);
  // Redact before compressing: pruning could cut a secret so it no longer matches.
  const trajectory = redactTrajectory(
    {
      conversations,
      timestamp: run?.endedAt ?? now,
      model,
      completed: input.completed,
      taskId: input.task.id,
      runId: run?.id ?? null,
    },
    input.secrets,
  );
  return input.options.compress ? compressTrajectory(trajectory, { maxTokens: input.options.maxTokens }) : trajectory;
}

/**
 * NDJSON download saved as `filename`, streamed one trajectory per line: `next` is asked for the
 * following trajectory only once the client has taken the previous line, and null ends the stream.
 * The stream owns the export slot `release`: freed when it ends, fails, is cancelled or `req` is
 * aborted (after any `next` in flight settles, so no two reads overlap a freed slot).
 */
export function ndjsonStream(
  req: Request,
  filename: string,
  release: () => void,
  next: () => Promise<Trajectory | null>,
): Response {
  const encoder = new TextEncoder();
  const { signal } = req;
  let busy = false;
  let stopped = false;
  const finish = () => {
    signal.removeEventListener("abort", stop);
    release();
  };
  function stop() {
    stopped = true;
    if (!busy) finish();
  }
  signal.addEventListener("abort", stop, { once: true });

  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let trajectory: Trajectory | null = null;
        if (!stopped && !signal.aborted) {
          busy = true;
          try {
            trajectory = await next();
          } catch (err) {
            finish();
            controller.error(err);
            return;
          } finally {
            busy = false;
          }
        }
        if (trajectory === null || stopped || signal.aborted) {
          finish();
          try {
            controller.close();
          } catch {
            // Already cancelled.
          }
          return;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify(trajectory)}\n`));
      },
      cancel: stop,
    },
    // Build a line only when the client asks for one: at most one session in memory.
    { highWaterMark: 0 },
  );
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
