// Strict input validation for API route bodies. Every parser throws HttpError(400) on bad input.
import fs from "node:fs";
import path from "node:path";
import { BRIEF_MAX, DESCRIPTION_MAX, TITLE_MAX } from "@/lib/card-draft";
import type { Repository } from "@/lib/db/types";
import { HttpError } from "@/lib/server/http";
import { TASK_STATUSES, type Board, type Task, type TaskStatus } from "@/lib/types";

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw new HttpError(400, min === 1 ? `${field} is required` : `${field} is too short`);
  }
  if (trimmed.length > max) {
    throw new HttpError(400, `${field} must be at most ${max} characters`);
  }
  return trimmed;
}

export function parseBoardName(value: unknown): string {
  return text(value, "name", 1, 100);
}

export function parseTitle(value: unknown): string {
  return text(value, "title", 1, TITLE_MAX);
}

export function parseDescription(value: unknown): string {
  return text(value, "description", 0, DESCRIPTION_MAX);
}

/** Free text a card is made from (the new-card form's request). */
export function parseBrief(value: unknown, field = "text"): string {
  return text(value, field, 1, BRIEF_MAX);
}

export function parseCommentBody(value: unknown): string {
  return text(value, "body", 1, 10000);
}

/** Users can only clear a card's question (dismiss); the agent sets it when a run ends. */
export function parseQuestionClear(value: unknown): null {
  if (value !== null) throw new HttpError(400, "question can only be cleared (set it to null)");
  return null;
}

/** `--model` selector; empty/null means "use the default". */
export function parseModel(value: unknown): string | null {
  if (value === null) return null;
  const model = text(value, "model", 0, 200);
  return model || null;
}

export function parseStatus(value: unknown): TaskStatus {
  if (typeof value !== "string" || !(TASK_STATUSES as readonly string[]).includes(value)) {
    throw new HttpError(400, `status must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  return value as TaskStatus;
}

export function parsePosition(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "position must be a finite number");
  }
  return value;
}

export function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new HttpError(400, `${field} must be a boolean`);
  return value;
}

const MAX_EXTRA_FOLDERS = 20;

/** Absolute path to an existing directory, normalized. `label` names it in error messages. */
function parseFolder(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `Please choose a ${label}.`);
  }
  const raw = value.trim();
  if (raw.length > 4096) throw new HttpError(400, `The ${label} path is too long.`);
  if (!path.isAbsolute(raw)) {
    throw new HttpError(400, `The ${label} must be a full path starting with "/": ${raw}`);
  }
  const resolved = path.resolve(raw);
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(resolved).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new HttpError(400, `The ${label} doesn't exist on the server (or isn't a folder): ${resolved}`);
  }
  return resolved;
}

export function parseWorkdir(value: unknown): string {
  return parseFolder(value, "main project folder");
}

/** Extra project folders: ≤20 existing absolute directories, deduped, never the workdir. */
export function parseExtraFolders(value: unknown, workdir: string): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, "extraFolders must be a list of folder paths.");
  if (value.length > MAX_EXTRA_FOLDERS) {
    throw new HttpError(400, `A project can have at most ${MAX_EXTRA_FOLDERS} extra folders.`);
  }
  const folders = new Set<string>();
  for (const item of value) {
    const folder = parseFolder(item, "extra folder");
    if (folder !== workdir) folders.add(folder);
  }
  return [...folders];
}

export async function requireBoard(repo: Repository, id: string): Promise<Board> {
  const board = await repo.getBoard(id);
  if (!board) throw new HttpError(404, "Board not found");
  return board;
}

export async function requireTask(repo: Repository, id: string): Promise<Task> {
  const task = await repo.getTask(id);
  if (!task) throw new HttpError(404, "Task not found");
  return task;
}

const MAX_BLOCKED_BY = 50;

/**
 * Task queue dependencies: ids of other cards on the same board, deduped. Rejects unknown cards,
 * the card itself, and anything that would make a cycle (a card waiting on itself indirectly).
 * `taskId` is null for a card being created.
 */
export async function parseBlockedBy(
  repo: Repository,
  value: unknown,
  boardId: string,
  taskId: string | null,
): Promise<string[]> {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new HttpError(400, "blockedBy must be a list of card ids.");
  }
  const ids = [...new Set((value as string[]).map((v) => v.trim()).filter(Boolean))];
  if (ids.length > MAX_BLOCKED_BY) {
    throw new HttpError(400, `A card can wait for at most ${MAX_BLOCKED_BY} cards.`);
  }
  if (ids.length === 0) return [];
  if (taskId !== null && ids.includes(taskId)) throw new HttpError(400, "A card cannot wait for itself.");
  const tasks = new Map((await repo.listTasks(boardId)).map((t) => [t.id, t]));
  const unknown = ids.find((id) => !tasks.has(id));
  if (unknown) throw new HttpError(400, `Card ${unknown} is not on this board.`);
  if (taskId === null) return ids;
  // Cycle: some blocker (transitively) waits for this card.
  const seen = new Set<string>();
  const stack = [...ids];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === taskId) throw new HttpError(400, "That would make the cards wait for each other forever.");
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(tasks.get(id)?.blockedBy ?? []));
  }
  return ids;
}
