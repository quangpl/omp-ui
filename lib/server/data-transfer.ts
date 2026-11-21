// Settings → Data transfer: move a whole AgentMan server to another machine. An export is one
// `.tar.gz` holding manifest.json, every database table as JSON lines of driver-independent domain
// records (db/<table>.jsonl, so an export from SQLite imports into PostgreSQL or MongoDB and back),
// DATA_DIR/files (card and project shared files) and DATA_DIR/credentials.key (the key that seals
// saved secrets; left out when CREDENTIALS_KEY sets it). Project folders and omp's own state
// (~/.omp: sessions, config, provider logins) are not part of it.
//
// An import replaces everything: it is refused while agents run, validates the whole archive
// first, saves a backup of the current data to DATA_DIR/backups, swaps the database rows, then the
// files and the key, and reloads what caches them (token secret, provider keys, MCP env, chat bots).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { holdNewRuns } from "@/lib/agent/manager";
import type { AgentManager } from "@/lib/agent/types";
import { forgetAuthSecret } from "@/lib/auth";
import { parseAgentResources, parseBranchMap, parseFolderList, parseTaskReview, parseTaskUsage } from "@/lib/db/util";
import { DATA_TABLES, type DataRows, type DataSnapshot, type DataTable, type DbDriver, type Repository } from "@/lib/db/types";
import { dataDir } from "@/lib/files";
import { loadAiProviderEnv } from "@/lib/server/ai-providers";
import { restartChatIntegrations } from "@/lib/server/chat/service";
import { replaceCredentialsKeyFile } from "@/lib/server/credentials";
import { HttpError } from "@/lib/server/http";
import { syncMcpServers } from "@/lib/server/mcp";
import { parseTodoPhases } from "@/lib/todos";
import {
  TASK_STATUSES,
  USER_ROLES,
  type AgentState,
  type CommentAuthor,
  type DataBackup,
  type DataImportResult,
  type DataTransferStatus,
  type ImportedCredentialsKey,
  type RunEventKind,
  type RunStatus,
  type SchedulerRun,
  type SchedulerRunStatus,
} from "@/lib/types";
import { APP_VERSION } from "@/lib/version";

const FORMAT = "agentman-data";
/** Bump when an older server could no longer read what this one writes. */
const FORMAT_VERSION = 1;
const MANIFEST = "manifest.json";
const KEY_FILE = "credentials.key";
const BACKUP_PREFIX = "before-import-";
/** Automatic backups kept in DATA_DIR/backups (oldest deleted first). */
const MAX_BACKUPS = 3;
const ARCHIVE_NAME = /^[A-Za-z0-9._-]+\.tar\.gz$/;

interface Manifest {
  format: typeof FORMAT;
  version: number;
  appVersion: string;
  createdAt: string;
  driver: DbDriver;
  counts: Record<DataTable, number>;
  /** "file": credentials.key is in the archive; "env": the source used CREDENTIALS_KEY (not included). */
  credentialsKey: "file" | "env" | "none";
}

const g = globalThis as unknown as { __ompUiDataImport?: boolean };

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

function credentialsKeyFromEnv(): boolean {
  return !!process.env.CREDENTIALS_KEY?.trim();
}

/** `yyyymmdd-hhmmss` (UTC) for file names. */
function fileStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function runTar(args: string[]): Promise<void> {
  // COPYFILE_DISABLE: macOS tar would add AppleDouble `._*` files.
  const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 4000) stderr += chunk;
  });
  const [code] = (await once(child, "close")) as [number | null];
  if (code !== 0) throw new Error(`tar failed (exit ${code ?? "signal"}): ${stderr.trim() || "no output"}`);
}

/** Regular files and total bytes under `dir` (0/0 when missing). `strict`: anything else (links, devices) throws. */
async function scanTree(dir: string, strict: boolean): Promise<{ files: number; bytes: number }> {
  const total = { files: 0, bytes: 0 };
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && current === dir) return;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        total.files++;
        total.bytes += (await fs.lstat(full)).size;
      } else if (strict) {
        throw new HttpError(400, `The archive holds an unsupported entry (link or special file): ${path.relative(dir, full)}`);
      }
    }
  };
  await walk(dir);
  return total;
}

// ---------------------------------------------------------------------------------------------
// Export

async function writeTable(repo: Repository, table: DataTable, file: string): Promise<number> {
  const out = createWriteStream(file);
  let count = 0;
  try {
    for await (const batch of repo.exportRows(table)) {
      for (const row of batch) {
        count++;
        if (!out.write(`${JSON.stringify(row)}\n`)) await once(out, "drain");
      }
    }
  } finally {
    out.end();
    await once(out, "close");
  }
  return count;
}

/** Write an export of everything `repo` and DATA_DIR hold to `file` (a `.tar.gz`). */
async function writeArchive(repo: Repository, file: string): Promise<Manifest> {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "agentman-export-"));
  try {
    await fs.mkdir(path.join(staging, "db"));
    const counts = {} as Record<DataTable, number>;
    for (const table of DATA_TABLES) counts[table] = await writeTable(repo, table, path.join(staging, "db", `${table}.jsonl`));
    const data = dataDir();
    const withFiles = await exists(path.join(data, "files"));
    const withKey = !credentialsKeyFromEnv() && (await exists(path.join(data, KEY_FILE)));
    const manifest: Manifest = {
      format: FORMAT,
      version: FORMAT_VERSION,
      appVersion: APP_VERSION,
      createdAt: new Date().toISOString(),
      driver: repo.driver,
      counts,
      credentialsKey: credentialsKeyFromEnv() ? "env" : withKey ? "file" : "none",
    };
    await fs.writeFile(path.join(staging, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    const fromData = [...(withFiles ? ["files"] : []), ...(withKey ? [KEY_FILE] : [])];
    await runTar([
      "-czf",
      file,
      "-C",
      staging,
      MANIFEST,
      "db",
      ...(fromData.length > 0 ? ["-C", data, ...fromData] : []),
    ]);
    await fs.chmod(file, 0o600);
    return manifest;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/** GET /data-transfer/export: the export as a download; the temporary archive is deleted once sent. */
export async function exportResponse(repo: Repository): Promise<Response> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentman-download-"));
  const name = `agentman-data-${fileStamp(new Date())}.tar.gz`;
  const file = path.join(dir, name);
  try {
    await writeArchive(repo, file);
    const { size } = await fs.stat(file);
    const stream = createReadStream(file);
    stream.on("close", () => void fs.rm(dir, { recursive: true, force: true }));
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        "content-type": "application/gzip",
        "content-length": String(size),
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Backups (DATA_DIR/backups)

function backupsDir(): string {
  return path.join(dataDir(), "backups");
}

export async function listBackups(): Promise<DataBackup[]> {
  let names: string[];
  try {
    names = await fs.readdir(backupsDir());
  } catch {
    return [];
  }
  const backups = await Promise.all(
    names
      .filter((name) => name.startsWith(BACKUP_PREFIX) && ARCHIVE_NAME.test(name))
      .map(async (name) => {
        const stat = await fs.stat(path.join(backupsDir(), name));
        return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
      }),
  );
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Absolute path of an existing backup; 404 for anything else. */
export async function backupFile(name: string): Promise<string> {
  if (!name.startsWith(BACKUP_PREFIX) || !ARCHIVE_NAME.test(name)) throw new HttpError(404, "Backup not found");
  const file = path.join(backupsDir(), name);
  if (!(await exists(file))) throw new HttpError(404, "Backup not found");
  return file;
}

async function createBackup(repo: Repository): Promise<DataBackup> {
  await fs.mkdir(backupsDir(), { recursive: true, mode: 0o700 });
  const name = `${BACKUP_PREFIX}${fileStamp(new Date())}.tar.gz`;
  const file = path.join(backupsDir(), name);
  await writeArchive(repo, file);
  for (const old of (await listBackups()).filter((b) => b.name !== name).slice(MAX_BACKUPS - 1)) {
    await fs.rm(path.join(backupsDir(), old.name), { force: true });
  }
  const stat = await fs.stat(file);
  return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
}

// ---------------------------------------------------------------------------------------------
// Status

export async function dataTransferStatus(repo: Repository, manager: AgentManager): Promise<DataTransferStatus> {
  const [users, boards, schedulers, files, backups] = await Promise.all([
    repo.listUsers(),
    repo.listBoards(),
    repo.listSchedulers(),
    scanTree(path.join(dataDir(), "files"), false),
    listBackups(),
  ]);
  const { running, queued } = manager.stats();
  return {
    driver: repo.driver,
    users: users.length,
    projects: boards.length,
    cards: boards.reduce((sum, b) => sum + b.counts.todo + b.counts.in_progress + b.counts.done, 0),
    schedulers: schedulers.length,
    filesBytes: files.bytes,
    credentialsKey: credentialsKeyFromEnv() ? "env" : "file",
    activeAgents: running.length + queued.length,
    importing: g.__ompUiDataImport === true,
    backups,
  };
}

// ---------------------------------------------------------------------------------------------
// Reading an archive

// Records, not arrays, so a value added to one of these unions fails to compile until it is listed.
const AGENT_STATES: Record<AgentState, true> = { idle: true, queued: true, running: true, error: true };
const COMMENT_AUTHORS: Record<CommentAuthor, true> = { user: true, agent: true };
const RUN_STATUSES: Record<RunStatus, true> = { running: true, succeeded: true, failed: true, aborted: true };
const RUN_EVENT_KINDS: Record<RunEventKind, true> = {
  status: true,
  text: true,
  thinking: true,
  tool: true,
  error: true,
  agent: true,
};
const SCHEDULER_RUN_STATUSES: Record<SchedulerRunStatus, true> = { created: true, failed: true };
const SCHEDULER_TRIGGERS: Record<SchedulerRun["trigger"], true> = { scheduled: true, manual: true };

/** Typed reads of one JSON line; a wrong type is a 400 naming the file, line and field. */
class Fields {
  constructor(
    private readonly row: Record<string, unknown>,
    private readonly where: string,
  ) {}

  private fail(field: string, what: string): never {
    throw new HttpError(400, `Invalid archive: ${this.where}: ${field} must be ${what}`);
  }

  raw(field: string): unknown {
    return this.row[field];
  }

  str(field: string): string {
    const value = this.row[field];
    return typeof value === "string" ? value : this.fail(field, "a string");
  }

  strOrNull(field: string): string | null {
    const value = this.row[field];
    return value == null ? null : typeof value === "string" ? value : this.fail(field, "a string or null");
  }

  num(field: string): number {
    const value = this.row[field];
    return typeof value === "number" && Number.isFinite(value) ? value : this.fail(field, "a number");
  }

  numOrNull(field: string): number | null {
    return this.row[field] == null ? null : this.num(field);
  }

  bool(field: string): boolean {
    const value = this.row[field];
    return typeof value === "boolean" ? value : this.fail(field, "true or false");
  }

  boolOrNull(field: string): boolean | null {
    return this.row[field] == null ? null : this.bool(field);
  }

  oneOf<T extends string>(field: string, allowed: Record<T, true> | readonly T[]): T {
    const values: readonly string[] = Array.isArray(allowed) ? allowed : Object.keys(allowed);
    const value = this.row[field];
    return typeof value === "string" && values.includes(value) ? (value as T) : this.fail(field, `one of ${values.join(", ")}`);
  }

  oneOfOrNull<T extends string>(field: string, allowed: Record<T, true>): T | null {
    return this.row[field] == null ? null : this.oneOf(field, allowed);
  }
}

const PARSERS: { [T in DataTable]: (f: Fields) => DataRows[T] } = {
  settings: (f) => ({ key: f.str("key"), value: f.str("value") }),
  users: (f) => ({
    id: f.str("id"),
    username: f.str("username"),
    email: f.strOrNull("email"),
    passwordHash: f.str("passwordHash"),
    role: f.oneOf("role", USER_ROLES),
    isActive: f.bool("isActive"),
    tokenEpoch: f.num("tokenEpoch"),
    createdAt: f.str("createdAt"),
    updatedAt: f.str("updatedAt"),
  }),
  boards: (f) => ({
    id: f.str("id"),
    name: f.str("name"),
    workdir: f.str("workdir"),
    extraFolders: parseFolderList(f.raw("extraFolders")),
    model: f.strOrNull("model"),
    autoRun: f.bool("autoRun"),
    pushBranch: f.str("pushBranch"),
    defaultBranches: parseBranchMap(f.raw("defaultBranches")),
    pinned: f.bool("pinned"),
    lastAccessedAt: f.strOrNull("lastAccessedAt"),
    userId: f.strOrNull("userId"),
    createdAt: f.str("createdAt"),
    updatedAt: f.str("updatedAt"),
  }),
  tasks: (f) => ({
    id: f.str("id"),
    boardId: f.str("boardId"),
    title: f.str("title"),
    description: f.str("description"),
    status: f.oneOf("status", TASK_STATUSES),
    position: f.num("position"),
    agentState: f.oneOf("agentState", AGENT_STATES),
    agentError: f.strOrNull("agentError"),
    question: f.strOrNull("question"),
    sessionFile: f.strOrNull("sessionFile"),
    lastRunId: f.strOrNull("lastRunId"),
    blockedBy: parseFolderList(f.raw("blockedBy")),
    createdByTaskId: f.strOrNull("createdByTaskId"),
    pushedAt: f.strOrNull("pushedAt"),
    autoRetries: f.num("autoRetries"),
    retryAt: f.strOrNull("retryAt"),
    todos: parseTodoPhases(f.raw("todos")),
    review: parseTaskReview(f.raw("review")),
    resources: parseAgentResources(f.raw("resources")),
    usage: parseTaskUsage(f.raw("usage")),
    schedulerId: f.strOrNull("schedulerId"),
    parallelize: f.boolOrNull("parallelize"),
    ignoreMemory: f.bool("ignoreMemory"),
    userId: f.strOrNull("userId"),
    createdAt: f.str("createdAt"),
    updatedAt: f.str("updatedAt"),
  }),
  comments: (f) => ({
    id: f.str("id"),
    taskId: f.str("taskId"),
    author: f.oneOf("author", COMMENT_AUTHORS),
    body: f.str("body"),
    resolved: f.bool("resolved"),
    resolvedAt: f.strOrNull("resolvedAt"),
    resolvedByRunId: f.strOrNull("resolvedByRunId"),
    fromTaskId: f.strOrNull("fromTaskId"),
    userId: f.strOrNull("userId"),
    createdAt: f.str("createdAt"),
  }),
  runs: (f) => ({
    id: f.str("id"),
    taskId: f.str("taskId"),
    status: f.oneOf("status", RUN_STATUSES),
    prompt: f.str("prompt"),
    summary: f.strOrNull("summary"),
    error: f.strOrNull("error"),
    startedAt: f.str("startedAt"),
    endedAt: f.strOrNull("endedAt"),
    userId: f.strOrNull("userId"),
    nodeId: f.strOrNull("nodeId"),
    nodeName: f.strOrNull("nodeName"),
  }),
  run_events: (f) => ({
    seq: f.num("seq"),
    runId: f.str("runId"),
    taskId: f.str("taskId"),
    kind: f.oneOf("kind", RUN_EVENT_KINDS),
    text: f.str("text"),
    createdAt: f.str("createdAt"),
  }),
  schedulers: (f) => ({
    id: f.str("id"),
    boardId: f.str("boardId"),
    name: f.str("name"),
    prompt: f.str("prompt"),
    cron: f.str("cron"),
    timezone: f.str("timezone"),
    enabled: f.bool("enabled"),
    maxRuns: f.numOrNull("maxRuns"),
    runCount: f.num("runCount"),
    lastRunAt: f.strOrNull("lastRunAt"),
    nextRunAt: f.strOrNull("nextRunAt"),
    lastStatus: f.oneOfOrNull("lastStatus", SCHEDULER_RUN_STATUSES),
    lastTaskId: f.strOrNull("lastTaskId"),
    lastError: f.strOrNull("lastError"),
    userId: f.strOrNull("userId"),
    createdAt: f.str("createdAt"),
    updatedAt: f.str("updatedAt"),
  }),
  scheduler_runs: (f) => ({
    id: f.str("id"),
    schedulerId: f.str("schedulerId"),
    taskId: f.strOrNull("taskId"),
    trigger: f.oneOf("trigger", SCHEDULER_TRIGGERS),
    scheduledFor: f.str("scheduledFor"),
    status: f.oneOf("status", SCHEDULER_RUN_STATUSES),
    error: f.strOrNull("error"),
    createdAt: f.str("createdAt"),
  }),
};

async function readTable<T extends DataTable>(file: string, table: T): Promise<DataRows[T][]> {
  const name = `db/${table}.jsonl`;
  if (!(await exists(file))) throw new HttpError(400, `Invalid archive: ${name} is missing`);
  const rows: DataRows[T][] = [];
  const lines = readline.createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of lines) {
    lineNo++;
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new HttpError(400, `Invalid archive: ${name} line ${lineNo} is not JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, `Invalid archive: ${name} line ${lineNo} is not an object`);
    }
    rows.push(PARSERS[table](new Fields(parsed as Record<string, unknown>, `${name} line ${lineNo}`)));
  }
  return rows;
}

function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid archive: manifest.json is not JSON");
  }
  const m = raw as Partial<Manifest> | null;
  if (!m || m.format !== FORMAT) throw new HttpError(400, "This is not an AgentMan data export");
  if (typeof m.version !== "number" || m.version < 1 || m.version > FORMAT_VERSION) {
    throw new HttpError(400, `The export has format version ${String(m.version)}; this server reads up to ${FORMAT_VERSION}. Update this server first.`);
  }
  if (!m.counts || typeof m.counts !== "object") throw new HttpError(400, "Invalid archive: manifest.json has no row counts");
  return m as Manifest;
}

/** Unpack `archive` into `dir` and read and check its manifest and tables. */
async function readArchive(archive: string, dir: string): Promise<{ manifest: Manifest; data: DataSnapshot; files: number }> {
  await fs.mkdir(dir, { recursive: true });
  try {
    await runTar(["-xzf", archive, "-C", dir, "--no-same-owner", "--no-same-permissions"]);
  } catch (err) {
    throw new HttpError(400, `The file is not a readable .tar.gz export (${errorMessage(err)})`);
  }
  // Before anything is read or moved: no links may point out of the unpacked tree.
  await scanTree(dir, true);
  let manifestText: string;
  try {
    manifestText = await fs.readFile(path.join(dir, MANIFEST), "utf8");
  } catch {
    throw new HttpError(400, "This is not an AgentMan data export (manifest.json is missing)");
  }
  const manifest = parseManifest(manifestText);
  const data = {} as Record<DataTable, unknown[]>;
  for (const table of DATA_TABLES) {
    const rows = await readTable(path.join(dir, "db", `${table}.jsonl`), table);
    if (rows.length !== manifest.counts[table]) {
      throw new HttpError(400, `Invalid archive: db/${table}.jsonl has ${rows.length} rows, the manifest says ${manifest.counts[table]}`);
    }
    data[table] = rows;
  }
  const { files } = await scanTree(path.join(dir, "files"), false);
  return { manifest, data: data as DataSnapshot, files };
}

// ---------------------------------------------------------------------------------------------
// Import

/**
 * Leave out rows whose parent row is not in the snapshot (the drivers' foreign keys would reject
 * them) and duplicate keys; returns how many rows were left out.
 */
function dropOrphans(data: DataSnapshot): number {
  let dropped = 0;
  const keep = <R>(rows: R[], ok: (row: R) => boolean): R[] => {
    const kept = rows.filter(ok);
    dropped += rows.length - kept.length;
    return kept;
  };
  const unique = <R>(rows: R[], key: (row: R) => string | number): R[] => {
    const seen = new Set<string | number>();
    return keep(rows, (row) => !seen.has(key(row)) && !!seen.add(key(row)));
  };
  data.settings = unique(data.settings, (s) => s.key);
  data.users = unique(data.users, (u) => u.id);
  data.boards = unique(data.boards, (b) => b.id);
  const boards = new Set(data.boards.map((b) => b.id));
  data.tasks = keep(unique(data.tasks, (t) => t.id), (t) => boards.has(t.boardId));
  const tasks = new Set(data.tasks.map((t) => t.id));
  data.comments = keep(unique(data.comments, (c) => c.id), (c) => tasks.has(c.taskId));
  data.runs = keep(unique(data.runs, (r) => r.id), (r) => tasks.has(r.taskId));
  const runs = new Set(data.runs.map((r) => r.id));
  data.run_events = keep(unique(data.run_events, (e) => e.seq), (e) => runs.has(e.runId));
  data.schedulers = keep(unique(data.schedulers, (s) => s.id), (s) => boards.has(s.boardId));
  const schedulers = new Set(data.schedulers.map((s) => s.id));
  data.scheduler_runs = keep(unique(data.scheduler_runs, (r) => r.id), (r) => schedulers.has(r.schedulerId));
  return dropped;
}

/**
 * Agents that were running or queued on the source server have no process here: their runs end
 * as aborted, running cards fail with a note (Resume continues them), queued cards go idle, and
 * pending automatic retries are dropped. Returns the number of cards stopped.
 */
function stopImportedAgents(data: DataSnapshot): number {
  const now = new Date().toISOString();
  for (const run of data.runs) {
    if (run.status !== "running") continue;
    run.status = "aborted";
    run.error ??= "Interrupted: the data was moved to another server";
    run.endedAt = now;
  }
  let stopped = 0;
  for (const task of data.tasks) {
    task.retryAt = null;
    if (task.agentState === "running") {
      task.agentState = "error";
      task.agentError = "Interrupted: the data was moved to another server. Resume to continue.";
      stopped++;
    } else if (task.agentState === "queued") {
      task.agentState = "idle";
      stopped++;
    }
  }
  return stopped;
}

async function moveAside(from: string, to: string): Promise<boolean> {
  try {
    await fs.rename(from, to);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * POST /data-transfer/import: replace this server's data with the export in `body`. Refused (409)
 * while agents run or another import is in progress; a bad archive is a 400 before anything changes.
 */
export async function importArchive(
  repo: Repository,
  manager: AgentManager,
  body: ReadableStream<Uint8Array> | null,
): Promise<Omit<DataImportResult, "signedOut">> {
  if (!body) throw new HttpError(400, "The upload is empty");
  if (g.__ompUiDataImport) throw new HttpError(409, "Another import is in progress");
  const busy = (): number => {
    const { running, queued } = manager.stats();
    return running.length + queued.length;
  };
  if (busy() > 0) {
    throw new HttpError(409, `Stop the ${busy()} running or queued agent(s) first: an import replaces their cards.`);
  }
  g.__ompUiDataImport = true;
  const runtime = path.join(dataDir(), "runtime");
  await fs.mkdir(runtime, { recursive: true });
  // Inside DATA_DIR, so the unpacked files move into place with a rename.
  const work = await fs.mkdtemp(path.join(runtime, "import-"));
  try {
    const archive = path.join(work, "upload.tar.gz");
    await pipeline(Readable.fromWeb(body as WebReadableStream<Uint8Array>), createWriteStream(archive, { mode: 0o600 }));
    const { manifest, data, files } = await readArchive(archive, path.join(work, "archive"));
    if (!data.users.some((u) => u.role === "admin" && u.isActive)) {
      throw new HttpError(400, "The export has no active admin account: nobody could manage this server after the import");
    }
    const skipped = dropOrphans(data);
    const interrupted = stopImportedAgents(data);

    holdNewRuns(true);
    try {
      if (busy() > 0) throw new HttpError(409, "An agent started meanwhile: stop it and import again.");
      const backup = await createBackup(repo);
      try {
        await repo.replaceAllData(data);
      } catch (err) {
        // SQLite and PostgreSQL rolled back; MongoDB may be half-written: put the backup back.
        if (repo.driver === "mongodb") {
          const previous = await readArchive(path.join(backupsDir(), backup.name), path.join(work, "backup"));
          await repo.replaceAllData(previous.data);
        }
        throw err;
      }

      const target = path.join(dataDir(), "files");
      await moveAside(target, path.join(work, "previous-files"));
      if (!(await moveAside(path.join(work, "archive", "files"), target))) await fs.mkdir(target, { recursive: true });

      let credentialsKey: ImportedCredentialsKey = manifest.credentialsKey === "env" ? "set-env" : "none";
      const keyFile = path.join(work, "archive", KEY_FILE);
      if (await exists(keyFile)) {
        replaceCredentialsKeyFile(await fs.readFile(keyFile, "utf8"));
        credentialsKey = credentialsKeyFromEnv() ? "ignored" : "restored";
      }

      await reloadImportedState(repo, manager);
      const counts = Object.fromEntries(DATA_TABLES.map((table) => [table, data[table].length]));
      return {
        source: { appVersion: manifest.appVersion, createdAt: manifest.createdAt, driver: manifest.driver },
        counts,
        skipped,
        files,
        credentialsKey,
        interrupted,
        backup,
      };
    } finally {
      holdNewRuns(false);
    }
  } finally {
    g.__ompUiDataImport = false;
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** Re-read what this process cached from the replaced data. Failures are logged, never thrown: the data is in. */
async function reloadImportedState(repo: Repository, manager: AgentManager): Promise<void> {
  forgetAuthSecret();
  await loadAiProviderEnv(repo);
  await syncMcpServers(repo).catch((err: unknown) => console.error("[data-transfer] MCP sync failed:", errorMessage(err)));
  await restartChatIntegrations(repo, manager).catch((err: unknown) =>
    console.error("[data-transfer] restarting chat bots failed:", errorMessage(err)),
  );
}
