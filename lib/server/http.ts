// Shared helpers for `app/api/v1/**/route.ts` handlers (Node runtime).
import { getAgentManager } from "@/lib/agent/manager";
import type { AgentManager } from "@/lib/agent/types";
import { ensureAuthBoot, isAuthenticated, issueToken, sessionCookie } from "@/lib/auth";
import { getRepo } from "@/lib/db";
import type { Repository } from "@/lib/db/types";

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

/**
 * Wrap a route handler: boots the repo, auth (ADMIN_PASSWORD) and agent manager, enforces
 * authentication unless `auth: false`, awaits route params, and maps thrown errors to JSON.
 */
export function withApi<P extends Record<string, string | string[]> = Record<string, never>>(
  handler: ApiHandler<P>,
  options: { auth?: boolean } = {},
): (req: Request, context?: { params?: Promise<P> }) => Promise<Response> {
  const requireAuth = options.auth ?? true;
  return async (req, context) => {
    try {
      const repo = await getRepo();
      await ensureAuthBoot();
      const manager = await getAgentManager();
      if (requireAuth && !(await isAuthenticated(req))) {
        return error(401, "Unauthorized");
      }
      const params = ((await context?.params) ?? {}) as P;
      return await handler({ req, repo, manager, params });
    } catch (err) {
      if (err instanceof HttpError) return error(err.status, err.message);
      console.error(`[api] ${req.method} ${new URL(req.url).pathname} failed:`, err);
      return error(500, err instanceof Error && err.message ? err.message : "Internal server error");
    }
  };
}
