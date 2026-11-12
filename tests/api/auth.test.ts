import { createHmac } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_PASSWORD,
  api,
  call,
  freshEnv,
  restartServer,
  setupAdmin,
  teardown,
  useToken,
  type RouteModule,
} from "./helpers";

import * as loginRoute from "@/app/api/v1/auth/login/route";
import * as logoutRoute from "@/app/api/v1/auth/logout/route";
import * as passwordRoute from "@/app/api/v1/auth/password/route";
import * as setupRoute from "@/app/api/v1/auth/setup/route";
import * as statusRoute from "@/app/api/v1/auth/status/route";
import * as boardRoute from "@/app/api/v1/boards/[id]/route";
import * as boardGitRoute from "@/app/api/v1/boards/[id]/git/route";
import * as boardTasksRoute from "@/app/api/v1/boards/[id]/tasks/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import * as commentRoute from "@/app/api/v1/comments/[id]/route";
import * as eventsRoute from "@/app/api/v1/events/route";
import * as browseRoute from "@/app/api/v1/fs/browse/route";
import * as cloneRoute from "@/app/api/v1/git/clone/route";
import * as healthRoute from "@/app/api/v1/health/route";
import * as runEventsRoute from "@/app/api/v1/runs/[id]/events/route";
import * as settingsRoute from "@/app/api/v1/settings/route";
import * as statsAiRoute from "@/app/api/v1/stats/ai/route";
import * as statsSystemRoute from "@/app/api/v1/stats/system/route";
import * as systemRoute from "@/app/api/v1/system/route";
import * as taskCommentsRoute from "@/app/api/v1/tasks/[id]/comments/route";
import * as taskPrRoute from "@/app/api/v1/tasks/[id]/git/pr/route";
import * as taskPushRoute from "@/app/api/v1/tasks/[id]/git/push/route";
import * as taskRoute from "@/app/api/v1/tasks/[id]/route";
import * as taskRunRoute from "@/app/api/v1/tasks/[id]/run/route";
import * as taskRunsRoute from "@/app/api/v1/tasks/[id]/runs/route";
import * as taskStopRoute from "@/app/api/v1/tasks/[id]/stop/route";

interface Session {
  token: string;
  expiresAt: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function setCookieOf(headers: Headers): string {
  const value = headers.get("set-cookie");
  if (!value) throw new Error("response has no Set-Cookie header");
  return value;
}

/** Attribute names/values of a Set-Cookie header, lower-cased names. */
function cookieAttributes(setCookie: string): Map<string, string> {
  const [, ...attrs] = setCookie.split(";").map((p) => p.trim());
  return new Map(
    attrs.map((attr): [string, string] => {
      const eq = attr.indexOf("=");
      return eq === -1
        ? [attr.toLowerCase(), ""]
        : [attr.slice(0, eq).toLowerCase(), attr.slice(eq + 1)];
    }),
  );
}

async function status(options: { token?: string | null; cookie?: string } = {}) {
  return api<{ configured: boolean; authenticated: boolean }>(statusRoute, "GET", "/auth/status", {
    token: options.token ?? null,
    cookie: options.cookie,
  });
}

async function login(password: unknown, ip = "198.51.100.1") {
  return api<Session & { error?: string }>(loginRoute, "POST", "/auth/login", {
    body: { password },
    token: null,
    headers: { "x-forwarded-for": ip },
  });
}

async function listBoards(token: string | null) {
  return api(boardsRoute, "GET", "/boards", { token });
}

afterAll(teardown);

describe("auth setup and status", () => {
  beforeEach(async () => {
    await freshEnv();
  });

  it("reports not configured before setup and configured afterwards", async () => {
    expect((await status()).body).toEqual({ configured: false, authenticated: false });

    const token = await setupAdmin();

    expect((await status()).body).toEqual({ configured: true, authenticated: false });
    expect((await status({ token })).body).toEqual({ configured: true, authenticated: true });
  });

  it("rejects passwords shorter than 8 characters and non-string passwords", async () => {
    const short = await api(setupRoute, "POST", "/auth/setup", { body: { password: "1234567" }, token: null });
    expect(short.status).toBe(400);
    expect(short.body).toEqual({ error: "Password must be at least 8 characters" });

    const missing = await api(setupRoute, "POST", "/auth/setup", { body: {}, token: null });
    expect(missing.status).toBe(400);

    const notString = await api(setupRoute, "POST", "/auth/setup", {
      body: { password: 123456789 },
      token: null,
    });
    expect(notString.status).toBe(400);

    expect((await status()).body.configured).toBe(false);

    const exact = await api<Session>(setupRoute, "POST", "/auth/setup", {
      body: { password: "12345678" },
      token: null,
    });
    expect(exact.status).toBe(200);
  });

  it("rejects malformed JSON bodies with 400", async () => {
    const bad = await api(setupRoute, "POST", "/auth/setup", { rawBody: "{not json", token: null });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: "Invalid JSON body" });

    const array = await api(setupRoute, "POST", "/auth/setup", { rawBody: "[1,2]", token: null });
    expect(array.status).toBe(400);
    expect(array.body).toEqual({ error: "Expected a JSON object body" });
  });

  it("returns a 30-day token with an HttpOnly session cookie, and only works once", async () => {
    const before = Date.now();
    const res = await api<Session>(setupRoute, "POST", "/auth/setup", {
      body: { password: ADMIN_PASSWORD },
      token: null,
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.token.length).toBeGreaterThan(20);
    const expires = Date.parse(res.body.expiresAt);
    expect(expires - before).toBeGreaterThan(30 * DAY_MS - 60_000);
    expect(expires - before).toBeLessThan(30 * DAY_MS + 60_000);

    const cookie = setCookieOf(res.headers);
    expect(cookie.startsWith(`omp_ui_token=${encodeURIComponent(res.body.token)};`)).toBe(true);
    const attrs = cookieAttributes(cookie);
    expect(attrs.has("httponly")).toBe(true);
    expect(attrs.get("samesite")).toBe("Lax");
    expect(attrs.get("path")).toBe("/");
    expect(Number(attrs.get("max-age"))).toBeGreaterThan(30 * 24 * 3600 - 120);
    // Plain http: no Secure flag, or the browser would drop the cookie.
    expect(attrs.has("secure")).toBe(false);

    const again = await api(setupRoute, "POST", "/auth/setup", {
      body: { password: "another-password" },
      token: null,
    });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "Admin password is already configured" });

    // The original password still works; the second one was not stored.
    expect((await login(ADMIN_PASSWORD)).status).toBe(200);
    expect((await login("another-password")).status).toBe(401);
  });

  it("marks the cookie Secure behind an https proxy", async () => {
    const res = await call(setupRoute, "POST", "/auth/setup", {
      body: { password: ADMIN_PASSWORD },
      token: null,
      headers: { "x-forwarded-proto": "https" },
    });
    expect(res.status).toBe(200);
    expect(cookieAttributes(setCookieOf(res.headers)).has("secure")).toBe(true);
  });
});

describe("login and logout", () => {
  beforeEach(async () => {
    await freshEnv({ VINEXT_TRUST_PROXY: undefined, VINEXT_TRUSTED_HOSTS: undefined });
  });

  // Tests that need per-client buckets opt into proxy trust; never leak it to later suites.
  afterEach(() => {
    delete process.env.VINEXT_TRUST_PROXY;
    delete process.env.VINEXT_TRUSTED_HOSTS;
  });

  it("answers 409 before an admin password is set up", async () => {
    const res = await login(ADMIN_PASSWORD);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Admin password is not set up yet" });
  });

  it("issues a working token for the right password and 401 for a wrong one", async () => {
    await setupAdmin();
    useToken(null);

    const bad = await login("wrong-password");
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: "Invalid password" });
    expect(bad.headers.get("set-cookie")).toBeNull();

    expect((await login("")).status).toBe(401);
    expect((await login(undefined)).status).toBe(401);

    const ok = await login(ADMIN_PASSWORD);
    expect(ok.status).toBe(200);
    expect(setCookieOf(ok.headers)).toContain(`omp_ui_token=${encodeURIComponent(ok.body.token)}`);
    expect((await listBoards(ok.body.token)).status).toBe(200);
  });

  it("rate limits a client after 10 failed attempts with Retry-After, per client IP", async () => {
    process.env.VINEXT_TRUST_PROXY = "1";
    await setupAdmin();
    const ip = "203.0.113.7";
    for (let i = 0; i < 10; i++) {
      expect((await login(`wrong-${i}`, ip)).status).toBe(401);
    }

    const limited = await login("still-wrong", ip);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatch(/too many/i);
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(600);

    // Even the right password is refused while limited...
    expect((await login(ADMIN_PASSWORD, ip)).status).toBe(429);
    // ...but other clients are unaffected.
    expect((await login(ADMIN_PASSWORD, "203.0.113.8")).status).toBe(200);
  });

  it("separates clients by the proxy-appended X-Forwarded-For entry behind a trusted proxy", async () => {
    process.env.VINEXT_TRUSTED_HOSTS = "omp.example.com";
    await setupAdmin();
    // The client-supplied left-most XFF entry varies, the proxy-appended right-most one doesn't.
    for (let i = 0; i < 10; i++) {
      expect((await login(`wrong-${i}`, `10.0.0.${i}, 203.0.113.30`)).status).toBe(401);
    }
    expect((await login(ADMIN_PASSWORD, "10.0.0.99, 203.0.113.30")).status).toBe(429);
    expect((await login(ADMIN_PASSWORD, "203.0.113.31")).status).toBe(200);
  });

  it("ignores forwarding headers without a trusted proxy, so spoofing them can't bypass the limit", async () => {
    await setupAdmin();
    for (let i = 0; i < 10; i++) {
      expect((await login(`wrong-${i}`, `198.51.100.${i}`)).status).toBe(401);
    }
    expect((await login(ADMIN_PASSWORD, "198.51.100.200")).status).toBe(429);
    const realIp = await api(loginRoute, "POST", "/auth/login", {
      body: { password: ADMIN_PASSWORD },
      token: null,
      headers: { "x-real-ip": "192.0.2.50" },
    });
    expect(realIp.status).toBe(429);
  });

  it("clears the failure count after a successful login", async () => {
    process.env.VINEXT_TRUST_PROXY = "1";
    await setupAdmin();
    const ip = "203.0.113.20";
    for (let i = 0; i < 9; i++) expect((await login(`wrong-${i}`, ip)).status).toBe(401);
    expect((await login(ADMIN_PASSWORD, ip)).status).toBe(200);
    for (let i = 0; i < 9; i++) expect((await login(`wrong-again-${i}`, ip)).status).toBe(401);
    expect((await login(ADMIN_PASSWORD, ip)).status).toBe(200);
  });

  it("accepts the token as a Bearer header or as the session cookie", async () => {
    const token = await setupAdmin();
    useToken(null);

    expect((await listBoards(token)).status).toBe(200);
    expect((await api(boardsRoute, "GET", "/boards", { token: null, headers: { authorization: `bearer ${token}` } })).status).toBe(200);
    const viaCookie = await api(boardsRoute, "GET", "/boards", {
      token: null,
      cookie: `theme=dark; omp_ui_token=${encodeURIComponent(token)}; other=1`,
    });
    expect(viaCookie.status).toBe(200);
    expect((await status({ cookie: `omp_ui_token=${encodeURIComponent(token)}` })).body.authenticated).toBe(true);

    expect((await api(boardsRoute, "GET", "/boards", { token: null, cookie: "omp_ui_token=" })).status).toBe(401);
    expect((await api(boardsRoute, "GET", "/boards", { token: null, cookie: "other_cookie=" + token })).status).toBe(401);
  });

  it("logout answers ok and expires the session cookie", async () => {
    const token = await setupAdmin();
    const res = await api(logoutRoute, "POST", "/auth/logout", {
      token: null,
      cookie: `omp_ui_token=${encodeURIComponent(token)}`,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const cookie = setCookieOf(res.headers);
    expect(cookie.startsWith("omp_ui_token=;")).toBe(true);
    const attrs = cookieAttributes(cookie);
    expect(attrs.get("max-age")).toBe("0");
    expect(Date.parse(attrs.get("expires") ?? "")).toBe(0);
    expect(attrs.get("path")).toBe("/");
    expect(attrs.has("httponly")).toBe(true);
  });
});

describe("change password", () => {
  beforeEach(async () => {
    await freshEnv();
  });

  it("requires authentication", async () => {
    await setupAdmin();
    const res = await api(passwordRoute, "POST", "/auth/password", {
      body: { current: ADMIN_PASSWORD, next: "brand-new-password" },
      token: null,
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("rejects a wrong current password (403) and a short new one (400) without changing anything", async () => {
    const token = await setupAdmin();
    const wrong = await api(passwordRoute, "POST", "/auth/password", {
      body: { current: "not-the-password", next: "brand-new-password" },
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toEqual({ error: "Current password is incorrect" });

    const short = await api(passwordRoute, "POST", "/auth/password", {
      body: { current: ADMIN_PASSWORD, next: "short" },
    });
    expect(short.status).toBe(400);
    expect(short.body).toEqual({ error: "New password must be at least 8 characters" });

    expect((await listBoards(token)).status).toBe(200);
    expect((await login(ADMIN_PASSWORD)).status).toBe(200);
  });

  it("rotates the password and revokes every older token", async () => {
    const original = await setupAdmin();
    const other = (await login(ADMIN_PASSWORD)).body.token;

    const res = await api<Session>(passwordRoute, "POST", "/auth/password", {
      body: { current: ADMIN_PASSWORD, next: "brand-new-password" },
      token: original,
    });
    expect(res.status).toBe(200);
    expect(setCookieOf(res.headers)).toContain(`omp_ui_token=${encodeURIComponent(res.body.token)}`);

    expect((await listBoards(original)).status).toBe(401);
    expect((await listBoards(other)).status).toBe(401);
    expect((await listBoards(res.body.token)).status).toBe(200);

    expect((await login(ADMIN_PASSWORD)).status).toBe(401);
    expect((await login("brand-new-password")).status).toBe(200);
  });
});

describe("ADMIN_PASSWORD at boot", () => {
  it("configures the password from the environment and overwrites it on a later boot", async () => {
    await freshEnv({ ADMIN_PASSWORD: "env-password-one" });

    expect((await status()).body.configured).toBe(true);
    const setup = await api(setupRoute, "POST", "/auth/setup", { body: { password: "whatever-else" }, token: null });
    expect(setup.status).toBe(409);
    const first = await login("env-password-one");
    expect(first.status).toBe(200);

    // Same env password on the next boot: nothing changes, tokens stay valid.
    await restartServer();
    expect((await listBoards(first.body.token)).status).toBe(200);

    // A different env password replaces the stored one and revokes older tokens.
    await restartServer({ ADMIN_PASSWORD: "env-password-two" });
    expect((await login("env-password-one")).status).toBe(401);
    const second = await login("env-password-two");
    expect(second.status).toBe(200);
    expect((await listBoards(first.body.token)).status).toBe(401);
    expect((await listBoards(second.body.token)).status).toBe(200);
  });

  it("overwrites a password that was set through the API", async () => {
    await freshEnv();
    await setupAdmin("api-password-1");
    await restartServer({ ADMIN_PASSWORD: "env-password-9" });
    expect((await login("api-password-1")).status).toBe(401);
    expect((await login("env-password-9")).status).toBe(200);
  });
});

describe("token validation", () => {
  const SECRET = "test-auth-secret-0123456789abcdef";

  function forge(payload: Record<string, unknown>, secret = SECRET, version = "v1"): string {
    const body = `${version}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const signature = createHmac("sha256", secret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  function payloadOf(token: string): { exp: number; epoch: number; iat: number } {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  }

  it("rejects tampered, foreign, expired and revoked-epoch tokens", async () => {
    await freshEnv({ AUTH_SECRET: SECRET });
    const token = await setupAdmin();
    useToken(null);
    const payload = payloadOf(token);

    // Control: a token built the documented way (HMAC-SHA256 with the server secret) is accepted.
    expect((await listBoards(forge({ ...payload, iat: payload.iat + 1 }))).status).toBe(200);

    const expired = forge({ ...payload, exp: Date.now() - 1000 });
    expect((await listBoards(expired)).status).toBe(401);

    const wrongEpoch = forge({ ...payload, epoch: payload.epoch + 1 });
    expect((await listBoards(wrongEpoch)).status).toBe(401);

    expect((await listBoards(forge(payload, "some-other-secret"))).status).toBe(401);
    expect((await listBoards(forge(payload, SECRET, "v2"))).status).toBe(401);

    // Payload edited, original signature kept.
    const [version, , signature] = token.split(".");
    const extended = Buffer.from(JSON.stringify({ ...payload, exp: payload.exp + DAY_MS })).toString("base64url");
    expect((await listBoards(`${version}.${extended}.${signature}`)).status).toBe(401);

    // Signature corrupted.
    const flipped = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    expect((await listBoards(`${version}.${token.split(".")[1]}.${flipped}`)).status).toBe(401);

    expect((await listBoards("garbage")).status).toBe(401);
    expect((await listBoards(`${token}.extra`)).status).toBe(401);
  });
});

describe("protected endpoints", () => {
  const id = "00000000-0000-0000-0000-000000000000";
  const protectedCalls: [string, RouteModule, "GET" | "POST" | "PATCH" | "DELETE", string, Record<string, string>?][] = [
    ["GET /boards", boardsRoute, "GET", "/boards"],
    ["POST /boards", boardsRoute, "POST", "/boards"],
    ["GET /boards/:id", boardRoute, "GET", `/boards/${id}`, { id }],
    ["PATCH /boards/:id", boardRoute, "PATCH", `/boards/${id}`, { id }],
    ["DELETE /boards/:id", boardRoute, "DELETE", `/boards/${id}`, { id }],
    ["GET /boards/:id/tasks", boardTasksRoute, "GET", `/boards/${id}/tasks`, { id }],
    ["POST /boards/:id/tasks", boardTasksRoute, "POST", `/boards/${id}/tasks`, { id }],
    ["GET /boards/:id/git", boardGitRoute, "GET", `/boards/${id}/git`, { id }],
    ["GET /tasks/:id", taskRoute, "GET", `/tasks/${id}`, { id }],
    ["PATCH /tasks/:id", taskRoute, "PATCH", `/tasks/${id}`, { id }],
    ["DELETE /tasks/:id", taskRoute, "DELETE", `/tasks/${id}`, { id }],
    ["POST /tasks/:id/run", taskRunRoute, "POST", `/tasks/${id}/run`, { id }],
    ["POST /tasks/:id/stop", taskStopRoute, "POST", `/tasks/${id}/stop`, { id }],
    ["GET /tasks/:id/comments", taskCommentsRoute, "GET", `/tasks/${id}/comments`, { id }],
    ["POST /tasks/:id/comments", taskCommentsRoute, "POST", `/tasks/${id}/comments`, { id }],
    ["PATCH /comments/:id", commentRoute, "PATCH", `/comments/${id}`, { id }],
    ["DELETE /comments/:id", commentRoute, "DELETE", `/comments/${id}`, { id }],
    ["GET /tasks/:id/runs", taskRunsRoute, "GET", `/tasks/${id}/runs`, { id }],
    ["GET /runs/:id/events", runEventsRoute, "GET", `/runs/${id}/events`, { id }],
    ["POST /tasks/:id/git/push", taskPushRoute, "POST", `/tasks/${id}/git/push`, { id }],
    ["POST /tasks/:id/git/pr", taskPrRoute, "POST", `/tasks/${id}/git/pr`, { id }],
    ["GET /fs/browse", browseRoute, "GET", "/fs/browse"],
    ["POST /git/clone", cloneRoute, "POST", "/git/clone"],
    ["GET /system", systemRoute, "GET", "/system"],
    ["GET /settings", settingsRoute, "GET", "/settings"],
    ["PATCH /settings", settingsRoute, "PATCH", "/settings"],
    ["GET /stats/system", statsSystemRoute, "GET", "/stats/system"],
    ["GET /stats/ai", statsAiRoute, "GET", "/stats/ai"],
    ["GET /events", eventsRoute, "GET", "/events"],
    ["POST /auth/password", passwordRoute, "POST", "/auth/password"],
  ];

  it.each(protectedCalls)("%s answers 401 JSON without a token", async (_name, mod, method, routePath, params) => {
    await freshEnv();
    await setupAdmin();
    const res = await call(mod, method, routePath, { token: null, params });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("also answers 401 before any password is configured", async () => {
    await freshEnv();
    expect((await listBoards(null)).status).toBe(401);
  });

  it("leaves /health, /auth/status, /auth/login, /auth/setup and /auth/logout open", async () => {
    await freshEnv();
    expect((await api(healthRoute, "GET", "/health", { token: null })).status).toBe(200);
    expect((await status()).status).toBe(200);
    expect((await api(logoutRoute, "POST", "/auth/logout", { token: null })).status).toBe(200);
    expect((await login(ADMIN_PASSWORD)).status).toBe(409);
    await setupAdmin();
    expect((await login(ADMIN_PASSWORD)).status).toBe(200);
  });
});
