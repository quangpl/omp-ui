// Read/forget proxy helpers for `app/api/v1/memory/{memories,search,sessions,stats}` routes:
// typed calls to the local agentmemory REST API (via `agentmemoryFetch`), the 503 "memory server
// unavailable" answer, and normalizers from agentmemory records to `lib/memory-types.ts`.
import path from "node:path";
import type { Repository } from "@/lib/db/types";
import type {
  MemoryCardLink,
  MemoryItem,
  MemoryLayer,
  MemorySession,
  MemoryUnavailable,
} from "@/lib/memory-types";
import { agentmemoryFetch, agentmemoryInstalled } from "@/lib/server/agentmemory";
import { type ApiContext, HttpError, json, withApi } from "@/lib/server/http";

/** The memory server is not reachable (not running, not installed, or unhealthy). */
class MemoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryUnavailableError";
  }
}

/** Calls an agentmemory path (e.g. `/agentmemory/memories?limit=10`) and parses its JSON answer. */
export async function memoryRequest<T>(pathname: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await agentmemoryFetch(pathname, init);
  } catch (err) {
    throw new MemoryUnavailableError(
      err instanceof Error && err.message ? `Memory server unreachable: ${err.message}` : "Memory server unreachable",
    );
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {}
  if (res.ok) return body as T;
  const message =
    body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `Memory server answered HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(502, `Memory server rejected AgentMan's credentials (${message})`);
  }
  if (res.status === 400 || res.status === 404) throw new HttpError(res.status, message);
  if (res.status >= 500) throw new MemoryUnavailableError(message);
  throw new HttpError(502, message);
}

/** POST a JSON body to an agentmemory path. */
export function memoryPost<T>(pathname: string, body: unknown): Promise<T> {
  return memoryRequest<T>(pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * `withApi` for memory routes: when the memory server can't be reached the route answers
 * 503 `MemoryUnavailable` so the UI can render its setup state. `options` go to `withApi`.
 */
export function memoryRoute<P extends Record<string, string | string[]> = Record<string, never>>(
  handler: (ctx: ApiContext<P>) => Promise<Response>,
  options: { admin?: boolean } = {},
) {
  return withApi<P>(async (ctx) => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (!(err instanceof MemoryUnavailableError)) throw err;
      const installed = await agentmemoryInstalled().catch(() => false);
      const body: MemoryUnavailable = {
        error: installed ? err.message : "agentmemory is not installed",
        installed,
        healthy: false,
      };
      return json(body, { status: 503 });
    }
  }, options);
}

// ---------------------------------------------------------------------------------------------
// Query parsing

const ID_RE = /^[A-Za-z0-9._:@-]{1,200}$/;

/** A memory/observation/session id from a path or query; 400 when malformed. */
export function parseId(value: string | null | undefined, field = "id"): string {
  const id = (value ?? "").trim();
  if (!ID_RE.test(id)) throw new HttpError(400, `${field} is invalid`);
  return id;
}

export function optionalId(value: string | null, field: string): string | null {
  return value === null || value.trim() === "" ? null : parseId(value, field);
}

/** Short free-text query param (project, type, search text). */
export function optionalText(value: string | null, field: string, max = 200): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  if (text.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return text;
}

export function parseLimit(value: string | null, fallback: number, max: number): number {
  if (value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "limit must be a positive integer");
  return Math.min(n, max);
}

/** Opaque agentmemory paging cursor (base64url). */
export function optionalCursor(value: string | null): string | null {
  const cursor = (value ?? "").trim();
  if (!cursor) return null;
  if (cursor.length > 500 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new HttpError(400, "cursor is invalid");
  return cursor;
}

export const MEMORY_RANGES = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 } as const;
export type MemoryRange = keyof typeof MEMORY_RANGES;

/** `range` (24h/7d/30d/90d) → the earliest ISO timestamp it allows; null for all time. */
export function parseRange(value: string | null): string | null {
  if (value === null || value === "" || value === "all") return null;
  const days = MEMORY_RANGES[value as MemoryRange];
  if (!days) throw new HttpError(400, "range must be one of 24h, 7d, 30d, 90d, all");
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Builds `/agentmemory/<path>?…`, skipping null/empty params. */
export function amPath(pathname: string, params: Record<string, string | number | boolean | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    query.set(key, String(value));
  }
  const qs = query.toString();
  return `/agentmemory/${pathname}${qs ? `?${qs}` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// agentmemory record shapes (only the fields read here)

export interface AmMemory {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  type?: string;
  title?: string;
  content?: string;
  concepts?: string[];
  files?: string[];
  sessionIds?: string[];
  strength?: number;
  version?: number;
  parentId?: string;
  supersedes?: string[];
  relatedIds?: string[];
  isLatest?: boolean;
  forgetAfter?: string;
  agentId?: string;
  project?: string;
  origin?: { channel?: string };
}

export interface AmObservation {
  id: string;
  sessionId?: string;
  timestamp?: string;
  type?: string;
  memoryType?: string;
  title?: string;
  subtitle?: string;
  facts?: string[];
  narrative?: string;
  concepts?: string[];
  files?: string[];
  importance?: number;
  confidence?: number;
  agentId?: string;
  origin?: { channel?: string };
}

export interface AmSessionSummary {
  title?: string;
  narrative?: string;
  keyDecisions?: string[];
  filesModified?: string[];
}

export interface AmSession {
  id: string;
  project?: string;
  cwd?: string;
  startedAt?: string;
  endedAt?: string;
  status?: string;
  observationCount?: number;
  model?: string;
  tags?: string[];
  firstPrompt?: string;
  summary?: string | AmSessionSummary;
  agentId?: string;
}

export interface AmFacet {
  value: string;
  count: number;
}

// ---------------------------------------------------------------------------------------------
// Normalizers

const SUMMARY_MAX = 280;

/** Collapses whitespace and trims to `max` characters with an ellipsis. */
export function excerpt(text: string | undefined | null, max = SUMMARY_MAX): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Memory strength is 1–10 on most write paths but 0–1 on a few; report it on 0–10. */
function strengthToImportance(strength: unknown): number | null {
  const n = num(strength);
  if (n === null) return null;
  return n <= 1 ? Math.round(n * 100) / 10 : n;
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function memoryToItem(m: AmMemory, score: number | null = null): MemoryItem {
  const content = m.content ?? "";
  return {
    id: m.id,
    layer: "memory",
    type: m.type ?? "fact",
    title: m.title?.trim() || excerpt(content, 120) || m.id,
    summary: excerpt(content),
    project: m.project ?? null,
    sessionId: m.sessionIds?.[0] ?? null,
    createdAt: m.createdAt ?? null,
    updatedAt: m.updatedAt ?? m.createdAt ?? null,
    importance: strengthToImportance(m.strength),
    confidence: null,
    score,
  };
}

export function observationToItem(
  o: AmObservation,
  project: string | null,
  layer: MemoryLayer = "observation",
  score: number | null = null,
): MemoryItem {
  const facts = strings(o.facts);
  return {
    id: o.id,
    layer,
    type: o.memoryType ?? o.type ?? "other",
    title: o.title?.trim() || excerpt(o.narrative, 120) || o.id,
    summary: excerpt(o.subtitle?.trim() || o.narrative || facts.join(" · ")),
    project,
    sessionId: o.sessionId && o.sessionId !== "memory" && o.sessionId !== "lesson" ? o.sessionId : null,
    createdAt: o.timestamp ?? null,
    updatedAt: o.timestamp ?? null,
    importance: num(o.importance),
    confidence: num(o.confidence),
    score,
  };
}

export function sessionSummary(s: AmSession): AmSessionSummary | null {
  return s.summary && typeof s.summary === "object" ? s.summary : null;
}

/** Suffix of the session label AgentMan gives card runs: "<card title> (card <id>)". */
const CARD_LABEL_RE = /\(card ([A-Za-z0-9_-]+)\)\s*$/;

export function sessionToItem(s: AmSession, cards: CardIndex): MemorySession {
  const summary = sessionSummary(s);
  return {
    id: s.id,
    project: s.project ?? null,
    cwd: s.cwd ?? null,
    status: s.status ?? "completed",
    startedAt: s.startedAt ?? null,
    endedAt: s.endedAt ?? null,
    observationCount: num(s.observationCount) ?? 0,
    model: s.model ?? null,
    agentId: s.agentId ?? null,
    firstPrompt: s.firstPrompt ? excerpt(s.firstPrompt, 400) : null,
    // A string summary is the "<title> (card <id>)" label AgentMan gives card sessions until agentmemory
    // summarizes them; show the title part.
    title:
      summary?.title?.trim() ||
      (typeof s.summary === "string" ? s.summary.replace(CARD_LABEL_RE, "").trim() || null : null),
    narrative: summary?.narrative?.trim() || null,
    tags: strings(s.tags),
    card: cards.match(s),
  };
}

// ---------------------------------------------------------------------------------------------
// AgentMan cards ↔ agentmemory sessions

/**
 * Maps agentmemory sessions to AgentMan cards. OMP's agentmemory extension uses the omp session id
 * (the `<uuid>` of the card's `…_<uuid>.jsonl` session file) as the agentmemory session id; AgentMan
 * labels card sessions "<title> (card <id>)" (see `tagMemorySession`), and a session tag naming a
 * card id (`<id>`, `card:<id>`, `task:<id>`) also links it.
 */
export interface CardIndex {
  match(session: AmSession): MemoryCardLink | null;
}

const CARD_INDEX_TTL_MS = 15_000;
let cardIndexCache: { at: number; promise: Promise<CardIndex> } | null = null;

export function cardIndex(repo: Repository): Promise<CardIndex> {
  const now = Date.now();
  if (cardIndexCache && now - cardIndexCache.at < CARD_INDEX_TTL_MS) return cardIndexCache.promise;
  const promise = buildCardIndex(repo);
  cardIndexCache = { at: now, promise };
  promise.catch(() => {
    cardIndexCache = null;
  });
  return promise;
}

async function buildCardIndex(repo: Repository): Promise<CardIndex> {
  const bySession = new Map<string, MemoryCardLink>();
  const byTask = new Map<string, MemoryCardLink>();
  const boards = await repo.listBoards();
  const lists = await Promise.all(boards.map((board) => repo.listTasks(board.id)));
  for (const tasks of lists) {
    for (const task of tasks) {
      const link: MemoryCardLink = { boardId: task.boardId, taskId: task.id, title: task.title };
      byTask.set(task.id, link);
      if (!task.sessionFile) continue;
      const base = path.basename(task.sessionFile).replace(/\.jsonl$/, "");
      bySession.set(base, link);
      const uuid = base.slice(base.lastIndexOf("_") + 1);
      if (uuid) bySession.set(uuid, link);
    }
  }
  return {
    match(session) {
      const direct = bySession.get(session.id);
      if (direct) return direct;
      const label = typeof session.summary === "string" ? CARD_LABEL_RE.exec(session.summary) : null;
      const labelled = label ? byTask.get(label[1]) : undefined;
      if (labelled) return labelled;
      for (const tag of strings(session.tags)) {
        const id = tag.slice(tag.lastIndexOf(":") + 1).trim();
        const link = byTask.get(id);
        if (link) return link;
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Session lookups (project of an observation, sessions linked from a memory)

const SESSION_INDEX_TTL_MS = 15_000;
let sessionIndexCache: { at: number; promise: Promise<Map<string, AmSession>> } | null = null;

/** id → session for every session agentmemory knows (cached briefly; used to label projects). */
export function sessionIndex(): Promise<Map<string, AmSession>> {
  const now = Date.now();
  if (sessionIndexCache && now - sessionIndexCache.at < SESSION_INDEX_TTL_MS) return sessionIndexCache.promise;
  const promise = memoryRequest<{ sessions?: AmSession[] }>(amPath("sessions", { agentId: "*", limit: 500 })).then(
    (body) => new Map((body.sessions ?? []).map((s) => [s.id, s])),
  );
  sessionIndexCache = { at: now, promise };
  promise.catch(() => {
    sessionIndexCache = null;
  });
  return promise;
}
