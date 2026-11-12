import path from "node:path";
import type { MemoryFacet, MemoryProject, MemoryStoreStats } from "@/lib/memory-types";
import { json } from "@/lib/server/http";
import { type AmFacet, amPath, memoryRequest, memoryRoute } from "@/lib/server/memory-api";

export const dynamic = "force-dynamic";

interface Counts {
  sessions?: number;
  activeSessions?: number;
  observations?: number;
  memories?: number;
  latestMemories?: number;
  lessons?: number;
  graphNodes?: number | null;
  graphEdges?: number | null;
}

interface Flags {
  version?: string;
  provider?: string;
  embeddingProvider?: string;
  flags?: { key?: string; label?: string; enabled?: boolean }[];
}

function facets(list: AmFacet[] | undefined): MemoryFacet[] {
  return (list ?? []).filter((f) => typeof f?.value === "string" && typeof f.count === "number");
}

function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Store totals, search mode and facets (projects, memory kinds, agents, session statuses). The
 * project list also includes every omp-ui board (by its folder name, which is what agentmemory's
 * OMP extension files card runs under), so filters work before a board has memories.
 */
export const GET = memoryRoute(async ({ repo }) => {
  const [counts, flags, memoryFacets, sessionFacets, boards] = await Promise.all([
    memoryRequest<{ counts?: Counts }>("/agentmemory/counts"),
    memoryRequest<Flags>("/agentmemory/config/flags"),
    memoryRequest<{ facets?: { projects?: AmFacet[]; types?: AmFacet[]; agents?: AmFacet[] } }>(
      amPath("memories", { latest: true, agentId: "*", facets: true, limit: 1 }),
    ),
    memoryRequest<{ facets?: { projects?: AmFacet[]; statuses?: AmFacet[] } }>(
      amPath("sessions", { agentId: "*", facets: true, limit: 1 }),
    ),
    repo.listBoards(),
  ]);
  const c = counts.counts ?? {};
  const memoryProjects = facets(memoryFacets.facets?.projects);
  const sessionProjects = facets(sessionFacets.facets?.projects);

  const projects = new Map<string, MemoryProject>();
  const add = (value: string, memories: number): MemoryProject => {
    const existing = projects.get(value);
    if (existing) {
      existing.count += memories;
      return existing;
    }
    const created: MemoryProject = { value, count: memories, boardId: null, boardName: null };
    projects.set(value, created);
    return created;
  };
  for (const f of memoryProjects) add(f.value, f.count);
  for (const f of sessionProjects) add(f.value, 0);
  for (const board of boards) {
    const value = path.basename(board.workdir);
    if (!value) continue;
    const project = add(value, 0);
    if (!project.boardId) Object.assign(project, { boardId: board.id, boardName: board.name });
  }

  const body: MemoryStoreStats = {
    version: flags.version ?? null,
    provider: flags.provider ?? null,
    embeddingProvider: flags.embeddingProvider ?? "none",
    counts: {
      sessions: count(c.sessions),
      activeSessions: count(c.activeSessions),
      observations: count(c.observations),
      memories: count(c.memories),
      latestMemories: count(c.latestMemories),
      lessons: count(c.lessons),
      graphNodes: typeof c.graphNodes === "number" ? c.graphNodes : null,
      graphEdges: typeof c.graphEdges === "number" ? c.graphEdges : null,
    },
    projects: [...projects.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    types: facets(memoryFacets.facets?.types),
    agents: facets(memoryFacets.facets?.agents),
    sessionStatuses: facets(sessionFacets.facets?.statuses),
    sessionProjects,
    flags: (flags.flags ?? []).flatMap((f) =>
      typeof f.key === "string" ? [{ key: f.key, label: f.label ?? f.key, enabled: f.enabled === true }] : [],
    ),
  };
  return json(body);
});
