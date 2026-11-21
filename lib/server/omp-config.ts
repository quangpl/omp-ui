// omp's user-level settings: `<agent dir>/config.yml` (YAML; agent dir from `omp config path`,
// i.e. ~/.omp/agent unless PI_CODING_AGENT_DIR or a profile moves it). omp itself is the parser and
// validator: every write is first applied to a copy in a scratch agent dir (`omp config set/reset`
// for structured edits, `omp config list` to parse a raw file), and only then replaces the real file
// (backup + temp file + rename). omp moves an unparsable config.yml aside on its next start, so an
// invalid file must never reach the real path.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { childEnv } from "@/lib/child-env";
import { HttpError } from "@/lib/server/http";
import type {
  OmpConfigField,
  OmpConfigSnapshot,
  OmpConfigValue,
  OmpModel,
  OmpSettingInfo,
  OmpSettingType,
  OmpSettingValue,
} from "@/lib/types";

const CONFIG_FILE = "config.yml";
const BACKUP_SUFFIX = ".bak";
const CLI_TIMEOUT_MS = 15_000;
const MODELS_TIMEOUT_MS = 30_000;
const MODELS_TTL_MS = 5 * 60_000;
const SETTINGS_TTL_MS = 10 * 60_000;
/** `omp config set <enum key> <this>` fails with "Valid values: a, b, c": how omp tells its enum choices. */
const ENUM_PROBE_VALUE = "__omp_ui_invalid__";
const ENUM_PROBE_CONCURRENCY = 8;
const MAX_RAW_BYTES = 1024 * 1024;
const MAX_STRING = 500;
const ROLE_PREFIX = "modelRoles.";

const THINKING_OPTIONS = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
  { value: "auto", label: "Auto" },
];

function role(name: string, label: string, help: string): OmpConfigField {
  return {
    key: `${ROLE_PREFIX}${name}`,
    label,
    type: "model",
    group: "models",
    help,
    placeholder: "provider/model-id[:thinking]",
  };
}

/** The keys the structured form edits. Enum choices mirror omp's own validation (`omp config set`). */
export const OMP_CONFIG_SCHEMA: readonly OmpConfigField[] = [
  role(
    "default",
    "Default model",
    "Used unless a board or AgentMan's default model picks another. A thinking level set here overrides the default thinking level.",
  ),
  role("smol", "Fast model (smol)", "Lightweight work."),
  role("slow", "Reasoning model (slow)", "Thorough analysis."),
  role("plan", "Plan model", "Architectural planning in plan mode."),
  role("designer", "Designer model", "UI work."),
  role("task", "Subagent model (task)", "Subagents the agent spawns with its task tool."),
  role("vision", "Vision model", "Reads images for models without vision support."),
  role("advisor", "Advisor model", "Reviews each turn when the advisor is enabled."),
  role("commit", "Commit model", "Writes commit messages and changelog entries."),
  {
    key: "defaultThinkingLevel",
    label: "Thinking level",
    type: "enum",
    group: "behavior",
    help: "Reasoning depth for thinking models when the model selector doesn't set one.",
    options: THINKING_OPTIONS,
  },
  {
    key: "tools.approvalMode",
    label: "Approval mode",
    type: "enum",
    group: "behavior",
    help: "Which tool calls omp runs without asking in your terminal. Card runs use the Agent section's approval mode.",
    options: [
      { value: "always-ask", label: "Always ask" },
      { value: "always-ask-cached", label: "Ask and remember" },
      { value: "write", label: "Write" },
      { value: "yolo", label: "Yolo" },
    ],
  },
  {
    key: "steeringMode",
    label: "Queued messages",
    type: "enum",
    group: "behavior",
    help: "How messages sent while the agent is working are delivered.",
    options: [
      { value: "one-at-a-time", label: "One at a time" },
      { value: "all", label: "All at once" },
    ],
  },
  {
    key: "interruptMode",
    label: "Interrupt",
    type: "enum",
    group: "behavior",
    help: "Whether a new message interrupts a running tool or waits for it to finish.",
    options: [
      { value: "immediate", label: "Immediately" },
      { value: "wait", label: "After the current tool" },
    ],
  },
  {
    key: "retry.enabled",
    label: "Retry API errors",
    type: "boolean",
    group: "behavior",
    help: "Retry provider requests that fail with transient errors.",
  },
  {
    key: "retry.maxRetries",
    label: "Max retries",
    type: "number",
    group: "behavior",
    help: "Retry attempts per failed provider request.",
    min: 0,
    max: 100,
  },
  {
    key: "compaction.enabled",
    label: "Auto-compact context",
    type: "boolean",
    group: "behavior",
    help: "Summarize older context as the conversation nears the model's context window.",
  },
  {
    key: "advisor.enabled",
    label: "Advisor",
    type: "boolean",
    group: "behavior",
    help: "A second model (the advisor role) reviews each turn and adds notes.",
  },
  {
    key: "todo.enabled",
    label: "Todo list",
    type: "boolean",
    group: "tools",
    help: "The agent tracks its work in a todo list.",
  },
  {
    key: "web_search.enabled",
    label: "Web search",
    type: "boolean",
    group: "tools",
    help: "The agent can search the web for live results.",
  },
  {
    key: "lsp.enabled",
    label: "Language servers",
    type: "boolean",
    group: "tools",
    help: "Diagnostics after edits, plus the lsp tool for definitions and references.",
  },
  {
    key: "task.isolation.enabled",
    label: "Isolated subagents",
    type: "boolean",
    group: "tools",
    help: "Subagents can work in an isolated copy of the repo and apply their changes afterwards.",
  },
  {
    key: "task.maxConcurrency",
    label: "Max parallel subagents",
    type: "number",
    group: "tools",
    help: "Subagents running at once per agent.",
    min: 1,
    max: 256,
  },
  {
    key: "task.maxRecursionDepth",
    label: "Subagent depth",
    type: "number",
    group: "tools",
    help: "How deep subagents may nest when they spawn their own subagents.",
    min: 0,
    max: 10,
  },
  {
    key: "python.interpreter",
    label: "Python interpreter",
    type: "string",
    group: "tools",
    help: "Python executable for the eval tool. Leave empty to let omp find one.",
    placeholder: "/usr/bin/python3",
  },
];

const FIELDS = new Map(OMP_CONFIG_SCHEMA.map((f) => [f.key, f]));

// ─── omp CLI ─────────────────────────────────────────────────────────────────

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runOmp(
  ompPath: string,
  args: string[],
  options: { cwd: string; agentDir?: string; timeout?: number },
): Promise<CliResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CliResult>();
  const env = childEnv(options.agentDir ? { PI_CODING_AGENT_DIR: options.agentDir } : {});
  execFile(
    ompPath,
    args,
    { cwd: options.cwd, env, timeout: options.timeout ?? CLI_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    (err, stdout, stderr) => {
      const code = err && "code" in err ? err.code : 0;
      if (code === "ENOENT") {
        reject(new HttpError(503, `omp not found at ${ompPath}. Install from https://omp.sh or set OMP_PATH`));
      } else if (code === "EACCES") {
        reject(new HttpError(503, `omp at ${ompPath} is not executable (permission denied)`));
      } else if (err && typeof code !== "number") {
        reject(new HttpError(503, `omp ${args.slice(0, 2).join(" ")} failed: ${err.message}`));
      } else {
        resolve({ code: typeof code === "number" ? code : 0, stdout: String(stdout), stderr: String(stderr) });
      }
    },
  );
  return promise;
}

/** omp's one-line explanation of a failed command (its `Error: …`/`error: …` line). */
function cliError(result: CliResult): string {
  const text = `${result.stderr}\n${result.stdout}`;
  const match = /^(?:error|Error): (.+)$/m.exec(text) ?? /^(Unknown setting: .+)$/m.exec(text);
  if (!match) return `omp exited with code ${result.code}`;
  return match[1]
    .replace(/^Settings config is invalid: .*?\(moved to [^)]*\): /, "")
    .replace(/^Settings config is invalid: [^:]*: /, "")
    .replace(/^SyntaxError: /, "")
    .trim();
}

interface ListedSetting {
  value?: unknown;
  type?: string;
  description?: string;
  /** Secrets (tokens, passwords): omp lists them without `value`. */
  redacted?: boolean;
}

/** `omp config list --json [--scope global]` → key → { value, type }. */
async function listSettings(
  ompPath: string,
  options: { cwd: string; agentDir?: string; scope?: "global" },
): Promise<Record<string, ListedSetting>> {
  const args = ["config", "list", "--json", ...(options.scope ? ["--scope", options.scope] : [])];
  const result = await runOmp(ompPath, args, options);
  if (result.code !== 0) throw new HttpError(400, cliError(result));
  const start = result.stdout.indexOf("{");
  try {
    const data: unknown = JSON.parse(result.stdout.slice(start === -1 ? 0 : start));
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, ListedSetting>;
  } catch {}
  throw new HttpError(502, "omp config list returned unexpected output; is omp up to date?");
}

/** omp's agent dir (`omp config path`), where config.yml lives. */
export async function agentDir(ompPath: string): Promise<string> {
  const result = await runOmp(ompPath, ["config", "path"], { cwd: os.tmpdir() });
  const dir = result.stdout.trim().split("\n").pop()?.trim();
  if (result.code !== 0 || !dir || !path.isAbsolute(dir)) {
    throw new HttpError(502, `omp config path failed: ${cliError(result)}`);
  }
  return dir;
}

/** One effective setting (`omp config get <key> --json`) as omp resolves it in `cwd` (project over user). */
export async function getOmpSetting(ompPath: string, key: string, cwd: string): Promise<unknown> {
  const result = await runOmp(ompPath, ["config", "get", key, "--json"], { cwd });
  if (result.code !== 0) throw new HttpError(400, cliError(result));
  const start = result.stdout.indexOf("{");
  try {
    const data: unknown = JSON.parse(result.stdout.slice(start === -1 ? 0 : start));
    if (data && typeof data === "object" && "value" in data) return data.value;
  } catch {}
  throw new HttpError(502, `omp config get ${key} returned unexpected output; is omp up to date?`);
}

// ─── file access ─────────────────────────────────────────────────────────────

function hash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

async function readRaw(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Replace `file` with `raw`: previous content to `<file>.bak`, then temp file + rename. Follows a symlinked config.yml. */
async function commit(file: string, raw: string, previous: string | null): Promise<void> {
  let target = file;
  let mode = 0o600;
  if (previous !== null) {
    target = await realpath(file);
    mode = (await stat(target)).mode & 0o777;
    await copyFile(target, `${file}${BACKUP_SUFFIX}`);
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

/** A throwaway agent dir holding `raw` as its config.yml, for omp to parse or edit. */
async function withScratch<T>(raw: string | null, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omp-ui-config-"));
  try {
    if (raw !== null) await writeFile(path.join(dir, CONFIG_FILE), raw, { mode: 0o600 });
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Saves are serialized: each reads, edits and replaces the whole file.
const g = globalThis as unknown as {
  __ompUiConfigLock?: Promise<unknown>;
  __ompUiModels?: { path: string; at: number; models: Promise<OmpModel[]> };
  __ompUiSettings?: { path: string; at: number; settings: Promise<OmpSettingInfo[]> };
};

function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = (g.__ompUiConfigLock ?? Promise.resolve()).then(fn, fn);
  g.__ompUiConfigLock = run.catch(() => undefined);
  return run;
}

// ─── values ──────────────────────────────────────────────────────────────────

function scalar(value: unknown): OmpConfigValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return null;
}

function roleMap(settings: Record<string, ListedSetting>): Record<string, unknown> {
  const roles = settings.modelRoles?.value;
  return roles && typeof roles === "object" && !Array.isArray(roles) ? (roles as Record<string, unknown>) : {};
}

/** Schema key → value from a listing (null when absent). */
function schemaValues(settings: Record<string, ListedSetting>): Record<string, OmpConfigValue> {
  const roles = roleMap(settings);
  const values: Record<string, OmpConfigValue> = {};
  for (const field of OMP_CONFIG_SCHEMA) {
    values[field.key] = field.key.startsWith(ROLE_PREFIX)
      ? scalar(roles[field.key.slice(ROLE_PREFIX.length)])
      : scalar(settings[field.key]?.value);
  }
  return values;
}

/** Validate one structured value; empty strings unset the key. */
function normalize(field: OmpConfigField, value: unknown): OmpConfigValue {
  if (value === null || value === undefined) return null;
  switch (field.type) {
    case "boolean":
      if (typeof value !== "boolean") throw new HttpError(400, `${field.label} must be true or false`);
      return value;
    case "number": {
      const min = field.min ?? Number.MIN_SAFE_INTEGER;
      const max = field.max ?? Number.MAX_SAFE_INTEGER;
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        throw new HttpError(400, `${field.label} must be a whole number between ${min} and ${max}`);
      }
      return value;
    }
    case "enum":
      if (typeof value !== "string" || !field.options?.some((o) => o.value === value)) {
        const choices = field.options?.map((o) => o.value).join(", ") ?? "";
        throw new HttpError(400, `${field.label} must be one of: ${choices}`);
      }
      return value;
    case "model":
    case "string": {
      if (typeof value !== "string") throw new HttpError(400, `${field.label} must be a string`);
      const text = value.trim();
      if (text.length > MAX_STRING) throw new HttpError(400, `${field.label} must be at most ${MAX_STRING} characters`);
      if (field.type === "model" && /\s/.test(text)) {
        throw new HttpError(400, `${field.label} must be a model selector without spaces, e.g. provider/model-id`);
      }
      return text || null;
    }
  }
}

const LIST_TYPE_CHECKS: Record<string, (value: unknown) => boolean> = {
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  string: (v) => typeof v === "string",
  enum: (v) => typeof v === "string",
  array: (v) => Array.isArray(v),
  record: (v) => typeof v === "object" && !Array.isArray(v),
};

const TYPE_NAMES: Record<string, string> = {
  number: "a number",
  boolean: "true or false",
  string: "a string",
  enum: "a string",
  array: "a list",
  record: "a mapping",
};

/** Type errors in a parsed raw file: omp's own types per key, plus the schema's enum choices. */
function rawTypeErrors(settings: Record<string, ListedSetting>): string[] {
  const errors: string[] = [];
  for (const [key, { value, type }] of Object.entries(settings)) {
    if (value === null || value === undefined || !type) continue;
    const check = LIST_TYPE_CHECKS[type];
    if (check && !check(value)) {
      errors.push(`${key} must be ${TYPE_NAMES[type]}`);
      continue;
    }
    const options = FIELDS.get(key)?.options;
    if (options && !options.some((o) => o.value === value)) {
      errors.push(`${key} must be one of: ${options.map((o) => o.value).join(", ")}`);
    }
  }
  const roles = settings.modelRoles?.value;
  if (roles && typeof roles === "object" && !Array.isArray(roles)) {
    for (const [name, selector] of Object.entries(roles)) {
      if (typeof selector !== "string") errors.push(`modelRoles.${name} must be a model selector string`);
    }
  }
  return errors;
}

// ─── public API ──────────────────────────────────────────────────────────────

/** omp's user config: file, values of the schema keys, and omp's defaults for unset keys. */
export async function getOmpConfig(ompPath: string): Promise<OmpConfigSnapshot> {
  const cwd = os.tmpdir();
  const [dir, effective] = await Promise.all([agentDir(ompPath), listSettings(ompPath, { cwd })]);
  const file = path.join(dir, CONFIG_FILE);
  const raw = await readRaw(file);
  // Listing the file through a scratch dir parses exactly the bytes returned as `raw`.
  const own = raw?.trim()
    ? await withScratch(raw, (scratch) =>
        listSettings(ompPath, { cwd: scratch, agentDir: scratch, scope: "global" }).catch((err) => {
          if (err instanceof HttpError && err.status === 400) {
            throw new HttpError(500, `${file} is not valid: ${err.message}. Fix it in a text editor; omp moves an invalid config aside on its next start.`);
          }
          throw err;
        }),
      )
    : {};
  const settings: Record<string, OmpSettingValue> = {};
  const secretsSet: string[] = [];
  for (const [key, entry] of Object.entries(own)) {
    if (entry.redacted) secretsSet.push(key);
    else if (entry.value !== undefined) settings[key] = entry.value as OmpSettingValue;
  }
  return {
    path: file,
    backupPath: `${file}${BACKUP_SUFFIX}`,
    format: "yaml",
    exists: raw !== null,
    version: hash(raw ?? ""),
    raw: raw ?? "",
    values: schemaValues(own),
    defaults: schemaValues(effective),
    schema: [...OMP_CONFIG_SCHEMA],
    settings,
    secretsSet,
  };
}

function checkVersion(current: string | null, version: unknown): void {
  if (version === undefined || version === null) return;
  if (typeof version !== "string") throw new HttpError(400, "version must be a string");
  if (version !== hash(current ?? "")) {
    throw new HttpError(409, "omp's config changed on disk since it was loaded. Reload it and apply your changes again.");
  }
}

/**
 * Apply structured edits (null unsets a key) through `omp config set/reset` on a scratch copy, then
 * replace the file. Keys are the form's schema keys or any setting omp knows (typed per `omp config
 * list`; lists and mappings as JSON values). Keys not edited are kept as they are.
 */
export function updateOmpConfigValues(
  ompPath: string,
  input: Record<string, unknown>,
  version?: unknown,
): Promise<OmpConfigSnapshot> {
  const next = new Map<string, OmpSettingValue>();
  for (const [key, value] of Object.entries(input)) {
    const field = FIELDS.get(key);
    next.set(key, field ? normalize(field, value) : ((value ?? null) as OmpSettingValue));
  }
  if (next.has("modelRoles") && [...next.keys()].some((key) => key.startsWith(ROLE_PREFIX))) {
    throw new HttpError(400, "Edit modelRoles either as a whole or per role, not both at once");
  }
  return locked(async () => {
    const file = path.join(await agentDir(ompPath), CONFIG_FILE);
    const current = await readRaw(file);
    checkVersion(current, version);
    const updated = await withScratch(current, async (scratch) => {
      const opts = { cwd: scratch, agentDir: scratch };
      const own = current?.trim() ? await listSettings(ompPath, { ...opts, scope: "global" }) : {};
      const generic = [...next.keys()].filter((key) => !FIELDS.has(key));
      const known = generic.length > 0 ? await listSettings(ompPath, opts) : {};
      const have = schemaValues(own);
      const roles = { ...roleMap(own) };
      let rolesChanged = false;
      const commands: { label: string; args: string[] }[] = [];
      for (const [key, value] of next) {
        const field = FIELDS.get(key);
        if (!field) {
          const type = known[key]?.type;
          if (!type) throw new HttpError(400, `Unknown omp setting: ${key}`);
          if (value !== null && LIST_TYPE_CHECKS[type] && !LIST_TYPE_CHECKS[type](value)) {
            throw new HttpError(400, `${key} must be ${TYPE_NAMES[type]}`);
          }
          const text = typeof value === "object" ? JSON.stringify(value) : String(value);
          if (Buffer.byteLength(text) > MAX_RAW_BYTES) throw new HttpError(400, `${key} is larger than 1 MB`);
          const was = own[key];
          const unchanged =
            value === null ? was === undefined : !was?.redacted && JSON.stringify(was?.value) === JSON.stringify(value);
          if (unchanged) continue;
          commands.push({ label: key, args: value === null ? ["config", "reset", key] : ["config", "set", key, text] });
        } else if (have[key] === value) {
          continue;
        } else if (key.startsWith(ROLE_PREFIX)) {
          const name = key.slice(ROLE_PREFIX.length);
          if (value === null) delete roles[name];
          else roles[name] = value;
          rolesChanged = true;
        } else if (value === null) {
          commands.push({ label: field.label, args: ["config", "reset", key] });
        } else {
          commands.push({ label: field.label, args: ["config", "set", key, String(value)] });
        }
      }
      if (rolesChanged) {
        commands.push({
          label: "Model roles",
          args:
            Object.keys(roles).length === 0
              ? ["config", "reset", "modelRoles"]
              : ["config", "set", "modelRoles", JSON.stringify(roles)],
        });
      }
      if (commands.length === 0) return current;
      for (const { label, args } of commands) {
        const result = await runOmp(ompPath, args, opts);
        if (result.code !== 0) throw new HttpError(400, `${label}: ${cliError(result)}`);
      }
      return readRaw(path.join(scratch, CONFIG_FILE));
    });
    if (updated !== null && updated !== current) await commit(file, updated, current);
    return getOmpConfig(ompPath);
  });
}

/** Replace the whole file with `raw` once omp parses it and its known keys have the right types. */
export function updateOmpConfigRaw(ompPath: string, raw: unknown, version?: unknown): Promise<OmpConfigSnapshot> {
  if (typeof raw !== "string") throw new HttpError(400, "raw must be a string");
  if (Buffer.byteLength(raw) > MAX_RAW_BYTES) throw new HttpError(400, "The config is larger than 1 MB");
  return locked(async () => {
    const file = path.join(await agentDir(ompPath), CONFIG_FILE);
    const current = await readRaw(file);
    checkVersion(current, version);
    if (raw === current) return getOmpConfig(ompPath);
    if (raw.trim()) {
      const parsed = await withScratch(raw, (scratch) =>
        listSettings(ompPath, { cwd: scratch, agentDir: scratch, scope: "global" }).catch((err) => {
          if (err instanceof HttpError && err.status === 400) throw new HttpError(400, `Invalid config: ${err.message}`);
          throw err;
        }),
      );
      const errors = rawTypeErrors(parsed);
      if (errors.length > 0) throw new HttpError(400, `Invalid config: ${errors.join("; ")}`);
    }
    await commit(file, raw, current);
    return getOmpConfig(ompPath);
  });
}

function parseModels(output: string): OmpModel[] {
  const start = output.indexOf("{");
  let data: unknown;
  try {
    data = JSON.parse(output.slice(start === -1 ? 0 : start));
  } catch {
    return [];
  }
  const list = data && typeof data === "object" && "models" in data ? data.models : null;
  if (!Array.isArray(list)) return [];
  const models: OmpModel[] = [];
  for (const entry of list as Record<string, unknown>[]) {
    if (!entry || typeof entry.selector !== "string") continue;
    if (entry.kind !== undefined && entry.kind !== "chat") continue;
    models.push({
      selector: entry.selector,
      name: typeof entry.name === "string" ? entry.name : entry.selector,
      provider: typeof entry.provider === "string" ? entry.provider : "",
      thinking: Array.isArray(entry.thinking) ? entry.thinking.filter((t): t is string => typeof t === "string") : [],
    });
  }
  return models;
}

/**
 * Chat models omp can use (`omp models --json`, a few seconds), cached for 5 minutes per omp path;
 * `refresh` re-lists. Never rejects: empty when omp is missing or the listing fails.
 */
export function listOmpModels(ompPath: string, options: { refresh?: boolean } = {}): Promise<OmpModel[]> {
  const cached = g.__ompUiModels;
  if (options.refresh || !cached || cached.path !== ompPath || Date.now() - cached.at > MODELS_TTL_MS) {
    const models = runOmp(ompPath, ["models", "--json"], { cwd: os.tmpdir(), timeout: MODELS_TIMEOUT_MS })
      .then((result) => (result.code === 0 ? parseModels(result.stdout) : []))
      .catch(() => []);
    g.__ompUiModels = { path: ompPath, at: Date.now(), models };
    // Don't keep a failed or empty listing for the whole TTL.
    void models.then((list) => {
      if (list.length === 0 && g.__ompUiModels?.models === models) g.__ompUiModels = undefined;
    });
  }
  return g.__ompUiModels!.models;
}

/** Every setting omp knows, with its built-in default (listed on an empty config) and enum choices. */
function loadOmpSettings(ompPath: string): Promise<OmpSettingInfo[]> {
  return withScratch(null, async (scratch) => {
    const opts = { cwd: scratch, agentDir: scratch };
    // Types this module knows how to check (all of omp's today).
    const listed = Object.entries(await listSettings(ompPath, opts)).filter(([, s]) => s.type && s.type in LIST_TYPE_CHECKS);
    // omp's listing has no enum choices; an invalid `config set` names them. The probe fails, so the scratch stays empty.
    const enums = listed.filter(([, s]) => s.type === "enum").map(([key]) => key);
    const options = new Map<string, string[]>();
    for (let i = 0; i < enums.length; i += ENUM_PROBE_CONCURRENCY) {
      await Promise.all(
        enums.slice(i, i + ENUM_PROBE_CONCURRENCY).map(async (key) => {
          const result = await runOmp(ompPath, ["config", "set", key, ENUM_PROBE_VALUE], opts);
          const match = /Valid values: (.+)$/m.exec(`${result.stderr}\n${result.stdout}`);
          options.set(key, match ? match[1].split(",").map((v) => v.trim()).filter(Boolean) : []);
        }),
      );
    }
    // omp redacts secrets only once they hold a value: list a config that sets every value-less string.
    const probe: Record<string, unknown> = {};
    for (const [key, s] of listed) {
      if (s.type !== "string" || s.value !== undefined || s.redacted) continue;
      const parts = key.split(".");
      let node = probe;
      for (const part of parts.slice(0, -1)) {
        const child = node[part];
        node = (child && typeof child === "object" ? child : (node[part] = {})) as Record<string, unknown>;
      }
      node[parts[parts.length - 1]] = ENUM_PROBE_VALUE;
    }
    // JSON is YAML; a failed probe only loses the secret flags of unset keys.
    await writeFile(path.join(scratch, CONFIG_FILE), JSON.stringify(probe), { mode: 0o600 });
    const probed = await listSettings(ompPath, { ...opts, scope: "global" }).catch(() => ({}) as Record<string, ListedSetting>);
    return listed.map(([key, s]) => ({
      key,
      type: s.type as OmpSettingType,
      description: s.description ?? "",
      options: options.get(key) ?? [],
      default: s.redacted ? null : ((s.value ?? null) as OmpSettingValue),
      secret: s.redacted === true || probed[key]?.redacted === true,
    }));
  });
}

/**
 * Every omp setting (`omp config list` on an empty config, plus one probe per enum for its choices; a
 * few seconds), cached for 10 minutes per omp path; `refresh` re-lists. A failed listing is not cached.
 */
export function listOmpSettings(ompPath: string, options: { refresh?: boolean } = {}): Promise<OmpSettingInfo[]> {
  const cached = g.__ompUiSettings;
  if (options.refresh || !cached || cached.path !== ompPath || Date.now() - cached.at > SETTINGS_TTL_MS) {
    const settings = loadOmpSettings(ompPath);
    g.__ompUiSettings = { path: ompPath, at: Date.now(), settings };
    settings.catch(() => {
      if (g.__ompUiSettings?.settings === settings) g.__ompUiSettings = undefined;
    });
  }
  return g.__ompUiSettings!.settings;
}
