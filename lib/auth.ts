// Server-only (Node runtime). Admin password + signed bearer/cookie tokens.
import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { getRepo } from "@/lib/db";

/** Cookie carrying the session token for the web UI. middleware.ts duplicates this literal. */
export const SESSION_COOKIE = "omp_ui_token";
export const MIN_PASSWORD_LENGTH = 8;

const PASSWORD_KEY = "admin_password_hash";
const SECRET_KEY = "auth_secret";
const EPOCH_KEY = "token_epoch";

const TOKEN_VERSION = "v1";
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

const RATE_LIMIT_MAX_FAILURES = 10;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

interface TokenPayload {
  exp: number;
  epoch: number;
  iat: number;
}

// Process-wide state survives dev HMR module reloads.
const g = globalThis as unknown as {
  __ompUiAuthSecret?: Promise<string>;
  __ompUiAuthBoot?: Promise<void>;
  __ompUiLoginFailures?: Map<string, { count: number; resetAt: number }>;
};

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

async function hashPassword(password: string): Promise<string> {
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

/** True once an admin password has been stored. */
export async function isConfigured(): Promise<boolean> {
  const repo = await getRepo();
  return Boolean(await repo.getSetting(PASSWORD_KEY));
}

/** Store a new admin password and revoke every previously issued token. */
export async function setPassword(password: string): Promise<void> {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Password must not be empty");
  }
  const repo = await getRepo();
  await repo.setSetting(PASSWORD_KEY, await hashPassword(password));
  const epoch = await currentTokenEpoch();
  await repo.setSetting(EPOCH_KEY, String(epoch + 1));
}

/** Constant-time check against the stored hash. False when no password is configured. */
export async function verifyPassword(password: string): Promise<boolean> {
  if (typeof password !== "string") return false;
  const repo = await getRepo();
  const stored = await repo.getSetting(PASSWORD_KEY);
  if (!stored) return false;
  return verifyHash(password, stored);
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

/**
 * Session token epoch, bumped by every password change (which revokes issued tokens and chat logins).
 * Read from the DB every time so `omp-ui passwd` in another process revokes tokens immediately.
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

export async function issueToken(): Promise<{ token: string; expiresAt: string }> {
  const [secret, epoch] = await Promise.all([getSecret(), currentTokenEpoch()]);
  const iat = Date.now();
  const exp = iat + TOKEN_TTL_MS;
  const payload: TokenPayload = { exp, epoch, iat };
  const body = `${TOKEN_VERSION}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const token = `${body}.${sign(body, secret).toString("base64url")}`;
  return { token, expiresAt: new Date(exp).toISOString() };
}

export async function verifyToken(token: string): Promise<boolean> {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return false;
  const secret = await getSecret();
  const expected = sign(`${parts[0]}.${parts[1]}`, secret);
  const actual = Buffer.from(parts[2], "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as TokenPayload;
  } catch {
    return false;
  }
  if (typeof payload?.exp !== "number" || payload.exp <= Date.now()) return false;
  if (typeof payload.epoch !== "number") return false;
  return payload.epoch === (await currentTokenEpoch());
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

export async function isAuthenticated(req: Request): Promise<boolean> {
  const token = getRequestToken(req);
  return token ? verifyToken(token) : false;
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

/** Once per process: apply ADMIN_PASSWORD from the environment if it differs from the stored one. */
export function ensureAuthBoot(): Promise<void> {
  g.__ompUiAuthBoot ??= (async () => {
    const envPassword = process.env.ADMIN_PASSWORD;
    if (envPassword && !(await verifyPassword(envPassword))) {
      await setPassword(envPassword);
    }
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
