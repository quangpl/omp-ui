// Stable JSON shapes of `/api/v1/memory/*` (the AgentMan proxy in front of the local agentmemory
// server). Routes normalize agentmemory's records into these so the UI never depends on the
// memory server's internal field names.

/** Where a record lives in agentmemory: long-term memories vs. captured session observations. */
export type MemoryLayer = "memory" | "observation" | "lesson" | "insight";

/** Memory kinds agentmemory assigns to long-term memories. */
export const MEMORY_TYPES = ["pattern", "preference", "architecture", "bug", "workflow", "fact"] as const;

/** One row of a memory list or search result. */
export interface MemoryItem {
  id: string;
  layer: MemoryLayer;
  /** Memory kind (`fact`, `bug`…) or observation kind (`file_edit`, `decision`…). */
  type: string;
  title: string;
  /** Plain-text excerpt of the content (≤ 280 chars). */
  summary: string;
  project: string | null;
  /** Session the record came from (observations) or was first seen in (memories). */
  sessionId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Observation importance (1–10) or memory strength (0–1, scaled to 0–10). */
  importance: number | null;
  /** 0–1 when agentmemory recorded one. */
  confidence: number | null;
  /** Search relevance (search results only). */
  score: number | null;
}

/** GET /memory/memories */
export interface MemoryListResponse {
  items: MemoryItem[];
  /** Total matches; null when a time filter makes the count unknowable without a full scan. */
  total: number | null;
  nextCursor: string | null;
}

/** GET /memory/search */
export interface MemorySearchResponse {
  /** agentmemory search mode, e.g. "compact". */
  mode: string;
  items: MemoryItem[];
  lessons: MemoryLesson[];
}

export interface MemoryLesson {
  id: string;
  content: string;
  confidence: number | null;
  score: number | null;
  project: string | null;
  createdAt: string | null;
}

/** An AgentMan card a memory session belongs to (matched by the card's omp session file). */
export interface MemoryCardLink {
  boardId: string;
  taskId: string;
  title: string;
}

export interface MemorySession {
  id: string;
  project: string | null;
  cwd: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  observationCount: number;
  model: string | null;
  agentId: string | null;
  firstPrompt: string | null;
  /** Session summary title/narrative when agentmemory summarized the session. */
  title: string | null;
  narrative: string | null;
  tags: string[];
  card: MemoryCardLink | null;
}

/** GET /memory/sessions */
export interface MemorySessionsResponse {
  items: MemorySession[];
  nextCursor: string | null;
}

/** GET /memory/sessions/:id — the session and a page of its observations (newest first). */
export interface MemorySessionDetail {
  session: MemorySession;
  keyDecisions: string[];
  filesModified: string[];
  observations: MemoryItem[];
  total: number;
  nextCursor: string | null;
}

/** GET /memory/memories/:id */
export interface MemoryDetail extends MemoryItem {
  /** Full text: memory content, or the observation narrative. */
  content: string;
  facts: string[];
  concepts: string[];
  files: string[];
  sessionIds: string[];
  version: number | null;
  /** False for a superseded memory version. */
  isLatest: boolean | null;
  agentId: string | null;
  /** Capture channel (`agent`, `tool`, `user`, `import`, `shared`). */
  origin: string | null;
  forgetAfter: string | null;
  /** Sessions the record links to, resolved (unknown ids are left out). */
  sessions: MemorySession[];
  /** Parent, superseded and related memories. */
  related: MemoryItem[];
}

export interface MemoryFacet {
  value: string;
  count: number;
}

/** A project option for filters: memory projects plus AgentMan boards (by workdir folder name). */
export interface MemoryProject {
  /** agentmemory project name (git repository or folder basename). */
  value: string;
  count: number;
  boardId: string | null;
  boardName: string | null;
}

/** GET /memory/stats */
export interface MemoryStoreStats {
  version: string | null;
  /** LLM provider kind agentmemory detected (`none` in keyless mode). */
  provider: string | null;
  /** e.g. "local (384 dims)"; "none" means BM25-only keyword recall. */
  embeddingProvider: string;
  counts: {
    sessions: number;
    activeSessions: number;
    observations: number;
    memories: number;
    latestMemories: number;
    lessons: number;
    graphNodes: number | null;
    graphEdges: number | null;
  };
  projects: MemoryProject[];
  types: MemoryFacet[];
  agents: MemoryFacet[];
  sessionStatuses: MemoryFacet[];
  sessionProjects: MemoryFacet[];
  flags: { key: string; label: string; enabled: boolean }[];
}

/** Body of a 503 from `/memory/*` when the memory server is not reachable. */
export interface MemoryUnavailable {
  error: string;
  installed: boolean;
  healthy: false;
}

/** DELETE /memory/memories/:id */
export interface MemoryForgetResult {
  deleted: number;
}
