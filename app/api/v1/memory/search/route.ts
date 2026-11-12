import type { MemoryItem, MemoryLayer, MemoryLesson, MemorySearchResponse } from "@/lib/memory-types";
import { HttpError, json } from "@/lib/server/http";
import {
  type AmMemory,
  type AmObservation,
  type AmSession,
  excerpt,
  memoryPost,
  memoryRequest,
  memoryRoute,
  memoryToItem,
  observationToItem,
  optionalText,
  parseLimit,
  parseRange,
  sessionIndex,
} from "@/lib/server/memory-api";

export const dynamic = "force-dynamic";

const LAYERS = ["all", "memory", "observation"] as const;
/** agentmemory expands at most 20 ids per smart-search call. */
const EXPAND_BATCH = 20;

interface CompactHit {
  obsId: string;
  sessionId?: string;
  layer?: MemoryLayer;
  title?: string;
  type?: string;
  memoryType?: string;
  score?: number;
  timestamp?: string;
}

interface CompactLesson {
  lessonId?: string;
  content?: string;
  confidence?: number;
  score?: number;
  createdAt?: string;
  project?: string;
}

/**
 * Hybrid search (BM25, plus vectors/graph when configured) across memories and session
 * observations. Query: `q` (required), `project`, `layer` (all|memory|observation), `type`,
 * `range` (24h|7d|30d|90d|all), `limit` (≤ 40). Hits are hydrated with their content excerpt.
 */
export const GET = memoryRoute(async ({ req }) => {
  const url = new URL(req.url);
  const q = optionalText(url.searchParams.get("q"), "q", 500);
  if (!q) throw new HttpError(400, "q is required");
  const layerParam = url.searchParams.get("layer") ?? "all";
  const layer = LAYERS.find((l) => l === layerParam);
  if (!layer) throw new HttpError(400, "layer must be one of all, memory, observation");
  const project = optionalText(url.searchParams.get("project"), "project");
  const type = optionalText(url.searchParams.get("type"), "type", 50);
  const since = parseRange(url.searchParams.get("range"));
  const limit = parseLimit(url.searchParams.get("limit"), 30, 40);

  const search = await memoryPost<{ mode?: string; results?: CompactHit[]; lessons?: CompactLesson[] }>(
    "/agentmemory/smart-search",
    {
      query: q,
      limit,
      ...(project ? { project } : {}),
      targetLayer: layer,
      includeLessons: layer === "all",
      agentId: "*",
      source: "viewer",
    },
  );
  const hits = (search.results ?? []).filter((h) => typeof h?.obsId === "string");

  // Hydrate: long-term memories by id, observations through smart-search's expand mode.
  // Long-term memories surface as `layer: "memory"` with the placeholder session "memory".
  const isMemoryHit = (h: CompactHit) => h.layer === "memory" || (h.layer === undefined && h.sessionId === "memory");
  const memoryHits = hits.filter(isMemoryHit);
  const otherHits = hits.filter((h) => !isMemoryHit(h));
  const batches: CompactHit[][] = [];
  for (let i = 0; i < otherHits.length; i += EXPAND_BATCH) batches.push(otherHits.slice(i, i + EXPAND_BATCH));
  const [memories, expanded, sessions] = await Promise.all([
    Promise.all(
      memoryHits.map((h) =>
        memoryRequest<{ memory?: AmMemory }>(`/agentmemory/memories/${encodeURIComponent(h.obsId)}`)
          .then((body) => body.memory ?? null)
          .catch(() => null),
      ),
    ),
    Promise.all(
      batches.map((batch) =>
        memoryPost<{ results?: { observation?: AmObservation }[] }>("/agentmemory/smart-search", {
          expandIds: batch.map((h) => (h.sessionId ? { obsId: h.obsId, sessionId: h.sessionId } : h.obsId)),
          agentId: "*",
          source: "viewer",
        })
          .then((body) => body.results ?? [])
          .catch(() => []),
      ),
    ),
    sessionIndex().catch(() => new Map<string, AmSession>()),
  ]);
  const memoryById = new Map(memories.filter((m) => m !== null).map((m) => [m.id, m]));
  const observationById = new Map<string, AmObservation>();
  for (const result of expanded.flat()) if (result.observation) observationById.set(result.observation.id, result.observation);

  const items: MemoryItem[] = [];
  for (const hit of hits) {
    const score = typeof hit.score === "number" ? hit.score : null;
    const memory = memoryById.get(hit.obsId);
    const observation = observationById.get(hit.obsId);
    const sessionProject = hit.sessionId ? (sessions.get(hit.sessionId)?.project ?? null) : null;
    let item: MemoryItem;
    if (memory) item = memoryToItem(memory, score);
    else if (observation) item = observationToItem(observation, sessionProject, hit.layer ?? "observation", score);
    else {
      item = observationToItem(
        {
          id: hit.obsId,
          sessionId: hit.sessionId,
          timestamp: hit.timestamp,
          type: hit.type,
          memoryType: hit.memoryType,
          title: hit.title,
        },
        sessionProject,
        isMemoryHit(hit) ? "memory" : (hit.layer ?? "observation"),
        score,
      );
    }
    if (type && item.type !== type) continue;
    if (since && (item.updatedAt ?? item.createdAt ?? "") < since) continue;
    items.push(item);
  }

  const lessons: MemoryLesson[] = (search.lessons ?? []).flatMap((l) =>
    typeof l?.lessonId === "string" && typeof l.content === "string"
      ? [
          {
            id: l.lessonId,
            content: excerpt(l.content, 600),
            confidence: typeof l.confidence === "number" ? l.confidence : null,
            score: typeof l.score === "number" ? l.score : null,
            project: l.project ?? null,
            createdAt: l.createdAt ?? null,
          },
        ]
      : [],
  );
  const body: MemorySearchResponse = { mode: search.mode ?? "compact", items, lessons };
  return json(body);
});
