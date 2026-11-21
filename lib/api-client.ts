"use client";

import type {
  AppSettings,
  ArtifactPeriod,
  ArtifactProject,
  ArtifactProjectResults,
  Board,
  BoardWithCounts,
  BoardPushResult,
  ChatPlatform,
  ChatPlatformStatus,
  ChatStatusResponse,
  Comment,
  CleanupStatus,
  DataImportResult,
  DataTransferStatus,
  ClusterJoinInfo,
  ClusterStatus,
  ClusterTestResult,
  AiStatsResponse,
  OmpSkill,
  OmpConfigSnapshot,
  OmpConfigUpdate,
  OmpModel,
  OmpSettingInfo,
  MemoryStatus,
  Dashboard,
  FileOp,
  FileOpResult,
  FsBrowseResult,
  FsEntry,
  GitActionResult,
  GitBranches,
  GitDiscardResult,
  GitStatus,
  GitSwitchResult,
  MaintenanceAction,
  MaintenanceReport,
  MaintenanceResult,
  ProjectFileContent,
  ProjectFileHit,
  QueueSnapshot,
  RestartStatus,
  Run,
  RunEvent,
  Scheduler,
  SchedulerChatEvent,
  SchedulerChatRequest,
  SchedulerDraft,
  SchedulerLogEntry,
  SchedulerRunView,
  ScheduledCleanupId,
  ServerEvent,
  SystemStats,
  SharedFiles,
  Task,
  TaskCheckpoint,
  TaskReviewResult,
  TaskStatus,
  TaskWorkspace,
  AuthStatus,
  CreateUserRequest,
  DeleteUserResult,
  UpdateUserRequest,
  User,
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
import type {
  CredentialInput,
  CredentialNotificationAction,
  CredentialNotificationsResponse,
  CredentialsResponse,
  CredentialSummary,
  CredentialTestResult,
  CredentialUpdate,
} from "@/lib/credential-types";
import type {
  AiOAuthSession,
  AiProvidersResponse,
  AiProviderTestInput,
  AiProviderTestResponse,
  AiProviderUpdate,
} from "@/lib/ai-providers";
import type {
  McpConnectInput,
  McpConnectResult,
  McpDirectoryResponse,
  McpServerSummary,
  McpServersResponse,
  McpServerUpdate,
} from "@/lib/mcp-types";
import type { WordModelData } from "@/lib/word-completion";
import {
  TERMINAL_PING_INTERVAL_MS,
  type TerminalBlock,
  type TerminalExecuteRequest,
  type TerminalStreamEvent,
} from "@/lib/terminal-types";
import type { LogExportFormat, LogPage, LogQuery, LogSource, LogSourcesResponse } from "@/lib/log-types";

/**
 * Thrown for non-2xx responses. `status` 401 means the session expired. `fields`: per-field
 * messages from a 400 `{ error, fields }` body (keyed like the request's fields), when present.
 */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fields: Record<string, string> = {},
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
    let fields: Record<string, string> = {};
    try {
      const data = (await res.json()) as { error?: string; fields?: unknown };
      if (data?.error) message = data.error;
      if (data?.fields && typeof data.fields === "object") {
        fields = Object.fromEntries(
          Object.entries(data.fields as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
      }
    } catch {}
    if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/auth/")) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    }
    throw new ApiRequestError(message, res.status, fields);
  }
  return res;
}

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  return (await (await send(path, init)).json()) as T;
}

export interface TokenResponse {
  token: string;
  expiresAt: string;
  /** The account the token signs in. */
  user: User;
}

export interface TaskDetail {
  task: Task;
  comments: Comment[];
  runs: Run[];
}

/** GET /tasks/:id/checkpoints. `enabled`: new runs take checkpoints (Settings → gitCheckpoints). */
export interface TaskCheckpointList {
  checkpoints: TaskCheckpoint[];
  enabled: boolean;
}

/** POST /tasks/:id/checkpoints/restore. */
export interface CheckpointRestoreResult {
  checkpoint: TaskCheckpoint;
  /** Snapshot taken just before the restore; restoring it undoes the restore. */
  undo: TaskCheckpoint;
  /** Number of files written back from the checkpoint. */
  restored: number;
  /** Number of files deleted because the checkpoint did not have them. */
  removed: number;
  /** The agent comment noting the rollback on the card. */
  comment: Comment;
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

/** Query string of `/logs/[source]` (and its export): levels become one comma list, "all" files are omitted. */
function logQuery(query: LogQuery, extra: Record<string, string> = {}): string {
  return memoryQuery({
    ...extra,
    limit: query.limit,
    offset: query.offset,
    level: query.levels?.join(","),
    since: query.since,
    until: query.until,
    q: query.q?.trim(),
    file: query.file === "all" ? undefined : query.file,
  });
}

export const api = {
  auth: {
    status: () => request<AuthStatus>("/auth/status"),
    /** First run: creates the first admin account (`username` defaults to "admin" server-side). */
    setup: (input: { username?: string; email?: string | null; password: string }) =>
      request<TokenResponse>("/auth/setup", { method: "POST", json: input }),
    /** `username`: a username or an email address. */
    login: (username: string, password: string) =>
      request<TokenResponse>("/auth/login", { method: "POST", json: { username, password } }),
    logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
    /** Change the signed-in user's own password; signs out that user's other sessions. */
    changePassword: (current: string, next: string) =>
      request<TokenResponse>("/auth/password", { method: "POST", json: { current, next } }),
  },
  /** User management (admins only). */
  users: {
    list: () => request<User[]>("/users"),
    get: (id: string) => request<User>(`/users/${encodeURIComponent(id)}`),
    create: (input: CreateUserRequest) => request<User>("/users", { method: "POST", json: input }),
    update: (id: string, patch: UpdateUserRequest) =>
      request<User>(`/users/${encodeURIComponent(id)}`, { method: "PATCH", json: patch }),
    /** Without `reassignTo` the user's boards and credentials are deleted with the account. */
    remove: (id: string, options: { reassignTo?: string } = {}) =>
      request<DeleteUserResult>(
        `/users/${encodeURIComponent(id)}${options.reassignTo ? `?reassignTo=${encodeURIComponent(options.reassignTo)}` : ""}`,
        { method: "DELETE" },
      ),
    /** Set another user's password (signs that user out everywhere). */
    setPassword: (id: string, password: string) =>
      request<{ ok: true }>(`/users/${encodeURIComponent(id)}/password`, { method: "PATCH", json: { password } }),
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
  /** Word-completion model for the composer's inline ghost text (server caches it 5 min). */
  wordCompletions: () => request<{ model: WordModelData }>("/system/word-completions"),
  /** Home dashboard aggregate: projects, totals, cards needing attention, recent results, queue. */
  dashboard: () => request<Dashboard>("/dashboard"),
  /** Artifacts page: every project with its final results in the period (newest result first). */
  artifacts: {
    projects: (period: ArtifactPeriod = {}) =>
      request<ArtifactProject[]>(`/artifacts${memoryQuery({ from: period.from, to: period.to })}`),
    /** One project's cards with a final result in the period: summary and final attachments only. */
    results: (boardId: string, period: ArtifactPeriod = {}) =>
      request<ArtifactProjectResults>(
        `/artifacts/${encodeURIComponent(boardId)}${memoryQuery({ from: period.from, to: period.to })}`,
      ),
  },
  settings: {
    get: () => request<AppSettings>("/settings"),
    update: (patch: Partial<AppSettings>) =>
      request<AppSettings>("/settings", { method: "PATCH", json: patch }),
    /** Send one test span to an OTLP/HTTP traces endpoint (Settings → Orchestration); `ok` = collector accepted it. */
    testTelemetry: (endpoint: string) =>
      request<{ ok: boolean; status: number | null; error: string | null }>("/settings/telemetry/test", {
        method: "POST",
        json: { endpoint },
      }),
  },
  /** Cluster mode (Settings → Cluster): this server's role, its nodes and membership (admins change it). */
  cluster: {
    status: () => request<ClusterStatus>("/cluster"),
    /** Make this server the primary of a new cluster. */
    enable: () => request<ClusterStatus>("/cluster/enable", { method: "POST" }),
    /** Back to standalone (a primary drops its replicas, a replica keeps its copy of the data). */
    disable: () => request<ClusterStatus>("/cluster/disable", { method: "POST" }),
    /** Become a replica of the primary at `url`; this server's own data is replaced and it restarts. */
    join: (url: string, token: string) =>
      request<ClusterStatus>("/cluster/join", { method: "POST", json: { url, token } }),
    /** Replica → standalone, keeping the replicated data as its own. */
    leave: () => request<ClusterStatus>("/cluster/leave", { method: "POST" }),
    /**
     * Replica: reconnect to the primary now, or (`restart`) restart this node through its supervisor;
     * 409 when this is not a replica or (restart) it runs without bin/supervisor.mjs.
     */
    restore: (restart = false) =>
      request<ClusterStatus>("/cluster/restore", { method: "POST", json: { restart } }),
    /** Can this server reach and authenticate with the primary at `url`? */
    test: (url: string, token: string) =>
      request<ClusterTestResult>("/cluster/test", { method: "POST", json: { url, token } }),
    /** Primary: the join token and the command that joins a new machine. */
    token: () => request<ClusterJoinInfo>("/cluster/token"),
    /** Primary: a new join token (connected nodes stay in). */
    rotateToken: () => request<ClusterJoinInfo>("/cluster/token", { method: "POST" }),
    /** Primary: drop a replica from the cluster (it becomes standalone). */
    removeNode: (id: string) =>
      request<{ ok: true }>(`/cluster/nodes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },
  /** Telegram / Discord bots that control AgentMan from chat (Settings → Chat integrations). */
  chat: {
    status: () => request<ChatStatusResponse>("/chat/status"),
    /** Validate and store the bot token, then start the bot; 400 with the reason for a bad token. */
    connect: (platform: ChatPlatform, body: { token: string; webhookUrl?: string | null }) =>
      request<ChatPlatformStatus>(`/chat/${platform}/connect`, { method: "POST", json: body }),
    /** Stop the bot and forget its token (authorized chat users are kept). */
    disconnect: (platform: ChatPlatform) =>
      request<ChatPlatformStatus>(`/chat/${platform}/disconnect`, { method: "POST" }),
  },
  /** Scheduled cleanup of AgentMan data (Settings → Cleanup); schedule and targets save via `settings.update`. */
  cleanup: {
    status: () => request<CleanupStatus>("/settings/cleanup"),
    /** Clean up now (default: the saved targets); 409 while a cleanup is running. */
    run: (ids?: ScheduledCleanupId[]) =>
      request<CleanupStatus>("/settings/cleanup", { method: "POST", json: ids ? { ids } : {} }),
  },
  /** Settings → Data transfer: move every project, card, user, setting and shared file to another server. */
  dataTransfer: {
    status: () => request<DataTransferStatus>("/data-transfer"),
    /** Download URL of a fresh export (cookie-authenticated; the archive is built before the download starts). */
    exportUrl: `${BASE}/data-transfer/export`,
    backupUrl: (name: string) => `${BASE}/data-transfer/backups/${encodeURIComponent(name)}`,
    /** Replace all data on this server with an export; 409 while agents run, 400 for an invalid archive. */
    import: (archive: Blob) =>
      request<DataImportResult>("/data-transfer/import?confirm=replace", {
        method: "POST",
        body: archive,
        headers: { "content-type": "application/gzip" },
      }),
  },
  /** omp's user config.yml (Settings → OMP); changes apply to the next agent run. */
  ompConfig: {
    get: () => request<OmpConfigSnapshot>("/omp-config"),
    update: (update: OmpConfigUpdate) =>
      request<OmpConfigSnapshot>("/omp-config", { method: "PUT", json: update }),
    /** Chat models omp can use; `refresh` bypasses the server's 5 min cache. */
    models: (refresh = false) =>
      request<{ models: OmpModel[] }>(`/omp-config/models${refresh ? "?refresh=1" : ""}`),
    /** Every setting omp knows (Settings → OMP → All settings); cached 10 min, `refresh` re-lists. */
    settings: (refresh = false) =>
      request<{ settings: OmpSettingInfo[] }>(`/omp-config/settings${refresh ? "?refresh=1" : ""}`),
  },
  /** AI model provider keys omp children get (Settings → AI Providers); `refresh` re-reads omp's model list. */
  aiProviders: {
    list: (refresh = false) =>
      request<AiProvidersResponse>(`/settings/ai-providers${refresh ? "?refresh=1" : ""}`),
    /** Save/clear values; 400 `{ error, fields }` (keyed by env var) for invalid ones. */
    update: (update: AiProviderUpdate) =>
      request<AiProvidersResponse>("/settings/ai-providers", { method: "PATCH", json: update }),
    /** Probe typed values (empty ones fall back to the effective values); 400 when nothing to test. */
    test: (input: AiProviderTestInput) =>
      request<AiProviderTestResponse>("/settings/ai-providers/test", { method: "POST", json: input }),
    /** OAuth sign-in through `omp login` on the server; poll `oauthStatus` until it is no longer running. */
    oauthStart: (loginId: string) =>
      request<AiOAuthSession>("/settings/ai-providers/oauth", { method: "POST", json: { loginId } }),
    oauthStatus: (id: string) => request<AiOAuthSession>(`/settings/ai-providers/oauth/${encodeURIComponent(id)}`),
    /** Answer omp's pending question (pasted redirect URL or code, …); 409 when it is not asking. */
    oauthAnswer: (id: string, input: string) =>
      request<AiOAuthSession>(`/settings/ai-providers/oauth/${encodeURIComponent(id)}`, {
        method: "POST",
        json: { input },
      }),
    oauthCancel: (id: string) =>
      request<AiOAuthSession>(`/settings/ai-providers/oauth/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },
  /** Credentials for MCP servers and connector services (the /credentials page). */
  credentials: {
    list: () => request<CredentialsResponse>("/credentials"),
    /** `test`: run the health check before answering, so the new credential starts healthy/failing. */
    create: (input: CredentialInput, test = false) =>
      request<CredentialSummary>("/credentials", { method: "POST", json: { ...input, test } }),
    update: (id: string, update: CredentialUpdate, test = false) =>
      request<CredentialSummary>(`/credentials/${encodeURIComponent(id)}`, {
        method: "PATCH",
        json: { ...update, test },
      }),
    remove: (id: string) =>
      request<{ ok: true }>(`/credentials/${encodeURIComponent(id)}`, { method: "DELETE" }),
    /** Health-check a saved credential now; its stored status updates. */
    check: (id: string) =>
      request<{ credential: CredentialSummary; result: CredentialTestResult }>(
        `/credentials/${encodeURIComponent(id)}/test`,
        { method: "POST" },
      ),
    /** Test unsaved form values; with `id`, omitted secret fields fall back to that credential's stored ones. */
    test: (input: CredentialInput, id?: string) =>
      request<CredentialTestResult>("/credentials/test", { method: "POST", json: { ...input, id } }),
    /** Health-check every credential now. */
    checkAll: () => request<CredentialsResponse>("/credentials/check-all", { method: "POST" }),
    notifications: () => request<CredentialNotificationsResponse>("/credentials/notifications"),
    /** `ids` for read/dismiss; ignored by read-all/dismiss-all. */
    updateNotifications: (action: CredentialNotificationAction, ids?: string[]) =>
      request<CredentialNotificationsResponse>("/credentials/notifications", {
        method: "POST",
        json: { action, ids },
      }),
  },
  /** MCP servers connected to every agent through omp's mcp.json (the /mcp page). */
  mcp: {
    list: () => request<McpServersResponse>("/mcp"),
    /** Save or reuse a credential, write the server into mcp.json and (unless `test: false`) probe it. */
    connect: (input: McpConnectInput) =>
      request<McpConnectResult>("/mcp", { method: "POST", json: input }),
    update: (name: string, update: McpServerUpdate) =>
      request<McpServerSummary>(`/mcp/${encodeURIComponent(name)}`, { method: "PATCH", json: update }),
    /** Remove from mcp.json; `deleteCredential` also deletes its credential. */
    remove: (name: string, deleteCredential = false) =>
      request<{ ok: true }>(`/mcp/${encodeURIComponent(name)}${deleteCredential ? "?deleteCredential=1" : ""}`, {
        method: "DELETE",
      }),
    /** Health-check the credential and probe the MCP server (initialize + tools/list) now. */
    test: (name: string) =>
      request<McpServerSummary>(`/mcp/${encodeURIComponent(name)}/test`, { method: "POST" }),
    /** Rewrite every managed entry into mcp.json (repairs hand edits). */
    sync: () => request<McpServersResponse>("/mcp/sync", { method: "POST" }),
    /** One page of the mcpservers.org server list; `refresh` re-reads it instead of the 12 h cache. */
    directory: (query: { q?: string; featured?: boolean; offset?: number; limit?: number; refresh?: boolean } = {}) => {
      const params = new URLSearchParams();
      if (query.q) params.set("q", query.q);
      if (query.featured) params.set("featured", "1");
      if (query.offset) params.set("offset", String(query.offset));
      if (query.limit) params.set("limit", String(query.limit));
      if (query.refresh) params.set("refresh", "1");
      const search = params.toString();
      return request<McpDirectoryResponse>(`/mcp/directory${search ? `?${search}` : ""}`);
    },
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
      pushBranch?: string;
      defaultBranches?: Record<string, string>;
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
        pushBranch: string;
        defaultBranches: Record<string, string>;
        pinned: boolean;
      }>,
    ) => request<Board>(`/boards/${id}`, { method: "PATCH", json: patch }),
    remove: (id: string) => request<{ ok: true }>(`/boards/${id}`, { method: "DELETE" }),
    /** Record that the board was opened (stamps `lastAccessedAt`). */
    access: (id: string) => request<Board>(`/boards/${id}/access`, { method: "POST" }),
    tasks: (id: string) => request<Task[]>(`/boards/${id}/tasks`),
    /** Delete these cards of the board (ids elsewhere are skipped); resolves with the deleted ids. */
    deleteTasks: (id: string, ids: string[]) =>
      request<{ deleted: string[] }>(`/boards/${id}/tasks`, { method: "DELETE", json: { ids } }),
    /**
     * "@" mention candidates from the board's project folders; pass `signal` to drop stale queries.
     * A query ending in "/" (or "") lists that directory's children (the Files tree); `limit` ≤ 1000.
     */
    projectFiles: (boardId: string, query: string, init?: { signal?: AbortSignal; limit?: number }) =>
      request<{ files: ProjectFileHit[] }>(
        `/boards/${boardId}/project-files?q=${encodeURIComponent(query)}${init?.limit ? `&limit=${init.limit}` : ""}`,
        { signal: init?.signal },
      ),
    /** Text of one project file (`path` as in `ProjectFileHit.insert`); 413 over 2 MB, 415 for binary files. */
    readProjectFile: (boardId: string, path: string, init?: { signal?: AbortSignal }) =>
      request<ProjectFileContent>(`/boards/${boardId}/project-files/content?path=${encodeURIComponent(path)}`, {
        signal: init?.signal,
      }),
    /** Overwrite an existing project file; 409 when it changed on disk since `baseMtimeMs`. */
    writeProjectFile: (boardId: string, input: { path: string; content: string; baseMtimeMs: number }) =>
      request<ProjectFileContent>(`/boards/${boardId}/project-files/content`, { method: "PUT", json: input }),
    /** Create, rename/move, copy or delete a file or folder in the project folders (Files tree). */
    projectFileOp: (boardId: string, op: FileOp) =>
      request<FileOpResult>(`/boards/${boardId}/project-files/ops`, { method: "POST", json: op }),
  },
  /** Recurring cards (Schedulers tab). Cron is evaluated in the scheduler's IANA `timezone`. */
  schedulers: {
    /** All schedulers, newest first; `boardId` filters to one project. */
    list: (boardId?: string) =>
      request<Scheduler[]>(`/schedulers${boardId ? `?boardId=${encodeURIComponent(boardId)}` : ""}`),
    get: (id: string) => request<Scheduler>(`/schedulers/${id}`),
    /** `name` defaults to the prompt's first line; `timezone` to UTC; `enabled` to true; `maxRuns` to null. */
    create: (input: {
      boardId: string;
      prompt: string;
      cron: string;
      timezone?: string;
      name?: string;
      enabled?: boolean;
      maxRuns?: number | null;
    }) => request<Scheduler>("/schedulers", { method: "POST", json: input }),
    update: (
      id: string,
      patch: Partial<{
        boardId: string;
        name: string;
        prompt: string;
        cron: string;
        timezone: string;
        enabled: boolean;
        maxRuns: number | null;
      }>,
    ) => request<Scheduler>(`/schedulers/${id}`, { method: "PATCH", json: patch }),
    remove: (id: string) => request<{ ok: true }>(`/schedulers/${id}`, { method: "DELETE" }),
    /** Fire now (manual run, works while disabled): creates its card; 201 with the history row. */
    run: (id: string) => request<SchedulerRunView>(`/schedulers/${id}/run`, { method: "POST" }),
    /** Run history, newest first, with a live snapshot of each created card. */
    runs: (id: string) => request<SchedulerRunView[]>(`/schedulers/${id}/runs`),
    /** Aggregated log of the latest runs (scheduler lines + their cards' agent run events), oldest first. */
    logs: (id: string) => request<SchedulerLogEntry[]>(`/schedulers/${id}/logs`),
    /**
     * One "Create with Agent" turn: streams the assistant's progress to `onActivity`, then resolves
     * with its reply and the draft it proposed (null when none). Aborting `signal` cancels it.
     */
    chat: async (
      input: SchedulerChatRequest,
      onActivity: (text: string) => void,
      signal?: AbortSignal,
    ): Promise<{ reply: string; draft: SchedulerDraft | null }> => {
      const res = await send("/schedulers/chat", { method: "POST", json: input, signal });
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
            const event = JSON.parse(line) as SchedulerChatEvent;
            if (event.type === "activity") onActivity(event.text);
            else if (event.type === "done") return { reply: event.reply, draft: event.draft };
            else throw new ApiRequestError(event.error, 502);
          }
          if (done) throw new ApiRequestError("The connection closed before the assistant answered", 502);
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }
    },
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
    /** A card from free text, created in In progress with the text as typed and its agent started. */
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
    /**
     * Code review decision: approve (agent idle; moves the card to Done) or request changes
     * (`note` required; posted as feedback that steers or resumes the agent). `hash` is the
     * `TaskDiff.hash` the reviewer saw.
     */
    review: (
      id: string,
      input: { decision: "approve" | "request_changes"; note?: string | null; hash?: string | null },
    ) => request<TaskReviewResult>(`/tasks/${id}/review`, { method: "POST", json: input }),
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
  /** Git snapshots of a card's folders taken before each run (and before each restore). */
  checkpoints: {
    list: (taskId: string) => request<TaskCheckpointList>(`/tasks/${taskId}/checkpoints`),
    /** Roll `folder`'s files back to checkpoint `id` (refused while the card's agent runs). */
    restore: (taskId: string, input: { id: string; folder: string }) =>
      request<CheckpointRestoreResult>(`/tasks/${taskId}/checkpoints/restore`, { method: "POST", json: input }),
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
    ai: (refresh = false) => request<AiStatsResponse>(`/stats/ai${refresh ? "?refresh=1" : ""}`),
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
    /** Create the folder `name` inside the absolute server folder `parent`. */
    mkdir: (parent: string, name: string) =>
      request<FsEntry>("/fs/mkdir", { method: "POST", json: { parent, name } }),
    /**
     * Files page, folder scope: entries of the absolute folder `root`, like `boards.projectFiles`
     * ("" or a query ending in "/" lists a directory; ids are relative to `root`). `limit` ≤ 1000.
     */
    files: (root: string, query: string, init?: { signal?: AbortSignal; limit?: number }) =>
      request<{ files: ProjectFileHit[] }>(
        `/fs/files?root=${encodeURIComponent(root)}&q=${encodeURIComponent(query)}${init?.limit ? `&limit=${init.limit}` : ""}`,
        { signal: init?.signal },
      ),
    /** Text of one file under `root` (`path` relative to it); same limits as `boards.readProjectFile`. */
    readFile: (root: string, path: string, init?: { signal?: AbortSignal }) =>
      request<ProjectFileContent>(
        `/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
        { signal: init?.signal },
      ),
    /** Overwrite an existing file under `root`; 409 when it changed on disk since `baseMtimeMs`. */
    writeFile: (input: { root: string; path: string; content: string; baseMtimeMs: number }) =>
      request<ProjectFileContent>("/fs/file", { method: "PUT", json: input }),
    /** `boards.projectFileOp` for one folder: paths relative to `root`. */
    fileOp: (root: string, op: FileOp) =>
      request<FileOpResult>("/fs/ops", { method: "POST", json: { root, ...op } }),
  },
  git: {
    /** Clone a repository into WORKSPACE_DIR/<name>; returns the absolute folder path. */
    clone: (input: { url: string; name?: string; branch?: string }) =>
      request<{ path: string; output: string }>("/git/clone", { method: "POST", json: input }),
    /** Whether an absolute server folder is inside a git work tree. */
    isRepo: (path: string) =>
      request<{ path: string; isGitRepo: boolean }>(`/git/repo?path=${encodeURIComponent(path)}`),
    /** Run `git init` in an existing absolute server folder that isn't a repository yet. */
    init: (path: string) =>
      request<{ path: string; output: string }>("/git/init", { method: "POST", json: { path } }),
    /** One entry per project folder (workdir first). */
    status: (boardId: string) => request<GitStatus[]>(`/boards/${boardId}/git`),
    /** Local + origin-only branches of one project folder. */
    branches: (boardId: string, folder: string) =>
      request<GitBranches>(`/boards/${boardId}/git/branches?folder=${encodeURIComponent(folder)}`),
    /** Check out an existing branch in one project folder and pull it; returns its fresh status. */
    switchBranch: (boardId: string, input: { folder: string; branch: string }) =>
      request<GitSwitchResult>(`/boards/${boardId}/git/branches`, { method: "POST", json: input }),
    /** Header quick push: commit every project repo's changes and push to the project's push branch. */
    pushBoard: (boardId: string) =>
      request<BoardPushResult>(`/boards/${boardId}/git/push`, { method: "POST", json: {} }),
    /** Header quick discard: roll every project repo's working tree back to HEAD (uncommitted changes only). */
    discardBoard: (boardId: string) =>
      request<GitDiscardResult>(`/boards/${boardId}/git/discard`, { method: "POST", json: {} }),
    /** Commit the task's changes and push straight to the project's push branch (all changed folders). */
    push: (taskId: string, input: { message?: string; folders?: string[] } = {}) =>
      request<GitActionResult>(`/tasks/${taskId}/git/push`, { method: "POST", json: input }),
    /** Commit the task's changes and push to the branch each folder is already on (all changed folders). */
    pushCurrent: (taskId: string, input: { message?: string; folders?: string[] } = {}) =>
      request<GitActionResult>(`/tasks/${taskId}/git/push-current`, { method: "POST", json: input }),
    /** Discard the task's uncommitted changes in the folders it ships from (worktrees, else project folders). */
    discard: (taskId: string) =>
      request<GitDiscardResult>(`/tasks/${taskId}/git/discard`, { method: "POST", json: {} }),
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
  terminal: {
    /**
     * Attach to the persistent terminal session. Every (re)open starts with a fresh `snapshot`
     * from the server, so missed events never need a refetch.
     */
    subscribe: (
      onEvent: (event: TerminalStreamEvent) => void,
      opts: { onStatus?: (status: "live" | "reconnecting") => void } = {},
    ) =>
      subscribeSse("/terminal/stream", onEvent, {
        onStatus: opts.onStatus,
        staleAfterMs: TERMINAL_PING_INTERVAL_MS * 2.5,
      }),
    /** Start a command (default cwd: the session's); its output arrives through `subscribe`. */
    execute: (req: TerminalExecuteRequest) =>
      request<TerminalBlock>("/terminal/execute", { method: "POST", json: req }),
    /** Kill a running command's process group. */
    cancel: (id: string) => request<{ ok: true }>("/terminal/cancel", { method: "POST", json: { id } }),
    /** Remove finished blocks; running ones stay. */
    clear: () => request<{ ok: true }>("/terminal/session", { method: "DELETE" }),
  },
  /** Server, security, access, agent, database, restart and tunnel logs (the /logs page). */
  logs: {
    sources: () => request<LogSourcesResponse>("/logs"),
    /** One page of entries, newest first. */
    list: (source: LogSource, query: LogQuery = {}) =>
      request<LogPage>(`/logs/${encodeURIComponent(source)}${logQuery(query)}`),
    /**
     * Download URL of every matching entry, newest first (cookie-authenticated, so a plain link
     * works; the server answers with `content-disposition: attachment`). Pagination is dropped.
     */
    exportUrl: (source: LogSource, query: LogQuery, format: LogExportFormat) => {
      const filters: LogQuery = { ...query, limit: undefined, offset: undefined };
      return `${BASE}/logs/${encodeURIComponent(source)}/export${logQuery(filters, { format })}`;
    },
    /**
     * Record a client-side page view in the access log. Best effort: never throws, and skips `send`
     * so an expired session does not trigger a second login redirect from a background beacon.
     */
    pageView: async (path: string): Promise<void> => {
      try {
        await fetch(`${BASE}/logs/access`, {
          method: "POST",
          credentials: "same-origin",
          keepalive: true,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path }),
        });
      } catch {}
    },
  },
};

/** Server heartbeat cadence: app/api/v1/events/route.ts sends a named `ping` event this often. */
const EVENTS_PING_INTERVAL_MS = 20_000;
/** Silence after which a stream that still claims to be open is presumed dead (~2.5 pings). */
export const EVENTS_STALE_AFTER_MS = EVENTS_PING_INTERVAL_MS * 2.5;
/** Backoff bounds for reopening a stream the browser gave up on; reset on every open. */
export const EVENTS_REOPEN_MIN_MS = 1_000;
export const EVENTS_REOPEN_MAX_MS = 30_000;
/** A tab hidden longer than this resyncs on return (mobile browsers suspend background streams). */
export const EVENTS_RESUME_AFTER_MS = 5_000;

interface SseOptions {
  /**
   * Events may have been missed; refetch state here. Fires after a dropped connection reopens
   * (native retry, watchdog or manual reopen), and when the tab returns from the background or
   * the network comes back while the stream still looks open.
   */
  onReconnect?: () => void;
  /**
   * Fires once, when the first connection opens without a drop before it (else `onReconnect`
   * fires). A snapshot fetched in parallel with subscribing may predate the server-side
   * subscription, and events published in between are never sent, so refetch it here.
   */
  onFirstOpen?: () => void;
  /** "live" on every successful open (including the first); "reconnecting" on drop. */
  onStatus?: (status: "live" | "reconnecting") => void;
}

/**
 * Subscribe to live server events (SSE). Returns an unsubscribe function.
 *
 * EventSource alone loses updates in several ways, so this wraps it:
 * - it retries natively only while `readyState` is CONNECTING; once CLOSED (e.g. a 502 from a proxy
 *   while the server restarts) it never retries, so we reopen it ourselves with capped backoff;
 * - a half-open connection (sleep, network switch, proxy idle drop) never errors, so a watchdog
 *   reopens the stream when neither data nor the server's `ping` event arrived for a while;
 * - a backgrounded tab may be suspended, so returning to it (or the network coming back) reopens a
 *   dead stream right away or, when it still looks healthy, asks the caller to resync.
 */
export function subscribeEvents(
  onEvent: (event: ServerEvent) => void,
  opts: SseOptions & { boardId?: string } = {},
): () => void {
  const query = opts.boardId ? `?boardId=${encodeURIComponent(opts.boardId)}` : "";
  return subscribeSse(`/events${query}`, onEvent, opts);
}

/**
 * The robust EventSource wrapper behind `subscribeEvents` and `api.terminal.subscribe`: unnamed
 * frames are JSON events for `onEvent`; a named `ping` only feeds the watchdog, which reopens the
 * stream after `staleAfterMs` (~2.5 server pings) of silence.
 */
function subscribeSse<T>(
  path: string,
  onEvent: (event: T) => void,
  opts: SseOptions & { staleAfterMs?: number },
): () => void {
  const url = BASE + path;
  const staleAfterMs = opts.staleAfterMs ?? EVENTS_STALE_AFTER_MS;
  const doc = typeof document === "undefined" ? null : document;
  const win = typeof window === "undefined" ? null : window;

  let source: EventSource | null = null;
  let stopped = false;
  /** A connection opened before, so the next open is not the first. */
  let opened = false;
  /** The stream dropped (error or forced reopen) since the last open: the next open resyncs. */
  let dropped = false;
  let backoff = EVENTS_REOPEN_MIN_MS;
  let lastActivity = Date.now();
  let hiddenAt: number | null = doc?.visibilityState === "hidden" ? Date.now() : null;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let reopenTimer: ReturnType<typeof setTimeout> | undefined;

  /** Any frame (data or ping), open or connect attempt pushes the watchdog back. */
  const alive = () => {
    lastActivity = Date.now();
    clearTimeout(watchdog);
    watchdog = setTimeout(() => reopen(0), staleAfterMs);
  };

  const closeSource = () => {
    clearTimeout(watchdog);
    if (!source) return;
    source.onopen = null;
    source.onmessage = null;
    source.onerror = null;
    source.removeEventListener("ping", alive);
    source.close();
    source = null;
  };

  const connect = () => {
    reopenTimer = undefined;
    const es = new EventSource(url, { withCredentials: true });
    source = es;
    // Armed before `open` too: a connect attempt can hang without ever reaching onerror.
    alive();
    es.onmessage = (msg) => {
      alive();
      try {
        onEvent(JSON.parse(msg.data) as T);
      } catch {}
    };
    es.addEventListener("ping", alive);
    es.onopen = () => {
      alive();
      backoff = EVENTS_REOPEN_MIN_MS;
      opts.onStatus?.("live");
      const first = !opened;
      opened = true;
      if (dropped) {
        dropped = false;
        opts.onReconnect?.();
      } else if (first) {
        opts.onFirstOpen?.();
      }
    };
    es.onerror = () => {
      dropped = true;
      opts.onStatus?.("reconnecting");
      // CONNECTING: the browser retries on its own (the server sends `retry: 3000`).
      // CLOSED: it gave up for good, so retry ourselves.
      if (es.readyState === EventSource.CLOSED) {
        reopen(backoff);
        backoff = Math.min(backoff * 2, EVENTS_REOPEN_MAX_MS);
      }
    };
  };

  /** Drop the current connection (if any) and open a fresh one after `delay` ms. */
  const reopen = (delay: number) => {
    if (stopped) return;
    closeSource();
    dropped = true;
    opts.onStatus?.("reconnecting");
    clearTimeout(reopenTimer);
    if (delay > 0) reopenTimer = setTimeout(connect, delay);
    else connect();
  };

  /** The tab came back or the network returned: the stream may be dead or may have missed events. */
  const resync = () => {
    if (stopped) return;
    const state = source?.readyState ?? EventSource.CLOSED;
    if (state === EventSource.CLOSED || Date.now() - lastActivity > staleAfterMs) {
      // Waiting out a backoff, given up, or silent too long (timers were frozen): reconnect now.
      backoff = EVENTS_REOPEN_MIN_MS;
      reopen(0);
    } else if (state === EventSource.OPEN) {
      opts.onReconnect?.();
    }
    // CONNECTING: its `open` resyncs (onFirstOpen / onReconnect); the watchdog covers a hang.
  };

  const onVisibility = () => {
    if (doc?.visibilityState === "hidden") {
      hiddenAt ??= Date.now();
      return;
    }
    const hiddenFor = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (hiddenFor > EVENTS_RESUME_AFTER_MS || source?.readyState !== EventSource.OPEN) resync();
  };
  const onOnline = () => resync();

  connect();
  doc?.addEventListener("visibilitychange", onVisibility);
  win?.addEventListener("online", onOnline);

  return () => {
    stopped = true;
    closeSource();
    clearTimeout(reopenTimer);
    doc?.removeEventListener("visibilitychange", onVisibility);
    win?.removeEventListener("online", onOnline);
  };
}
