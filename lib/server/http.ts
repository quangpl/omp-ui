// Shared helpers for `app/api/v1/**/route.ts` handlers (Node runtime).
import { getAgentManager } from "@/lib/agent/manager";
import type { AgentManager } from "@/lib/agent/types";
import { clientIp, ensureAuthBoot, getRequestToken, isAuthenticated, issueToken, sessionCookie } from "@/lib/auth";
import { getRepo } from "@/lib/db";
import type { Repository } from "@/lib/db/types";
import type { LogLevel, StoredLogEvent } from "@/lib/log-types";
import { logEvent } from "@/lib/server/log-store";

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

/** Issue a new token and answer `{ token, expiresAt }` with the session cookie set (web). */
export async function sessionResponse(req: Request): Promise<Response> {
  const { token, expiresAt } = await issueToken();
  return json({ token, expiresAt }, { headers: { "set-cookie": sessionCookie(token, expiresAt, req) } });
}

export interface ApiContext<P> {
  req: Request;
  repo: Repository;
  manager: AgentManager;
  params: P;
}

type ApiHandler<P> = (ctx: ApiContext<P>) => Response | Promise<Response>;

/** Record a security-log event for this request (adds the client `ip`). Never throws or blocks. */
export function securityEvent(
  req: Request,
  level: LogLevel,
  category: string,
  message: string,
  meta: StoredLogEvent["meta"] = {},
): void {
  void logEvent("security", { level, category, message, meta: { ...meta, ip: clientIp(req) } });
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
    meta: { method, path: pathname, status, durationMs, ip: clientIp(req) },
  });
}

/**
 * Wrap a route handler: boots the repo, auth (ADMIN_PASSWORD) and agent manager, enforces
 * authentication unless `auth: false`, awaits route params, and maps thrown errors to JSON.
 * Every request is recorded in the access log, unauthorized ones in the security log.
 */
export function withApi<P extends Record<string, string | string[]> = Record<string, never>>(
  handler: ApiHandler<P>,
  options: { auth?: boolean } = {},
): (req: Request, context?: { params?: Promise<P> }) => Promise<Response> {
  const requireAuth = options.auth ?? true;
  return async (req, context) => {
    const startedAt = Date.now();
    const pathname = new URL(req.url).pathname;
    let response: Response;
    try {
      const repo = await getRepo();
      await ensureAuthBoot();
      const manager = await getAgentManager();
      if (requireAuth && !(await isAuthenticated(req))) {
        recordUnauthorized(req, pathname);
        response = error(401, "Unauthorized");
      } else {
        const params = ((await context?.params) ?? {}) as P;
        response = await handler({ req, repo, manager, params });
      }
    } catch (err) {
      if (err instanceof HttpError) {
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
