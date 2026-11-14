import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_PASSWORD,
  api,
  call,
  createUser,
  env,
  freshEnv,
  loginAs,
  restartServer,
  setupAdmin,
  teardown,
  tempDir,
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
import * as mkdirRoute from "@/app/api/v1/fs/mkdir/route";
import * as cloneRoute from "@/app/api/v1/git/clone/route";
import * as initRoute from "@/app/api/v1/git/init/route";
import * as repoRoute from "@/app/api/v1/git/repo/route";
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
import * as userPasswordRoute from "@/app/api/v1/users/[id]/password/route";
import * as userRoute from "@/app/api/v1/users/[id]/route";
import * as usersRoute from "@/app/api/v1/users/route";
import { hashPassword } from "@/lib/auth";
import { getRepo } from "@/lib/db";
import type { StoredLogEvent } from "@/lib/log-types";
import { eventLogPath, flushLogEvents } from "@/lib/server/log-store";
import type { AuthStatus, Board, User } from "@/lib/types";

interface Session {
  token: string;
  expiresAt: string;
  user: User;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Every field of a public `User`: secrets (password hash, token epoch) never leave the server. */
const USER_KEYS = ["createdAt", "email", "id", "isActive", "role", "updatedAt", "username"];

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
  return api<AuthStatus>(statusRoute, "GET", "/auth/status", {
    token: options.token ?? null,
    cookie: options.cookie,
  });
}

/** POST /auth/login; `username` omitted = password-only body (signs in `admin`). */
async function login(password: unknown, ip = "198.51.100.1", username?: unknown) {
  return api<Session & { error?: string }>(loginRoute, "POST", "/auth/login", {
    body: username === undefined ? { password } : { username, password },
    token: null,
    headers: { "x-forwarded-for": ip },
  });
}

async function listBoards(token: string | null) {
  return api<Board[]>(boardsRoute, "GET", "/boards", { token });
}

async function patchUser(id: string, body: Record<string, unknown>) {
  return api<User & { error?: string }>(userRoute, "PATCH", `/users/${id}`, { body, params: { id } });
}

afterAll(teardown);

describe("auth setup and status", () => {
  beforeEach(async () => {
    await freshEnv();
  });

  it("reports not configured before setup and configured afterwards, with the signed-in user", async () => {
    expect((await status()).body).toEqual({ configured: false, authenticated: false, user: null });

    const token = await setupAdmin();

    expect((await status()).body).toEqual({ configured: true, authenticated: false, user: null });
    const signedIn = (await status({ token })).body;
    expect(signedIn).toEqual({
      configured: true,
      authenticated: true,
      user: expect.objectContaining({ username: "admin", email: null, role: "admin", isActive: true }),
    });
    expect(Object.keys(signedIn.user ?? {}).sort()).toEqual(USER_KEYS);
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

  it("rejects an invalid username or email without creating anything", async () => {
    for (const body of [
      { username: "x", password: ADMIN_PASSWORD },
      { username: "-starts-with-dash", password: ADMIN_PASSWORD },
      { username: "has space", password: ADMIN_PASSWORD },
      { username: 42, password: ADMIN_PASSWORD },
      { email: "not-an-email", password: ADMIN_PASSWORD },
      { email: "a@b", password: ADMIN_PASSWORD },
    ]) {
      const res = await api<{ error?: string }>(setupRoute, "POST", "/auth/setup", { body, token: null });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(typeof res.body.error).toBe("string");
    }
    expect((await status()).body.configured).toBe(false);
  });

  it("creates the first admin with a chosen, normalized username and email", async () => {
    const res = await api<Session>(setupRoute, "POST", "/auth/setup", {
      body: { username: "  Root.Admin ", email: " Root@Example.COM ", password: ADMIN_PASSWORD },
      token: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      username: "root.admin",
      email: "root@example.com",
      role: "admin",
      isActive: true,
    });

    expect((await login(ADMIN_PASSWORD, undefined, "ROOT.ADMIN")).status).toBe(200);
    expect((await login(ADMIN_PASSWORD, undefined, "root@example.com")).status).toBe(200);
    // Password-only logins sign in `admin`, which does not exist here.
    expect((await login(ADMIN_PASSWORD)).status).toBe(401);
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
    expect(res.body.user).toMatchObject({ username: "admin", email: null, role: "admin", isActive: true });
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
      body: { username: "second", password: "another-password" },
      token: null,
    });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "Setup is already complete" });

    // The original password still works; the second account was not created.
    expect((await login(ADMIN_PASSWORD)).status).toBe(200);
    expect((await login("another-password")).status).toBe(401);
    expect((await login("another-password", undefined, "second")).status).toBe(401);
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

  it("answers 409 before setup", async () => {
    const res = await login(ADMIN_PASSWORD);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Setup is not complete yet" });
  });

  it("issues a working token for the right password and 401 for a wrong one", async () => {
    await setupAdmin();
    useToken(null);

    const bad = await login("wrong-password");
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: "Invalid username or password" });
    expect(bad.headers.get("set-cookie")).toBeNull();

    expect((await login("")).status).toBe(401);
    expect((await login(undefined)).status).toBe(401);

    // Password-only body: the `admin` account (back-compat for older clients and the CLI).
    const ok = await login(ADMIN_PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ username: "admin", role: "admin" });
    expect(setCookieOf(ok.headers)).toContain(`omp_ui_token=${encodeURIComponent(ok.body.token)}`);
    expect((await listBoards(ok.body.token)).status).toBe(200);

    const named = await login(ADMIN_PASSWORD, undefined, "admin");
    expect(named.status).toBe(200);
    expect(named.body.user.id).toBe(ok.body.user.id);
  });

  it("signs users in by username or email, case-insensitively, with the same 401 for every failure", async () => {
    await setupAdmin();
    const alice = await createUser({ username: "alice", email: "alice@example.com", password: "alice-password" });
    useToken(null);

    for (const name of ["alice", "  ALICE ", "alice@example.com", "Alice@Example.com"]) {
      const res = await login("alice-password", undefined, name);
      expect(res.status, name).toBe(200);
      expect(res.body.user).toEqual(alice);
      expect((await status({ token: res.body.token })).body.user).toEqual(alice);
    }

    // Wrong password, unknown account and another account's password are indistinguishable.
    for (const [name, password] of [
      ["alice", "wrong-password"],
      ["nobody", "alice-password"],
      ["nobody@example.com", "alice-password"],
      ["admin", "alice-password"],
      ["alice", ADMIN_PASSWORD],
    ]) {
      const res = await login(password, undefined, name);
      expect(res.status, `${name}/${password}`).toBe(401);
      expect(res.body).toEqual({ error: "Invalid username or password" });
    }
  });

  it("refuses inactive users and ends their sessions", async () => {
    await setupAdmin();
    const bob = await createUser({ username: "bob", password: "bob-password" });
    const bobToken = await loginAs("bob", "bob-password");
    expect((await listBoards(bobToken)).status).toBe(200);

    expect((await patchUser(bob.id, { isActive: false })).status).toBe(200);
    expect((await listBoards(bobToken)).status).toBe(401);
    const refused = await login("bob-password", undefined, "bob");
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: "Invalid username or password" });

    expect((await patchUser(bob.id, { isActive: true })).status).toBe(200);
    // Reactivating does not resurrect old tokens, but the account can sign in again.
    expect((await listBoards(bobToken)).status).toBe(401);
    expect((await login("bob-password", undefined, "bob")).status).toBe(200);
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

  it("rotates only the caller's password and revokes only the caller's older tokens", async () => {
    const original = await setupAdmin();
    await createUser({ username: "carol", password: "carol-password" });
    const other = (await login(ADMIN_PASSWORD)).body.token;
    const carol = await loginAs("carol", "carol-password");

    const res = await api<Session>(passwordRoute, "POST", "/auth/password", {
      body: { current: ADMIN_PASSWORD, next: "brand-new-password" },
      token: original,
    });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: "admin" });
    expect(setCookieOf(res.headers)).toContain(`omp_ui_token=${encodeURIComponent(res.body.token)}`);

    expect((await listBoards(original)).status).toBe(401);
    expect((await listBoards(other)).status).toBe(401);
    expect((await listBoards(res.body.token)).status).toBe(200);
    // Another user's session and password are untouched.
    expect((await listBoards(carol)).status).toBe(200);
    expect((await login("carol-password", undefined, "carol")).status).toBe(200);

    expect((await login(ADMIN_PASSWORD)).status).toBe(401);
    expect((await login("brand-new-password")).status).toBe(200);
  });

  it("lets a regular user change their own password without touching the admin", async () => {
    const admin = await setupAdmin();
    await createUser({ username: "dave", password: "dave-password" });
    const dave = await loginAs("dave", "dave-password");
    const daveOther = await loginAs("dave", "dave-password");

    const wrong = await api(passwordRoute, "POST", "/auth/password", {
      // The admin's password is not dave's current password.
      body: { current: ADMIN_PASSWORD, next: "dave-new-password" },
      token: dave,
    });
    expect(wrong.status).toBe(403);

    const res = await api<Session>(passwordRoute, "POST", "/auth/password", {
      body: { current: "dave-password", next: "dave-new-password" },
      token: dave,
    });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: "dave", role: "user" });

    expect((await listBoards(dave)).status).toBe(401);
    expect((await listBoards(daveOther)).status).toBe(401);
    expect((await listBoards(res.body.token)).status).toBe(200);
    expect((await listBoards(admin)).status).toBe(200);
    expect((await login("dave-password", undefined, "dave")).status).toBe(401);
    expect((await login("dave-new-password", undefined, "dave")).status).toBe(200);
    expect((await login(ADMIN_PASSWORD)).status).toBe(200);
  });
});

describe("ADMIN_PASSWORD at boot", () => {
  it("configures the admin account from the environment and overwrites its password on a later boot", async () => {
    await freshEnv({ ADMIN_PASSWORD: "env-password-one" });

    expect((await status()).body.configured).toBe(true);
    const setup = await api(setupRoute, "POST", "/auth/setup", { body: { password: "whatever-else" }, token: null });
    expect(setup.status).toBe(409);
    const first = await login("env-password-one");
    expect(first.status).toBe(200);
    expect(first.body.user).toMatchObject({ username: "admin", role: "admin", isActive: true });

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

  it("creates the admin account next to a differently named first admin, leaving other users alone", async () => {
    await freshEnv();
    await api(setupRoute, "POST", "/auth/setup", { body: { username: "root", password: "root-password" }, token: null });
    const rootToken = await loginAs("root", "root-password");

    await restartServer({ ADMIN_PASSWORD: "env-password-3" });
    const admin = await login("env-password-3", undefined, "admin");
    expect(admin.status).toBe(200);
    expect(admin.body.user).toMatchObject({ username: "admin", role: "admin", isActive: true });
    expect((await listBoards(rootToken)).status).toBe(200);
    expect((await login("root-password", undefined, "root")).status).toBe(200);
  });
});

describe("legacy single-password databases", () => {
  it("boot into an `admin` account with the stored password, which receives the existing data", async () => {
    await freshEnv();
    // A pre-users database: only the old settings key, plus an ownerless board.
    const repo = await getRepo();
    await repo.setSetting("admin_password_hash", await hashPassword("legacy-password-1"));
    const legacyBoard = await repo.createBoard({ name: "Legacy", workdir: tempDir("legacy-project") });
    expect(legacyBoard.userId).toBeNull();

    expect((await status()).body).toEqual({ configured: true, authenticated: false, user: null });
    const setup = await api(setupRoute, "POST", "/auth/setup", { body: { password: "takeover-attempt" }, token: null });
    expect(setup.status).toBe(409);

    const res = await login("legacy-password-1");
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: "admin", email: null, role: "admin", isActive: true });
    expect((await login("legacy-password-1", undefined, "admin")).status).toBe(200);
    expect((await login("takeover-attempt")).status).toBe(401);

    // The legacy key is consumed, and the ownerless board now belongs to the migrated admin.
    expect(await repo.getSetting("admin_password_hash")).toBeNull();
    expect((await repo.listUsers()).map((u) => u.username)).toEqual(["admin"]);
    const boards = await listBoards(res.body.token);
    expect(boards.status).toBe(200);
    expect(boards.body.find((b) => b.id === legacyBoard.id)?.userId).toBe(res.body.user.id);

    // The next boot keeps the account and its sessions.
    await restartServer();
    expect((await listBoards(res.body.token)).status).toBe(200);
    expect((await login("legacy-password-1")).status).toBe(200);
  });
});

describe("token validation", () => {
  const SECRET = "test-auth-secret-0123456789abcdef";

  function forge(payload: Record<string, unknown>, secret = SECRET, version = "v2"): string {
    const body = `${version}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const signature = createHmac("sha256", secret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  function payloadOf(token: string): { uid: string; uep: number; epoch: number; iat: number; exp: number } {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  }

  it("rejects tampered, foreign, expired, revoked-epoch, unknown-user and v1 tokens", async () => {
    await freshEnv({ AUTH_SECRET: SECRET });
    const token = await setupAdmin();
    useToken(null);
    const payload = payloadOf(token);
    expect(token.startsWith("v2.")).toBe(true);
    expect(payload.uid).toBe((await status({ token })).body.user?.id);

    // Control: a token built the documented way (HMAC-SHA256 with the server secret) is accepted.
    expect((await listBoards(forge({ ...payload, iat: payload.iat + 1 }))).status).toBe(200);

    const expired = forge({ ...payload, exp: Date.now() - 1000 });
    expect((await listBoards(expired)).status).toBe(401);

    const wrongEpoch = forge({ ...payload, epoch: payload.epoch + 1 });
    expect((await listBoards(wrongEpoch)).status).toBe(401);

    const wrongUserEpoch = forge({ ...payload, uep: payload.uep + 1 });
    expect((await listBoards(wrongUserEpoch)).status).toBe(401);

    const unknownUser = forge({ ...payload, uid: "00000000-0000-0000-0000-000000000000" });
    expect((await listBoards(unknownUser)).status).toBe(401);

    expect((await listBoards(forge({ ...payload, uid: undefined }))).status).toBe(401);

    expect((await listBoards(forge(payload, "some-other-secret"))).status).toBe(401);
    // Pre-users tokens (v1, no user id) are signed with the same secret but no longer accepted.
    expect((await listBoards(forge({ epoch: payload.epoch, iat: payload.iat, exp: payload.exp }, SECRET, "v1"))).status).toBe(401);
    expect((await listBoards(forge(payload, SECRET, "v1"))).status).toBe(401);

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

  it("does not let one user's token pass as another's", async () => {
    await freshEnv({ AUTH_SECRET: SECRET });
    const adminToken = await setupAdmin();
    const adminId = payloadOf(adminToken).uid;
    const erin = await createUser({ username: "erin", password: "erin-password" });
    const erinToken = await loginAs("erin", "erin-password");
    const payload = payloadOf(erinToken);
    expect(payload.uid).toBe(erin.id);
    useToken(null);

    expect((await status({ token: erinToken })).body.user).toEqual(erin);
    // Swapping in the admin's id without re-signing breaks the signature.
    const [version, , signature] = erinToken.split(".");
    const swapped = Buffer.from(JSON.stringify({ ...payload, uid: adminId })).toString("base64url");
    expect((await status({ token: `${version}.${swapped}.${signature}` })).body).toEqual({
      configured: true,
      authenticated: false,
      user: null,
    });
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
    ["POST /fs/mkdir", mkdirRoute, "POST", "/fs/mkdir"],
    ["POST /git/clone", cloneRoute, "POST", "/git/clone"],
    ["GET /git/repo", repoRoute, "GET", "/git/repo"],
    ["POST /git/init", initRoute, "POST", "/git/init"],
    ["GET /system", systemRoute, "GET", "/system"],
    ["GET /settings", settingsRoute, "GET", "/settings"],
    ["PATCH /settings", settingsRoute, "PATCH", "/settings"],
    ["GET /stats/system", statsSystemRoute, "GET", "/stats/system"],
    ["GET /stats/ai", statsAiRoute, "GET", "/stats/ai"],
    ["GET /events", eventsRoute, "GET", "/events"],
    ["POST /auth/password", passwordRoute, "POST", "/auth/password"],
    ["GET /users", usersRoute, "GET", "/users"],
    ["POST /users", usersRoute, "POST", "/users"],
    ["GET /users/:id", userRoute, "GET", `/users/${id}`, { id }],
    ["PATCH /users/:id", userRoute, "PATCH", `/users/${id}`, { id }],
    ["DELETE /users/:id", userRoute, "DELETE", `/users/${id}`, { id }],
    ["PATCH /users/:id/password", userPasswordRoute, "PATCH", `/users/${id}/password`, { id }],
  ];

  it.each(protectedCalls)("%s answers 401 JSON without a token", async (_name, mod, method, routePath, params) => {
    await freshEnv();
    await setupAdmin();
    const res = await call(mod, method, routePath, { token: null, params });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("also answers 401 before setup", async () => {
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

describe("security and access logs", () => {
  // lib/server/http.ts keeps its unauthorized-request log throttle on globalThis (like helpers' `g`).
  const http = globalThis as unknown as { __ompUiUnauthorizedLogged?: Map<string, number> };

  beforeEach(async () => {
    // Without proxy trust every client is "direct".
    await freshEnv({ VINEXT_TRUST_PROXY: undefined, VINEXT_TRUSTED_HOSTS: undefined });
    // One "Unauthorized request" entry per ip + method + path a minute: forget earlier tests' ones.
    http.__ompUiUnauthorizedLogged?.clear();
  });

  /** Raw text and parsed events of DATA_DIR/<source>.log once every queued write landed. */
  async function readEvents(source: "security" | "access"): Promise<{ raw: string; events: StoredLogEvent[] }> {
    await flushLogEvents();
    const raw = readFileSync(eventLogPath(source), "utf8");
    const events = raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as StoredLogEvent);
    return { raw, events };
  }

  it("records failed and successful logins with the login name in DATA_DIR/security.log, without the password", async () => {
    expect(eventLogPath("security").startsWith(env().dataDir)).toBe(true);
    await setupAdmin();
    const wrong = "wrong-password-xyz";
    expect((await login(wrong)).status).toBe(401);
    const ok = await login(ADMIN_PASSWORD);
    expect(ok.status).toBe(200);

    const { raw, events } = await readEvents("security");
    const logins = events.filter((e) => e.category === "login");
    expect(logins).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "Login failed: invalid username or password",
        meta: expect.objectContaining({ login: "admin" }),
      }),
      expect.objectContaining({
        level: "info",
        message: "Login succeeded",
        meta: expect.objectContaining({ login: "admin", user: "admin", userId: ok.body.user.id }),
      }),
    ]);
    for (const event of logins) {
      expect(Number.isNaN(Date.parse(event.t))).toBe(false);
      expect(event.meta?.ip).toBe("direct");
    }
    expect(events).toContainEqual(
      expect.objectContaining({ category: "password", message: "Setup completed: admin account created" }),
    );
    expect(raw).not.toContain(wrong);
    expect(raw).not.toContain(ADMIN_PASSWORD);
  });

  it("records authenticated API calls with the user in DATA_DIR/access.log without the query string", async () => {
    await setupAdmin();
    expect((await api(boardsRoute, "GET", "/boards?token=leak-me")).status).toBe(200);

    const { raw, events } = await readEvents("access");
    expect(events).toContainEqual(
      expect.objectContaining({
        level: "info",
        category: "api",
        message: "GET /api/v1/boards 200",
        meta: expect.objectContaining({ method: "GET", path: "/api/v1/boards", status: 200, ip: "direct", user: "admin" }),
      }),
    );
    expect(raw).not.toContain("leak-me");
    expect(raw).not.toContain("?");
  });

  it("records unauthorized requests once per client, method and path a minute", async () => {
    await setupAdmin();
    expect((await listBoards(null)).status).toBe(401);
    expect((await listBoards("not-a-token")).status).toBe(401);

    const unauthorized = (await readEvents("security")).events.filter((e) => e.category === "auth");
    expect(unauthorized).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "Unauthorized request: GET /api/v1/boards",
        meta: { ip: "direct", method: "GET", path: "/api/v1/boards", reason: "no token" },
      }),
    ]);
    const denied = (await readEvents("access")).events.filter((e) => e.message === "GET /api/v1/boards 401");
    expect(denied.map((e) => e.level)).toEqual(["warn", "warn"]);
  });
});
