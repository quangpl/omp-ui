// The queue planner: an omp agent that orders a project's queued cards (prerequisites and quick
// unblockers first) and infers which of them must run after another, so independent cards run in
// parallel and dependent ones wait. It runs on a warm `omp --mode rpc` helper worker in the
// project with read-only tools, so it can look at the files each card touches.
import { readModelRoles } from "@/lib/agent/model-select";
import { existingFolders, extractJsonObject, isDirectory, runOmpHelper } from "@/lib/agent/omp-helper";
import { clip } from "@/lib/card-draft";
import { childEnv } from "@/lib/child-env";
import type { AppSettings, Board } from "@/lib/types";

/** The planner is cancelled after this long. */
const TIMEOUT_SECONDS = 120;
/** Description characters shown per running card. */
const RUNNING_DESCRIPTION_MAX = 600;
/** Description characters shown per queued card. */
const QUEUED_DESCRIPTION_MAX = 1500;
/** Characters kept of the planner's reason per card. */
const REASON_MAX = 160;

/** The prompt starts with this exact phrase (lets fakes and logs recognise a planner run). */
export const PLANNER_MARKER = "You are the queue planner";

export interface PlanCard {
  id: string;
  title: string;
  description: string;
  blockedBy: string[];
}

export interface QueuePlan {
  /** Every queued card id exactly once, highest priority (starts first) first. */
  order: string[];
  /**
   * Inferred prerequisites per queued card id: ids of other queued or running cards. Never forms a
   * cycle together with the cards' existing blockedBy. Cards without new deps may be absent.
   */
  dependencies: Record<string, string[]>;
  /** One-line reason per queued card id (may be absent). */
  reasons: Record<string, string>;
}

export interface PlanQueueOptions {
  /** Runs in `board.workdir`, reading its existing extra folders too. */
  board: Board;
  /** The project's queued cards, in current queue order. */
  queued: PlanCard[];
  /** The project's running cards (possible prerequisites only). */
  running: PlanCard[];
  settings: AppSettings;
  signal: AbortSignal;
}

/** Run the planner over a project's queued cards and return its plan. Rejects on failure or abort. */
export async function planQueue(options: PlanQueueOptions): Promise<QueuePlan> {
  const { board, queued, running, settings, signal } = options;
  const workdir = board.workdir;
  const env = childEnv();
  const [found, extras, roles] = await Promise.all([
    isDirectory(workdir),
    existingFolders(board.extraFolders ?? [], workdir),
    readModelRoles(settings.ompPath, workdir, env),
  ]);
  if (!found) throw new Error(`Project folder not found: ${workdir}`);
  // The fast `smol` role when configured; otherwise the usual model, thinking briefly.
  const model = roles?.smol ? "@smol" : board.model?.trim() || settings.defaultModel.trim() || null;
  const thinking = roles?.smol ? null : "low";
  signal.throwIfAborted();

  const prompt = buildPlanPrompt({ board: { ...board, extraFolders: extras }, queued, running });
  const reply = await runOmpHelper({
    command: settings.ompPath,
    cwd: workdir,
    addDirs: extras,
    model,
    thinking,
    timeoutSeconds: TIMEOUT_SECONDS,
    env,
    prompt,
    signal,
    label: "queue planner",
    onActivity: () => undefined,
  });
  return parsePlanReply(reply, queued, running);
}

/** The planner's instructions plus the project's running and queued cards. */
export function buildPlanPrompt(input: {
  board: Pick<Board, "name" | "workdir" | "extraFolders">;
  queued: PlanCard[];
  running: PlanCard[];
}): string {
  const { board, queued, running } = input;
  const extras = board.extraFolders.filter((f) => f !== board.workdir);
  const lines = [
    `${PLANNER_MARKER} for the "${board.name}" project board. Every card on this board is a task that an autonomous omp coding agent carries out on its own, and several cards run in parallel. Decide the order in which the queued cards below start, and which of them must wait for another card to finish first.`,
    "",
    `Project folder: ${board.workdir}${extras.length > 0 ? ` (also: ${extras.join(", ")})` : ""}`,
  ];
  if (running.length > 0) {
    lines.push(
      "",
      "Cards running now (id — title — description):",
      ...running.map((c) => `- ${c.id} — ${oneLine(c.title, 140)} — ${oneLine(c.description, RUNNING_DESCRIPTION_MAX)}`),
    );
  }
  lines.push(
    "",
    "Queued cards, in the user's order (id — title — description):",
    ...queued.map((c) => {
      const after = c.blockedBy.length > 0 ? ` (already runs after: ${c.blockedBy.join(", ")})` : "";
      return `- ${c.id} — ${oneLine(c.title, 140)} — ${oneLine(c.description, QUEUED_DESCRIPTION_MAX)}${after}`;
    }),
    "",
    "How to work:",
    "1. You may do a few quick read-only glob/grep/read lookups to see which files each card touches. Skim; stop once you know enough.",
    "2. Do NOT carry out any card, change files or run commands. Your only output is the plan.",
    "",
    "Decide for every queued card:",
    "- waitFor: ids of queued or running cards it must wait for — ONLY when it builds on that card's result, or when both would substantially rewrite the same files so running them at once would conflict. Otherwise []. Running cards in parallel is the goal, so be conservative.",
    "- order: all queued ids. Prerequisites before the cards that wait for them, then cards that unblock others, then small, quick wins before large ones; otherwise keep the user's order.",
    "- reason: at most 100 characters on why it sits where it does or waits for what.",
    "",
    "Reply with only this JSON object — no other text, no code fence:",
    '{"order": ["<id>", ...], "cards": [{"id": "<id>", "waitFor": ["<id>", ...], "reason": "…"}]}',
  );
  return lines.join("\n");
}

/**
 * The plan in the planner's final reply: a JSON object, possibly fenced or surrounded by prose.
 * Unknown ids, self-dependencies and edges that would close a cycle are dropped; queued cards the
 * planner left out are appended in their input order, and every card ends up after its queued
 * prerequisites.
 */
export function parsePlanReply(reply: string, queued: PlanCard[], running: PlanCard[]): QueuePlan {
  const data = extractJsonObject(reply);
  if (!data) throw new Error("The queue planner did not answer with a plan.");
  const queuedIds = new Set(queued.map((c) => c.id));
  const knownIds = new Set([...queuedIds, ...running.map((c) => c.id)]);

  const planned = new Set<string>();
  for (const id of Array.isArray(data.order) ? data.order : []) {
    if (typeof id === "string" && queuedIds.has(id)) planned.add(id);
  }
  for (const card of queued) planned.add(card.id);
  const order = [...planned];

  // The planner's entry per queued card (the first one wins).
  const entries = new Map<string, Record<string, unknown>>();
  for (const entry of Array.isArray(data.cards) ? data.cards : []) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const id = (entry as Record<string, unknown>).id;
    if (typeof id === "string" && queuedIds.has(id) && !entries.has(id)) entries.set(id, entry as Record<string, unknown>);
  }

  // Wait-for graph (card → its prerequisites): existing edges first, then accepted inferred ones.
  const graph = new Map<string, Set<string>>();
  for (const card of [...queued, ...running]) graph.set(card.id, new Set(card.blockedBy));
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of graph.get(id) ?? []) stack.push(next);
    }
    return false;
  };

  const dependencies: Record<string, string[]> = {};
  const reasons: Record<string, string> = {};
  for (const id of order) {
    const entry = entries.get(id);
    if (!entry) continue;
    const accepted: string[] = [];
    for (const dep of Array.isArray(entry.waitFor) ? entry.waitFor : []) {
      if (typeof dep !== "string" || dep === id || !knownIds.has(dep) || accepted.includes(dep)) continue;
      // `id` waiting for `dep` closes a cycle when `dep` already (transitively) waits for `id`.
      if (reaches(dep, id)) continue;
      accepted.push(dep);
      graph.get(id)?.add(dep);
    }
    if (accepted.length > 0) dependencies[id] = accepted;
    const reason = typeof entry.reason === "string" ? oneLine(entry.reason, REASON_MAX) : "";
    if (reason) reasons[id] = reason;
  }

  const queuedPrereqs = (id: string) => [...(graph.get(id) ?? [])].filter((dep) => queuedIds.has(dep));
  return { order: prerequisitesFirst(order, queuedPrereqs), dependencies, reasons };
}

/**
 * `order` reordered so every card comes after its prerequisites (`prereqs`, all within `order`),
 * otherwise keeping `order`: each step takes the earliest card whose prerequisites are placed.
 * Cards stuck in a cycle (only possible through existing edges) keep their order at the end.
 */
function prerequisitesFirst(order: string[], prereqs: (id: string) => string[]): string[] {
  const placed = new Set<string>();
  const result: string[] = [];
  const pending = [...order];
  while (pending.length > 0) {
    const index = pending.findIndex((id) => prereqs(id).every((dep) => placed.has(dep)));
    if (index === -1) {
      result.push(...pending);
      break;
    }
    const [id] = pending.splice(index, 1);
    placed.add(id);
    result.push(id);
  }
  return result;
}

/** `text` on one line, clipped to `max` characters. */
function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s+/g, " ").trim(), max);
}
