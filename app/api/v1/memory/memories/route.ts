import type { MemoryListResponse } from "@/lib/memory-types";
import { json } from "@/lib/server/http";
import {
  type AmMemory,
  amPath,
  memoryRequest,
  memoryRoute,
  memoryToItem,
  optionalCursor,
  optionalText,
  parseLimit,
  parseRange,
} from "@/lib/server/memory-api";

export const dynamic = "force-dynamic";

/**
 * Long-term memories, newest first (latest versions only). Query: `project`, `type`, `q` (ranked
 * keyword/semantic match), `range` (24h|7d|30d|90d|all), `limit` (≤ 100), `cursor`.
 */
export const GET = memoryRoute(async ({ req }) => {
  const url = new URL(req.url);
  const q = optionalText(url.searchParams.get("q"), "q", 500);
  const since = parseRange(url.searchParams.get("range"));
  const body = await memoryRequest<{ memories?: AmMemory[]; total?: number; nextCursor?: string | null }>(
    amPath("memories", {
      latest: true,
      agentId: "*",
      project: optionalText(url.searchParams.get("project"), "project"),
      type: optionalText(url.searchParams.get("type"), "type", 50),
      q,
      cursor: optionalCursor(url.searchParams.get("cursor")),
      limit: parseLimit(url.searchParams.get("limit"), 40, 100),
    }),
  );
  const memories = body.memories ?? [];
  let nextCursor = body.nextCursor ?? null;
  let kept = memories;
  if (since) {
    const fresh = (m: AmMemory) => (m.updatedAt ?? m.createdAt ?? "") >= since;
    kept = memories.filter(fresh);
    // Unranked lists are newest first: once a page reaches past the range, later pages are older still.
    if (!q && kept.length < memories.length) nextCursor = null;
  }
  const result: MemoryListResponse = {
    items: kept.map((m) => memoryToItem(m)),
    total: since ? null : (body.total ?? null),
    nextCursor,
  };
  return json(result);
});
