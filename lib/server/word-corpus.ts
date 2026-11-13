// Corpus for the composer's inline word completion: the user's omp prompt history plus this
// app's card titles and descriptions, condensed into an n-gram model the client looks up locally.
// Building reads every card and spawns omp once, so the model is cached for a few minutes.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Repository } from "@/lib/db/types";
import { agentDir } from "@/lib/server/omp-config";
import { buildWordModelData, type WordModelData } from "@/lib/word-completion";

const CACHE_TTL_MS = 5 * 60_000;
const HISTORY_LIMIT = 5000;
// omp stands in these for pasted blocks and images; they are not prose the user typed.
const PLACEHOLDER = /\[(?:Pasted text|Image) #\d+[^\]]*\]/g;

const g = globalThis as unknown as {
  __ompUiWordModel?: { path: string; at: number; agentDir: Promise<string>; model: Promise<WordModelData> };
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

/** Titles and descriptions of every card on every board. */
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

async function buildModel(repo: Repository, dir: Promise<string>): Promise<WordModelData> {
  const [prompts, cards] = await Promise.all([dir.then(historyPrompts), cardTexts(repo)]);
  return buildWordModelData([...prompts, ...cards]);
}

/**
 * The word-completion model (cached for five minutes per omp path; `refresh` rebuilds).
 * Concurrent callers share one build; a failed build is not cached.
 */
export function wordCompletionModel(
  repo: Repository,
  ompPath: string,
  options: { refresh?: boolean } = {},
): Promise<WordModelData> {
  const cached = g.__ompUiWordModel;
  if (options.refresh || !cached || cached.path !== ompPath || Date.now() - cached.at > CACHE_TTL_MS) {
    // The agent dir rarely changes; reuse the resolved one so a rebuild does not spawn omp again.
    const dir = cached && cached.path === ompPath ? cached.agentDir : resolveAgentDir(ompPath);
    const model = buildModel(repo, dir);
    const entry = { path: ompPath, at: Date.now(), agentDir: dir, model };
    g.__ompUiWordModel = entry;
    model.catch(() => {
      if (g.__ompUiWordModel === entry) g.__ompUiWordModel = undefined;
    });
  }
  return g.__ompUiWordModel!.model;
}
