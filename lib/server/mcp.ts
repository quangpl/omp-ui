// Server-only store behind `/api/v1/mcp/**` (the /mcp page). Each connected MCP server is a record
// in the settings table under `mcp_servers` (name, provider, backing credential, enabled, last
// probe) and an entry in omp's user MCP config (`<omp agent dir>/mcp.json`), so every omp agent
// OMP-UI starts gets its tools. Secrets never reach mcp.json or the store: entries reference
// them as `${OMPUI_MCP_<SERVER>_<FIELD>}` placeholders and the decrypted values go to the agent
// environment cache in lib/server/mcp-env.ts. Entries OMP-UI does not manage and unknown
// top-level keys in mcp.json are kept verbatim; an unparsable mcp.json is reported, never overwritten.
//
// NOTE: like credentials.ts, never use an import from lib/server/http.ts at module evaluation time.
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { getCredentialProvider, isCredentialProviderId, mcpServerConfig } from "@/lib/credential-providers";
import type { CredentialField, CredentialProvider, CredentialProviderId } from "@/lib/credential-types";
import type { Repository } from "@/lib/db/types";
import {
  MCP_ENV_PREFIX,
  MCP_SERVER_NAME_PATTERN,
  type McpConnectInput,
  type McpConnectResult,
  type McpExternalServer,
  type McpProbeResult,
  type McpServerConfig,
  type McpServerStatus,
  type McpServerSummary,
  type McpServerUpdate,
  type McpServersResponse,
} from "@/lib/mcp-types";
import {
  allCredentialValues,
  checkCredential,
  createCredential,
  credentialValues,
  deleteCredential,
  type CredentialValues,
} from "@/lib/server/credentials";
import { HttpError } from "@/lib/server/http";
import { setMcpAgentEnv, setMcpEnvReady } from "@/lib/server/mcp-env";
import { probeMcpServer } from "@/lib/server/mcp-probe";
import { agentDir } from "@/lib/server/omp-config";
import { getAppSettings } from "@/lib/settings";

const STORE_KEY = "mcp_servers";
const CONFIG_FILE = "mcp.json";
const SCHEMA_URL =
  "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";
const NAME_REGEX = new RegExp(MCP_SERVER_NAME_PATTERN);
const MAX_ID_LENGTH = 100;
const MAX_NAME_LENGTH = 200;
const MAX_FIELD_LENGTH = 16 * 1024;

interface StoredMcpServer {
  /** Key under `mcpServers` in mcp.json. */
  name: string;
  providerId: CredentialProviderId;
  credentialId: string;
  enabled: boolean;
  /** Last MCP probe (messages already scrubbed of secrets). */
  probe: McpProbeResult | null;
  createdAt: string;
  updatedAt: string;
}

/** omp's mcp.json as last read. */
interface ConfigFile {
  /** null when omp's agent dir cannot be resolved. */
  path: string | null;
  /** Why the file cannot be read or written, else null. */
  error: string | null;
  /** Parsed content (`{}` when the file is missing); null when `error` is set. */
  data: Record<string, unknown> | null;
  exists: boolean;
}

/** Everything a summary or a write needs, loaded together. */
interface McpState {
  records: StoredMcpServer[];
  credentials: Map<string, CredentialValues>;
  file: ConfigFile;
}

// On globalThis so dev hot reloads share one write lock, one agent dir cache and one boot sync.
const g = globalThis as unknown as {
  __ompUiMcpLock?: Promise<void>;
  __ompUiMcpAgentDirs?: Map<string, string>;
  __ompUiMcpSyncStarted?: boolean;
};

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------------
// Providers and configs

/** The provider of a catalog server; 400 when it is unknown or has no MCP server. */
function mcpProvider(providerId: string): CredentialProvider {
  const provider = getCredentialProvider(providerId);
  if (!provider?.mcp) throw new HttpError(400, `${provider?.name ?? providerId} has no MCP server`);
  return provider;
}

function serverConfig(
  provider: CredentialProvider,
  fields: Record<string, string>,
  secretValue: (field: CredentialField) => string | null,
): McpServerConfig {
  const config = mcpServerConfig(provider, fields, secretValue);
  if (!config) throw new HttpError(400, `${provider.name} has no MCP server`);
  return config;
}

/** Server name as it appears in env var names: upper case, non-alphanumerics → `_`. */
function envSlug(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** `OMPUI_MCP_<SERVER>_<FIELD>`, e.g. aws + secretAccessKey → OMPUI_MCP_AWS_SECRET_ACCESS_KEY. */
function envVarName(server: string, fieldKey: string): string {
  const field = fieldKey
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_");
  return `${MCP_ENV_PREFIX}${envSlug(server)}_${field}`;
}

/**
 * The entry OMP-UI writes for `record`: secrets as placeholders (only those the credential holds,
 * plus required ones), switched off when disabled or when its credential is deleted or unreadable.
 */
function fileEntry(record: StoredMcpServer, credential: CredentialValues | undefined): McpServerConfig {
  const summary = credential?.summary;
  // Summary fields: non-secret values verbatim; masked secrets are ignored by mcpServerConfig.
  const config = serverConfig(mcpProvider(record.providerId), summary?.fields ?? {}, (field) =>
    field.required || summary?.secretsSet.includes(field.key) ? `\${${envVarName(record.name, field.key)}}` : null,
  );
  const runnable = record.enabled && credential !== undefined && !credential.broken;
  return runnable ? config : { ...config, enabled: false };
}

/** Placeholder → decrypted secret for every server that can run. */
function agentEnv(state: McpState): Record<string, string> {
  const env: Record<string, string> = {};
  for (const record of state.records) {
    const credential = state.credentials.get(record.credentialId);
    if (!record.enabled || !credential || credential.broken) continue;
    for (const field of mcpProvider(record.providerId).fields) {
      const value = field.kind === "secret" ? credential.fields[field.key] : undefined;
      if (value) env[envVarName(record.name, field.key)] = value;
    }
  }
  return env;
}

// ---------------------------------------------------------------------------------------------
// Storage

async function loadServers(repo: Repository): Promise<StoredMcpServer[]> {
  const raw = await repo.getSetting(STORE_KEY);
  if (!raw) return [];
  // Corrupt JSON throws: an empty list would let the next write drop every server.
  const data = JSON.parse(raw) as unknown;
  if (!Array.isArray(data)) return [];
  return data.filter(
    (item): item is StoredMcpServer =>
      isObject(item) &&
      typeof item.name === "string" &&
      typeof item.credentialId === "string" &&
      isCredentialProviderId(item.providerId) &&
      !!getCredentialProvider(item.providerId)?.mcp,
  );
}

async function saveServers(repo: Repository, list: StoredMcpServer[]): Promise<void> {
  await repo.setSetting(STORE_KEY, JSON.stringify(list));
}

/** Serialize read-modify-write cycles (store and mcp.json) so concurrent requests never lose updates. */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = (g.__ompUiMcpLock ?? Promise.resolve()).then(fn);
  g.__ompUiMcpLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function findOrThrow(list: StoredMcpServer[], name: string): StoredMcpServer {
  const record = list.find((s) => s.name === name);
  if (!record) throw new HttpError(404, `MCP server not found: ${name}`);
  return record;
}

/** A saved credential usable for `provider`: 404 when unknown, 400 when it belongs to another provider. */
function credentialFor(state: McpState, id: string, provider: CredentialProvider): CredentialValues {
  const credential = state.credentials.get(id);
  if (!credential) throw new HttpError(404, "Credential not found");
  if (credential.summary.providerId !== provider.id) {
    throw new HttpError(400, `That credential is not a ${provider.name} credential`);
  }
  return credential;
}

// ---------------------------------------------------------------------------------------------
// mcp.json

async function configPath(repo: Repository): Promise<string> {
  const { ompPath } = await getAppSettings(repo);
  const dirs = (g.__ompUiMcpAgentDirs ??= new Map<string, string>());
  let dir = dirs.get(ompPath);
  if (!dir) {
    dir = await agentDir(ompPath);
    dirs.set(ompPath, dir);
  }
  return path.join(dir, CONFIG_FILE);
}

async function readConfig(repo: Repository): Promise<ConfigFile> {
  let file: string;
  try {
    file = await configPath(repo);
  } catch (err) {
    return { path: null, error: `Cannot locate omp's MCP config: ${errorMessage(err)}`, data: null, exists: false };
  }
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { path: file, error: null, data: {}, exists: false };
    return { path: file, error: `Cannot read ${file}: ${errorMessage(err)}`, data: null, exists: true };
  }
  if (!raw.trim()) return { path: file, error: null, data: {}, exists: true };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { path: file, error: `${file} is not valid JSON: ${errorMessage(err)} — fix or delete it`, data: null, exists: true };
  }
  if (!isObject(data) || (data.mcpServers !== undefined && !isObject(data.mcpServers))) {
    const reason = 'expected an object with an "mcpServers" object';
    return { path: file, error: `${file} is not valid JSON: ${reason} — fix or delete it`, data: null, exists: true };
  }
  return { path: file, error: null, data, exists: true };
}

function serversOf(data: Record<string, unknown> | null): Record<string, unknown> {
  return data && isObject(data.mcpServers) ? data.mcpServers : {};
}

/** Temp file + rename. Follows a symlinked mcp.json and keeps its mode; new files get 0600. */
async function replaceFile(file: string, raw: string, exists: boolean): Promise<void> {
  let target = file;
  let mode = 0o600;
  if (exists) {
    target = await realpath(file);
    mode = (await stat(target)).mode & 0o777;
  } else {
    await mkdir(path.dirname(file), { recursive: true });
  }
  const temp = `${target}.omp-ui-${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temp, raw, { mode });
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

/**
 * Set every managed entry and drop `removed` ones, keeping everything else verbatim. Writes only
 * when an entry changes. Returns why mcp.json cannot be read or written, else null.
 */
async function writeEntries(file: ConfigFile, entries: Map<string, McpServerConfig>, removed: string[]): Promise<string | null> {
  if (file.error || !file.path || !file.data) return file.error;
  const current = serversOf(file.data);
  const servers = { ...current };
  for (const name of removed) delete servers[name];
  for (const [name, entry] of entries) servers[name] = entry;
  if (isDeepStrictEqual(servers, current)) return null;
  const data = { ...(file.data.$schema === undefined ? { $schema: SCHEMA_URL } : {}), ...file.data, mcpServers: servers };
  try {
    await replaceFile(file.path, `${JSON.stringify(data, null, 2)}\n`, file.exists);
  } catch (err) {
    return `Cannot write ${file.path}: ${errorMessage(err)}`;
  }
  file.data = data;
  file.exists = true;
  return null;
}

async function loadState(repo: Repository): Promise<McpState> {
  const [records, credentials, file] = await Promise.all([loadServers(repo), allCredentialValues(repo), readConfig(repo)]);
  return { records, credentials, file };
}

/** Write the managed entries to mcp.json and refresh the agent env. Returns the mcp.json problem, else null. */
async function publish(state: McpState, removed: string[] = []): Promise<string | null> {
  const entries = new Map(
    state.records.map((record) => [record.name, fileEntry(record, state.credentials.get(record.credentialId))]),
  );
  const error = await writeEntries(state.file, entries, removed);
  setMcpAgentEnv(agentEnv(state));
  return error;
}

/** Taken by any mcp.json entry or managed server, or would share its env var names with a managed one. */
function nameTaken(state: McpState, name: string): boolean {
  if (Object.hasOwn(serversOf(state.file.data), name)) return true;
  const slug = envSlug(name);
  return state.records.some((record) => record.name === name || envSlug(record.name) === slug);
}

/** The provider id, else `<id>-2`, `<id>-3`, … */
function defaultName(state: McpState, providerId: string): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? providerId : `${providerId}-${n}`;
    if (!nameTaken(state, name)) return name;
  }
}

// ---------------------------------------------------------------------------------------------
// Summaries

/** Disabled / error first; otherwise the newer of the credential health check and the MCP probe decides. */
function serverStatus(
  record: StoredMcpServer,
  credential: CredentialValues | undefined,
): { status: McpServerStatus; statusMessage: string | null } {
  if (!record.enabled) return { status: "disabled", statusMessage: null };
  if (!credential) return { status: "error", statusMessage: "Credential deleted — pick another or remove the server" };
  if (credential.broken) return { status: "error", statusMessage: "Cannot decrypt the credential" };
  const { summary } = credential;
  const checkedAt = summary.lastCheckedAt ? Date.parse(summary.lastCheckedAt) : null;
  const { probe } = record;
  if (probe && (checkedAt === null || Date.parse(probe.checkedAt) >= checkedAt)) {
    return probe.ok ? { status: "connected", statusMessage: null } : { status: "failing", statusMessage: probe.message };
  }
  if (checkedAt !== null && summary.health === "healthy") return { status: "connected", statusMessage: null };
  if (checkedAt !== null && summary.health === "failing") {
    return { status: "failing", statusMessage: summary.lastMessage ?? "Credential check failed" };
  }
  return { status: "untested", statusMessage: null };
}

function summarize(state: McpState, record: StoredMcpServer): McpServerSummary {
  const credential = state.credentials.get(record.credentialId);
  const config = fileEntry(record, credential);
  const entry = serversOf(state.file.data)[record.name];
  return {
    name: record.name,
    providerId: record.providerId,
    credentialId: record.credentialId,
    credential: credential?.summary ?? null,
    enabled: record.enabled,
    ...serverStatus(record, credential),
    transport: config.type,
    config,
    synced: entry !== undefined && isDeepStrictEqual(entry, config),
    probe: record.probe,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function transportOf(entry: unknown): string {
  if (!isObject(entry)) return "unknown";
  if (typeof entry.type === "string") return entry.type;
  if (typeof entry.url === "string") return "http";
  if (typeof entry.command === "string") return "stdio";
  return "unknown";
}

function externalServers(state: McpState): McpExternalServer[] {
  const managed = new Set(state.records.map((record) => record.name));
  const listed = state.file.data?.disabledServers;
  const disabled = new Set(Array.isArray(listed) ? listed.filter((name): name is string => typeof name === "string") : []);
  return Object.entries(serversOf(state.file.data))
    .filter(([name]) => !managed.has(name))
    .map(([name, entry]) => ({
      name,
      transport: transportOf(entry),
      enabled: !(isObject(entry) && entry.enabled === false) && !disabled.has(name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function response(state: McpState, configError = state.file.error): McpServersResponse {
  return {
    servers: state.records.map((record) => summarize(state, record)).sort((a, b) => a.name.localeCompare(b.name)),
    configPath: state.file.path,
    configError,
    external: externalServers(state),
  };
}

async function serverSummary(repo: Repository, name: string): Promise<McpServerSummary> {
  const state = await loadState(repo);
  return summarize(state, findOrThrow(state.records, name));
}

// ---------------------------------------------------------------------------------------------
// Probes

/** Probe with the real secrets (outside the lock) and store the scrubbed result. */
async function probeAndStore(repo: Repository, record: StoredMcpServer, credential: CredentialValues): Promise<void> {
  const provider = mcpProvider(record.providerId);
  const config = serverConfig(provider, credential.fields, (field) => credential.fields[field.key] || null);
  const secrets = provider.fields
    .filter((field) => field.kind === "secret" && credential.fields[field.key])
    .map((field) => credential.fields[field.key]);
  const result = await probeMcpServer(config, { secrets });
  await withLock(async () => {
    const list = await loadServers(repo);
    // Dropped when the server was removed or switched to another credential meanwhile.
    const stored = list.find((s) => s.name === record.name && s.credentialId === record.credentialId);
    if (!stored) return;
    stored.probe = result;
    await saveServers(repo, list);
  });
}

// ---------------------------------------------------------------------------------------------
// API

/** Every managed server with its status, plus the mcp.json entries OMP-UI does not manage. */
export async function listMcpServers(repo: Repository): Promise<McpServersResponse> {
  return response(await loadState(repo));
}

/**
 * Connect a catalog server: reuse a saved credential or save a new one (health-checked first),
 * write its mcp.json entry, refresh the agent env, then probe it unless `test` is false.
 */
export async function connectMcpServer(repo: Repository, input: McpConnectInput): Promise<McpConnectResult> {
  const provider = mcpProvider(input.providerId);
  if (input.credentialId && input.credential) {
    throw new HttpError(400, "Pick a saved credential or enter a new one, not both");
  }
  if (input.name !== undefined && !NAME_REGEX.test(input.name)) {
    throw new HttpError(400, "name must be 1–48 lowercase letters, digits, - or _, starting with a letter or digit");
  }
  const { record, credential } = await withLock(async () => {
    const state = await loadState(repo);
    // Before creating a credential: nothing would be connected.
    if (state.file.error) throw new HttpError(502, state.file.error);
    if (input.name !== undefined && nameTaken(state, input.name)) {
      throw new HttpError(409, `An MCP server named ${input.name} already exists`);
    }
    const name = input.name ?? defaultName(state, provider.id);
    let credential: CredentialValues;
    if (input.credentialId) {
      credential = credentialFor(state, input.credentialId, provider);
    } else if (input.credential) {
      const { name: credentialName, fields, expiresAt } = input.credential;
      const created = await createCredential(
        repo,
        { providerId: provider.id, name: credentialName, fields, expiresAt, autoCheck: true },
        { test: true },
      );
      const values = await credentialValues(repo, created.id);
      if (!values) throw new HttpError(404, "Credential not found");
      credential = values;
      state.credentials.set(created.id, credential);
    } else {
      throw new HttpError(400, "Pick a saved credential or enter a new one");
    }
    const now = new Date().toISOString();
    const record: StoredMcpServer = {
      name,
      providerId: provider.id,
      credentialId: credential.summary.id,
      enabled: true,
      probe: null,
      createdAt: now,
      updatedAt: now,
    };
    state.records.push(record);
    await saveServers(repo, state.records);
    const error = await publish(state);
    if (error) throw new HttpError(502, error);
    return { record, credential };
  });
  if (input.test !== false && !credential.broken) await probeAndStore(repo, record, credential);
  return { server: await serverSummary(repo, record.name) };
}

/** Switch a server on/off and/or to another saved credential of the same provider. */
export async function updateMcpServer(repo: Repository, name: string, update: McpServerUpdate): Promise<McpServerSummary> {
  return withLock(async () => {
    const state = await loadState(repo);
    const record = findOrThrow(state.records, name);
    if (update.credentialId !== undefined && update.credentialId !== record.credentialId) {
      credentialFor(state, update.credentialId, mcpProvider(record.providerId));
      record.credentialId = update.credentialId;
      // The probe tested the previous credential.
      record.probe = null;
    }
    if (update.enabled !== undefined) record.enabled = update.enabled;
    record.updatedAt = new Date().toISOString();
    await saveServers(repo, state.records);
    const error = await publish(state);
    if (error) throw new HttpError(502, error);
    return summarize(state, record);
  });
}

/** Remove a server from mcp.json and the store; `deleteCredential` also deletes its credential. */
export async function removeMcpServer(
  repo: Repository,
  name: string,
  options: { deleteCredential?: boolean },
): Promise<void> {
  await withLock(async () => {
    const state = await loadState(repo);
    const record = findOrThrow(state.records, name);
    if (options.deleteCredential) {
      try {
        await deleteCredential(repo, record.credentialId);
      } catch (err) {
        if (!(err instanceof HttpError && err.status === 404)) throw err;
      }
      // Other servers on the same credential switch off with it.
      state.credentials.delete(record.credentialId);
    }
    state.records.splice(state.records.indexOf(record), 1);
    await saveServers(repo, state.records);
    const error = await publish(state, [name]);
    if (error) throw new HttpError(502, error);
  });
}

/** Health-check the credential, then probe the MCP server; both outcomes are stored. */
export async function testMcpServer(repo: Repository, name: string): Promise<McpServerSummary> {
  const record = findOrThrow(await loadServers(repo), name);
  try {
    await checkCredential(repo, record.credentialId);
  } catch (err) {
    // A deleted credential shows as status "error"; there is nothing to probe with.
    if (!(err instanceof HttpError && err.status === 404)) throw err;
  }
  const credential = await credentialValues(repo, record.credentialId);
  if (credential && !credential.broken) await probeAndStore(repo, record, credential);
  return serverSummary(repo, name);
}

/**
 * Rewrite the managed mcp.json entries and refresh the agent env (after credential changes, or
 * when mcp.json was edited by hand). mcp.json problems are reported in `configError`, not thrown.
 */
export async function syncMcpServers(repo: Repository): Promise<McpServersResponse> {
  return withLock(async () => {
    const state = await loadState(repo);
    return response(state, await publish(state));
  });
}

/** Boot hook: sync once so agents get the MCP env; `mcpAgentEnv` waits for it. Idempotent. */
export function startMcpSync(repo: Repository): void {
  if (g.__ompUiMcpSyncStarted) return;
  g.__ompUiMcpSyncStarted = true;
  setMcpEnvReady(
    syncMcpServers(repo)
      .then(({ configError }) => {
        if (configError) console.warn("[mcp] boot sync:", configError);
      })
      .catch((err: unknown) => console.error("[mcp] boot sync failed:", errorMessage(err))),
  );
}

// ---------------------------------------------------------------------------------------------
// Request bodies

/** undefined and null mean absent. */
function optionalString(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${label} must be a string`);
  if (value.length > max) throw new HttpError(400, `${label} is too long`);
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new HttpError(400, `${label} must be a boolean`);
  return value;
}

function parseNewCredential(value: unknown): McpConnectInput["credential"] {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) throw new HttpError(400, "credential must be an object");
  const { fields } = value;
  if (!isObject(fields)) throw new HttpError(400, "credential.fields must be an object of strings");
  const credential: NonNullable<McpConnectInput["credential"]> = {
    name: optionalString(value.name, "credential.name", MAX_NAME_LENGTH) ?? "",
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, v]) => [
        key,
        optionalString(v, `credential.fields.${key}`, MAX_FIELD_LENGTH) ?? "",
      ]),
    ),
  };
  if (value.expiresAt === null) credential.expiresAt = null;
  else {
    const expiresAt = optionalString(value.expiresAt, "credential.expiresAt", 100);
    if (expiresAt !== undefined) credential.expiresAt = expiresAt;
  }
  return credential;
}

/** POST /mcp body. */
export function parseMcpConnectInput(body: Record<string, unknown>): McpConnectInput {
  const { providerId } = body;
  if (typeof providerId !== "string" || !providerId) throw new HttpError(400, "providerId is required");
  if (!isCredentialProviderId(providerId)) throw new HttpError(400, `Unknown provider: ${providerId}`);
  const input: McpConnectInput = { providerId };
  // An empty name field means "pick one".
  const name = optionalString(body.name, "name", MAX_NAME_LENGTH);
  if (name) input.name = name;
  const credentialId = optionalString(body.credentialId, "credentialId", MAX_ID_LENGTH);
  if (credentialId) input.credentialId = credentialId;
  const credential = parseNewCredential(body.credential);
  if (credential) input.credential = credential;
  const test = optionalBoolean(body.test, "test");
  if (test !== undefined) input.test = test;
  return input;
}

/** PATCH /mcp/:name body. */
export function parseMcpServerUpdate(body: Record<string, unknown>): McpServerUpdate {
  const update: McpServerUpdate = {};
  const enabled = optionalBoolean(body.enabled, "enabled");
  if (enabled !== undefined) update.enabled = enabled;
  const credentialId = optionalString(body.credentialId, "credentialId", MAX_ID_LENGTH);
  if (credentialId !== undefined) {
    if (!credentialId) throw new HttpError(400, "credentialId must not be empty");
    update.credentialId = credentialId;
  }
  if (update.enabled === undefined && update.credentialId === undefined) {
    throw new HttpError(400, "Nothing to update: send enabled and/or credentialId");
  }
  return update;
}
