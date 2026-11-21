// The queue planner: an omp agent that orders a project's queued cards (urgent work and quick
// wins first). Cards never wait for one another: each one starts as soon as a slot is free. It
// runs on a warm `omp --mode rpc` helper worker in the project with read-only tools, so it can
// look at the files each card touches.
import { readModelRoles } from "@/lib/agent/model-select";
import { chooseHelperModel } from "@/lib/agent/provider-quota";
import { existingFolders, extractJsonObject, isDirectory, runOmpHelper } from "@/lib/agent/omp-helper";
import { clip } from "@/lib/card-draft";
import { childEnv } from "@/lib/child-env";
import { mcpAgentEnv } from "@/lib/server/mcp-env";
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
}

export interface QueuePlan {
  /** Every queued card id exactly once, highest priority (starts first) first. */
  order: string[];
  /** One-line reason per queued card id (may be absent). */
  reasons: Record<string, string>;
}

export interface PlanQueueOptions {
  /** Runs in `board.workdir`, reading its existing extra folders too. */
  board: Board;
  /** The project's queued cards, in current queue order. */
  queued: PlanCard[];
  /** The project's running cards: context only, they are never reordered. */
  running: PlanCard[];
  settings: AppSettings;
  signal: AbortSignal;
}

/** Run the planner over a project's queued cards and return its plan. Rejects on failure or abort. */
export async function planQueue(options: PlanQueueOptions): Promise<QueuePlan> {
  const { board, queued, running, settings, signal } = options;
  const workdir = board.workdir;
  const env = childEnv(await mcpAgentEnv());
  const [found, extras, roles] = await Promise.all([
    isDirectory(workdir),
    existingFolders(board.extraFolders ?? [], workdir),
    readModelRoles(settings.ompPath, workdir, env),
  ]);
  if (!found) throw new Error(`Project folder not found: ${workdir}`);
  // The fast `smol` role when configured; otherwise the usual model, thinking briefly.
  const { model, role, config } = await chooseHelperModel({ settings, pinned: board.model, roles: [["smol", roles?.smol]], modelRoles: roles });
  const thinking = role ? null : "low";
  signal.throwIfAborted();

  const prompt = buildPlanPrompt({ board: { ...board, extraFolders: extras }, queued, running });
  const reply = await runOmpHelper({
    command: settings.ompPath,
    cwd: workdir,
    addDirs: extras,
    model,
    thinking,
    config,
    timeoutSeconds: TIMEOUT_SECONDS,
    env,
    prompt,
    signal,
    label: "queue planner",
    onActivity: () => undefined,
  });
  return parsePlanReply(reply, queued);
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
    ...queued.map((c) => `- ${c.id} — ${oneLine(c.title, 140)} — ${oneLine(c.description, QUEUED_DESCRIPTION_MAX)}`),
    "",
    "How to work:",
    "1. You may do a few quick read-only glob/grep/read lookups to see which files each card touches. Skim; stop once you know enough.",
    "2. Do NOT carry out any card, change files or run commands. Your only output is the plan.",
    "",
    "Decide the start order of every queued card. No card waits for another: whatever is next starts as soon as an agent slot is free, so the order is about priority, not dependencies.",
    "- order: all queued ids, highest priority first. Prefer work that unblocks people or other work, then small quick wins, then large pieces; otherwise keep the user's order.",
    "- reason: at most 100 characters on why the card sits where it does.",
    "",
    "Reply with only this JSON object — no other text, no code fence:",
    '{"order": ["<id>", ...], "cards": [{"id": "<id>", "reason": "…"}]}',
  );
  return lines.join("\n");
}

/**
 * The plan in the planner's final reply: a JSON object, possibly fenced or surrounded by prose.
 * Unknown ids are dropped and queued cards the planner left out are appended in their input order.
 */
export function parsePlanReply(reply: string, queued: PlanCard[]): QueuePlan {
  const data = extractJsonObject(reply);
  if (!data) throw new Error("The queue planner did not answer with a plan.");
  const queuedIds = new Set(queued.map((c) => c.id));

  const planned = new Set<string>();
  for (const id of Array.isArray(data.order) ? data.order : []) {
    if (typeof id === "string" && queuedIds.has(id)) planned.add(id);
  }
  for (const card of queued) planned.add(card.id);
  const order = [...planned];

  // The planner's reason per queued card (the first entry wins).
  const reasons: Record<string, string> = {};
  for (const entry of Array.isArray(data.cards) ? data.cards : []) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const { id, reason } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !queuedIds.has(id) || id in reasons) continue;
    const line = typeof reason === "string" ? oneLine(reason, REASON_MAX) : "";
    if (line) reasons[id] = line;
  }

  return { order, reasons };
}

/** `text` on one line, clipped to `max` characters. */
function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s+/g, " ").trim(), max);
}
