// Server-only credential store behind `/api/v1/credentials/**` (the /credentials page). Records
// live in the settings table under `credentials`; secret field values are AES-256-GCM encrypted
// with a key from CREDENTIALS_KEY or DATA_DIR/credentials.key and only ever leave this module
// masked. Health checks run on demand and every CREDENTIAL_CHECK_INTERVAL_MS in the background;
// notifications are derived from the stored state on read (only read/dismissed ids persist).
//
// NOTE: lib/server/http.ts imports lib/agent/manager.ts, which imports this module: never use an
// import from lib/server/http.ts at module evaluation time (e.g. `class … extends HttpError`).
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  getCredentialProvider,
  isCredentialProviderId,
  maskSecret,
  validateCredentialFields,
  validateCredentialInput,
} from "@/lib/credential-providers";
import {
  CREDENTIAL_CHECK_INTERVAL_MS,
  CREDENTIAL_EXPIRY_WARNING_MS,
  type CredentialInput,
  type CredentialNotification,
  type CredentialNotificationAction,
  type CredentialNotificationsResponse,
  type CredentialProvider,
  type CredentialProviderId,
  type CredentialSummary,
  type CredentialTestResult,
  type CredentialUpdate,
  type CredentialValidationErrors,
  type CredentialsResponse,
} from "@/lib/credential-types";
import type { Repository } from "@/lib/db/types";
import { dataDir } from "@/lib/files";
import { probeCredential } from "@/lib/server/credential-checks";
import { HttpError, json } from "@/lib/server/http";

const STORE_KEY = "credentials";
const NOTIFICATIONS_KEY = "credential_notifications";
const KEY_FILE = "credentials.key";
const CIPHER = "aes-256-gcm";
const DECRYPT_MESSAGE = "Cannot decrypt: the encryption key changed";
/** First background check after the server starts (lets boot settle), then every interval. */
const FIRST_CHECK_MS = 30_000;
/** A credential nobody tested for this long gets an "untested" notification. */
const UNTESTED_NOTICE_MS = 60 * 60_000;
const MAX_NAME_LENGTH = 200;
const MAX_FIELD_LENGTH = 16 * 1024;

export const NOTIFICATION_ACTIONS: readonly CredentialNotificationAction[] = [
  "read",
  "dismiss",
  "read-all",
  "dismiss-all",
];

/** Health state shared by stored records and summaries. */
type HealthState = Pick<
  CredentialSummary,
  "health" | "lastCheckedAt" | "lastOkAt" | "lastLatencyMs" | "lastMessage" | "failingSince" | "consecutiveFailures"
>;

interface StoredCredential extends HealthState {
  id: string;
  providerId: CredentialProviderId;
  name: string;
  /** Non-secret field values, plain. */
  fields: Record<string, string>;
  /** Secret field values: `v1:<iv>:<tag>:<data>` (base64url), AES-256-GCM. */
  secrets: Record<string, string>;
  expiresAt: string | null;
  autoCheck: boolean;
  createdAt: string;
  updatedAt: string;
}

interface NotificationState {
  read: string[];
  dismissed: string[];
}

// On globalThis so dev hot reloads share one key cache, one write lock and one timer.
const g = globalThis as unknown as {
  __ompUiCredentialKeys?: Map<string, Buffer>;
  __ompUiCredentialLock?: Promise<void>;
  __ompUiCredentialChecks?: { repo: Repository };
  __ompUiCredentialChecksRunning?: boolean;
};

/** Invalid field values: routes answer 400 `{ error, fields }` (see `withFieldErrors`). */
export class CredentialValidationError extends Error {
  constructor(readonly fields: CredentialValidationErrors) {
    super(Object.values(fields)[0] ?? "Invalid credential");
    this.name = "CredentialValidationError";
  }
}

/** Run a route body, turning a CredentialValidationError into 400 `{ error, fields }`. */
export async function withFieldErrors(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof CredentialValidationError) {
      return json({ error: err.message, fields: err.fields }, { status: 400 });
    }
    throw err;
  }
}

function throwIfInvalid(errors: CredentialValidationErrors): void {
  if (Object.keys(errors).length > 0) throw new CredentialValidationError(errors);
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

// ---------------------------------------------------------------------------------------------
// Encryption

function parseKeyFile(text: string, file: string): Buffer {
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== 32) throw new Error(`${file} does not hold a base64 32-byte key`);
  return key;
}

function readOrCreateKeyFile(file: string): Buffer {
  try {
    return parseKeyFile(readFileSync(file, "utf8"), file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const key = randomBytes(32);
  try {
    writeFileSync(file, `${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    return key;
  } catch (err) {
    // Another process created it first: use theirs.
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return parseKeyFile(readFileSync(file, "utf8"), file);
    throw err;
  }
}

/**
 * CREDENTIALS_KEY (any string, sha256 → 32 bytes) or DATA_DIR/credentials.key (created on first
 * use). File keys are cached by path, so a different DATA_DIR gets its own key.
 */
function encryptionKey(): Buffer {
  const secret = process.env.CREDENTIALS_KEY?.trim();
  if (secret) return createHash("sha256").update(secret).digest();
  const file = path.join(dataDir(), KEY_FILE);
  const cache = (g.__ompUiCredentialKeys ??= new Map());
  let key = cache.get(file);
  if (!key) {
    key = readOrCreateKeyFile(file);
    cache.set(file, key);
  }
  return key;
}

/** Reading only: an unusable key makes every secret unreadable instead of failing the request. */
function readKey(): Buffer | null {
  try {
    return encryptionKey();
  } catch (err) {
    console.error("[credentials] cannot load the encryption key:", errorMessage(err));
    return null;
  }
}

/** Binds a ciphertext to its credential and field, so values cannot be swapped between them. */
function aad(credentialId: string, field: string): Buffer {
  return Buffer.from(`${credentialId}:${field}`, "utf8");
}

function encrypt(plain: string, key: Buffer, credentialId: string, field: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  cipher.setAAD(aad(credentialId, field));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${data.toString("base64url")}`;
}

/** null when the value is malformed or was sealed with another key. */
function decrypt(sealed: string, key: Buffer, credentialId: string, field: string): string | null {
  const [version, iv, tag, data] = sealed.split(":");
  if (version !== "v1" || iv === undefined || tag === undefined || data === undefined) return null;
  try {
    const decipher = createDecipheriv(CIPHER, key, Buffer.from(iv, "base64url"));
    decipher.setAAD(aad(credentialId, field));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Seal a secret stored outside the credentials list (e.g. chat bot tokens) with the credentials
 * key; `scope` (e.g. `chat:telegram`) binds the ciphertext to its use. Throws when no key is usable.
 */
export function sealSecret(plain: string, scope: string): string {
  return encrypt(plain, encryptionKey(), scope, "value");
}

/** Open a `sealSecret` value; null when the key is unusable, the value malformed or sealed for another scope. */
export function openSecret(sealed: string, scope: string): string | null {
  const key = readKey();
  return key ? decrypt(sealed, key, scope, "value") : null;
}

/** Decrypted secrets; `broken` when any could not be decrypted (those are left out). */
function openSecrets(record: StoredCredential): { values: Record<string, string>; broken: boolean } {
  const values: Record<string, string> = {};
  const entries = Object.entries(record.secrets);
  if (entries.length === 0) return { values, broken: false };
  const key = readKey();
  let broken = false;
  for (const [field, sealed] of entries) {
    const plain = key ? decrypt(sealed, key, record.id, field) : null;
    if (plain === null) broken = true;
    else values[field] = plain;
  }
  return { values, broken };
}

// ---------------------------------------------------------------------------------------------
// Storage

async function loadAll(repo: Repository): Promise<StoredCredential[]> {
  const raw = await repo.getSetting(STORE_KEY);
  if (!raw) return [];
  // Corrupt JSON throws: answering an empty list would let the next write wipe every credential.
  const data = JSON.parse(raw) as unknown;
  if (!Array.isArray(data)) return [];
  return data.filter(
    (item): item is StoredCredential =>
      !!item && typeof item === "object" && typeof item.id === "string" && typeof item.providerId === "string",
  );
}

async function loadNotificationState(repo: Repository): Promise<NotificationState> {
  const raw = await repo.getSetting(NOTIFICATIONS_KEY);
  if (!raw) return { read: [], dismissed: [] };
  try {
    const s = JSON.parse(raw) as Partial<NotificationState>;
    const ids = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
    return { read: ids(s.read), dismissed: ids(s.dismissed) };
  } catch {
    return { read: [], dismissed: [] };
  }
}

/** Serialize read-modify-write cycles in this process so concurrent requests never lose updates. */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = (g.__ompUiCredentialLock ?? Promise.resolve()).then(fn);
  g.__ompUiCredentialLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Locked load → `fn` edits the list in place → save (skipped when `fn` throws). */
function mutate<T>(repo: Repository, fn: (list: StoredCredential[]) => T): Promise<T> {
  return withLock(async () => {
    const list = await loadAll(repo);
    const result = fn(list);
    await repo.setSetting(STORE_KEY, JSON.stringify(list));
    await saveNotificationState(repo, list, await loadNotificationState(repo));
    return result;
  });
}

/** Save read/dismissed ids, dropping those whose notification no longer exists. */
async function saveNotificationState(
  repo: Repository,
  list: StoredCredential[],
  state: NotificationState,
): Promise<NotificationState> {
  const live = new Set(liveNotifications(list.map(toSummary)).map((n) => n.id));
  const next: NotificationState = {
    read: [...new Set(state.read)].filter((id) => live.has(id)),
    dismissed: [...new Set(state.dismissed)].filter((id) => live.has(id)),
  };
  const raw = JSON.stringify(next);
  if (raw !== (await repo.getSetting(NOTIFICATIONS_KEY))) await repo.setSetting(NOTIFICATIONS_KEY, raw);
  return next;
}

function findOrThrow(list: StoredCredential[], id: string): StoredCredential {
  const record = list.find((c) => c.id === id);
  if (!record) throw new HttpError(404, "Credential not found");
  return record;
}

/** Changes whenever field values or secrets change (new secrets get a new IV). */
function fingerprint(record: StoredCredential): string {
  return JSON.stringify([record.fields, record.secrets]);
}

// ---------------------------------------------------------------------------------------------
// Summaries

function untestedState(): HealthState {
  return {
    health: "untested",
    lastCheckedAt: null,
    lastOkAt: null,
    lastLatencyMs: null,
    lastMessage: null,
    failingSince: null,
    consecutiveFailures: 0,
  };
}

function toSummary(record: StoredCredential): CredentialSummary {
  const opened = openSecrets(record);
  const provider = getCredentialProvider(record.providerId);
  // Provider field order first, then anything the catalog no longer lists.
  const order = [...(provider?.fields.map((f) => f.key) ?? []), ...Object.keys(record.fields), ...Object.keys(opened.values)];
  const fields: Record<string, string> = {};
  const secretsSet: string[] = [];
  for (const key of new Set(order)) {
    if (key in opened.values) {
      fields[key] = maskSecret(opened.values[key]);
      secretsSet.push(key);
    } else if (key in record.fields) {
      fields[key] = record.fields[key];
    }
  }
  const health: HealthState = {
    health: record.health,
    lastCheckedAt: record.lastCheckedAt,
    lastOkAt: record.lastOkAt,
    lastLatencyMs: record.lastLatencyMs,
    lastMessage: record.lastMessage,
    failingSince: record.failingSince,
    consecutiveFailures: record.consecutiveFailures,
  };
  if (opened.broken) {
    health.health = "failing";
    health.lastMessage = DECRYPT_MESSAGE;
    health.failingSince = record.failingSince ?? record.lastCheckedAt ?? record.updatedAt;
    health.consecutiveFailures = Math.max(1, record.consecutiveFailures);
  }
  return {
    id: record.id,
    providerId: record.providerId,
    name: record.name,
    fields,
    secretsSet,
    expiresAt: record.expiresAt,
    autoCheck: record.autoCheck,
    ...health,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function listCredentials(repo: Repository): Promise<CredentialsResponse> {
  const list = await loadAll(repo);
  return {
    credentials: list
      .map(toSummary)
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.createdAt.localeCompare(b.createdAt),
      ),
    checkIntervalMs: CREDENTIAL_CHECK_INTERVAL_MS,
    keySource: process.env.CREDENTIALS_KEY?.trim() ? "env" : "file",
  };
}

/** A credential with its values in the clear. Server-only: never send `fields` to a client. */
export interface CredentialValues {
  summary: CredentialSummary;
  /** Plain fields and decrypted secrets (secrets that cannot be decrypted are left out). */
  fields: Record<string, string>;
  /** Some secret could not be decrypted (the encryption key changed). */
  broken: boolean;
}

function toValues(record: StoredCredential): CredentialValues {
  const opened = openSecrets(record);
  return { summary: toSummary(record), fields: { ...record.fields, ...opened.values }, broken: opened.broken };
}

/** Decrypted values of one credential, null when the id is unknown (for MCP server configs). */
export async function credentialValues(repo: Repository, id: string): Promise<CredentialValues | null> {
  const record = (await loadAll(repo)).find((c) => c.id === id);
  return record ? toValues(record) : null;
}

/** Decrypted values of every credential, keyed by id (for the MCP agent environment). */
export async function allCredentialValues(repo: Repository): Promise<Map<string, CredentialValues>> {
  return new Map((await loadAll(repo)).map((record) => [record.id, toValues(record)]));
}

// ---------------------------------------------------------------------------------------------
// Health checks

async function runProbe(provider: CredentialProvider, fields: Record<string, string>): Promise<CredentialTestResult> {
  const checkedAt = new Date().toISOString();
  const started = performance.now();
  let outcome: { ok: boolean; message: string };
  try {
    outcome = await probeCredential(provider, fields);
  } catch (err) {
    // probeCredential never throws by contract; stay safe anyway.
    outcome = { ok: false, message: errorMessage(err) || "Health check failed" };
  }
  return { ok: outcome.ok, message: outcome.message, latencyMs: Math.round(performance.now() - started), checkedAt };
}

/** Probe a stored credential with its decrypted values. */
async function probeStored(record: StoredCredential): Promise<CredentialTestResult> {
  const provider = getCredentialProvider(record.providerId);
  const opened = openSecrets(record);
  if (!provider || opened.broken) {
    return {
      ok: false,
      message: provider ? DECRYPT_MESSAGE : `Unknown provider: ${record.providerId}`,
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
    };
  }
  return runProbe(provider, { ...record.fields, ...opened.values });
}

function applyResult(record: StoredCredential, result: CredentialTestResult): void {
  record.lastCheckedAt = result.checkedAt;
  record.lastLatencyMs = result.latencyMs;
  record.lastMessage = result.message;
  if (result.ok) {
    record.health = "healthy";
    record.lastOkAt = result.checkedAt;
    record.failingSince = null;
    record.consecutiveFailures = 0;
  } else {
    record.health = "failing";
    record.failingSince = record.failingSince ?? result.checkedAt;
    record.consecutiveFailures += 1;
  }
}

/** Store a probe of `snapshot` unless the credential's values changed (or it was deleted) meanwhile. */
async function commitResult(
  repo: Repository,
  snapshot: StoredCredential,
  result: CredentialTestResult,
): Promise<StoredCredential | null> {
  return mutate(repo, (list) => {
    const record = list.find((c) => c.id === snapshot.id);
    if (!record) return null;
    if (fingerprint(record) === fingerprint(snapshot)) applyResult(record, result);
    return record;
  });
}

/** Health-check one saved credential now and store the outcome. */
export async function checkCredential(
  repo: Repository,
  id: string,
): Promise<{ credential: CredentialSummary; result: CredentialTestResult }> {
  const record = findOrThrow(await loadAll(repo), id);
  const result = await probeStored(record);
  const stored = await commitResult(repo, record, result);
  if (!stored) throw new HttpError(404, "Credential not found");
  return { credential: toSummary(stored), result };
}

/**
 * Health-check credentials one after another (probes run outside the write lock).
 * `autoCheckOnly`: the background tick skips credentials with autoCheck off.
 */
export async function checkAllCredentials(
  repo: Repository,
  options: { autoCheckOnly?: boolean } = {},
): Promise<CredentialsResponse> {
  const records = await loadAll(repo);
  for (const record of records) {
    if (options.autoCheckOnly && !record.autoCheck) continue;
    try {
      await commitResult(repo, record, await probeStored(record));
    } catch (err) {
      console.error(`[credentials] health check of ${record.id} failed:`, errorMessage(err));
    }
  }
  return listCredentials(repo);
}

/** Background health checks: ~30 s after boot, then every CREDENTIAL_CHECK_INTERVAL_MS. Idempotent. */
export function startCredentialHealthChecks(repo: Repository): void {
  const existing = g.__ompUiCredentialChecks;
  if (existing) {
    existing.repo = repo;
    return;
  }
  const state = { repo };
  g.__ompUiCredentialChecks = state;
  const tick = (): void => {
    if (g.__ompUiCredentialChecksRunning) return;
    g.__ompUiCredentialChecksRunning = true;
    checkAllCredentials(state.repo, { autoCheckOnly: true })
      .catch((err: unknown) => console.error("[credentials] scheduled health check failed:", errorMessage(err)))
      .finally(() => {
        g.__ompUiCredentialChecksRunning = false;
      });
  };
  setTimeout(() => {
    tick();
    setInterval(tick, CREDENTIAL_CHECK_INTERVAL_MS).unref();
  }, FIRST_CHECK_MS).unref();
}

// ---------------------------------------------------------------------------------------------
// Create / update / delete / test

function requireProvider(providerId: string): CredentialProvider {
  const provider = isCredentialProviderId(providerId) ? getCredentialProvider(providerId) : undefined;
  if (!provider) throw new HttpError(400, `Unknown provider: ${providerId}`);
  return provider;
}

function trimFields(fields: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(fields ?? {}).map(([key, value]) => [key, value.trim()]));
}

/** Non-empty values split into plain fields and (still plaintext) secrets. */
function splitFields(
  provider: CredentialProvider,
  fields: Record<string, string>,
): { plain: Record<string, string>; secrets: Record<string, string> } {
  const plain: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const field of provider.fields) {
    const value = fields[field.key];
    if (!value) continue;
    if (field.kind === "secret") secrets[field.key] = value;
    else plain[field.key] = value;
  }
  return { plain, secrets };
}

function normalizeExpiry(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  return new Date(value.trim()).toISOString();
}

function sameValues(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && a[key] === b[key]);
}

/** `test`: probe before saving, so the credential starts healthy/failing instead of untested. */
export async function createCredential(
  repo: Repository,
  input: CredentialInput,
  options: { test?: boolean } = {},
): Promise<CredentialSummary> {
  const provider = requireProvider(input.providerId);
  const name = input.name.trim();
  const fields = trimFields(input.fields);
  throwIfInvalid(validateCredentialInput({ name, fields, expiresAt: input.expiresAt }, provider));
  const { plain, secrets } = splitFields(provider, fields);
  const result = options.test ? await runProbe(provider, { ...plain, ...secrets }) : null;

  const id = randomUUID();
  const now = new Date().toISOString();
  const key = encryptionKey();
  const record: StoredCredential = {
    id,
    providerId: provider.id,
    name,
    fields: plain,
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([field, value]) => [field, encrypt(value, key, id, field)]),
    ),
    expiresAt: normalizeExpiry(input.expiresAt),
    autoCheck: input.autoCheck ?? true,
    ...untestedState(),
    createdAt: now,
    updatedAt: now,
  };
  if (result) applyResult(record, result);
  await mutate(repo, (list) => {
    list.push(record);
  });
  return toSummary(record);
}

/**
 * Partial update. Secret fields omitted or "" keep their stored value; `clear` removes optional
 * fields. Changing any field value resets health to untested unless `test` probes the new values.
 */
export async function updateCredential(
  repo: Repository,
  id: string,
  update: CredentialUpdate,
  options: { test?: boolean } = {},
): Promise<CredentialSummary> {
  const current = findOrThrow(await loadAll(repo), id);
  const provider = requireProvider(current.providerId);
  const opened = openSecrets(current);
  const incoming = trimFields(update.fields);

  const clearErrors: CredentialValidationErrors = {};
  for (const key of update.clear ?? []) {
    const field = provider.fields.find((f) => f.key === key);
    if (!field) clearErrors[key] = "Unknown field";
    else if (field.required) clearErrors[key] = `${field.label} is required`;
  }
  throwIfInvalid(clearErrors);

  // Next values: stored ones (undecryptable secrets dropped), minus cleared, plus incoming.
  const nextPlain: Record<string, string> = { ...current.fields };
  const nextSecrets: Record<string, string> = { ...opened.values };
  for (const key of update.clear ?? []) {
    delete nextPlain[key];
    delete nextSecrets[key];
  }
  for (const field of provider.fields) {
    const value = incoming[field.key];
    if (value === undefined) continue;
    if (field.kind === "secret") {
      if (value) nextSecrets[field.key] = value;
    } else if (value) {
      nextPlain[field.key] = value;
    } else {
      delete nextPlain[field.key];
    }
  }

  const name = update.name !== undefined ? update.name.trim() : current.name;
  const expiresAt = update.expiresAt !== undefined ? update.expiresAt : current.expiresAt;
  // Stored secrets are not re-validated (pass ""), incoming values are; unknown keys get reported.
  const validationFields: Record<string, string> = { ...nextPlain, ...incoming };
  throwIfInvalid(
    validateCredentialInput({ name, fields: validationFields, expiresAt }, provider, {
      existingSecrets: Object.keys(nextSecrets),
    }),
  );

  const valuesChanged =
    opened.broken || !sameValues(current.fields, nextPlain) || !sameValues(opened.values, nextSecrets);
  const result = options.test ? await runProbe(provider, { ...nextPlain, ...nextSecrets }) : null;
  const key = Object.keys(nextSecrets).length > 0 ? encryptionKey() : null;

  const saved = await mutate(repo, (list) => {
    const record = findOrThrow(list, id);
    if (record.updatedAt !== current.updatedAt) {
      throw new HttpError(409, "The credential was changed meanwhile; reload and try again");
    }
    record.name = name;
    record.expiresAt = normalizeExpiry(expiresAt);
    if (update.autoCheck !== undefined) record.autoCheck = update.autoCheck;
    record.fields = nextPlain;
    // Unchanged secrets keep their ciphertext, so the fingerprint only moves on real changes.
    record.secrets = Object.fromEntries(
      Object.entries(nextSecrets).map(([field, value]) => [
        field,
        opened.values[field] === value && current.secrets[field]
          ? current.secrets[field]
          : encrypt(value, key as Buffer, record.id, field),
      ]),
    );
    if (valuesChanged) Object.assign(record, untestedState());
    if (result) applyResult(record, result);
    record.updatedAt = new Date().toISOString();
    return record;
  });
  return toSummary(saved);
}

export async function deleteCredential(repo: Repository, id: string): Promise<void> {
  // Saving prunes the credential's read/dismissed notification ids.
  await mutate(repo, (list) => {
    list.splice(list.indexOf(findOrThrow(list, id)), 1);
  });
}

/**
 * Probe form values without saving anything. With `id`, secret fields left empty use that
 * credential's stored values (the edit form never sees them).
 */
export async function testCredentialInput(
  repo: Repository,
  input: Pick<CredentialInput, "providerId" | "fields">,
  id?: string,
): Promise<CredentialTestResult> {
  const provider = requireProvider(input.providerId);
  const fields = trimFields(input.fields);
  if (id) {
    const record = findOrThrow(await loadAll(repo), id);
    if (record.providerId !== provider.id) throw new HttpError(400, "providerId does not match the credential");
    const stored = openSecrets(record).values;
    for (const field of provider.fields) {
      if (field.kind === "secret" && !fields[field.key] && stored[field.key]) fields[field.key] = stored[field.key];
    }
  }
  throwIfInvalid(validateCredentialFields(provider, fields));
  const { plain, secrets } = splitFields(provider, fields);
  return runProbe(provider, { ...plain, ...secrets });
}

// ---------------------------------------------------------------------------------------------
// Notifications

type LiveNotification = Omit<CredentialNotification, "read">;

/** Every current notification condition, dismissed or not. */
function liveNotifications(summaries: CredentialSummary[], now = Date.now()): LiveNotification[] {
  const out: LiveNotification[] = [];
  for (const c of summaries) {
    const providerName = getCredentialProvider(c.providerId)?.name ?? c.providerId;
    // Names often already say the provider ("Slack (team bot)"): don't repeat it.
    const label = c.name.toLowerCase().includes(providerName.toLowerCase()) ? c.name : `${c.name} (${providerName})`;
    // An expiry condition never predates the credential (e.g. created 3 days before it expires).
    const created = Date.parse(c.createdAt);
    const since = (start: number): string => new Date(Math.max(start, created)).toISOString();
    const base = { credentialId: c.id, credentialName: c.name, providerId: c.providerId };
    if (c.health === "failing" && c.failingSince) {
      out.push({
        ...base,
        id: `${c.id}:failing:${c.failingSince}`,
        kind: "failing",
        severity: "error",
        title: `${label} is failing`,
        message: c.lastMessage ?? "The health check failed",
        createdAt: c.failingSince,
      });
    }
    const expires = c.expiresAt ? Date.parse(c.expiresAt) : Number.NaN;
    if (c.expiresAt && Number.isFinite(expires)) {
      if (expires <= now) {
        out.push({
          ...base,
          id: `${c.id}:expired:${c.expiresAt}`,
          kind: "expired",
          severity: "error",
          title: `${label} has expired`,
          message: `Expired on ${c.expiresAt.slice(0, 10)}. Replace the key to keep agents working.`,
          createdAt: since(expires),
        });
      } else if (expires - now <= CREDENTIAL_EXPIRY_WARNING_MS) {
        out.push({
          ...base,
          id: `${c.id}:expiring:${c.expiresAt}`,
          kind: "expiring",
          severity: "warning",
          title: `${label} expires soon`,
          message: `Expires on ${c.expiresAt.slice(0, 10)}.`,
          createdAt: since(expires - CREDENTIAL_EXPIRY_WARNING_MS),
        });
      }
    }
    if (c.health === "untested" && now - Date.parse(c.createdAt) > UNTESTED_NOTICE_MS) {
      out.push({
        ...base,
        id: `${c.id}:untested:${c.createdAt}`,
        kind: "untested",
        severity: "info",
        title: `${label} has not been tested`,
        message: "Run a health check to confirm it works.",
        createdAt: c.createdAt,
      });
    }
  }
  return out;
}

function notificationsResponse(list: StoredCredential[], state: NotificationState): CredentialNotificationsResponse {
  const read = new Set(state.read);
  const dismissed = new Set(state.dismissed);
  const notifications = liveNotifications(list.map(toSummary))
    .filter((n) => !dismissed.has(n.id))
    .map((n) => ({ ...n, read: read.has(n.id) }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { notifications, unread: notifications.filter((n) => !n.read).length };
}

export async function getNotifications(repo: Repository): Promise<CredentialNotificationsResponse> {
  return notificationsResponse(await loadAll(repo), await loadNotificationState(repo));
}

/** `ids` for read/dismiss (unknown ids are ignored); read-all/dismiss-all cover every visible one. */
export async function updateNotifications(
  repo: Repository,
  action: CredentialNotificationAction,
  ids: string[] = [],
): Promise<CredentialNotificationsResponse> {
  return withLock(async () => {
    const list = await loadAll(repo);
    const state = await loadNotificationState(repo);
    const visible = notificationsResponse(list, state).notifications.map((n) => n.id);
    const targets = action === "read-all" || action === "dismiss-all" ? visible : ids;
    if (action === "read" || action === "read-all") state.read.push(...targets);
    else state.dismissed.push(...targets);
    return notificationsResponse(list, await saveNotificationState(repo, list, state));
  });
}

// ---------------------------------------------------------------------------------------------
// Request bodies

function optionalString(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${label} must be a string`);
  if (value.length > max) throw new HttpError(400, `${label} is too long`);
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new HttpError(400, `${label} must be a boolean`);
  return value;
}

function parseFields(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "fields must be an object of strings");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [key, optionalString(v, `fields.${key}`, MAX_FIELD_LENGTH) ?? ""]),
  );
}

function parseExpiresAt(value: unknown): string | null | undefined {
  if (value === null) return null;
  return optionalString(value, "expiresAt", 100);
}

function parseProviderId(value: unknown): CredentialProviderId {
  if (typeof value !== "string" || !value) throw new HttpError(400, "providerId is required");
  if (!isCredentialProviderId(value)) throw new HttpError(400, `Unknown provider: ${value}`);
  return value;
}

/** POST /credentials and POST /credentials/test bodies (`name` may be absent for a test). */
export function parseCredentialInput(body: Record<string, unknown>): {
  input: CredentialInput;
  test: boolean;
  id?: string;
} {
  const input: CredentialInput = {
    providerId: parseProviderId(body.providerId),
    name: optionalString(body.name, "name", MAX_NAME_LENGTH) ?? "",
    fields: parseFields(body.fields) ?? {},
  };
  const expiresAt = parseExpiresAt(body.expiresAt);
  if (expiresAt !== undefined) input.expiresAt = expiresAt;
  const autoCheck = optionalBoolean(body.autoCheck, "autoCheck");
  if (autoCheck !== undefined) input.autoCheck = autoCheck;
  const id = body.id === null ? undefined : optionalString(body.id, "id", 100);
  return { input, test: optionalBoolean(body.test, "test") ?? false, ...(id ? { id } : {}) };
}

/** PATCH /credentials/[id] body. */
export function parseCredentialUpdate(body: Record<string, unknown>): { update: CredentialUpdate; test: boolean } {
  if (body.providerId !== undefined) throw new HttpError(400, "providerId cannot be changed");
  const update: CredentialUpdate = {};
  const name = optionalString(body.name, "name", MAX_NAME_LENGTH);
  if (name !== undefined) update.name = name;
  const fields = parseFields(body.fields);
  if (fields) update.fields = fields;
  if (body.clear !== undefined) {
    if (!Array.isArray(body.clear) || body.clear.some((key) => typeof key !== "string")) {
      throw new HttpError(400, "clear must be an array of field keys");
    }
    update.clear = body.clear as string[];
  }
  const expiresAt = parseExpiresAt(body.expiresAt);
  if (expiresAt !== undefined) update.expiresAt = expiresAt;
  const autoCheck = optionalBoolean(body.autoCheck, "autoCheck");
  if (autoCheck !== undefined) update.autoCheck = autoCheck;
  return { update, test: optionalBoolean(body.test, "test") ?? false };
}

/** POST /credentials/notifications body. */
export function parseNotificationAction(body: Record<string, unknown>): {
  action: CredentialNotificationAction;
  ids: string[];
} {
  const action = body.action;
  if (typeof action !== "string" || !(NOTIFICATION_ACTIONS as readonly string[]).includes(action)) {
    throw new HttpError(400, `action must be one of: ${NOTIFICATION_ACTIONS.join(", ")}`);
  }
  let ids: string[] = [];
  if (body.ids !== undefined && body.ids !== null) {
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string")) {
      throw new HttpError(400, "ids must be an array of strings");
    }
    ids = body.ids as string[];
  }
  if ((action === "read" || action === "dismiss") && ids.length === 0) {
    throw new HttpError(400, `ids are required for ${action}`);
  }
  return { action: action as CredentialNotificationAction, ids };
}
