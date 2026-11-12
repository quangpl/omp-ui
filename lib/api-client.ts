"use client";

import type {
  AppSettings,
  Board,
  BoardWithCounts,
  Comment,
  AiStats,
  Dashboard,
  FsBrowseResult,
  GitActionResult,
  GitBranches,
  GitStatus,
  QueueSnapshot,
  Run,
  RunEvent,
  ServerEvent,
  SystemStats,
  SharedFiles,
  Task,
  TaskStatus,
  TaskWorkspace,
} from "@/lib/types";

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

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
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
  return (await res.json()) as T;
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
  /** Home dashboard aggregate: projects, totals, cards needing attention, recent results, queue. */
  dashboard: () => request<Dashboard>("/dashboard"),
  settings: {
    get: () => request<AppSettings>("/settings"),
    update: (patch: Partial<AppSettings>) =>
      request<AppSettings>("/settings", { method: "PATCH", json: patch }),
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
    get: (id: string) => request<TaskDetail>(`/tasks/${id}`),
    update: (
      id: string,
      patch: Partial<{
        title: string;
        description: string;
        status: TaskStatus;
        position: number;
        blockedBy: string[];
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
    /** Commit the task's changes and push straight to the default branch (all changed folders). */
    push: (taskId: string, input: { message?: string; folders?: string[] } = {}) =>
      request<GitActionResult>(`/tasks/${taskId}/git/push`, { method: "POST", json: input }),
    /** Commit to a new branch, push, and open a PR (GitHub) / MR (GitLab). */
    pr: (taskId: string, input: { title?: string; body?: string; folders?: string[] } = {}) =>
      request<GitActionResult>(`/tasks/${taskId}/git/pr`, { method: "POST", json: input }),
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
