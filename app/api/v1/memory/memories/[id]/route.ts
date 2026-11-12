import type { MemoryDetail, MemoryForgetResult, MemoryItem, MemoryLayer, MemorySession } from "@/lib/memory-types";
import { HttpError, json } from "@/lib/server/http";
import {
  type AmMemory,
  type AmObservation,
  amPath,
  cardIndex,
  memoryPost,
  memoryRequest,
  memoryRoute,
  memoryToItem,
  observationToItem,
  optionalId,
  parseId,
  sessionIndex,
  sessionToItem,
  strings,
} from "@/lib/server/memory-api";

export const dynamic = "force-dynamic";

type Params = { id: string };

const RELATED_MAX = 8;
const SESSIONS_MAX = 8;

/** The long-term memory with this id, or null when it is an observation (or gone). */
async function findMemory(id: string): Promise<AmMemory | null> {
  try {
    const body = await memoryRequest<{ memory?: AmMemory }>(`/agentmemory/memories/${encodeURIComponent(id)}`);
    return body.memory ?? null;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

/**
 * A memory (`layer=memory`) or a captured observation (`layer=observation`, `sessionId` speeds
 * the lookup) with its linked sessions and related memories. Without `layer`, memories are tried
 * first.
 */
export const GET = memoryRoute<Params>(async ({ req, repo, params }) => {
  const id = parseId(params.id);
  const url = new URL(req.url);
  const layer = url.searchParams.get("layer");
  const sessionHint = optionalId(url.searchParams.get("sessionId"), "sessionId");
  const [sessions, cards] = await Promise.all([sessionIndex(), cardIndex(repo)]);
  const linkedSessions = (ids: string[]): MemorySession[] =>
    [...new Set(ids)]
      .slice(0, SESSIONS_MAX)
      .map((sid) => sessions.get(sid))
      .filter((s) => s !== undefined)
      .map((s) => sessionToItem(s, cards));

  const memory = layer === "observation" ? null : await findMemory(id);
  if (memory) {
    const relatedIds = [
      ...new Set([memory.parentId, ...strings(memory.supersedes), ...strings(memory.relatedIds)]),
    ].filter((rid): rid is string => typeof rid === "string" && rid !== id);
    const related = (await Promise.all(relatedIds.slice(0, RELATED_MAX).map(findMemory)))
      .filter((m) => m !== null)
      .map((m) => memoryToItem(m));
    const detail: MemoryDetail = {
      ...memoryToItem(memory),
      content: memory.content ?? "",
      facts: [],
      concepts: strings(memory.concepts),
      files: strings(memory.files),
      sessionIds: strings(memory.sessionIds),
      version: typeof memory.version === "number" ? memory.version : null,
      isLatest: typeof memory.isLatest === "boolean" ? memory.isLatest : null,
      agentId: memory.agentId ?? null,
      origin: memory.origin?.channel ?? null,
      forgetAfter: memory.forgetAfter ?? null,
      sessions: linkedSessions(strings(memory.sessionIds)),
      related,
    };
    return json(detail);
  }
  if (layer === "memory") throw new HttpError(404, "Memory not found");

  const expanded = await memoryPost<{
    results?: { observation?: AmObservation; layer?: MemoryLayer; sessionId?: string }[];
  }>("/agentmemory/smart-search", {
    expandIds: [sessionHint ? { obsId: id, sessionId: sessionHint } : id],
    agentId: "*",
    source: "viewer",
  });
  const hit = expanded.results?.find((r) => r.observation?.id === id);
  const observation = hit?.observation;
  if (!observation) throw new HttpError(404, "Memory not found");
  const sessionId = observation.sessionId ?? hit?.sessionId ?? null;
  const session = sessionId ? sessions.get(sessionId) : undefined;
  // Long-term memories distilled from this observation's session.
  let related: MemoryItem[] = [];
  if (sessionId) {
    const body = await memoryRequest<{ memories?: AmMemory[] }>(
      amPath("memories", { sessionId, latest: true, agentId: "*", limit: RELATED_MAX }),
    ).catch(() => ({ memories: [] as AmMemory[] }));
    related = (body.memories ?? []).map((m) => memoryToItem(m));
  }
  const detail: MemoryDetail = {
    ...observationToItem(observation, session?.project ?? null, hit?.layer ?? "observation"),
    content: observation.narrative ?? "",
    facts: strings(observation.facts),
    concepts: strings(observation.concepts),
    files: strings(observation.files),
    sessionIds: sessionId ? [sessionId] : [],
    version: null,
    isLatest: null,
    agentId: observation.agentId ?? null,
    origin: observation.origin?.channel ?? null,
    forgetAfter: null,
    sessions: sessionId ? linkedSessions([sessionId]) : [],
    related,
  };
  return json(detail);
});

/**
 * Forget (permanently delete) a memory, or an observation with `layer=observation&sessionId=…`.
 * 404 when nothing was deleted.
 */
export const DELETE = memoryRoute<Params>(async ({ req, params }) => {
  const id = parseId(params.id);
  const url = new URL(req.url);
  const layer = url.searchParams.get("layer") ?? "memory";
  let payload: Record<string, unknown>;
  if (layer === "memory") {
    payload = { memoryId: id };
  } else if (layer === "observation") {
    const sessionId = parseId(url.searchParams.get("sessionId"), "sessionId");
    payload = { sessionId, observationIds: [id] };
  } else {
    throw new HttpError(400, "layer must be memory or observation");
  }
  const result = await memoryPost<{ deleted?: number; success?: boolean }>("/agentmemory/forget", payload);
  const deleted = typeof result.deleted === "number" ? result.deleted : 0;
  if (deleted === 0) {
    throw new HttpError(result.success === false ? 502 : 404, result.success === false ? "Forget failed" : "Memory not found");
  }
  const body: MemoryForgetResult = { deleted };
  return json(body);
});
