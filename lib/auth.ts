// Server-only (Node runtime). User accounts (scrypt password hashes) + signed bearer/cookie tokens.
import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { getRepo } from "@/lib/db";
import type { Repository, UserAuthRecord } from "@/lib/db/types";
import { reassignCredentials } from "@/lib/server/credentials";
import type { User } from "@/lib/types";

/** Cookie carrying the session token for the web UI. middleware.ts duplicates this literal. */
export const SESSION_COOKIE = "omp_ui_token";
export const MIN_PASSWORD_LENGTH = 8;
/** Username of the setup admin, the account ADMIN_PASSWORD manages and the login default for password-only clients. */
export const DEFAULT_ADMIN_USERNAME = "admin";

/** Pre-users single admin password; migrated into the `admin` account by ensureAuthBoot. */
const LEGACY_PASSWORD_KEY = "admin_password_hash";
const SECRET_KEY = "auth_secret";
const EPOCH_KEY = "token_epoch";

/** v2 tokens carry the user id; bumping the version rejects every v1 (pre-users) token. */
const TOKEN_VERSION = "v2";
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

const RATE_LIMIT_MAX_FAILURES = 10;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

interface TokenPayload {
  /** User id. */
  uid: string;
  /** The user's tokenEpoch at issue time. */
  uep: number;
  /** Global token epoch at issue time. */
  epoch: number;
  iat: number;
  exp: number;
}

// Process-wide state survives dev HMR module reloads.
const g = globalThis as unknown as {
  __ompUiAuthSecret?: Promise<string>;
  __ompUiAuthBoot?: Promise<void>;
  __ompUiDummyHash?: Promise<string>;
  __ompUiLoginFailures?: Map<string, { count: number; resetAt: number }>;
};

/** Usernames and emails are stored trimmed and lowercase; logins are matched the same way. */
export function normalizeLogin(value: string): string {
  return value.trim().toLowerCase();
}

/** The client-safe view of an auth record (no hash, no epoch). */
function publicUser(record: UserAuthRecord): User {
  return {
    id: record.id,
    username: record.username,
    email: record.email,
    role: record.role,
    isActive: record.isActive,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Password hashing

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  scrypt(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  return promise;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * SCRYPT_N * SCRYPT_R,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

async function verifyHash(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await scryptAsync(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: 256 * N * r,
  });
  return timingSafeEqual(actual, expected);
}

/** Hash checked for unknown logins so a miss costs the same scrypt work as a wrong password. */
function dummyHash(): Promise<string> {
  g.__ompUiDummyHash ??= hashPassword(randomBytes(16).toString("hex")).catch((err: unknown) => {
    g.__ompUiDummyHash = undefined;
    throw err;
  });
  return g.__ompUiDummyHash;
}

function assertPassword(password: string): void {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Password must not be empty");
  }
}

/** True once at least one user exists (first-run setup done). */
export async function isConfigured(): Promise<boolean> {
  const repo = await getRepo();
  return (await repo.listUsers()).length > 0;
}

/**
 * The active user whose username or email is `login` and whose password matches; null otherwise.
 * Unknown logins still pay one scrypt verify, so response time does not reveal which accounts exist.
 */
export async function authenticate(login: string, password: string): Promise<User | null> {
  if (typeof login !== "string" || typeof password !== "string") return null;
  const normalized = normalizeLogin(login);
  const repo = await getRepo();
  const record = normalized ? await repo.findUserAuthByLogin(normalized) : null;
  if (!record) {
    await verifyHash(password, await dummyHash());
    return null;
  }
  const ok = await verifyHash(password, record.passwordHash);
  return ok && record.isActive ? publicUser(record) : null;
}

/** Constant-time check of a user's password. False for unknown users. */
export async function verifyUserPassword(userId: string, password: string): Promise<boolean> {
  if (typeof password !== "string") return false;
  const repo = await getRepo();
  const record = await repo.getUserAuth(userId);
  if (!record) return false;
  return verifyHash(password, record.passwordHash);
}

/** Store a new password for the user and revoke every token and chat login issued to them. */
export async function setUserPassword(userId: string, password: string): Promise<void> {
  assertPassword(password);
  const repo = await getRepo();
  const record = await repo.getUserAuth(userId);
  if (!record) throw new Error("User not found");
  const passwordHash = await hashPassword(password);
  await repo.updateUser(userId, { passwordHash, tokenEpoch: record.tokenEpoch + 1 });
}

/** Revoke every token and chat login issued to the user (no-op for unknown users). */
export async function revokeUserSessions(userId: string): Promise<void> {
  const repo = await getRepo();
  const record = await repo.getUserAuth(userId);
  if (!record) return;
  await repo.updateUser(userId, { tokenEpoch: record.tokenEpoch + 1 });
}

/** Give rows without an owner (pre-users data) and unowned credentials to `adminId`. */
async function adoptOrphanData(repo: Repository, adminId: string): Promise<void> {
  await repo.reassignUserData(null, adminId);
  await reassignCredentials(repo, null, adminId);
}

/**
 * First-run setup: create the first admin (username defaults to "admin") and hand it any data
 * without an owner. Callers validate the fields and check `isConfigured()` first; throws when a
 * user already exists.
 */
export async function createFirstAdmin(input: {
  username?: string;
  email?: string | null;
  password: string;
}): Promise<User> {
  assertPassword(input.password);
  const repo = await getRepo();
  if ((await repo.listUsers()).length > 0) throw new Error("A user already exists");
  const email = input.email ? normalizeLogin(input.email) : null;
  const user = await repo.createUser({
    username: normalizeLogin(input.username ?? DEFAULT_ADMIN_USERNAME),
    email: email || null,
    passwordHash: await hashPassword(input.password),
    role: "admin",
  });
  await adoptOrphanData(repo, user.id);
  return user;
}

// ---------------------------------------------------------------------------
// Tokens

function getSecret(): Promise<string> {
  const fromEnv = process.env.AUTH_SECRET;
  if (fromEnv) return Promise.resolve(fromEnv);
  g.__ompUiAuthSecret ??= (async () => {
    const repo = await getRepo();
    const existing = await repo.getSetting(SECRET_KEY);
    if (existing) return existing;
    const generated = randomBytes(32).toString("hex");
    await repo.setSetting(SECRET_KEY, generated);
    return generated;
  })().catch((err: unknown) => {
    g.__ompUiAuthSecret = undefined;
    throw err;
  });
  return g.__ompUiAuthSecret;
}

/** Read the token secret from the database again (it was replaced by a data import). */
export function forgetAuthSecret(): void {
  g.__ompUiAuthSecret = undefined;
}

/**
 * Global session token epoch: bumping it revokes every user's tokens and chat logins at once (each
 * user also has a tokenEpoch for their own sessions). Read from the DB every time so a change made
 * by another process takes effect immediately.
 */
export async function currentTokenEpoch(): Promise<number> {
  const repo = await getRepo();
  const raw = await repo.getSetting(EPOCH_KEY);
  const n = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

function sign(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

/** Sign a session token for the user, bound to their current tokenEpoch and the global epoch. */
export async function issueToken(userId: string): Promise<{ token: string; expiresAt: string }> {
  const repo = await getRepo();
  const [secret, epoch, record] = await Promise.all([getSecret(), currentTokenEpoch(), repo.getUserAuth(userId)]);
  if (!record) throw new Error("User not found");
  const iat = Date.now();
  const exp = iat + TOKEN_TTL_MS;
  const payload: TokenPayload = { uid: record.id, uep: record.tokenEpoch, epoch, iat, exp };
  const body = `${TOKEN_VERSION}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const token = `${body}.${sign(body, secret).toString("base64url")}`;
  return { token, expiresAt: new Date(exp).toISOString() };
}

/**
 * The token's user, or null unless the signature is valid, the token is unexpired, the user exists
 * and is active, and both the user's and the global epoch still match.
 */
export async function verifyToken(token: string): Promise<User | null> {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const secret = await getSecret();
  const expected = sign(`${parts[0]}.${parts[1]}`, secret);
  const actual = Buffer.from(parts[2], "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as TokenPayload;
  } catch {
    return null;
  }
  if (typeof payload?.exp !== "number" || payload.exp <= Date.now()) return null;
  if (typeof payload.uid !== "string" || typeof payload.uep !== "number" || typeof payload.epoch !== "number") {
    return null;
  }
  const repo = await getRepo();
  const [record, epoch] = await Promise.all([repo.getUserAuth(payload.uid), currentTokenEpoch()]);
  if (!record || !record.isActive) return null;
  if (payload.uep !== record.tokenEpoch || payload.epoch !== epoch) return null;
  return publicUser(record);
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/** Token from `Authorization: Bearer <token>` (mobile/CLI) or the session cookie (web). */
export function getRequestToken(req: Request): string | null {
  const authorization = req.headers.get("authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }
  return readCookie(req.headers.get("cookie"), SESSION_COOKIE) || null;
}

/** The signed-in user of a request (bearer or cookie token), or null. */
export async function getRequestUser(req: Request): Promise<User | null> {
  const token = getRequestToken(req);
  return token ? verifyToken(token) : null;
}

export async function isAuthenticated(req: Request): Promise<boolean> {
  return (await getRequestUser(req)) !== null;
}

// ---------------------------------------------------------------------------
// Cookies

function isSecureRequest(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded && forwarded.split(",")[0].trim().toLowerCase() === "https") return true;
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

function cookieAttributes(req: Request): string {
  return `Path=/; HttpOnly; SameSite=Lax${isSecureRequest(req) ? "; Secure" : ""}`;
}

/** Set-Cookie header value for a freshly issued token. */
export function sessionCookie(token: string, expiresAt: string, req: Request): string {
  const expires = new Date(expiresAt);
  const maxAge = Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttributes(req)}; Max-Age=${maxAge}; Expires=${expires.toUTCString()}`;
}

/** Set-Cookie header value that removes the session cookie. */
export function clearSessionCookie(req: Request): string {
  return `${SESSION_COOKIE}=; ${cookieAttributes(req)}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

// ---------------------------------------------------------------------------
// Boot

/**
 * Once per process:
 * 1. migrate the pre-users admin password (setting `admin_password_hash`) into the `admin` account;
 * 2. apply ADMIN_PASSWORD from the environment to the `admin` account (created if missing, made an
 *    active admin; a changed password revokes that account's sessions) — the `omp-ui passwd` recovery path;
 * 3. hand data without an owner (pre-users rows and credentials) to the oldest active admin.
 */
export function ensureAuthBoot(): Promise<void> {
  g.__ompUiAuthBoot ??= (async () => {
    const repo = await getRepo();

    const legacyHash = await repo.getSetting(LEGACY_PASSWORD_KEY);
    if (legacyHash) {
      if ((await repo.listUsers()).length === 0) {
        await repo.createUser({
          username: DEFAULT_ADMIN_USERNAME,
          email: null,
          passwordHash: legacyHash,
          role: "admin",
        });
      }
      await repo.deleteSetting(LEGACY_PASSWORD_KEY);
    }

    const envPassword = process.env.ADMIN_PASSWORD;
    if (envPassword) {
      const admin = await repo.findUserAuthByLogin(DEFAULT_ADMIN_USERNAME);
      if (!admin) {
        await repo.createUser({
          username: DEFAULT_ADMIN_USERNAME,
          email: null,
          passwordHash: await hashPassword(envPassword),
          role: "admin",
        });
      } else {
        const passwordChanged = !(await verifyHash(envPassword, admin.passwordHash));
        if (passwordChanged || admin.role !== "admin" || !admin.isActive) {
          await repo.updateUser(admin.id, {
            role: "admin",
            isActive: true,
            ...(passwordChanged
              ? { passwordHash: await hashPassword(envPassword), tokenEpoch: admin.tokenEpoch + 1 }
              : {}),
          });
        }
      }
    }

    const firstAdmin = (await repo.listUsers()).find((user) => user.role === "admin" && user.isActive);
    if (firstAdmin) await adoptOrphanData(repo, firstAdmin.id);
  })().catch((err: unknown) => {
    g.__ompUiAuthBoot = undefined;
    throw err;
  });
  return g.__ompUiAuthBoot;
}

// ---------------------------------------------------------------------------
// Login rate limiting (in-memory, per client IP)

const failures: Map<string, { count: number; resetAt: number }> = (g.__ompUiLoginFailures ??=
  new Map());

/**
 * Rate-limit bucket for a request. Route handlers don't see the socket address, so forwarding
 * headers are the only per-client signal, and they are trusted only behind a declared reverse
 * proxy (`VINEXT_TRUST_PROXY=1` or `VINEXT_TRUSTED_HOSTS`, same gate as vinext's server).
 * Otherwise every client shares the "direct" bucket, so spoofed headers can't dodge the limit.
 * Behind the proxy: `X-Real-IP` (set by the proxy), else the right-most `X-Forwarded-For` entry,
 * i.e. the one the trusted proxy appended (left-most entries are client-controlled).
 */
export function clientIp(req: Request): string {
  const trustProxy =
    process.env.VINEXT_TRUST_PROXY === "1" ||
    (process.env.VINEXT_TRUSTED_HOSTS ?? "").split(",").some((h) => h.trim());
  if (!trustProxy) return "direct";
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = req.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  return forwarded || "direct";
}

function pruneFailures(now: number): void {
  for (const [ip, entry] of failures) {
    if (entry.resetAt <= now) failures.delete(ip);
  }
}

/** Seconds until the client may retry, or 0 when login attempts are allowed. */
export function loginRetryAfter(req: Request): number {
  const now = Date.now();
  pruneFailures(now);
  const entry = failures.get(clientIp(req));
  if (!entry || entry.count < RATE_LIMIT_MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
}

export function recordLoginFailure(req: Request): void {
  const now = Date.now();
  const ip = clientIp(req);
  const entry = failures.get(ip);
  if (!entry || entry.resetAt <= now) {
    failures.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

export function clearLoginFailures(req: Request): void {
  failures.delete(clientIp(req));
}
