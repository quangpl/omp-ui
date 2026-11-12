// Strict input validation for API route bodies. Every parser throws HttpError(400) on bad input.
import fs from "node:fs";
import path from "node:path";
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
  return text(value, "title", 1, 200);
}

export function parseDescription(value: unknown): string {
  return text(value, "description", 0, 20000);
}

export function parseCommentBody(value: unknown): string {
  return text(value, "body", 1, 10000);
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
