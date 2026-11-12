// The card writer: an omp agent that turns whatever the user typed into a card (title + brief)
// that gets the best result from the agent that will run it. It runs on a warm `omp --mode rpc`
// helper worker in the project with read-only tools, so the brief names the real files involved,
// and it decides whether the work needs parallel subagents and which open cards it must wait for.
// RPC mode lets the host steer it to answer once it has spent its lookup budget, which keeps
// drafts fast.
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { readModelRoles, type ModelRoles } from "@/lib/agent/model-select";
import { existingFolders, extractJsonObject, isDirectory, runOmpHelper } from "@/lib/agent/omp-helper";
import { DESCRIPTION_MAX, TITLE_MAX, clip } from "@/lib/card-draft";
import { childEnv } from "@/lib/child-env";
import { dataDir } from "@/lib/files";
import { listOmpSkills } from "@/lib/omp-skills";
import {
  STATUS_LABELS,
  type AppSettings,
  type Board,
  type CardDraft,
  type OmpSkill,
  type Task,
} from "@/lib/types";

/** The card writer is cancelled after this long: quick and thorough drafts. */
const QUICK_TIMEOUT_SECONDS = 150;
const THOROUGH_TIMEOUT_SECONDS = 270;
/** A request this long, or with this many list items, gets the thorough card writer. */
const THOROUGH_MIN_WORDS = 150;
const THOROUGH_MIN_LIST_ITEMS = 5;
/** Parallel tool calls per lookup turn (two turns at most): the card writer points the way, the run digs. */
const LOOKUPS_PER_TURN = 5;
/** Tool calls after which the card writer is steered to answer with what it found. */
const LOOKUP_BUDGET: Record<DraftTier, number> = { quick: 8, thorough: 16 };
const ANSWER_NOW = "That is enough looking around. Reply now with only the card JSON object, using what you found so far.";
/** Longer requests are handed over as a file the agent reads instead of inline. */
const INLINE_MAX = 60_000;
/** Open cards offered as "Run after" candidates (newest first). */
const MAX_OPEN_CARDS = 40;
/** Drafts running at once across the server: half the cores, at least 4, at most 16. */
const MAX_CONCURRENT_DRAFTS = Math.max(4, Math.min(16, Math.floor(availableParallelism() / 2)));
/** Installed skills listed for the card writer to suggest, and how much of each description. */
const MAX_PROMPT_SKILLS = 60;
const SKILL_DESCRIPTION_MAX = 160;

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
  const env = childEnv();
  const [found, extras, roles, skills] = await Promise.all([
    isDirectory(workdir),
    existingFolders(board.extraFolders ?? [], workdir),
    readModelRoles(settings.ompPath, workdir, env),
    listOmpSkills(settings.ompPath),
  ]);
  if (!found) throw new Error(`Project folder not found: ${workdir}`);
  const { model, thinking, tier, timeoutSeconds } = chooseDraftModel({ text, roles, board, settings });
  // Asked for in so many words: omp's own keyword always means parallel subagents.
  const askedForParallel = text.search(MAGIC_KEYWORD) !== -1;
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

  const prompt = buildDraftPrompt({
    text,
    board: { ...board, extraFolders: extras },
    openCards,
    requestFile,
    skills,
  });
  onActivity(`Card agent started (${model ?? "omp default"}${tier === "thorough" ? ", long request" : ""})`);
  try {
    const reply = await runOmpHelper({
      command: settings.ompPath,
      cwd: workdir,
      addDirs: requestDir ? [...extras, requestDir] : extras,
      model,
      thinking,
      timeoutSeconds,
      env,
      prompt,
      signal,
      label: "card agent",
      onActivity,
      writing: "Writing the card…",
      steer: { afterTools: LOOKUP_BUDGET[tier], message: ANSWER_NOW, activity: "Enough looking around: writing the card…" },
      // The request folder is unique to this draft: no later call could reuse the worker.
      reusable: requestDir === null,
    });
    const draft = parseDraftReply(reply, new Map(openCards.map((t) => [t.id, t.title])));
    return { draft: askedForParallel ? { ...draft, orchestrate: true } : draft, model };
  } finally {
    if (requestDir) await rm(requestDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** `quick`: short requests, fast model; `thorough`: long or list-heavy ones, the usual model. */
export type DraftTier = "quick" | "thorough";

/** A markdown list item at the start of a line: `- x`, `* x`, `1. x`, `2) x`, `- [ ] x`. */
const LIST_ITEM = /^[ \t]*(?:[-*]|\d+[.)])[ \t]+\S/gm;

/**
 * Model and time budget for the card writer. Short requests get a quick draft (the fast `smol`
 * role when configured, else the usual model thinking briefly); long or list-heavy requests get
 * the usual model with its own thinking and more time, since their brief carries more detail.
 */
export function chooseDraftModel(input: {
  text: string;
  roles: ModelRoles | null;
  board: Pick<Board, "model">;
  settings: Pick<AppSettings, "defaultModel">;
}): { model: string | null; thinking: "low" | null; tier: DraftTier; timeoutSeconds: number } {
  const { text, roles, board, settings } = input;
  const fallback = board.model?.trim() || settings.defaultModel.trim() || null;
  const words = text.split(/\s+/).filter(Boolean).length;
  const listItems = text.match(LIST_ITEM)?.length ?? 0;
  if (words >= THOROUGH_MIN_WORDS || listItems >= THOROUGH_MIN_LIST_ITEMS) {
    return { model: fallback, thinking: null, tier: "thorough", timeoutSeconds: THOROUGH_TIMEOUT_SECONDS };
  }
  const smol = typeof roles?.smol === "string" && roles.smol.trim() !== "";
  return smol
    ? { model: "@smol", thinking: null, tier: "quick", timeoutSeconds: QUICK_TIMEOUT_SECONDS }
    : { model: fallback, thinking: "low", tier: "quick", timeoutSeconds: QUICK_TIMEOUT_SECONDS };
}

/**
 * omp's magic keyword for parallel subagents: anywhere in the prompt it would switch the card
 * writer itself into that mode, so text we quote from elsewhere (skill descriptions) loses it.
 */
const MAGIC_KEYWORD = /(?<![\p{L}\p{N}_./\\-])orchestrate(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()/gu;

/** The card writer's instructions plus the user's request. */
export function buildDraftPrompt(input: {
  text: string;
  board: Pick<Board, "name" | "workdir" | "extraFolders">;
  openCards: Pick<Task, "id" | "title" | "status">[];
  /** Set when the request is too long to inline: the file holding it. */
  requestFile: string | null;
  /** Installed omp skills the card writer may point the agent to. */
  skills: Pick<OmpSkill, "name" | "description">[];
}): string {
  const { text, board, openCards, requestFile } = input;
  const skills = input.skills.slice(0, MAX_PROMPT_SKILLS);
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
    // The user's own keyword would switch the card writer itself into orchestration; the host
    // already turns it into `orchestrate: true`.
    lines.push("<request>", text.trim().replace(MAGIC_KEYWORD, "parallelize"), "</request>");
  }
  if (openCards.length > 0) {
    lines.push(
      "",
      "Open cards on this board (id — status — title):",
      ...openCards.map((t) => `- ${t.id} — ${STATUS_LABELS[t.status]} — ${clip(t.title.replace(/\s+/g, " ").trim(), 140)}`),
    );
  }
  if (skills.length > 0) {
    lines.push(
      "",
      "Installed OMP skills (name: what it is for):",
      ...skills.map((s) => {
        const description = clip(s.description.replace(/\s+/g, " ").trim(), SKILL_DESCRIPTION_MAX);
        return `- ${s.name}: ${description.replace(MAGIC_KEYWORD, "coordinate")}`;
      }),
    );
  }
  lines.push(
    "",
    "How to work:",
    "1. Work out what the user wants done and why.",
    `2. Make the brief concrete, fast. You get at most two turns of project lookups, each with up to ${LOOKUPS_PER_TURN} tool calls made at once in parallel: first turn, glob/grep for every part of the request together; second turn (only if needed), read the few most relevant files together. Then write the card.${requestFile ? " Reading the request file does not count." : ""} Find where the work happens (the main files, components, routes, commands or tests), not every detail: the agent that runs the card investigates further. Skim; don't read whole large files or confirm line numbers. If the request links a URL, you may read it in the first turn.`,
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
    ...(skills.length > 0
      ? [
          "  When installed OMP skills listed above clearly fit the work, add `skill://<name>` for at most 3 of them to the description, with a line telling the agent to read them first. Only use names from that list; never invent a skill name.",
        ]
      : []),
    "- parallel: true when the work splits into several independent parts that parallel subagents could do at the same time (several features, many pages or files, a codebase-wide change), or when the user asks for parallel work or subagents; false for one focused change. Express it only through this field: never ask for parallel subagents in the title or description.",
    "- waitFor: ids of open cards listed above that must be finished before this one can start: when the request says it builds on, depends on, or comes after one of them, even when it names that card loosely (\"after the dark mode card\" means the open card about dark mode). Otherwise [].",
    "",
    "Reply with only this JSON object — no other text, no code fence:",
    '{"title": "…", "description": "…", "parallel": false, "waitFor": []}',
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
  // `parallel` is the field the prompt asks for; `orchestrate` is its older name.
  const orchestrate = data.parallel === true || data.orchestrate === true;
  return { title, description, orchestrate, waitFor };
}
