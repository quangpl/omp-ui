// The card writer: an omp agent that turns whatever the user typed into a card (title + brief)
// that gets the best result from the agent that will run it. It runs `omp -p --mode json` in the
// project with read-only tools, so the brief names the real files involved, and it decides
// whether the work needs parallel subagents and which open cards it must wait for.
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readModelRoles } from "@/lib/agent/model-select";
import { existingFolders, extractJsonObject, isDirectory, runOmpPrint } from "@/lib/agent/omp-print";
import { DESCRIPTION_MAX, TITLE_MAX, clip } from "@/lib/card-draft";
import { childEnv } from "@/lib/child-env";
import { dataDir } from "@/lib/files";
import { STATUS_LABELS, type AppSettings, type Board, type CardDraft, type Task } from "@/lib/types";

/** omp stops the session itself after this long (`--max-time`). */
const MAX_TIME_SECONDS = 120;
/** Longer requests are handed over as a file the agent reads instead of inline. */
const INLINE_MAX = 60_000;
/** Open cards offered as "Run after" candidates (newest first). */
const MAX_OPEN_CARDS = 40;
/** Drafts running at once across the server. */
const MAX_CONCURRENT_DRAFTS = 4;

export interface DraftOptions {
  /** What the user typed. */
  text: string;
  board: Board;
  /** Cards on the board; open ones can be picked for `waitFor`. */
  tasks: Task[];
  settings: AppSettings;
  signal: AbortSignal;
  /** One-line progress ("Finding the new-card form…") as the agent works. */
  onActivity: (text: string) => void;
}

export interface DraftResult {
  draft: CardDraft;
  /** `--model` the card writer ran with; null for omp's default. */
  model: string | null;
}

const g = globalThis as unknown as { __ompUiDrafts?: number };

/** Reserve one of the server-wide draft slots; null when all are busy. Call the result to release. */
export function acquireDraftSlot(): (() => void) | null {
  const running = g.__ompUiDrafts ?? 0;
  if (running >= MAX_CONCURRENT_DRAFTS) return null;
  g.__ompUiDrafts = running + 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    g.__ompUiDrafts = Math.max(0, (g.__ompUiDrafts ?? 1) - 1);
  };
}

/** Run the card writer on `text` and return the card it wrote. Rejects on failure or abort. */
export async function draftCard(options: DraftOptions): Promise<DraftResult> {
  const { text, board, tasks, settings, signal, onActivity } = options;
  const workdir = board.workdir;
  if (!(await isDirectory(workdir))) throw new Error(`Project folder not found: ${workdir}`);
  const extras = await existingFolders(board.extraFolders ?? [], workdir);

  const env = childEnv();
  const roles = await readModelRoles(settings.ompPath, workdir, env);
  // The fast `smol` role when configured; otherwise the usual model, thinking briefly.
  const model = roles?.smol ? "@smol" : board.model?.trim() || settings.defaultModel.trim() || null;
  const thinking = roles?.smol ? null : "low";
  signal.throwIfAborted();

  const openCards = tasks
    .filter((t) => t.status !== "done")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_OPEN_CARDS);
  let requestDir: string | null = null;
  let requestFile: string | null = null;
  if (text.length > INLINE_MAX) {
    requestDir = path.join(dataDir(), "runtime", "drafts", randomUUID());
    requestFile = path.join(requestDir, "request.md");
    await mkdir(requestDir, { recursive: true });
    await writeFile(requestFile, text);
  }

  const prompt = buildDraftPrompt({ text, board: { ...board, extraFolders: extras }, openCards, requestFile });
  onActivity(`Card agent started${model ? ` (${model})` : ""}`);
  try {
    const reply = await runOmpPrint({
      command: settings.ompPath,
      cwd: workdir,
      addDirs: requestDir ? [...extras, requestDir] : extras,
      model,
      thinking,
      maxTimeSeconds: MAX_TIME_SECONDS,
      env,
      prompt,
      signal,
      label: "card agent",
      onActivity,
      writing: "Writing the card…",
    });
    return { draft: parseDraftReply(reply, new Map(openCards.map((t) => [t.id, t.title]))), model };
  } finally {
    if (requestDir) await rm(requestDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The card writer's instructions plus the user's request. */
export function buildDraftPrompt(input: {
  text: string;
  board: Pick<Board, "name" | "workdir" | "extraFolders">;
  openCards: Pick<Task, "id" | "title" | "status">[];
  /** Set when the request is too long to inline: the file holding it. */
  requestFile: string | null;
}): string {
  const { text, board, openCards, requestFile } = input;
  const extras = board.extraFolders.filter((f) => f !== board.workdir);
  const lines = [
    `You are the card writer for the "${board.name}" project board. Every card on this board is a task that an autonomous omp coding agent carries out on its own (it can read and change the code, run commands, use a browser and delegate to parallel subagents). The user typed the request below in their own words. Turn it into the card that gets the best result from that agent.`,
    "",
    `Project folder: ${board.workdir}${extras.length > 0 ? ` (also: ${extras.join(", ")})` : ""}`,
    "",
  ];
  if (requestFile) {
    lines.push(
      `The request is long (${text.length} characters), so it is saved in ${requestFile}. Read all of it (page through the file) before you write the card.`,
    );
  } else {
    lines.push("<request>", text.trim(), "</request>");
  }
  if (openCards.length > 0) {
    lines.push(
      "",
      "Open cards on this board (id — status — title):",
      ...openCards.map((t) => `- ${t.id} — ${STATUS_LABELS[t.status]} — ${clip(t.title.replace(/\s+/g, " ").trim(), 140)}`),
    );
  }
  lines.push(
    "",
    "How to work:",
    "1. Work out what the user wants done and why.",
    "2. Make the brief concrete: with a few quick glob/grep/read lookups, find the files, components, routes, commands or tests involved. Skim, don't read whole large files; stop once you know where the work happens. If the request links a URL, you may read it.",
    "3. Do NOT carry out the task, change files or run commands. Your only output is the card.",
    "",
    "The card:",
    "- title: imperative and specific, at most 80 characters, plain text (no markdown, no trailing period), in the language of the request.",
    `- description: a Markdown brief for the agent, in the language of the request, at most ${Math.floor(DESCRIPTION_MAX / 2)} characters. Scale it to the task: a small fix gets a few lines, a large feature gets sections. Use only the sections that add something, in this order:`,
    "  ## Goal — what to achieve and why, in 1–3 sentences.",
    "  ## Context — what exists today: relevant files and symbols you found (paths relative to the project folder), current behavior, constraints.",
    "  ## Requirements — the distinct pieces of work, one bullet each; fold small details into their bullet.",
    "  ## Acceptance criteria — observable checks that prove it is done, including how to verify (tests, build, what to check in the UI).",
    "  ## Notes — assumptions you made where the request is ambiguous, and what is out of scope.",
    "  Keep every concrete detail of the request word for word: names, numbers, paths, URLs, error messages, code and logs (code and logs in fenced code blocks). Fix typos without changing the meaning. Never invent requirements the user did not ask for, and never drop one they did.",
    "  When the request references OMP skills (`skill://<name>` tokens), keep each token verbatim in the description and add a line telling the agent to read those skills before starting the work.",
    "- orchestrate: true when the work splits into several independent parts that parallel subagents could do at the same time (several features, many pages or files, a codebase-wide change), or when the user asks for orchestration or parallel work; false for one focused change. Express it only through this field: never write the word orchestrate in the title or description.",
    `- waitFor: ids of open cards listed above that must be finished before this one can start — only when the request says it builds on them or comes after them. Otherwise [].`,
    "",
    "Reply with only this JSON object — no other text, no code fence:",
    '{"title": "…", "description": "…", "orchestrate": false, "waitFor": []}',
  );
  return lines.join("\n");
}

/**
 * The card in the agent's final reply: a JSON object, possibly fenced or surrounded by prose.
 * Title and description are trimmed and kept within the API limits; `waitFor` keeps only ids of
 * `openCards` (id → title).
 */
export function parseDraftReply(reply: string, openCards: ReadonlyMap<string, string>): CardDraft {
  const data = extractJsonObject(reply);
  if (!data) throw new Error("The card agent did not answer with a card. Try again, or use the text as typed.");
  const title = clip(typeof data.title === "string" ? data.title.replace(/\s+/g, " ").trim() : "", TITLE_MAX);
  if (!title) throw new Error("The card agent's answer has no title. Try again, or use the text as typed.");
  const description = clip(typeof data.description === "string" ? data.description.trim() : "", DESCRIPTION_MAX);
  const ids = Array.isArray(data.waitFor) ? data.waitFor : [];
  const waitFor = [...new Set(ids)]
    .filter((id): id is string => typeof id === "string" && openCards.has(id))
    .map((id) => ({ id, title: openCards.get(id) ?? id }));
  return { title, description, orchestrate: data.orchestrate === true, waitFor };
}
