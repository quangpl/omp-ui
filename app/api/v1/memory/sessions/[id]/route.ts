import type { MemorySessionDetail } from "@/lib/memory-types";
import { HttpError, json } from "@/lib/server/http";
import {
  type AmObservation,
  type AmSession,
  amPath,
  cardIndex,
  memoryRequest,
  memoryRoute,
  observationToItem,
  optionalCursor,
  parseId,
  parseLimit,
  sessionIndex,
  sessionSummary,
  sessionToItem,
  strings,
} from "@/lib/server/memory-api";

export const dynamic = "force-dynamic";

type Params = { id: string };

/** A session's details and a page of its observations, newest first (`limit` ≤ 200, `cursor`). */
export const GET = memoryRoute<Params>(async ({ req, repo, params }) => {
  const id = parseId(params.id);
  const url = new URL(req.url);
  const [known, observations, cards] = await Promise.all([
    sessionIndex().then((index) => index.get(id)),
    memoryRequest<{ observations?: AmObservation[]; total?: number; nextCursor?: string | null }>(
      amPath("observations", {
        sessionId: id,
        agentId: "*",
        cursor: optionalCursor(url.searchParams.get("cursor")),
        limit: parseLimit(url.searchParams.get("limit"), 50, 200),
      }),
    ),
    cardIndex(repo),
  ]);
  // The cached index can miss a session that started moments ago: ask for it by id.
  const session =
    known ??
    (
      await memoryRequest<{ sessions?: AmSession[] }>(amPath("sessions", { agentId: "*", q: id, limit: 20 }))
    ).sessions?.find((s) => s.id === id);
  if (!session) throw new HttpError(404, "Session not found");
  const summary = sessionSummary(session);
  const project = session.project ?? null;
  const detail: MemorySessionDetail = {
    session: sessionToItem(session, cards),
    keyDecisions: strings(summary?.keyDecisions),
    filesModified: strings(summary?.filesModified),
    observations: (observations.observations ?? []).map((o) => observationToItem(o, project)),
    total: observations.total ?? 0,
    nextCursor: observations.nextCursor ?? null,
  };
  return json(detail);
}, { admin: true });
