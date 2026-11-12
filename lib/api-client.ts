"use client";

import type {
  AppSettings,
  Board,
  BoardWithCounts,
  BoardPushResult,
  Comment,
  CleanupStatus,
  AiStats,
  OmpSkill,
  OmpConfigSnapshot,
  OmpConfigUpdate,
  OmpModel,
  MemoryStatus,
  Dashboard,
  FsBrowseResult,
  GitActionResult,
  GitBranches,
  GitStatus,
  MaintenanceAction,
  MaintenanceReport,
  MaintenanceResult,
  QueueSnapshot,
  RestartStatus,
  Run,
  RunEvent,
  ScheduledCleanupId,
  ServerEvent,
  SystemStats,
  SharedFiles,
  Task,
  TaskStatus,
  TaskWorkspace,
} from "@/lib/types";
import type {
  ComposeAction,
  ComposeDeploySpec,
  ComposeFile,
  ContainerAction,
  DockerContainerStats,
  DockerJobEvent,
  DockerOverview,
  HubRepository,
  HubTag,
  PruneKind,
  QuickComposeSpec,
  QuickRunSpec,
  RunContainerSpec,
  RunningSummary,
  TemplateCatalog,
} from "@/lib/docker-types";
import type { DiffSummary, TaskDiff } from "@/lib/diff-types";
import type {
  MemoryDetail,
  MemoryForgetResult,
  MemoryLayer,
  MemoryListResponse,
  MemorySearchResponse,
  MemorySessionDetail,
  MemorySessionsResponse,
  MemoryStoreStats,
} from "@/lib/memory-types";

/** Thrown for non-2xx responses. `status` 401 means the session expired. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const BASE = "/api/v1";

/** Fetch an API path; resolves with the response when it is 2xx, else throws `ApiRequestError`. */
async function send(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, headers, ...rest } = init;
  const res = await fetch(BASE + path, {
    credentials: "same-origin",
    ...rest,
    headers: {
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {}
    if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/auth/")) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    }
    throw new ApiRequestError(message, res.status);
  }
  return res;
}

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  return (await (await send(path, init)).json()) as T;
}

export interface TokenResponse {
  token: string;
  expiresAt: string;
}

export interface TaskDetail {
  task: Task;
  comments: Comment[];
  runs: Run[];
}

export interface SystemInfo {
  version: string;
  db: "sqlite" | "mongodb" | "postgres";
  omp: { path: string; installed: boolean; version: string | null };
}

export type FileScope = "tasks" | "boards";

/** Outcome of a streamed docker job; `ok: false` carries docker's error in `message`. */
export interface DockerJobResult {
  ok: boolean;
  message: string;
  id?: string;
}

/** POST/DELETE a docker job route and read its NDJSON `DockerJobEvent`s until `done`. */
async function dockerJob(
  path: string,
  init: RequestInit & { json?: unknown },
  onLine?: (line: string) => void,
): Promise<DockerJobResult> {
  const res = await send(path, init);
  if (!res.body) throw new ApiRequestError("The server sent no answer", 502);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += value ?? "";
      const lines = buffer.split("\n");
      buffer = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as DockerJobEvent;
        if (event.type === "log") onLine?.(event.line);
        else return { ok: event.ok, message: event.message, id: event.id };
      }
      if (done) return { ok: false, message: "The connection closed before docker finished" };
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** Filters shared by the memory list and search. `range`: 24h | 7d | 30d | 90d | all. */
export type MemoryFilters = {
  project?: string | null;
  type?: string | null;
  range?: string | null;
};

/** `?a=1&b=2` from defined, non-empty values ("" when none). */
function memoryQuery(params: Record<string, string | number | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") query.set(key, String(value));
  }
  const qs = query.toString();
  return qs ? `?${qs}` : "";
}

export const api = {
  auth: {
    status: () => request<{ configured: boolean; authenticated: boolean }>("/auth/status"),
    setup: (password: string) =>
      request<TokenResponse>("/auth/setup", { method: "POST", json: { password } }),
    login: (password: string) =>
      request<TokenResponse>("/auth/login", { method: "POST", json: { password } }),
    logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
    changePassword: (current: string, next: string) =>
      request<TokenResponse>("/auth/password", { method: "POST", json: { current, next } }),
  },
  system: () => request<SystemInfo>("/system"),
  restart: {
    status: () => request<RestartStatus>("/system/restart"),
    /** Stop, rebuild and start the server (202); it goes down for the build. */
    start: () =>
      request<{ ok: true; mode: "cli" | "pm2"; interrupted: number }>("/system/restart", { method: "POST" }),
  },
  /** Installed omp skills for the "/" picker; `refresh` bypasses the server's 60s cache. */
  skills: (refresh = false) =>
    request<{ skills: OmpSkill[] }>(`/system/skills${refresh ? "?refresh=1" : ""}`),
  /** Home dashboard aggregate: projects, totals, cards needing attention, recent results, queue. */
  dashboard: () => request<Dashboard>("/dashboard"),
  settings: {
    get: () => request<AppSettings>("/settings"),
    update: (patch: Partial<AppSettings>) =>
      request<AppSettings>("/settings", { method: "PATCH", json: patch }),
  },
  /** Scheduled cleanup of AgentMan data (Settings → Cleanup); schedule and targets save via `settings.update`. */
  cleanup: {
    status: () => request<CleanupStatus>("/settings/cleanup"),
    /** Clean up now (default: the saved targets); 409 while a cleanup is running. */
    run: (ids?: ScheduledCleanupId[]) =>
      request<CleanupStatus>("/settings/cleanup", { method: "POST", json: ids ? { ids } : {} }),
  },
  /** omp's user config.yml (Settings → OMP); changes apply to the next agent run. */
  ompConfig: {
    get: () => request<OmpConfigSnapshot>("/omp-config"),
    update: (update: OmpConfigUpdate) =>
      request<OmpConfigSnapshot>("/omp-config", { method: "PUT", json: update }),
    /** Chat models omp can use; `refresh` bypasses the server's 5 min cache. */
    models: (refresh = false) =>
      request<{ models: OmpModel[] }>(`/omp-config/models${refresh ? "?refresh=1" : ""}`),
  },
  /** The local agentmemory server (Settings → Memory). */
  memory: {
    /** `refresh` re-probes the agentmemory CLI instead of the server's 1 min cache. */
    status: (refresh = false) => request<MemoryStatus>(`/memory${refresh ? "?refresh=1" : ""}`),
    /** Start the server; answers within a minute with `starting: true` while it still boots. */
    start: () => request<MemoryStatus>("/memory/start", { method: "POST" }),
    /** `agentmemory connect omp --with-mcp`; restart omp sessions to load it. */
    connectOmp: () => request<MemoryStatus>("/memory/connect-omp", { method: "POST" }),
    // Browsing (the /memory page). A down server answers 503 `MemoryUnavailable`.
    /** Long-term memories, newest first; `q` ranks by relevance. */
    list: (filters: MemoryFilters & { q?: string; cursor?: string | null; limit?: number } = {}) =>
      request<MemoryListResponse>(`/memory/memories${memoryQuery(filters)}`),
    /** Hybrid search across memories and session observations. */
    search: (q: string, filters: MemoryFilters & { layer?: "all" | "memory" | "observation"; limit?: number } = {}) =>
      request<MemorySearchResponse>(`/memory/search${memoryQuery({ ...filters, q })}`),
    get: (id: string, opts: { layer?: MemoryLayer; sessionId?: string | null } = {}) =>
      request<MemoryDetail>(`/memory/memories/${encodeURIComponent(id)}${memoryQuery(opts)}`),
    /** Permanently delete a memory, or an observation (`layer: "observation"` + its `sessionId`). */
    forget: (id: string, opts: { layer?: MemoryLayer; sessionId?: string | null } = {}) =>
      request<MemoryForgetResult>(`/memory/memories/${encodeURIComponent(id)}${memoryQuery(opts)}`, {
        method: "DELETE",
      }),
    sessions: (filters: { project?: string | null; status?: string | null; q?: string; cursor?: string | null; limit?: number } = {}) =>
      request<MemorySessionsResponse>(`/memory/sessions${memoryQuery(filters)}`),
    session: (id: string, opts: { cursor?: string | null; limit?: number } = {}) =>
      request<MemorySessionDetail>(`/memory/sessions/${encodeURIComponent(id)}${memoryQuery(opts)}`),
    stats: () => request<MemoryStoreStats>("/memory/stats"),
  },
  boards: {
    list: () => request<BoardWithCounts[]>("/boards"),
    get: (id: string) => request<Board>(`/boards/${id}`),
    create: (input: {
      name: string;
      workdir: string;
      extraFolders?: string[];
      model?: string | null;
      autoRun?: boolean;
      worktrees?: boolean;
    }) =>
      request<Board>("/boards", { method: "POST", json: input }),
    update: (
      id: string,
      patch: Partial<{
        name: string;
        workdir: string;
        extraFolders: string[];
        model: string | null;
        autoRun: boolean;
        worktrees: boolean;
      }>,
    ) => request<Board>(`/boards/${id}`, { method: "PATCH", json: patch }),
    remove: (id: string) => request<{ ok: true }>(`/boards/${id}`, { method: "DELETE" }),
    tasks: (id: string) => request<Task[]>(`/boards/${id}/tasks`),
  },
  tasks: {
    create: (
      boardId: string,
      input: {
        title: string;
        description?: string;
        status?: TaskStatus;
        position?: number;
        blockedBy?: string[];
      },
    ) => request<Task>(`/boards/${boardId}/tasks`, { method: "POST", json: input }),
    /**
     * A card from free text, created in In progress with its agent started; the card writer
     * writes its title and brief in the background before the run starts.
     */
    createFromText: (boardId: string, input: { text: string; position?: number }) =>
      request<Task>(`/boards/${boardId}/tasks`, { method: "POST", json: input }),
    get: (id: string) => request<TaskDetail>(`/tasks/${id}`),
    update: (
      id: string,
      patch: Partial<{
        title: string;
        description: string;
        status: TaskStatus;
        position: number;
        blockedBy: string[];
        /** Only null is accepted: dismisses the agent's question. */
        question: null;
      }>,
    ) => request<Task>(`/tasks/${id}`, { method: "PATCH", json: patch }),
    remove: (id: string) => request<{ ok: true }>(`/tasks/${id}`, { method: "DELETE" }),
    run: (id: string) => request<Task>(`/tasks/${id}/run`, { method: "POST" }),
    stop: (id: string) => request<Task>(`/tasks/${id}/stop`, { method: "POST" }),
    comments: (id: string) => request<Comment[]>(`/tasks/${id}/comments`),
    comment: (id: string, body: string) =>
      request<Comment>(`/tasks/${id}/comments`, { method: "POST", json: { body } }),
    runs: (id: string) => request<Run[]>(`/tasks/${id}/runs`),
    /** The card's dedicated workspace (worktree per git project folder). */
    workspace: (id: string) => request<TaskWorkspace>(`/tasks/${id}/workspace`),
    /** Delete the card's worktrees and their local branches (refused while its agent runs). */
    removeWorkspace: (id: string) =>
      request<TaskWorkspace>(`/tasks/${id}/workspace`, { method: "DELETE" }),
    /** Git status of the folders the card ships from: its worktrees, else the project folders. */
    git: (id: string) => request<GitStatus[]>(`/tasks/${id}/git`),
    /** The card's code changes (uncommitted plus commits ahead of the base branch), per repo. */
    diff: (id: string, init?: { signal?: AbortSignal }) => request<TaskDiff>(`/tasks/${id}/diff`, init),
    /** One/two-sentence summary of the changes; `pending` while the summary agent writes it. `regenerate` drops the cached one. */
    diffSummary: (id: string, options: { regenerate?: boolean; signal?: AbortSignal } = {}) =>
      request<DiffSummary>(`/tasks/${id}/diff/summary`, {
        method: options.regenerate ? "POST" : "GET",
        signal: options.signal,
      }),
  },
  /** Files shared on a card (`scope` "tasks") or on a whole board (`scope` "boards"). */
  files: {
    list: (scope: FileScope, id: string) => request<SharedFiles>(`/${scope}/${id}/files`),
    upload: (scope: FileScope, id: string, file: Blob, name: string) =>
      request<SharedFiles>(`/${scope}/${id}/files?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      }),
    /** Download/preview URL (cookie-authenticated). `download` forces a save dialog. */
    url: (scope: FileScope, id: string, name: string, download = false) =>
      `${BASE}/${scope}/${id}/files/${name.split("/").map(encodeURIComponent).join("/")}${download ? "?download=1" : ""}`,
    remove: (scope: FileScope, id: string, name: string) =>
      request<SharedFiles>(
        `/${scope}/${id}/files/${name.split("/").map(encodeURIComponent).join("/")}`,
        { method: "DELETE" },
      ),
  },
  /** The agent queue across all boards. */
  queue: {
    get: () => request<QueueSnapshot>("/queue"),
    /** Move a queued card to `position` (0 = starts next). */
    move: (taskId: string, position: number) =>
      request<QueueSnapshot>("/queue", { method: "POST", json: { taskId, position } }),
  },
  comments: {
    setResolved: (id: string, resolved: boolean) =>
      request<Comment>(`/comments/${id}`, { method: "PATCH", json: { resolved } }),
    remove: (id: string) => request<{ ok: true }>(`/comments/${id}`, { method: "DELETE" }),
  },
  runs: {
    events: (id: string, after = 0, limit = 500) =>
      request<RunEvent[]>(`/runs/${id}/events?after=${after}&limit=${limit}`),
  },
  stats: {
    system: () => request<SystemStats>("/stats/system"),
    /** AI provider quota + usage via omp; `refresh` bypasses the 60s server cache. */
    ai: (refresh = false) => request<AiStats>(`/stats/ai${refresh ? "?refresh=1" : ""}`),
    /** Analyze CPU, memory and storage (processes, cleanable data, recommendations). */
    analyze: () => request<MaintenanceReport>("/stats/maintenance"),
    /** Clean up storage, end processes, free server memory or stop a card. */
    maintain: (action: MaintenanceAction) =>
      request<MaintenanceResult>("/stats/maintenance", { method: "POST", json: action }),
  },
  fs: {
    /** List sub-folders of `path` (default: WORKSPACE_DIR). */
    browse: (path?: string) =>
      request<FsBrowseResult>(`/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  },
  git: {
    /** Clone a repository into WORKSPACE_DIR/<name>; returns the absolute folder path. */
    clone: (input: { url: string; name?: string; branch?: string }) =>
      request<{ path: string; output: string }>("/git/clone", { method: "POST", json: input }),
    /** One entry per project folder (workdir first). */
    status: (boardId: string) => request<GitStatus[]>(`/boards/${boardId}/git`),
    /** Local + origin-only branches of one project folder. */
    branches: (boardId: string, folder: string) =>
      request<GitBranches>(`/boards/${boardId}/git/branches?folder=${encodeURIComponent(folder)}`),
    /** Check out an existing branch in one project folder; returns its fresh status. */
    switchBranch: (boardId: string, input: { folder: string; branch: string }) =>
      request<GitStatus>(`/boards/${boardId}/git/branches`, { method: "POST", json: input }),
    /** Header quick push: commit every project repo's changes and push to its default branch. */
    pushBoard: (boardId: string) =>
      request<BoardPushResult>(`/boards/${boardId}/git/push`, { method: "POST", json: {} }),
    /** Commit the task's changes and push straight to the default branch (all changed folders). */
    push: (taskId: string, input: { message?: string; folders?: string[] } = {}) =>
      request<GitActionResult>(`/tasks/${taskId}/git/push`, { method: "POST", json: input }),
    /** Commit to a new branch, push, and open a PR (GitHub) / MR (GitLab). */
    pr: (taskId: string, input: { title?: string; body?: string; folders?: string[] } = {}) =>
      request<GitActionResult>(`/tasks/${taskId}/git/pr`, { method: "POST", json: input }),
  },
  docker: {
    overview: () => request<DockerOverview>("/docker"),
    stats: () => request<DockerContainerStats[]>("/docker/stats"),
    inspect: (id: string) => request<Record<string, unknown>>(`/docker/containers/${encodeURIComponent(id)}`),
    containerAction: (id: string, action: ContainerAction) =>
      request<{ ok: true }>(`/docker/containers/${encodeURIComponent(id)}`, { method: "POST", json: { action } }),
    removeContainer: (id: string, volumes = false) =>
      request<{ ok: true }>(`/docker/containers/${encodeURIComponent(id)}${volumes ? "?volumes=1" : ""}`, {
        method: "DELETE",
      }),
    containerLogs: (id: string, tail = 300) =>
      request<{ logs: string }>(`/docker/containers/${encodeURIComponent(id)}/logs?tail=${tail}`),
    /** `docker run -d`; streams pull/run output to `onLine`. */
    run: (spec: RunContainerSpec, onLine?: (line: string) => void) =>
      dockerJob("/docker/run", { method: "POST", json: spec }, onLine),
    pull: (image: string, onLine?: (line: string) => void) =>
      dockerJob("/docker/images", { method: "POST", json: { image } }, onLine),
    removeImage: (ref: string, force = false) =>
      request<{ ok: true }>(`/docker/images?ref=${encodeURIComponent(ref)}${force ? "&force=1" : ""}`, {
        method: "DELETE",
      }),
    removeVolume: (name: string) =>
      request<{ ok: true }>(`/docker/volumes/${encodeURIComponent(name)}`, { method: "DELETE" }),
    removeNetwork: (id: string) =>
      request<{ ok: true }>(`/docker/networks/${encodeURIComponent(id)}`, { method: "DELETE" }),
    prune: (kind: PruneKind) => request<{ message: string }>("/docker/prune", { method: "POST", json: { kind } }),
    composeFile: (name: string) => request<ComposeFile>(`/docker/compose/${encodeURIComponent(name)}`),
    composeLogs: (name: string, tail = 300) =>
      request<{ logs: string }>(`/docker/compose/${encodeURIComponent(name)}/logs?tail=${tail}`),
    /** Create or redeploy an AgentMan compose project (`up -d`). */
    deployCompose: (spec: ComposeDeploySpec, onLine?: (line: string) => void) =>
      dockerJob("/docker/compose", { method: "POST", json: spec }, onLine),
    composeAction: (name: string, action: ComposeAction, onLine?: (line: string) => void) =>
      dockerJob(`/docker/compose/${encodeURIComponent(name)}`, { method: "POST", json: { action } }, onLine),
    removeCompose: (name: string, volumes: boolean, onLine?: (line: string) => void) =>
      dockerJob(`/docker/compose/${encodeURIComponent(name)}${volumes ? "?volumes=1" : ""}`, { method: "DELETE" }, onLine),
    templates: (refresh = false) => request<TemplateCatalog>(`/docker/templates${refresh ? "?refresh=1" : ""}`),
    templateCompose: (id: string) =>
      request<{ yaml: string }>(`/docker/templates/${encodeURIComponent(id)}/compose`),
    search: (q: string, registry: "dockerhub" | "quay" = "dockerhub") =>
      request<HubRepository[]>(`/docker/registry/search?q=${encodeURIComponent(q)}&registry=${registry}`),
    tags: (repo: string) => request<HubTag[]>(`/docker/registry/tags?repo=${encodeURIComponent(repo)}`),
    /** Running containers + compose projects (cheap; the header badge polls it). */
    running: () => request<RunningSummary>("/docker/running"),
    /** `docker run -d` with smart defaults (free ports, unused name); `id` is the container id. */
    quickRun: (spec: QuickRunSpec, onLine?: (line: string) => void) =>
      dockerJob("/docker/quick-run", { method: "POST", json: spec }, onLine),
    /** One-click compose up from a template, YAML or URL; `id` is the project name. */
    quickCompose: (spec: QuickComposeSpec, onLine?: (line: string) => void) =>
      dockerJob("/docker/quick-compose", { method: "POST", json: spec }, onLine),
    composeFromUrl: (url: string) =>
      request<{ yaml: string; url: string }>(`/docker/compose-url?url=${encodeURIComponent(url)}`),
  },
};

/**
 * Subscribe to live server events (SSE). Returns an unsubscribe function.
 * EventSource reconnects automatically; `onReconnect` fires after a dropped connection
 * reopens so callers can refetch state they may have missed.
 */
export function subscribeEvents(
  onEvent: (event: ServerEvent) => void,
  opts: {
    boardId?: string;
    onReconnect?: () => void;
    /** "live" on every successful open (including the first); "reconnecting" on drop. */
    onStatus?: (status: "live" | "reconnecting") => void;
  } = {},
): () => void {
  const url = `${BASE}/events${opts.boardId ? `?boardId=${encodeURIComponent(opts.boardId)}` : ""}`;
  const source = new EventSource(url, { withCredentials: true });
  let dropped = false;
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as ServerEvent);
    } catch {}
  };
  source.onerror = () => {
    dropped = true;
    opts.onStatus?.("reconnecting");
  };
  source.onopen = () => {
    opts.onStatus?.("live");
    if (dropped) {
      dropped = false;
      opts.onReconnect?.();
    }
  };
  return () => source.close();
}
