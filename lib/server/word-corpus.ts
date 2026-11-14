// Corpus for the composer's inline word completion, condensed into an n-gram model the client
// looks up locally. Admins get omp's prompt history plus every card's title and description; a
// regular user only the cards their scoped repository shows (omp's history holds everyone's prompts).
// Building reads every visible card (and spawns omp for admins), so models are cached for a few
// minutes per viewer.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { repoActor } from "@/lib/db/scoped";
import type { Repository } from "@/lib/db/types";
import { agentDir } from "@/lib/server/omp-config";
import { buildWordModelData, type WordModelData } from "@/lib/word-completion";

const CACHE_TTL_MS = 5 * 60_000;
/** Cached models at most (one per viewer active in the last few minutes); the oldest go first. */
const CACHE_MAX_ENTRIES = 50;
const HISTORY_LIMIT = 5000;
// omp stands in these for pasted blocks and images; they are not prose the user typed.
const PLACEHOLDER = /\[(?:Pasted text|Image) #\d+[^\]]*\]/g;

interface CachedModel {
  /** omp path the history was read through; null for regular users' card-only models. */
  path: string | null;
  at: number;
  agentDir: Promise<string> | null;
  model: Promise<WordModelData>;
}

const g = globalThis as unknown as {
  /** Viewer key (see `viewerKey`) → model. Map order is build order, oldest first. */
  __ompUiWordModels?: Map<string, CachedModel>;
};

/** omp's agent dir; falls back to its default location when omp is missing or fails. */
async function resolveAgentDir(ompPath: string): Promise<string> {
  try {
    return await agentDir(ompPath);
  } catch {
    return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent");
  }
}

/** Recent prompts from omp's `history.db`; empty when the file is missing or unreadable. */
function historyPrompts(dir: string): string[] {
  const file = path.join(dir, "history.db");
  if (!existsSync(file)) return [];
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT prompt FROM history WHERE typeof(prompt) = 'text' ORDER BY id DESC LIMIT ?")
        .all(HISTORY_LIMIT);
      const prompts: string[] = [];
      for (const row of rows) {
        const prompt = row.prompt;
        // Slash commands are not prose.
        if (typeof prompt !== "string" || prompt.trimStart().startsWith("/")) continue;
        prompts.push(prompt.replace(PLACEHOLDER, " "));
      }
      return prompts;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** Titles and descriptions of every card on every board `repo` shows. */
async function cardTexts(repo: Repository): Promise<string[]> {
  const boards = await repo.listBoards();
  const tasks = await Promise.all(boards.map((board) => repo.listTasks(board.id)));
  const texts: string[] = [];
  for (const task of tasks.flat()) {
    texts.push(task.title);
    if (task.description) texts.push(task.description);
  }
  return texts;
}

async function buildModel(repo: Repository, dir: Promise<string> | null): Promise<WordModelData> {
  const [prompts, cards] = await Promise.all([dir ? dir.then(historyPrompts) : [], cardTexts(repo)]);
  return buildWordModelData([...prompts, ...cards]);
}

const ADMIN_KEY = "admin";

/** Admins and the unscoped repository see the same corpus and share one model; each user gets their own. */
function viewerKey(repo: Repository): string {
  const actor = repoActor(repo);
  return actor && actor.role !== "admin" ? `user:${actor.id}` : ADMIN_KEY;
}

/** Drop expired models, then the oldest while over the cap. */
function prune(cache: Map<string, CachedModel>, now: number): void {
  for (const [key, entry] of cache) {
    if (now - entry.at > CACHE_TTL_MS) cache.delete(key);
  }
  for (const key of cache.keys()) {
    if (cache.size <= CACHE_MAX_ENTRIES) break;
    cache.delete(key);
  }
}

/**
 * The word-completion model for `repo`'s viewer (cached for five minutes per viewer and, for
 * admins, per omp path; `refresh` rebuilds the viewer's own model). Concurrent callers share one
 * build; a failed build is not cached.
 */
export function wordCompletionModel(
  repo: Repository,
  ompPath: string,
  options: { refresh?: boolean } = {},
): Promise<WordModelData> {
  const cache = (g.__ompUiWordModels ??= new Map());
  const key = viewerKey(repo);
  // Only the admin model reads omp's history.
  const historyFrom = key === ADMIN_KEY ? ompPath : null;
  const now = Date.now();
  const cached = cache.get(key);
  if (!options.refresh && cached && cached.path === historyFrom && now - cached.at <= CACHE_TTL_MS) {
    return cached.model;
  }

  // The agent dir rarely changes; reuse the resolved one so a rebuild does not spawn omp again.
  const dir =
    historyFrom === null ? null : cached?.path === historyFrom ? cached.agentDir : resolveAgentDir(historyFrom);
  const model = buildModel(repo, dir);
  const entry: CachedModel = { path: historyFrom, at: now, agentDir: dir, model };
  // Re-inserting moves the key to the end: Map order stays oldest build first.
  cache.delete(key);
  cache.set(key, entry);
  prune(cache, now);
  model.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return model;
}
