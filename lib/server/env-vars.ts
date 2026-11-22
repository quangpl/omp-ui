// Server-only store behind `/api/v1/env`: custom environment variables every agent child process
// receives (lib/child-env.ts `setUserEnv`). Kept in the settings table under `env_vars`, values
// sealed with the credentials key. Loaded at boot and after every change.
import { SECRET_ENV_KEYS, setUserEnv } from "@/lib/child-env";
import type { Repository } from "@/lib/db/types";
import { ENV_KEY_PATTERN, MAX_ENV_VALUE_LENGTH, type EnvVar, type EnvVarsResponse } from "@/lib/env-vars";
import { openSecret, sealSecret } from "@/lib/server/credentials";
import { HttpError } from "@/lib/server/http";

const STORE_KEY = "env_vars";

/** Key → sealed value. */
type Store = Record<string, { value: string; updatedAt: string }>;

const g = globalThis as unknown as { __ompUiEnvVarsLock?: Promise<unknown> };

const scope = (key: string) => `env:${key}`;

async function loadStore(repo: Repository): Promise<Store> {
  const raw = await repo.getSetting(STORE_KEY);
  // Corrupt JSON throws: answering an empty store would let the next write wipe every variable.
  const data = raw ? (JSON.parse(raw) as unknown) : null;
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Store) : {};
}

/** Decrypted vars; entries that cannot be decrypted (the encryption key changed) are left out. */
function open(store: Store): EnvVar[] {
  const vars: EnvVar[] = [];
  for (const [key, entry] of Object.entries(store)) {
    const value = openSecret(entry.value, scope(key));
    if (value !== null) vars.push({ key, value, updatedAt: entry.updatedAt });
  }
  return vars.sort((a, b) => a.key.localeCompare(b.key));
}

function apply(store: Store): EnvVar[] {
  const vars = open(store);
  setUserEnv(Object.fromEntries(vars.map((v) => [v.key, v.value])));
  return vars;
}

/** Hand the saved variables to every agent child started from now on. Call at boot; never throws. */
export async function loadEnvVars(repo: Repository): Promise<void> {
  try {
    apply(await loadStore(repo));
  } catch (err) {
    console.error("[env-vars] Cannot read the saved environment variables:", err instanceof Error ? err.message : err);
  }
}

export async function listEnvVars(repo: Repository): Promise<EnvVarsResponse> {
  return { vars: open(await loadStore(repo)) };
}

/** Serialize read-modify-write cycles in this process so concurrent requests never lose updates. */
function mutate(repo: Repository, fn: (store: Store) => void): Promise<EnvVarsResponse> {
  const run = Promise.resolve(g.__ompUiEnvVarsLock).then(async () => {
    const store = await loadStore(repo);
    fn(store);
    await repo.setSetting(STORE_KEY, JSON.stringify(store));
    return { vars: apply(store) };
  });
  g.__ompUiEnvVarsLock = run.catch(() => undefined);
  return run;
}

function badKey(key: string): string | null {
  if (!ENV_KEY_PATTERN.test(key)) return "must match [A-Za-z_][A-Za-z0-9_]*";
  if (SECRET_ENV_KEYS.includes(key) || key.startsWith("OMP_UI_")) return "is reserved for AgentMan";
  return null;
}

/** Validated `{ KEY: value }` body of PUT /env; 400 names the offending keys. */
export function parseEnvVarsInput(body: Record<string, unknown>): Record<string, string> {
  const vars = body.vars;
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) throw new HttpError(400, "vars must be an object of KEY: value");
  const entries = Object.entries(vars as Record<string, unknown>);
  const problems: string[] = [];
  for (const [key, value] of entries) {
    const bad = badKey(key);
    if (bad) problems.push(`${key} ${bad}`);
    else if (typeof value !== "string") problems.push(`${key} must be a string`);
    else if (value.length > MAX_ENV_VALUE_LENGTH) problems.push(`${key} is longer than ${MAX_ENV_VALUE_LENGTH} characters`);
  }
  if (problems.length > 0) throw new HttpError(400, problems.join("; "));
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Add or overwrite variables; answers the new list. */
export function setEnvVars(repo: Repository, vars: Record<string, string>): Promise<EnvVarsResponse> {
  const now = new Date().toISOString();
  return mutate(repo, (store) => {
    for (const [key, value] of Object.entries(vars)) store[key] = { value: sealSecret(value, scope(key)), updatedAt: now };
  });
}

export function deleteEnvVar(repo: Repository, key: string): Promise<EnvVarsResponse> {
  return mutate(repo, (store) => {
    if (!(key in store)) throw new HttpError(404, "Variable not found");
    delete store[key];
  });
}
