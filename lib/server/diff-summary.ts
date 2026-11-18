// The one/two-sentence summary on top of the Review tab. A quick read-only omp helper run
// (pooled `omp --mode rpc`, the fast `smol` role when configured) writes it from the diffstat and a truncated
// patch; results are cached by the diff's hash in memory and under DATA_DIR/runtime, so reopening
// a card is instant. Until the summary agent answers (or when it can't), a deterministic line
// ("3 files changed (+120 −14): app/page.tsx, lib/x.ts …") stands in.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readModelRoles } from "@/lib/agent/model-select";
import { chooseHelperModel } from "@/lib/agent/provider-quota";
import { isDirectory, runOmpHelper } from "@/lib/agent/omp-helper";
import { clip } from "@/lib/card-draft";
import { childEnv } from "@/lib/child-env";
import { fallbackSummary, type DiffSummary, type TaskDiff } from "@/lib/diff-types";
import { dataDir } from "@/lib/files";
import type { AppSettings, Board, Task } from "@/lib/types";

/** Host-side hard cancel of the summary agent. */
const TIMEOUT_SECONDS = 90;
/** Patch characters handed to the summary agent. */
const PROMPT_PATCH_MAX = 24_000;
/** Files listed in the prompt's diffstat. */
const PROMPT_FILES_MAX = 80;
const SUMMARY_MAX = 320;
/** Summaries kept in memory (least recently used dropped first). */
const MEMORY_LIMIT = 200;
/** Summary agents running at once across the server. */
const MAX_CONCURRENT = 2;

interface Cached {
  /** The model's summary; null when it failed (`error`). */
  text: string | null;
  error: string | null;
}

interface State {
  cache: Map<string, Cached>;
  inflight: Map<string, Promise<void>>;
  running: number;
}

const g = globalThis as unknown as { __ompUiDiffSummaries?: State };
const state: State = (g.__ompUiDiffSummaries ??= { cache: new Map(), inflight: new Map(), running: 0 });

function cacheFile(hash: string): string {
  return path.join(dataDir(), "runtime", "diff-summaries", `${hash}.json`);
}

function remember(hash: string, entry: Cached): void {
  state.cache.delete(hash);
  state.cache.set(hash, entry);
  while (state.cache.size > MEMORY_LIMIT) {
    const oldest = state.cache.keys().next().value;
    if (oldest === undefined) break;
    state.cache.delete(oldest);
  }
}

async function lookup(hash: string): Promise<Cached | null> {
  const hit = state.cache.get(hash);
  if (hit) {
    remember(hash, hit);
    return hit;
  }
  try {
    const data = JSON.parse(await readFile(cacheFile(hash), "utf8")) as { text?: unknown };
    if (typeof data.text === "string" && data.text.trim()) {
      const entry = { text: data.text, error: null };
      remember(hash, entry);
      return entry;
    }
  } catch {
    // Not cached on disk.
  }
  return null;
}

/** The summary agent's instructions plus the diffstat and a truncated patch. */
export function buildSummaryPrompt(diff: TaskDiff, task: Pick<Task, "title">): string {
  const multi = diff.repos.filter((repo) => repo.files.length > 0).length > 1;
  const stat: string[] = [];
  const patches: string[] = [];
  let room = PROMPT_PATCH_MAX;
  for (const repo of diff.repos) {
    for (const file of repo.files) {
      const name = multi ? `${repo.name}/${file.path}` : file.path;
      const renamed = file.oldPath ? ` (renamed from ${file.oldPath})` : "";
      const kind = file.binary ? " binary" : file.untracked ? " new, untracked" : "";
      if (stat.length < PROMPT_FILES_MAX) {
        stat.push(`${file.status} ${name}${renamed} (+${file.additions} -${file.deletions}${kind})`);
      }
      if (file.patch && room > 200) {
        const piece = `--- ${name}\n${file.patch}`;
        const taken = piece.length > room ? `${piece.slice(0, room)}\n[… cut]` : piece;
        patches.push(taken);
        room -= taken.length;
      }
    }
  }
  if (diff.stats.files > stat.length) stat.push(`… and ${diff.stats.files - stat.length} more files`);
  // omp treats this word anywhere in a prompt as a request for parallel subagents.
  const defuse = (text: string) => text.replace(/orchestrate/gi, (word) => `${word.slice(0, 5)}\u200b${word.slice(5)}`);
  return [
    "You summarise code changes for a reviewer. Write one or two short, plain sentences (at most 40 words in total) saying what the change does and why it matters — behaviour, not a list of files.",
    "Reply with only the summary: no markdown, no heading, no preamble, no quotes. Do not use any tools; everything you need is below.",
    "",
    `Card: ${defuse(clip(task.title.replace(/\s+/g, " ").trim(), 200))}`,
    `Totals: ${diff.stats.files} files, +${diff.stats.additions} -${diff.stats.deletions}`,
    "",
    "Files:",
    ...stat.map(defuse),
    "",
    "Patch (may be cut short):",
    defuse(patches.join("\n")),
  ].join("\n");
}

/** The agent's reply as one clean line. */
function cleanReply(reply: string): string {
  const text = reply
    .trim()
    .replace(/^```[a-z]*\s*\n?([\s\S]*?)\n?```$/i, "$1")
    .replace(/^(summary|tl;dr)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
  return clip(text, SUMMARY_MAX);
}

async function generate(
  hash: string,
  diff: TaskDiff,
  context: { board: Board; task: Pick<Task, "title">; settings: AppSettings },
): Promise<void> {
  const { board, task, settings } = context;
  try {
    const cwd =
      diff.repos.find((repo) => repo.isRepo && repo.files.length > 0)?.folder ?? board.workdir;
    if (!(await isDirectory(cwd))) throw new Error(`Project folder not found: ${cwd}`);
    const env = childEnv();
    const roles = await readModelRoles(settings.ompPath, cwd, env);
    // The fast `smol` role when configured; otherwise the usual model, thinking briefly.
    const { model, role, config } = await chooseHelperModel({ settings, pinned: board.model, roles: [["smol", roles?.smol]], modelRoles: roles });
    const reply = await runOmpHelper({
      command: settings.ompPath,
      cwd,
      addDirs: [],
      model,
      thinking: role ? null : "low",
      config,
      timeoutSeconds: TIMEOUT_SECONDS,
      env,
      prompt: buildSummaryPrompt(diff, task),
      signal: new AbortController().signal,
      label: "summary agent",
      // Everything it needs is in the prompt: answer instead of looking around.
      steer: { afterTools: 2, message: "Reply now with only the one or two sentence summary.", activity: "Writing the summary" },
    });
    const text = cleanReply(reply);
    if (!text) throw new Error("The summary agent gave an empty answer.");
    remember(hash, { text, error: null });
    await mkdir(path.dirname(cacheFile(hash)), { recursive: true });
    await writeFile(cacheFile(hash), JSON.stringify({ text, createdAt: new Date().toISOString() }));
  } catch (err) {
    // Remembered in memory only: a server restart or "Regenerate" tries again.
    if (!state.cache.get(hash)?.text) {
      remember(hash, { text: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * The summary of `diff`: cached when known, else starts the summary agent and waits up to
 * `waitMs` for it. Answers the deterministic fallback with `pending: true` while it still works;
 * the caller asks again. `force` drops a cached summary (or failure) and writes a new one.
 */
export async function diffSummary(
  diff: TaskDiff,
  context: { board: Board; task: Pick<Task, "title">; settings: AppSettings },
  options: { force?: boolean; waitMs?: number } = {},
): Promise<DiffSummary> {
  const { hash } = diff;
  const fallback = (pending: boolean, error: string | null): DiffSummary => ({
    text: fallbackSummary(diff),
    source: "fallback",
    pending,
    error,
    hash,
  });
  if (diff.stats.files === 0) return fallback(false, null);

  if (options.force && !state.inflight.has(hash)) {
    state.cache.delete(hash);
    await rm(cacheFile(hash), { force: true }).catch(() => undefined);
  }
  const answer = async (): Promise<DiffSummary | null> => {
    const cached = await lookup(hash);
    if (!cached) return null;
    return cached.text
      ? { text: cached.text, source: "model", pending: false, error: null, hash }
      : fallback(false, cached.error);
  };
  const known = await answer();
  if (known) return known;

  let inflight = state.inflight.get(hash);
  if (!inflight) {
    // Every slot busy: the fallback for now; the next ask tries again.
    if (state.running >= MAX_CONCURRENT) return fallback(true, null);
    state.running++;
    inflight = generate(hash, diff, context).finally(() => {
      state.running = Math.max(0, state.running - 1);
      state.inflight.delete(hash);
    });
    state.inflight.set(hash, inflight);
  }
  await Promise.race([inflight, delay(options.waitMs ?? 0)]);
  return (await answer()) ?? fallback(true, null);
}
