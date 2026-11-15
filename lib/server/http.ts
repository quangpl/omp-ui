// Shared helpers for `app/api/v1/**/route.ts` handlers (Node runtime).
import { getAgentManager } from "@/lib/agent/manager";
import type { AgentManager } from "@/lib/agent/types";
import { clientIp, ensureAuthBoot, getRequestToken, getRequestUser, issueToken, sessionCookie } from "@/lib/auth";
import { clusterRole, readNodeState } from "@/lib/cluster/node";
import { getRepo } from "@/lib/db";
import { ScopeError, scopeRepo } from "@/lib/db/scoped";
import type { Repository } from "@/lib/db/types";
import type { LogLevel, StoredLogEvent } from "@/lib/log-types";
import { logEvent } from "@/lib/server/log-store";
import type { User } from "@/lib/types";

/** Throw from a handler (or helper) to answer with `{ error: message }` and the given status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function error(status: number, message: string): Response {
  return json({ error: message }, { status });
}

/** Parse a JSON object body. Empty body → `{}`; malformed JSON or a non-object → 400. */
export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text.trim()) return {} as T;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpError(400, "Expected a JSON object body");
  }
  return data as T;
}

/** Signed-in user per request (set by withApi and sessionResponse) so log entries name the user. */
const requestUsers = new WeakMap<Request, User>();

/** `{ user, userId }` log meta for the request's signed-in user; empty when anonymous. */
function userMeta(req: Request): Record<string, string> {
  const user = requestUsers.get(req);
  return user ? { user: user.username, userId: user.id } : {};
}

/** Issue a new token for `user` and answer `{ token, expiresAt, user }` with the session cookie set (web). */
export async function sessionResponse(req: Request, user: User): Promise<Response> {
  const { token, expiresAt } = await issueToken(user.id);
  requestUsers.set(req, user);
  return json({ token, expiresAt, user }, { headers: { "set-cookie": sessionCookie(token, expiresAt, req) } });
}

/** Throw 403 unless `user` is an admin (for checks finer than a whole route's `{ admin: true }`). */
export function requireAdmin(user: User): void {
  if (user.role !== "admin") throw new HttpError(403, "Admin only");
}

/**
 * `user` is the signed-in user: always set on authenticated routes, null on `auth: false` routes
 * without a valid token. `repo` is scoped to `user` on authenticated routes (lib/db/scoped.ts) and the
 * unscoped base repository on `auth: false` routes.
 */
export interface ApiContext<P, U = User> {
  req: Request;
  repo: Repository;
  manager: AgentManager;
  params: P;
  user: U;
}

type ApiHandler<P, U> = (ctx: ApiContext<P, U>) => Response | Promise<Response>;
type RouteHandler<P> = (req: Request, context?: { params?: Promise<P> }) => Promise<Response>;

/**
 * Record a security-log event for this request (adds the client `ip`, and `user`/`userId` once the
 * request is authenticated). Never throws or blocks.
 */
export function securityEvent(
  req: Request,
  level: LogLevel,
  category: string,
  message: string,
  meta: StoredLogEvent["meta"] = {},
): void {
  void logEvent("security", { level, category, message, meta: { ...userMeta(req), ...meta, ip: clientIp(req) } });
}

/**
 * Run a mutating route body and record a "warn" security event `<failure>: <reason>` when it fails
 * with a 4xx: a thrown HttpError (rethrown for withApi) or a returned error response such as
 * withFieldErrors' 400 (only the invalid field keys are logged, never values). Success events are
 * the caller's, since it knows what changed; 5xx failures show up in the access log.
 */
export async function auditFailures(
  req: Request,
  category: string,
  failure: string,
  run: () => Promise<Response>,
): Promise<Response> {
  let response: Response;
  try {
    response = await run();
  } catch (err) {
    if (err instanceof HttpError && err.status < 500) {
      securityEvent(req, "warn", category, `${failure}: ${err.message}`, { status: err.status });
    }
    throw err;
  }
  if (response.status >= 400 && response.status < 500) {
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    const record: object = body && typeof body === "object" ? body : {};
    const reason =
      "error" in record && typeof record.error === "string" ? record.error : `HTTP ${response.status}`;
    const fields =
      "fields" in record && record.fields && typeof record.fields === "object"
        ? Object.keys(record.fields).join(",")
        : "";
    securityEvent(req, "warn", category, `${failure}: ${reason}`, {
      status: response.status,
      ...(fields ? { fields } : {}),
    });
  }
  return response;
}

/** One "Unauthorized request" security entry per ip + method + path in this window. */
const UNAUTHORIZED_LOG_WINDOW_MS = 60_000;
/** Bound on remembered keys (a scan of many paths must not grow memory without limit). */
const UNAUTHORIZED_LOG_MAX_KEYS = 1000;

// key → time logged; insertion order is chronological. On globalThis to survive dev HMR reloads.
const g = globalThis as unknown as { __ompUiUnauthorizedLogged?: Map<string, number> };
const unauthorizedLogged: Map<string, number> = (g.__ompUiUnauthorizedLogged ??= new Map());

function recordUnauthorized(req: Request, pathname: string): void {
  const now = Date.now();
  for (const [key, at] of unauthorizedLogged) {
    if (now - at < UNAUTHORIZED_LOG_WINDOW_MS && unauthorizedLogged.size <= UNAUTHORIZED_LOG_MAX_KEYS) break;
    unauthorizedLogged.delete(key);
  }
  const ip = clientIp(req);
  const key = `${ip} ${req.method} ${pathname}`;
  if (unauthorizedLogged.has(key)) return;
  unauthorizedLogged.set(key, now);
  void logEvent("security", {
    level: "warn",
    category: "auth",
    message: `Unauthorized request: ${req.method} ${pathname}`,
    meta: {
      ip,
      method: req.method,
      path: pathname,
      reason: getRequestToken(req) ? "invalid or expired token" : "no token",
    },
  });
}

/**
 * Access-log entry for an API request: method, path (never the query string, which may carry
 * secrets), status and duration. The Logs page's own polling (GET /api/v1/logs/**) and its
 * page-view beacon (POST /api/v1/logs/access, which logs the page view itself) are skipped.
 */
function recordAccess(req: Request, pathname: string, status: number, durationMs: number): void {
  const method = req.method;
  if (method === "GET" && (pathname === "/api/v1/logs" || pathname.startsWith("/api/v1/logs/"))) return;
  if (method === "POST" && pathname === "/api/v1/logs/access") return;
  void logEvent("access", {
    level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
    category: "api",
    message: `${method} ${pathname} ${status}`,
    meta: { method, path: pathname, status, durationMs, ...userMeta(req), ip: clientIp(req) },
  });
}

/** Methods a replica serves itself: reads never change the replicated state. */
const REPLICA_READ_METHODS = ["GET", "HEAD", "OPTIONS"];
/**
 * Writes a replica still accepts: signing in/out and managing its own cluster membership. Never
 * setup or password changes: the replicated user table would undo them (and a freshly joined node's
 * empty database must not let anyone create an admin).
 */
const REPLICA_WRITE_PATHS = ["/api/v1/auth/login", "/api/v1/auth/logout"];
const REPLICA_WRITE_PREFIX = "/api/v1/cluster/";

/**
 * A replica keeps a read-only copy of the primary's state (replication overwrites it), so changes
 * are refused with 409 and a pointer to the primary.
 */
function assertWritable(req: Request, pathname: string): void {
  if (REPLICA_READ_METHODS.includes(req.method) || clusterRole() !== "replica") return;
  if (REPLICA_WRITE_PATHS.includes(pathname) || pathname.startsWith(REPLICA_WRITE_PREFIX)) return;
  const primary = readNodeState().primary;
  const where = primary ? `${primary.name} (${primary.httpUrl})` : "the cluster's primary";
  throw new HttpError(409, `This node is a replica of ${where}; make changes there.`);
}

/**
 * Wrap a route handler: boots the repo, auth (ADMIN_PASSWORD) and agent manager, enforces
 * authentication unless `auth: false` (and the admin role with `admin: true`), awaits route params,
 * and maps thrown errors to JSON (`ScopeError` → 404). Authenticated handlers get the signed-in
 * `user` and a repository scoped to them. Every request is recorded in the access log, unauthorized
 * and forbidden ones in the security log.
 */
export function withApi<P extends Record<string, string | string[]> = Record<string, never>>(
  handler: ApiHandler<P, User>,
  options?: { auth?: true; admin?: boolean },
): RouteHandler<P>;
export function withApi<P extends Record<string, string | string[]> = Record<string, never>>(
  handler: ApiHandler<P, User | null>,
  options: { auth: false },
): RouteHandler<P>;
export function withApi<P extends Record<string, string | string[]> = Record<string, never>>(
  handler: ApiHandler<P, User> | ApiHandler<P, User | null>,
  options: { auth?: boolean; admin?: boolean } = {},
): RouteHandler<P> {
  const requireAuth = options.auth ?? true;
  const adminOnly = requireAuth && options.admin === true;
  // The overloads pair `auth: false` with nullable-user handlers; authenticated routes never see null.
  const run = handler as ApiHandler<P, User | null>;
  return async (req, context) => {
    const startedAt = Date.now();
    const pathname = new URL(req.url).pathname;
    let response: Response;
    try {
      const baseRepo = await getRepo();
      await ensureAuthBoot();
      const manager = await getAgentManager();
      const user = await getRequestUser(req);
      if (user) requestUsers.set(req, user);
      if (requireAuth && !user) {
        recordUnauthorized(req, pathname);
        response = error(401, "Unauthorized");
      } else if (adminOnly && user?.role !== "admin") {
        securityEvent(req, "warn", "auth", `Forbidden (admin only): ${req.method} ${pathname}`, {
          method: req.method,
          path: pathname,
        });
        response = error(403, "Admin only");
      } else {
        assertWritable(req, pathname);
        const params = ((await context?.params) ?? {}) as P;
        const repo = requireAuth && user ? scopeRepo(baseRepo, user) : baseRepo;
        response = await run({ req, repo, manager, params, user });
      }
    } catch (err) {
      if (err instanceof HttpError || err instanceof ScopeError) {
        response = error(err.status, err.message);
      } else {
        console.error(`[api] ${req.method} ${pathname} failed:`, err);
        response = error(500, err instanceof Error && err.message ? err.message : "Internal server error");
      }
    }
    recordAccess(req, pathname, response.status, Date.now() - startedAt);
    return response;
  };
}
