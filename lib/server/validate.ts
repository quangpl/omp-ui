// Strict input validation for API route bodies. Every parser throws HttpError(400) on bad input.
import fs from "node:fs";
import path from "node:path";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { BRIEF_MAX, DESCRIPTION_MAX, TITLE_MAX } from "@/lib/card-draft";
import { cronError, isValidTimeZone } from "@/lib/cron";
import type { Repository } from "@/lib/db/types";
import { HttpError } from "@/lib/server/http";
import {
  CLEANUP_IDS,
  TASK_STATUSES,
  USER_ROLES,
  type Board,
  type CleanupId,
  type MaintenanceAction,
  type Scheduler,
  type Task,
  type TaskStatus,
  type UserRole,
} from "@/lib/types";

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

/** Review action posted to `POST /tasks/:id/review`. */
export type ReviewAction = "approve" | "request_changes";

export function parseReviewDecision(value: unknown): ReviewAction {
  if (value !== "approve" && value !== "request_changes") {
    throw new HttpError(400, "decision must be one of: approve, request_changes");
  }
  return value;
}

/** Reviewer's note, trimmed (≤10000 characters). Required to request changes; empty or absent → null otherwise. */
export function parseReviewNote(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, "note is required");
    return null;
  }
  const note = text(value, "note", required ? 1 : 0, 10000);
  return note || null;
}

/** `TaskDiff.hash` the reviewer saw (≤128 characters); empty or absent → null. */
export function parseReviewHash(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return text(value, "hash", 0, 128) || null;
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

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;
const PASSWORD_MAX = 1024;

/** Account name, normalized (trimmed, lowercase): 2–32 of `a-z 0-9 . _ -`, starting with a letter or digit. */
export function parseUsername(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "username must be a string");
  const username = value.trim().toLowerCase();
  if (!username) throw new HttpError(400, "username is required");
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(
      400,
      "username must be 2–32 characters of a-z, 0-9, '.', '_' or '-', starting with a letter or digit",
    );
  }
  return username;
}

/** Optional email, normalized (trimmed, lowercase); null, absent or empty → null. */
export function parseEmail(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "email must be a string");
  const email = value.trim().toLowerCase();
  if (!email) return null;
  if (email.length > EMAIL_MAX) throw new HttpError(400, `email must be at most ${EMAIL_MAX} characters`);
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "email is not a valid email address");
  return email;
}

export function parseUserRole(value: unknown): UserRole {
  if (typeof value !== "string" || !(USER_ROLES as readonly string[]).includes(value)) {
    throw new HttpError(400, `role must be one of: ${USER_ROLES.join(", ")}`);
  }
  return value as UserRole;
}

/** A password to store: taken verbatim (never trimmed), MIN_PASSWORD_LENGTH–1024 characters. */
export function parseNewPassword(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "password must be a string");
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (value.length > PASSWORD_MAX) throw new HttpError(400, `password must be at most ${PASSWORD_MAX} characters`);
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

export async function requireScheduler(repo: Repository, id: string): Promise<Scheduler> {
  const scheduler = await repo.getScheduler(id);
  if (!scheduler) throw new HttpError(404, "Scheduler not found");
  return scheduler;
}

/** Most runs a scheduler may be limited to (`maxRuns`). */
const MAX_SCHEDULER_RUNS = 100_000;

export function parseSchedulerName(value: unknown): string {
  return text(value, "name", 1, 100);
}

/** 5-field cron expression or macro (see lib/cron.ts); runs of whitespace collapse to one space. */
export function parseCronExpression(value: unknown): string {
  const cron = text(value, "cron", 1, 200).replace(/\s+/g, " ");
  const problem = cronError(cron);
  if (problem) throw new HttpError(400, `cron: ${problem}`);
  return cron;
}

/** IANA time zone name such as "Europe/Berlin" or "UTC". */
export function parseTimeZone(value: unknown): string {
  const timezone = text(value, "timezone", 1, 100);
  if (!isValidTimeZone(timezone)) {
    throw new HttpError(400, `timezone must be an IANA time zone such as "Europe/Berlin" or "UTC": ${timezone}`);
  }
  return timezone;
}

/** Stop after this many runs; null = repeat forever. */
export function parseMaxRuns(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_SCHEDULER_RUNS) {
    throw new HttpError(400, `maxRuns must be null or a whole number from 1 to ${MAX_SCHEDULER_RUNS}`);
  }
  return value;
}

export function parseEnabled(value: unknown): boolean {
  return parseBoolean(value, "enabled");
}

/** A non-empty list of card ids (a bulk action's targets), deduped. */
export function parseTaskIds(value: unknown): Set<string> {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new HttpError(400, "ids must be a list of card ids");
  }
  const ids = new Set((value as string[]).map((v) => v.trim()).filter(Boolean));
  if (ids.size === 0) throw new HttpError(400, "ids is required");
  return ids;
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

/** POST /stats/maintenance body: `{ kind: "cleanup", ids } | { kind: "kill", pids } | { kind: "release-memory" } | { kind: "stop-card", taskId }`. */
export function parseMaintenanceAction(body: Record<string, unknown>): MaintenanceAction {
  switch (body.kind) {
    case "cleanup": {
      const ids = body.ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > CLEANUP_IDS.length) {
        throw new HttpError(400, "ids must be a non-empty array of cleanup ids");
      }
      for (const id of ids) {
        if (!(CLEANUP_IDS as readonly unknown[]).includes(id)) {
          throw new HttpError(400, `ids must be among: ${CLEANUP_IDS.join(", ")}`);
        }
      }
      return { kind: "cleanup", ids: [...new Set(ids as CleanupId[])] };
    }
    case "kill": {
      const pids = body.pids;
      if (!Array.isArray(pids) || pids.length === 0 || pids.length > 100) {
        throw new HttpError(400, "pids must be a non-empty array (at most 100)");
      }
      if (!pids.every((pid) => Number.isInteger(pid) && pid > 1)) throw new HttpError(400, "pids must be integers above 1");
      return { kind: "kill", pids: [...new Set(pids as number[])] };
    }
    case "release-memory":
      return { kind: "release-memory" };
    case "stop-card": {
      if (typeof body.taskId !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.taskId)) {
        throw new HttpError(400, "taskId is required");
      }
      return { kind: "stop-card", taskId: body.taskId };
    }
    default:
      throw new HttpError(400, "kind must be one of: cleanup, kill, release-memory, stop-card");
  }
}
