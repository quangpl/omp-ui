// Server-only store behind `/api/v1/settings/ai-providers` (Settings → AI Providers). Values live
// in the settings table under `ai_providers`, each sealed with the credentials key
// (`sealSecret(value, "ai-provider:<ENV_VAR>")`); plaintext is never stored or logged and secrets
// only leave this module masked. Saved values override the same env vars inherited from the
// server's process.env for every omp child (lib/child-env.ts `setProviderEnv`): loaded at boot,
// replaced on every save, so a new key works for the next agent without a restart.
//
// NOTE: lib/server/http.ts imports lib/agent/manager.ts, which imports this module: never use an
// import from lib/server/http.ts at module evaluation time (e.g. `class … extends HttpError`).
import {
  AI_PROVIDERS,
  aiFieldError,
  aiModelProviders,
  completeMethod,
  getAiProvider,
  isAiProviderId,
  isMethodComplete,
  type AiAuthMethod,
  type AiOtherProvider,
  type AiProviderDefinition,
  type AiProviderFieldState,
  type AiProviderId,
  type AiProviderModel,
  type AiProviderState,
  type AiProvidersResponse,
  type AiProviderStatus,
  type AiProviderTestInput,
  type AiProviderTestResponse,
  type AiProviderTestResult,
  type AiProviderUpdate,
} from "@/lib/ai-providers";
import { setProviderEnv } from "@/lib/child-env";
import { maskSecret } from "@/lib/credential-providers";
import type { Repository } from "@/lib/db/types";
import { probeAiProvider } from "@/lib/server/credential-checks";
import { CredentialValidationError, openSecret, sealSecret } from "@/lib/server/credentials";
import { HttpError } from "@/lib/server/http";
import { listOmpModels } from "@/lib/server/omp-config";
import { getAiStats } from "@/lib/stats";
import type { AiProviderQuota, OmpModel } from "@/lib/types";

const STORE_KEY = "ai_providers";
const MAX_VALUE_LENGTH = 16 * 1024;
const BROKEN_MESSAGE = "A saved value can no longer be decrypted (the encryption key changed): enter it again";
const NO_MODELS_MESSAGE = "omp lists no models: omp is missing, `omp models` failed, or no provider is set up";

interface StoredProvider {
  /** Env var → sealed value. */
  values: Record<string, string>;
  lastTest: AiProviderTestResult | null;
  updatedAt: string;
}

type Store = Partial<Record<AiProviderId, StoredProvider>>;

/** A provider's saved values opened: decrypted ones, and env vars whose value cannot be decrypted. */
interface OpenedValues {
  saved: Record<string, string>;
  broken: Set<string>;
}

/** What omp reports, fetched once per request. */
interface OmpSnapshot {
  models: OmpModel[];
  quota: AiProviderQuota[];
}

// On globalThis so dev hot reloads share one write lock.
const g = globalThis as unknown as { __ompUiAiProvidersLock?: Promise<void> };

function scope(envVar: string): string {
  return `ai-provider:${envVar}`;
}

// ---------------------------------------------------------------------------------------------
// Storage

function parseLastTest(value: unknown): AiProviderTestResult | null {
  if (!value || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  if (
    typeof t.ok !== "boolean" ||
    typeof t.message !== "string" ||
    typeof t.latencyMs !== "number" ||
    typeof t.checkedAt !== "string"
  ) {
    return null;
  }
  return { ok: t.ok, message: t.message, latencyMs: t.latencyMs, checkedAt: t.checkedAt };
}

/** Tolerant: unknown providers and env vars are ignored. Corrupt JSON throws (see below). */
async function loadStore(repo: Repository): Promise<Store> {
  const raw = await repo.getSetting(STORE_KEY);
  if (!raw) return {};
  // Corrupt JSON throws: answering an empty store would let the next write wipe every saved key.
  const data = JSON.parse(raw) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const store: Store = {};
  for (const [id, entry] of Object.entries(data as Record<string, unknown>)) {
    const provider = getAiProvider(id);
    if (!provider || !entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const values: Record<string, string> = {};
    if (e.values && typeof e.values === "object") {
      for (const field of provider.fields) {
        const sealed = (e.values as Record<string, unknown>)[field.envVar];
        if (typeof sealed === "string" && sealed) values[field.envVar] = sealed;
      }
    }
    const lastTest = parseLastTest(e.lastTest);
    if (Object.keys(values).length === 0 && !lastTest) continue;
    store[provider.id] = {
      values,
      lastTest,
      updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : new Date(0).toISOString(),
    };
  }
  return store;
}

/** Serialize read-modify-write cycles in this process so concurrent requests never lose updates. */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = (g.__ompUiAiProvidersLock ?? Promise.resolve()).then(fn);
  g.__ompUiAiProvidersLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Locked load → `fn` edits the store in place → save (skipped when `fn` throws) → overlay refresh. */
function mutate<T>(repo: Repository, fn: (store: Store) => T): Promise<T> {
  return withLock(async () => {
    const store = await loadStore(repo);
    const result = fn(store);
    await repo.setSetting(STORE_KEY, JSON.stringify(store));
    applyOverlay(store);
    return result;
  });
}

function openValues(stored: StoredProvider | undefined): OpenedValues {
  const opened: OpenedValues = { saved: {}, broken: new Set() };
  for (const [envVar, sealed] of Object.entries(stored?.values ?? {})) {
    const plain = openSecret(sealed, scope(envVar));
    if (plain === null) opened.broken.add(envVar);
    else opened.saved[envVar] = plain;
  }
  return opened;
}

/** Hand every decryptable saved value to child processes; returns env vars that could not be decrypted. */
function applyOverlay(store: Store): string[] {
  const overlay: Record<string, string> = {};
  const broken: string[] = [];
  for (const provider of AI_PROVIDERS) {
    const opened = openValues(store[provider.id]);
    Object.assign(overlay, opened.saved);
    broken.push(...opened.broken);
  }
  setProviderEnv(overlay);
  return broken;
}

/**
 * Apply the saved values to every omp child started from now on. Call at boot, before anything
 * spawns omp. Never throws: an unreadable store leaves the inherited environment alone.
 */
export async function loadAiProviderEnv(repo: Repository): Promise<void> {
  let store: Store;
  try {
    store = await loadStore(repo);
  } catch {
    console.error("[ai-providers] Cannot read the saved AI provider settings (corrupt JSON); using the server environment only");
    return;
  }
  const broken = applyOverlay(store);
  if (broken.length > 0) {
    console.error(
      `[ai-providers] Cannot decrypt saved ${broken.join(", ")} (the encryption key changed): enter them again in Settings → AI Providers`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// State

function environmentValue(envVar: string): string | undefined {
  return process.env[envVar]?.trim() || undefined;
}

/** What omp children see: the saved value, else the server environment's. */
function effectiveValues(provider: AiProviderDefinition, opened: OpenedValues): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of provider.fields) {
    const value = opened.saved[field.envVar] ?? environmentValue(field.envVar);
    if (value) values[field.envVar] = value;
  }
  return values;
}

function fieldStates(provider: AiProviderDefinition, opened: OpenedValues): Record<string, AiProviderFieldState> {
  const fields: Record<string, AiProviderFieldState> = {};
  for (const field of provider.fields) {
    const saved = opened.saved[field.envVar];
    const env = environmentValue(field.envVar);
    const value = saved ?? env;
    fields[field.envVar] = {
      envVar: field.envVar,
      source: saved !== undefined ? "settings" : env ? "environment" : null,
      value: value === undefined ? null : field.secret ? maskSecret(value) : value,
      overridesEnvironment: saved !== undefined && !!env,
      broken: opened.broken.has(field.envVar),
    };
  }
  return fields;
}

function modelProvider(model: OmpModel): string {
  return model.provider || model.selector.split("/")[0] || "";
}

/** Models of the omp providers `ids`, in omp's order. */
function modelsOf(models: OmpModel[], ids: Set<string>): AiProviderModel[] {
  return models
    .filter((model) => ids.has(modelProvider(model)))
    .map((model) => ({ selector: model.selector, name: model.name }));
}

function providerModels(provider: AiProviderDefinition, models: OmpModel[]): AiProviderModel[] {
  return modelsOf(models, new Set(aiModelProviders(provider)));
}

function signInFrom(quota: AiProviderQuota[], ids: Set<string>): { account: string | null } | null {
  const matches = quota.filter((q) => ids.has(q.provider));
  if (matches.length === 0) return null;
  return { account: matches.find((q) => q.account)?.account ?? null };
}

function providerSignIn(provider: AiProviderDefinition, quota: AiProviderQuota[]): { account: string | null } | null {
  return signInFrom(quota, new Set([provider.id, ...aiModelProviders(provider)]));
}

function fieldLabel(provider: AiProviderDefinition, envVar: string): string {
  return provider.fields.find((f) => f.envVar === envVar)?.label ?? envVar;
}

/** "Incomplete: <method> needs <fields>" for the method closest to complete (catalog order breaks ties). */
function incompleteMessage(provider: AiProviderDefinition, values: Record<string, string>): string {
  const has = (envVar: string) => !!values[envVar];
  const score = (method: AiAuthMethod) =>
    method.required.filter(has).length + (method.anyOf?.some(has) ? 1 : 0);
  let best = provider.methods[0];
  for (const method of provider.methods) if (score(method) > score(best)) best = method;
  const missing = best.required.filter((envVar) => !has(envVar)).map((envVar) => fieldLabel(provider, envVar));
  if (best.anyOf && !best.anyOf.some(has)) {
    missing.push(best.anyOf.map((envVar) => fieldLabel(provider, envVar)).join(" or "));
  }
  return `Incomplete: ${best.label} needs ${missing.join(", ")}`;
}

/** Where the credentials omp uses come from, for the status line. */
function sourceLabel(
  provider: AiProviderDefinition,
  values: Record<string, string>,
  opened: OpenedValues,
  signIn: { account: string | null } | null,
): string {
  const method = completeMethod(provider, values);
  if (method) {
    const used = [...method.required, ...(method.anyOf ?? []), ...(method.optional ?? [])].filter((v) => values[v]);
    const what = method.kind === "aws" ? "credentials" : "key";
    return used.some((envVar) => opened.saved[envVar] !== undefined)
      ? `${what} saved in Settings`
      : "from the server environment";
  }
  if (signIn) return `signed in through omp${signIn.account ? ` (${signIn.account})` : ""}`;
  // No complete method: omp uses its own stored credentials (e.g. a key `omp login` issued).
  return Object.keys(values).length > 0 ? "from the server environment" : "from omp's credential store";
}

/**
 * Status rules, first match wins:
 * 1. a saved value cannot be decrypted → error;
 * 2. no complete method, no omp sign-in and no models → not-configured ("Incomplete: …" when some
 *    values are set);
 * 3. the last test of the current values failed → error;
 * 4. omp lists models for it → authenticated;
 * 5. omp's whole model list is unavailable → unverified, or authenticated when the last test passed;
 * 6. otherwise (credentials or a sign-in, but omp lists no models for them) → error.
 */
function providerStatus(
  provider: AiProviderDefinition,
  values: Record<string, string>,
  opened: OpenedValues,
  activeMethods: string[],
  signIn: { account: string | null } | null,
  models: AiProviderModel[],
  lastTest: AiProviderTestResult | null,
  modelsError: string | null,
): { status: AiProviderStatus; statusMessage: string } {
  if (opened.broken.size > 0) return { status: "error", statusMessage: BROKEN_MESSAGE };
  if (activeMethods.length === 0 && !signIn && models.length === 0) {
    return {
      status: "not-configured",
      statusMessage: Object.keys(values).length > 0 ? incompleteMessage(provider, values) : "Not configured",
    };
  }
  if (lastTest?.ok === false) return { status: "error", statusMessage: `Last test failed: ${lastTest.message}` };
  if (models.length > 0) {
    return {
      status: "authenticated",
      statusMessage: `omp lists ${models.length} model${models.length === 1 ? "" : "s"} · ${sourceLabel(provider, values, opened, signIn)}`,
    };
  }
  if (modelsError) {
    return lastTest?.ok
      ? { status: "authenticated", statusMessage: `Last test passed: ${lastTest.message}` }
      : { status: "unverified", statusMessage: `Not verified: ${modelsError}` };
  }
  return { status: "error", statusMessage: "omp lists no models for these credentials" };
}

function providerState(
  provider: AiProviderDefinition,
  stored: StoredProvider | undefined,
  omp: OmpSnapshot,
  modelsError: string | null,
): AiProviderState {
  const opened = openValues(stored);
  const values = effectiveValues(provider, opened);
  const activeMethods = provider.methods.filter((method) => isMethodComplete(method, values)).map((m) => m.id);
  const ompSignIn = providerSignIn(provider, omp.quota);
  const models = providerModels(provider, omp.models);
  const lastTest = stored?.lastTest ?? null;
  return {
    id: provider.id,
    ...providerStatus(provider, values, opened, activeMethods, ompSignIn, models, lastTest, modelsError),
    activeMethods,
    fields: fieldStates(provider, opened),
    ompSignIn,
    models,
    lastTest,
  };
}

/** Providers omp lists models for or reports a sign-in for that no catalog entry covers. */
function otherProviders(omp: OmpSnapshot): AiOtherProvider[] {
  const covered = new Set(AI_PROVIDERS.flatMap((p) => [p.id, ...aiModelProviders(p)]));
  const ids = new Set<string>();
  for (const model of omp.models) ids.add(modelProvider(model));
  for (const q of omp.quota) ids.add(q.provider);
  return [...ids]
    .filter((id) => id && !covered.has(id))
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({
      id,
      models: modelsOf(omp.models, new Set([id])),
      ompSignIn: signInFrom(omp.quota, new Set([id])),
    }));
}

/** omp's model list and sign-ins in parallel (both cached; `refresh` re-runs omp). */
async function ompSnapshot(ompPath: string, refresh: boolean): Promise<OmpSnapshot> {
  const [models, quota] = await Promise.all([
    listOmpModels(ompPath, { refresh }),
    getAiStats(ompPath, { refresh })
      .then((stats) => stats.quota.providers)
      .catch(() => [] as AiProviderQuota[]),
  ]);
  return { models, quota };
}

function buildResponse(store: Store, omp: OmpSnapshot): AiProvidersResponse {
  const modelsError = omp.models.length === 0 ? NO_MODELS_MESSAGE : null;
  return {
    providers: AI_PROVIDERS.map((provider) => providerState(provider, store[provider.id], omp, modelsError)),
    other: otherProviders(omp),
    modelsError,
    keySource: process.env.CREDENTIALS_KEY?.trim() ? "env" : "file",
    generatedAt: new Date().toISOString(),
  };
}

/** Every catalog provider with its auth status; `refresh` re-runs `omp models` and `omp usage`. */
export async function getAiProviders(
  repo: Repository,
  ompPath: string,
  options: { refresh?: boolean } = {},
): Promise<AiProvidersResponse> {
  const [store, omp] = await Promise.all([loadStore(repo), ompSnapshot(ompPath, !!options.refresh)]);
  return buildResponse(store, omp);
}

// ---------------------------------------------------------------------------------------------
// Update / test

function requireProvider(providerId: string): AiProviderDefinition {
  const provider = getAiProvider(providerId);
  if (!provider) throw new HttpError(400, `Unknown provider: ${providerId}`);
  return provider;
}

/** Trimmed non-empty values; field errors (keyed by env var) for unknown env vars and bad formats. */
function validateValues(
  provider: AiProviderDefinition,
  values: Record<string, string> | undefined,
  errors: Record<string, string>,
): Record<string, string> {
  const valid: Record<string, string> = {};
  for (const [envVar, value] of Object.entries(values ?? {})) {
    const trimmed = value.trim();
    // aiFieldError also rejects env vars that are not this provider's (even when empty).
    const error =
      trimmed.length > MAX_VALUE_LENGTH
        ? `${fieldLabel(provider, envVar)} is too long`
        : aiFieldError(provider, envVar, trimmed);
    if (error) errors[envVar] = error;
    else if (trimmed) valid[envVar] = trimmed;
  }
  return valid;
}

/** Identifies the saved values a test ran against (sealing again gives a new IV, so this changes on save). */
function valuesKey(stored: StoredProvider | undefined): string {
  return JSON.stringify(stored?.values ?? {});
}

/** Store a test of the saved values unless they changed meanwhile. */
async function commitLastTest(
  repo: Repository,
  providerId: AiProviderId,
  snapshot: string,
  result: AiProviderTestResult,
): Promise<void> {
  await withLock(async () => {
    const store = await loadStore(repo);
    if (valuesKey(store[providerId]) !== snapshot) return;
    store[providerId] = {
      values: store[providerId]?.values ?? {},
      lastTest: result,
      updatedAt: store[providerId]?.updatedAt ?? new Date().toISOString(),
    };
    await repo.setSetting(STORE_KEY, JSON.stringify(store));
  });
}

/** Whether omp lists the provider's models after a fresh `omp models` (runs with the saved values). */
async function testThroughOmp(provider: AiProviderDefinition, ompPath: string): Promise<{ ok: boolean; message: string }> {
  const models = providerModels(provider, await listOmpModels(ompPath, { refresh: true }));
  return models.length > 0
    ? { ok: true, message: `omp lists ${models.length} model${models.length === 1 ? "" : "s"}` }
    : { ok: false, message: `omp lists no ${provider.name} models` };
}

/**
 * Test `values` (env var → value): the provider's own API when a method is complete, else omp's
 * model listing when omp has a sign-in or models for it. `overridden`: `values` include unsaved
 * input, which omp (running with the saved values) cannot check.
 */
async function runTest(
  provider: AiProviderDefinition,
  values: Record<string, string>,
  ompPath: string,
  overridden: boolean,
): Promise<AiProviderTestResult> {
  const method = completeMethod(provider, values);
  // Probe directly: a complete method, or incomplete values omp knows nothing about ("Incomplete: …").
  let probe = !!method;
  if (!method) {
    const omp = await ompSnapshot(ompPath, false);
    const ompKnows = !!providerSignIn(provider, omp.quota) || providerModels(provider, omp.models).length > 0;
    if (!ompKnows && Object.keys(values).length === 0) {
      throw new HttpError(400, "Nothing to test: enter credentials first");
    }
    probe = !ompKnows;
  }
  const checkedAt = new Date().toISOString();
  const started = performance.now();
  let outcome = probe
    ? await probeAiProvider(provider, values).catch((err: unknown) => ({
        // probeAiProvider never throws by contract; stay safe anyway.
        ok: false,
        message: (err instanceof Error && err.message) || "Test failed",
      }))
    : null;
  // null: the complete method (e.g. an AWS profile) can only be checked through omp.
  if (!outcome) {
    if (method && overridden) {
      throw new HttpError(400, `Save first: omp tests ${method.label} with the saved values`);
    }
    outcome = await testThroughOmp(provider, ompPath);
  }
  return { ok: outcome.ok, message: outcome.message, latencyMs: Math.round(performance.now() - started), checkedAt };
}

/**
 * Save (`values`, trimmed; "" keeps the saved value) and remove (`clear`) values. Any change resets
 * `lastTest`, updates the child environment and re-lists omp's models and sign-ins; `test` then
 * tests the new effective values and stores the outcome.
 */
export async function updateAiProvider(
  repo: Repository,
  ompPath: string,
  update: AiProviderUpdate,
): Promise<AiProvidersResponse> {
  const provider = requireProvider(update.providerId);
  const errors: Record<string, string> = {};
  const values = validateValues(provider, update.values, errors);
  for (const envVar of update.clear ?? []) {
    const error = aiFieldError(provider, envVar, "");
    if (error) errors[envVar] = error;
  }
  if (Object.keys(errors).length > 0) throw new CredentialValidationError(errors);

  const snapshot = await mutate(repo, (store) => {
    const current = store[provider.id];
    const opened = openValues(current);
    const sealed = { ...current?.values };
    let changed = false;
    // Clear first, so a value sent in both wins.
    for (const envVar of update.clear ?? []) {
      if (envVar in sealed) {
        delete sealed[envVar];
        changed = true;
      }
    }
    for (const [envVar, value] of Object.entries(values)) {
      if (envVar in sealed && opened.saved[envVar] === value) continue;
      sealed[envVar] = sealSecret(value, scope(envVar));
      changed = true;
    }
    const lastTest = changed ? null : (current?.lastTest ?? null);
    if (Object.keys(sealed).length === 0 && !lastTest) {
      delete store[provider.id];
    } else {
      store[provider.id] = {
        values: sealed,
        lastTest,
        updatedAt: changed || !current ? new Date().toISOString() : current.updatedAt,
      };
    }
    return { key: valuesKey(store[provider.id]), effective: effectiveValues(provider, openValues(store[provider.id])) };
  });

  // omp re-reads its environment per run: list models and sign-ins with the new values.
  await ompSnapshot(ompPath, true);
  if (update.test) {
    const result = await runTest(provider, snapshot.effective, ompPath, false);
    await commitLastTest(repo, provider.id, snapshot.key, result);
  }
  return getAiProviders(repo, ompPath);
}

/** Test the effective values, with non-empty `input.values` in place of saved ones (not saved). */
export async function testAiProvider(
  repo: Repository,
  ompPath: string,
  input: AiProviderTestInput,
): Promise<AiProviderTestResponse> {
  const provider = requireProvider(input.providerId);
  const errors: Record<string, string> = {};
  const overrides = validateValues(provider, input.values, errors);
  if (Object.keys(errors).length > 0) throw new CredentialValidationError(errors);

  const stored = (await loadStore(repo))[provider.id];
  const effective = effectiveValues(provider, openValues(stored));
  const overridden = Object.entries(overrides).some(([envVar, value]) => effective[envVar] !== value);
  const result = await runTest(provider, { ...effective, ...overrides }, ompPath, overridden);
  if (!overridden) await commitLastTest(repo, provider.id, valuesKey(stored), result);

  const state = (await getAiProviders(repo, ompPath)).providers.find((p) => p.id === provider.id)!;
  return { result, provider: state };
}

// ---------------------------------------------------------------------------------------------
// Request bodies

function parseProviderId(value: unknown): AiProviderId {
  if (typeof value !== "string" || !value) throw new HttpError(400, "providerId is required");
  if (!isAiProviderId(value)) throw new HttpError(400, `Unknown provider: ${value}`);
  return value;
}

function parseValues(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((v) => typeof v !== "string")
  ) {
    throw new HttpError(400, "values must be an object of strings");
  }
  return { ...(value as Record<string, string>) };
}

/** PATCH /settings/ai-providers body. */
export function parseAiProviderUpdate(body: Record<string, unknown>): AiProviderUpdate {
  const update: AiProviderUpdate = { providerId: parseProviderId(body.providerId) };
  const values = parseValues(body.values);
  if (values) update.values = values;
  if (body.clear !== undefined) {
    if (!Array.isArray(body.clear) || body.clear.some((key) => typeof key !== "string")) {
      throw new HttpError(400, "clear must be an array of env var names");
    }
    update.clear = body.clear as string[];
  }
  if (body.test !== undefined) {
    if (typeof body.test !== "boolean") throw new HttpError(400, "test must be a boolean");
    update.test = body.test;
  }
  return update;
}

/** POST /settings/ai-providers/test body. */
export function parseAiProviderTestInput(body: Record<string, unknown>): AiProviderTestInput {
  const input: AiProviderTestInput = { providerId: parseProviderId(body.providerId) };
  const values = parseValues(body.values);
  if (values) input.values = values;
  return input;
}
