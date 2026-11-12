import type { MemorySessionsResponse } from "@/lib/memory-types";
import { json } from "@/lib/server/http";
import {
  type AmSession,
  amPath,
  cardIndex,
  memoryRequest,
  memoryRoute,
  optionalCursor,
  optionalText,
  parseLimit,
  sessionToItem,
} from "@/lib/server/memory-api";

export const dynamic = "force-dynamic";

/**
 * Agent sessions agentmemory recorded, newest first, each linked to its AgentMan card when one ran
 * it. Query: `project`, `status` (active|completed|abandoned), `q`, `limit` (≤ 100), `cursor`.
 */
export const GET = memoryRoute(async ({ req, repo }) => {
  const url = new URL(req.url);
  const [body, cards] = await Promise.all([
    memoryRequest<{ sessions?: AmSession[]; nextCursor?: string | null }>(
      amPath("sessions", {
        agentId: "*",
        project: optionalText(url.searchParams.get("project"), "project"),
        status: optionalText(url.searchParams.get("status"), "status", 20),
        q: optionalText(url.searchParams.get("q"), "q", 200),
        cursor: optionalCursor(url.searchParams.get("cursor")),
        limit: parseLimit(url.searchParams.get("limit"), 30, 100),
      }),
    ),
    cardIndex(repo),
  ]);
  const result: MemorySessionsResponse = {
    items: (body.sessions ?? []).map((s) => sessionToItem(s, cards)),
    nextCursor: body.nextCursor ?? null,
  };
  return json(result);
});
