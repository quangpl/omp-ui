// Server-only Docker management behind `/api/v1/docker/**`. Everything goes through the `docker`
// CLI (DOCKER_BIN, default `docker`) via execFile/spawn with argument arrays — never a shell — so
// it uses the same daemon, contexts and registry logins as the host user. Every user-supplied
// value is validated before it reaches an argument list (no leading "-", strict name patterns).
import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { childEnv } from "@/lib/child-env";
import { fetchComposeUrl, getTemplateCompose } from "@/lib/docker-catalog";
import type {
  ComposeAction,
  ComposeDeploySpec,
  ComposeFile,
  ComposeProject,
  ContainerAction,
  ContainerState,
  DockerContainer,
  DockerContainerStats,
  DockerImage,
  DockerJobEvent,
  DockerNetwork,
  DockerOverview,
  DockerPort,
  DockerVolume,
  EnvVar,
  PortMapping,
  PruneKind,
  RunContainerSpec,
  RunningSummary,
} from "@/lib/docker-types";
import { dataDir } from "@/lib/files";
import { HttpError } from "@/lib/server/http";

const QUICK_TIMEOUT_MS = 20_000;
const STATS_TIMEOUT_MS = 15_000;
/** Pulls and compose up can download gigabytes. */
const JOB_TIMEOUT_MS = 30 * 60_000;
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_LOG_LINES = 5000;

export const CONTAINER_ACTIONS: readonly ContainerAction[] = [
  "start",
  "stop",
  "restart",
  "pause",
  "unpause",
  "kill",
];
export const COMPOSE_ACTIONS: readonly ComposeAction[] = ["up", "down", "stop", "start", "restart", "pull"];
export const PRUNE_KINDS: readonly PruneKind[] = ["containers", "images", "volumes", "networks", "builder"];

function dockerBin(): string {
  return process.env.DOCKER_BIN?.trim() || "docker";
}

/** DATA_DIR/compose: one folder per compose project created from AgentMan. */
export function composeRoot(): string {
  return path.join(dataDir(), "compose");
}

// ---------------------------------------------------------------------------------------------
// Validation

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** Loose image reference check (docker validates the rest): registry/repo:tag@digest. */
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,254}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const HOST_PORT_RE = /^(?:(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):)?(\d{1,5})$/;

/** Container id or name. */
export function parseContainerRef(value: unknown): string {
  if (typeof value !== "string" || !NAME_RE.test(value)) {
    throw new HttpError(400, "Invalid container id or name");
  }
  return value;
}

/** Volume or network name/id (same rules as container names). */
export function parseResourceName(value: unknown, what: string): string {
  if (typeof value !== "string" || !NAME_RE.test(value)) throw new HttpError(400, `Invalid ${what} name`);
  return value;
}

export function parseImageRef(value: unknown): string {
  const image = typeof value === "string" ? value.trim() : "";
  if (!image) throw new HttpError(400, "Image is required");
  if (!IMAGE_RE.test(image)) throw new HttpError(400, `Invalid image reference: ${image}`);
  return image;
}

/** Compose project names: lowercase letters, digits, "-" and "_", starting with a letter/digit. */
export function parseProjectName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!PROJECT_RE.test(name)) {
    throw new HttpError(
      400,
      "Project name must be lowercase letters, digits, \"-\" or \"_\" and start with a letter or digit",
    );
  }
  return name;
}

function parseEnv(value: unknown): EnvVar[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "env must be a list");
  const out: EnvVar[] = [];
  for (const item of value) {
    const key = typeof item?.key === "string" ? item.key.trim() : "";
    if (!key) continue;
    if (!ENV_KEY_RE.test(key)) throw new HttpError(400, `Invalid environment variable name: ${key}`);
    const raw = item.value;
    const val = raw === undefined || raw === null ? "" : String(raw);
    if (/[\r\n]/.test(val)) throw new HttpError(400, `${key}: values cannot contain line breaks`);
    out.push({ key, value: val });
  }
  return out;
}

/** Split a command line like a POSIX shell would (quotes and backslashes), without expansion. */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      current += command[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || current) args.push(current);
      current = "";
      has = false;
    } else {
      current += ch;
    }
  }
  if (quote) throw new HttpError(400, "Command has an unclosed quote");
  if (has || current) args.push(current);
  return args;
}

/** Validate a POST /docker/run body and turn it into `docker run` arguments. */
export function buildRunArgs(input: Record<string, unknown>): { args: string[]; spec: RunContainerSpec } {
  const image = parseImageRef(input.image);
  const args = ["run", "-d"];
  const spec: RunContainerSpec = { image };

  if (input.name !== undefined && input.name !== null && String(input.name).trim()) {
    const name = String(input.name).trim();
    if (!NAME_RE.test(name)) {
      throw new HttpError(400, "Container name may use letters, digits, \"_\", \".\" and \"-\"");
    }
    spec.name = name;
    args.push("--name", name);
  }

  if (input.ports !== undefined && !Array.isArray(input.ports)) throw new HttpError(400, "ports must be a list");
  for (const port of (input.ports as unknown[] | undefined) ?? []) {
    const p = port as Record<string, unknown>;
    const container = Number(p.container);
    if (!Number.isInteger(container) || container < 1 || container > 65535) {
      throw new HttpError(400, `Invalid container port: ${String(p.container)}`);
    }
    const protocol = p.protocol === "udp" ? "udp" : "tcp";
    const host = typeof p.host === "string" ? p.host.trim() : p.host == null ? "" : String(p.host);
    let publish: string;
    if (!host) {
      publish = `${container}:${container}`;
    } else {
      const match = HOST_PORT_RE.exec(host);
      const hostPort = match ? Number(match[2]) : NaN;
      if (!match || hostPort < 1 || hostPort > 65535) throw new HttpError(400, `Invalid host port: ${host}`);
      publish = `${host}:${container}`;
    }
    args.push("-p", `${publish}/${protocol}`);
  }

  for (const { key, value } of parseEnv(input.env)) args.push("-e", `${key}=${value}`);

  if (input.volumes !== undefined && !Array.isArray(input.volumes)) {
    throw new HttpError(400, "volumes must be a list");
  }
  for (const volume of (input.volumes as unknown[] | undefined) ?? []) {
    const v = volume as Record<string, unknown>;
    const target = typeof v.target === "string" ? v.target.trim() : "";
    if (!target.startsWith("/") || target.includes(":") || target.includes(",")) {
      throw new HttpError(400, `Invalid container path for a volume: ${target || "(empty)"}`);
    }
    const source = typeof v.source === "string" ? v.source.trim() : "";
    if (source && !path.isAbsolute(source) && !NAME_RE.test(source)) {
      throw new HttpError(400, `Volume source must be a volume name or an absolute host path: ${source}`);
    }
    if (source.includes(":") || source.includes(",")) {
      throw new HttpError(400, `Volume source cannot contain ":" or ",": ${source}`);
    }
    const mode = v.readonly === true ? ":ro" : "";
    args.push("-v", source ? `${source}:${target}${mode}` : target);
  }

  const restart = input.restart ?? "unless-stopped";
  if (restart !== "no" && restart !== "unless-stopped" && restart !== "always" && restart !== "on-failure") {
    throw new HttpError(400, "restart must be no, unless-stopped, always or on-failure");
  }
  spec.restart = restart;
  args.push("--restart", restart);

  if (typeof input.network === "string" && input.network.trim()) {
    args.push("--network", parseResourceName(input.network.trim(), "network"));
  }
  if (input.interactive === true) args.push("-i", "-t");
  if (input.privileged === true) args.push("--privileged");

  args.push(image);
  if (typeof input.command === "string" && input.command.trim()) args.push(...splitCommand(input.command));
  return { args, spec };
}

// ---------------------------------------------------------------------------------------------
// Running docker

interface DockerResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Plain-language failure, null on success. */
  error: string | null;
}

/** Turn docker's stderr into a message a person can act on. */
export function explainDockerError(stderr: string, code?: string | number | null): string {
  if (code === "ENOENT") return "Docker is not installed on this server (`docker` not found).";
  if (code === "EACCES") return "Can't run `docker`: permission denied.";
  const text = stderr.trim();
  if (/permission denied.*docker(\.sock|\s+daemon\s+socket)/i.test(text)) {
    return "No access to the Docker socket. Add the user running AgentMan to the docker group, then restart AgentMan.";
  }
  if (/cannot connect to the docker daemon|is the docker daemon running|docker daemon is not running/i.test(text)) {
    return "The Docker daemon is not running. Start it on this server.";
  }
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return (lines.at(-1) ?? "docker failed").replace(/^Error( response from daemon)?:\s*/i, "");
}

function docker(
  args: string[],
  options: { timeout?: number; cwd?: string } = {},
): Promise<DockerResult> {
  const { promise, resolve } = Promise.withResolvers<DockerResult>();
  execFile(
    dockerBin(),
    args,
    {
      timeout: options.timeout ?? QUICK_TIMEOUT_MS,
      cwd: options.cwd,
      maxBuffer: MAX_BUFFER,
      env: childEnv(),
      windowsHide: true,
    },
    (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, stdout: `${stdout}`, stderr: `${stderr}`, error: null });
      const error = err.killed
        ? `docker ${args[0]} took too long to respond`
        : explainDockerError(`${stderr}` || err.message, err.code);
      resolve({ ok: false, stdout: `${stdout}`, stderr: `${stderr}`, error });
    },
  );
  return promise;
}

/** Run docker and throw an HttpError (502) with docker's message on failure. */
async function dockerOrThrow(args: string[], options: { timeout?: number; cwd?: string } = {}): Promise<string> {
  const result = await docker(args, options);
  if (!result.ok) throw new HttpError(502, result.error ?? "docker failed");
  return result.stdout;
}

function jsonLines<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // docker may print warnings between JSON lines.
    }
  }
  return out;
}

/**
 * Run a long docker command and report it as `DockerJobEvent`s: each output line (stdout and
 * stderr; `\r` progress redraws count as lines), then one `done`. Never rejects. The command
 * keeps running if nobody listens anymore: interrupting a pull half-way helps no one.
 */
export function runDockerJob(
  args: string[],
  onEvent: (event: DockerJobEvent) => void,
  options: { cwd?: string; successMessage?: (stdout: string) => string; id?: (stdout: string) => string } = {},
): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  let stdout = "";
  let stderr = "";
  let finished = false;
  const finish = (event: DockerJobEvent) => {
    if (finished) return;
    finished = true;
    onEvent(event);
    resolve();
  };

  let child: ChildProcess;
  try {
    child = spawn(dockerBin(), args, {
      cwd: options.cwd,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    finish({ type: "done", ok: false, message: explainDockerError("", (err as NodeJS.ErrnoException).code) });
    return promise;
  }

  const timer = setTimeout(() => child.kill("SIGTERM"), JOB_TIMEOUT_MS);
  const pump = (kind: "out" | "err") => {
    let partial = "";
    return (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (kind === "out") stdout += text;
      else stderr = (stderr + text).slice(-64 * 1024);
      partial += text;
      const parts = partial.split(/\r?\n|\r/);
      partial = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) onEvent({ type: "log", line: line.trimEnd() });
    };
  };
  child.stdout?.on("data", pump("out"));
  child.stderr?.on("data", pump("err"));
  child.on("error", (err: NodeJS.ErrnoException) => {
    clearTimeout(timer);
    finish({ type: "done", ok: false, message: explainDockerError(stderr, err.code) });
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    if (code === 0) {
      const out = stdout.trim();
      finish({
        type: "done",
        ok: true,
        message: options.successMessage?.(out) ?? "Done",
        ...(options.id ? { id: options.id(out) } : {}),
      });
    } else {
      const message = signal ? `docker ${args[0]} was stopped (${signal})` : explainDockerError(stderr || stdout);
      finish({ type: "done", ok: false, message });
    }
  });
  return promise;
}

/** Stream a docker job as an NDJSON response. */
export function jobResponse(
  start: (send: (event: DockerJobEvent) => void) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: DockerJobEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
        }
      };
      start(send)
        .catch((err: unknown) =>
          send({ type: "done", ok: false, message: err instanceof Error ? err.message : String(err) }),
        )
        .finally(() => {
          if (!open) return;
          open = false;
          try {
            controller.close();
          } catch {
            // Client went away.
          }
        });
    },
    cancel() {
      open = false;
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Overview

const CONTAINER_FORMAT = `{"ID":{{json .ID}},"Names":{{json .Names}},"Image":{{json .Image}},"State":{{json .State}},"Status":{{json .Status}},"Command":{{json .Command}},"CreatedAt":{{json .CreatedAt}},"Ports":{{json .Ports}},"Networks":{{json .Networks}},"Mounts":{{json .Mounts}},"Project":{{json (.Label "com.docker.compose.project")}},"Service":{{json (.Label "com.docker.compose.service")}}}`;

interface RawContainer {
  ID: string;
  Names: string;
  Image: string;
  State: string;
  Status: string;
  Command: string;
  CreatedAt: string;
  Ports: string;
  Networks: string;
  Mounts: string;
  Project: string;
  Service: string;
}

const splitList = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 443/tcp" */
export function parsePorts(value: string): DockerPort[] {
  const ports: DockerPort[] = [];
  for (const part of splitList(value)) {
    const mapped = /^(.*):(\d+)(?:-\d+)?->(\d+)(?:-\d+)?\/(\w+)$/.exec(part);
    if (mapped) {
      ports.push({
        hostIp: mapped[1].replace(/^\[|\]$/g, ""),
        hostPort: Number(mapped[2]),
        containerPort: Number(mapped[3]),
        protocol: mapped[4],
      });
      continue;
    }
    const exposed = /^(\d+)(?:-\d+)?\/(\w+)$/.exec(part);
    if (exposed) {
      ports.push({ hostIp: null, hostPort: null, containerPort: Number(exposed[1]), protocol: exposed[2] });
    }
  }
  return ports;
}

const STATES: Record<ContainerState, true> = {
  running: true,
  paused: true,
  restarting: true,
  exited: true,
  created: true,
  removing: true,
  dead: true,
};

function toContainer(raw: RawContainer): DockerContainer {
  const health = /\((healthy|unhealthy|health: starting)\)/.exec(raw.Status)?.[1]?.replace("health: ", "") ?? null;
  const state = (Object.hasOwn(STATES, raw.State) ? raw.State : "exited") as ContainerState;
  return {
    id: raw.ID.slice(0, 12),
    name: raw.Names.split(",")[0] ?? raw.ID.slice(0, 12),
    image: raw.Image,
    state,
    status: raw.Status,
    health,
    command: raw.Command.replace(/^"|"$/g, ""),
    createdAt: raw.CreatedAt,
    ports: parsePorts(raw.Ports),
    composeProject: raw.Project || null,
    composeService: raw.Service || null,
    networks: splitList(raw.Networks),
    mounts: splitList(raw.Mounts),
  };
}

interface RawComposeProject {
  Name: string;
  Status: string;
  ConfigFiles?: string;
}

interface RawImage {
  ID: string;
  Repository: string;
  Tag: string;
  Size: string;
  CreatedSince: string;
}

interface RawVolume {
  Name: string;
  Driver: string;
  Mountpoint: string;
}

interface RawNetwork {
  ID: string;
  Name: string;
  Driver: string;
  Scope: string;
}

/** Project folders created from AgentMan (DATA_DIR/compose/<name>/compose.yaml). */
function managedProjects(): string[] {
  try {
    return fs
      .readdirSync(composeRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PROJECT_RE.test(entry.name))
      .filter((entry) => fs.existsSync(managedComposeFile(entry.name)))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function managedComposeFile(name: string): string {
  return path.join(composeRoot(), name, "compose.yaml");
}

function imageInUse(image: RawImage, containers: DockerContainer[]): number {
  const ref = `${image.Repository}:${image.Tag}`;
  const shortId = image.ID.replace(/^sha256:/, "").slice(0, 12);
  return containers.filter(
    (c) =>
      c.image === ref ||
      (image.Tag === "latest" && c.image === image.Repository) ||
      c.image.replace(/^sha256:/, "").startsWith(shortId),
  ).length;
}

function buildComposeProjects(raw: RawComposeProject[], containers: DockerContainer[]): ComposeProject[] {
  const managed = new Set(managedProjects());
  const byName = new Map<string, ComposeProject>();
  for (const project of raw) {
    const members = containers.filter((c) => c.composeProject === project.Name);
    byName.set(project.Name, {
      name: project.Name,
      status: project.Status,
      configFiles: splitList(project.ConfigFiles),
      managed: managed.has(project.Name),
      running: members.filter((c) => c.state === "running").length,
      total: members.length,
    });
  }
  // Managed projects that are down have no containers, so `compose ls` does not list them.
  for (const name of managed) {
    if (byName.has(name)) continue;
    byName.set(name, {
      name,
      status: "down",
      configFiles: [managedComposeFile(name)],
      managed: true,
      running: 0,
      total: 0,
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getDockerOverview(): Promise<DockerOverview> {
  const version = await docker(["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 });
  const empty: DockerOverview = {
    available: false,
    error: version.error,
    version: null,
    composeVersion: null,
    containers: [],
    composeProjects: [],
    images: [],
    volumes: [],
    networks: [],
  };
  if (!version.ok) return empty;

  const [compose, ps, ls, images, volumes, networks] = await Promise.all([
    docker(["compose", "version", "--short"], { timeout: 10_000 }),
    docker(["ps", "-a", "--no-trunc", "--format", CONTAINER_FORMAT]),
    docker(["compose", "ls", "-a", "--format", "json"]),
    docker(["images", "--format", "{{json .}}"]),
    docker(["volume", "ls", "--format", "{{json .}}"]),
    docker(["network", "ls", "--format", "{{json .}}"]),
  ]);
  if (!ps.ok) return { ...empty, error: ps.error };

  const containers = jsonLines<RawContainer>(ps.stdout).map(toContainer);
  const rawProjects = ls.ok ? composeLsJson(ls.stdout) : [];

  return {
    available: true,
    error: null,
    version: version.stdout.trim() || null,
    composeVersion: compose.ok ? compose.stdout.trim().replace(/^v/, "") || null : null,
    containers,
    composeProjects: buildComposeProjects(rawProjects, containers),
    images: jsonLines<RawImage>(images.stdout).map((image) => ({
      id: image.ID.replace(/^sha256:/, "").slice(0, 12),
      repository: image.Repository,
      tag: image.Tag,
      size: image.Size,
      createdSince: image.CreatedSince,
      containers: imageInUse(image, containers),
    })) satisfies DockerImage[],
    volumes: jsonLines<RawVolume>(volumes.stdout).map((volume) => ({
      name: volume.Name,
      driver: volume.Driver,
      mountpoint: volume.Mountpoint,
      usedBy: containers.filter((c) => c.mounts.includes(volume.Name)).map((c) => c.name),
    })) satisfies DockerVolume[],
    networks: jsonLines<RawNetwork>(networks.stdout).map((network) => ({
      id: network.ID,
      name: network.Name,
      driver: network.Driver,
      scope: network.Scope,
      builtin: ["bridge", "host", "none"].includes(network.Name),
    })) satisfies DockerNetwork[],
  };
}

interface RawStats {
  ID: string;
  Name: string;
  CPUPerc: string;
  MemPerc: string;
  MemUsage: string;
  NetIO: string;
  BlockIO: string;
}

export async function getContainerStats(): Promise<DockerContainerStats[]> {
  const out = await dockerOrThrow(["stats", "--no-stream", "--format", "{{json .}}"], {
    timeout: STATS_TIMEOUT_MS,
  });
  return jsonLines<RawStats>(out).map((s) => ({
    id: s.ID.slice(0, 12),
    name: s.Name,
    cpuPercent: Number.parseFloat(s.CPUPerc) || 0,
    memPercent: Number.parseFloat(s.MemPerc) || 0,
    memUsage: s.MemUsage,
    netIO: s.NetIO,
    blockIO: s.BlockIO,
  }));
}

// ---------------------------------------------------------------------------------------------
// Containers

export async function containerAction(ref: string, action: ContainerAction): Promise<void> {
  await dockerOrThrow([action, ref], { timeout: action === "stop" || action === "restart" ? 60_000 : QUICK_TIMEOUT_MS });
}

export async function removeContainer(ref: string, removeVolumes: boolean): Promise<void> {
  await dockerOrThrow(["rm", "-f", ...(removeVolumes ? ["-v"] : []), ref], { timeout: 60_000 });
}

/** Docker log lines start with an RFC 3339 timestamp when `--timestamps` is set. */
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /;

/** Merge stdout and stderr log lines back into time order. */
export function mergeLogStreams(stdout: string, stderr: string): string {
  const lines = [...stdout.split("\n"), ...stderr.split("\n")].filter((line) => line.length > 0);
  const keyed = lines.map((line, index) => ({ line, index, ts: TIMESTAMP_RE.exec(line)?.[1] ?? "" }));
  keyed.sort((a, b) => (a.ts && b.ts && a.ts !== b.ts ? (a.ts < b.ts ? -1 : 1) : a.index - b.index));
  return keyed.map((entry) => entry.line).join("\n");
}

export function parseTail(value: string | null): number {
  const n = Number(value ?? 300);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LOG_LINES) : 300;
}

export async function containerLogs(ref: string, tail: number): Promise<string> {
  const result = await docker(["logs", "--tail", String(tail), "--timestamps", ref]);
  if (!result.ok) throw new HttpError(502, result.error ?? "docker logs failed");
  return mergeLogStreams(result.stdout, result.stderr);
}

export async function inspectContainer(ref: string): Promise<unknown> {
  const out = await dockerOrThrow(["inspect", "--type", "container", ref]);
  const parsed = JSON.parse(out) as unknown[];
  if (!Array.isArray(parsed) || parsed.length === 0) throw new HttpError(404, "Container not found");
  return parsed[0];
}

// ---------------------------------------------------------------------------------------------
// Images, volumes, networks, prune

export async function removeImage(ref: string, force: boolean): Promise<void> {
  await dockerOrThrow(["rmi", ...(force ? ["-f"] : []), ref], { timeout: 60_000 });
}

export async function removeVolume(name: string): Promise<void> {
  await dockerOrThrow(["volume", "rm", name]);
}

export async function removeNetwork(name: string): Promise<void> {
  await dockerOrThrow(["network", "rm", name]);
}

const DOCKER_SIZE_UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 };

/** Docker's human sizes ("212.8MB", "40.96kB", "0B") → bytes; null when unparseable. */
export function parseDockerSize(text: string): number | null {
  const m = /^([\d.]+)\s*([kmgt]?b)/i.exec(text.trim());
  const unit = m && DOCKER_SIZE_UNITS[m[2]!.toLowerCase()];
  return m && unit ? Math.round(Number.parseFloat(m[1]!) * unit) : null;
}

export type DockerReclaimable =
  | { ok: true; kinds: Record<PruneKind, { bytes: number | null; count: number }> }
  | { ok: false; error: string };

/**
 * What each `prune -f` would remove: stopped containers, dangling images, anonymous unused
 * volumes (Docker 23+ keeps named ones), unused networks and the build cache.
 */
export async function dockerReclaimable(): Promise<DockerReclaimable> {
  const [df, images, volumes, networks] = await Promise.all([
    docker(["system", "df", "--format", "{{json .}}"], { timeout: 30_000 }),
    docker(["images", "-f", "dangling=true", "--format", "{{.Size}}"]),
    docker(["volume", "ls", "-q", "-f", "dangling=true"]),
    docker(["network", "ls", "-q", "-f", "dangling=true"]),
  ]);
  if (!df.ok) return { ok: false, error: df.error ?? "docker failed" };
  const rows = new Map(
    jsonLines<{ Type?: string; TotalCount?: string; Active?: string; Reclaimable?: string }>(df.stdout).map((r) => [
      r.Type ?? "",
      r,
    ]),
  );
  const count = (value: string | undefined) => Number.parseInt(value ?? "0", 10) || 0;
  const containers = rows.get("Containers");
  const cache = rows.get("Build Cache");
  const imageSizes = images.ok ? images.stdout.split("\n").filter((l) => l.trim()) : [];
  const anonymousVolumes = volumes.ok
    ? volumes.stdout.split("\n").filter((name) => /^[0-9a-f]{64}$/.test(name.trim()))
    : [];
  return {
    ok: true,
    kinds: {
      containers: {
        bytes: parseDockerSize(containers?.Reclaimable ?? ""),
        count: Math.max(0, count(containers?.TotalCount) - count(containers?.Active)),
      },
      images: {
        bytes: imageSizes.reduce((sum, size) => sum + (parseDockerSize(size) ?? 0), 0),
        count: imageSizes.length,
      },
      volumes: { bytes: null, count: anonymousVolumes.length },
      networks: { bytes: null, count: networks.ok ? networks.stdout.split("\n").filter((l) => l.trim()).length : 0 },
      builder: { bytes: parseDockerSize(cache?.Reclaimable ?? ""), count: count(cache?.TotalCount) },
    },
  };
}

export async function prune(kind: PruneKind): Promise<string> {
  const args =
    kind === "containers"
      ? ["container", "prune", "-f"]
      : kind === "images"
        ? ["image", "prune", "-f"]
        : kind === "volumes"
          ? ["volume", "prune", "-f"]
          : kind === "networks"
            ? ["network", "prune", "-f"]
            : ["builder", "prune", "-f"];
  const out = await dockerOrThrow(args, { timeout: 5 * 60_000 });
  const reclaimed = /Total reclaimed space:\s*(.+)/i.exec(out)?.[1]?.trim();
  return reclaimed ? `Reclaimed ${reclaimed}` : "Nothing to remove";
}

// ---------------------------------------------------------------------------------------------
// Compose

/** `docker compose ls --format json` output; older compose without JSON output lists nothing. */
function composeLsJson(stdout: string): RawComposeProject[] {
  try {
    const parsed = JSON.parse(stdout || "[]");
    return Array.isArray(parsed) ? (parsed as RawComposeProject[]) : [];
  } catch {
    return [];
  }
}

async function listComposeProjects(): Promise<RawComposeProject[]> {
  const result = await docker(["compose", "ls", "-a", "--format", "json"]);
  if (!result.ok) throw new HttpError(502, result.error ?? "docker compose ls failed");
  return composeLsJson(result.stdout);
}

/** `-p <name> -f <file>…` for a project: AgentMan's own folder first, else what compose recorded. */
async function composeTarget(name: string): Promise<{ args: string[]; files: string[]; managed: boolean }> {
  const managedFile = managedComposeFile(name);
  if (fs.existsSync(managedFile)) {
    return { args: ["compose", "-p", name, "-f", managedFile], files: [managedFile], managed: true };
  }
  const project = (await listComposeProjects()).find((p) => p.Name === name);
  if (!project) throw new HttpError(404, `Compose project "${name}" not found`);
  const files = splitList(project.ConfigFiles).filter((file) => fs.existsSync(file));
  return {
    args: ["compose", "-p", name, ...files.flatMap((file) => ["-f", file])],
    files,
    managed: false,
  };
}

function readEnvFile(file: string): EnvVar[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: EnvVar[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (/^'.*'$/.test(value)) value = value.slice(1, -1);
    else if (/^".*"$/.test(value)) value = value.slice(1, -1).replace(/\\(["\\$])/g, "$1");
    out.push({ key: match[1], value });
  }
  return out;
}

/** .env lines compose reads back verbatim: single quotes when needed (no escapes inside). */
function formatEnvFile(env: EnvVar[]): string {
  return env
    .map(({ key, value }) =>
      /^[A-Za-z0-9_./:@+-]*$/.test(value) || value.includes("'") ? `${key}=${value}` : `${key}='${value}'`,
    )
    .join("\n");
}

export async function readComposeFile(name: string): Promise<ComposeFile> {
  const target = await composeTarget(name);
  const file = target.files[0];
  if (!file) throw new HttpError(404, "The compose file of this project is not on this server");
  return {
    name,
    managed: target.managed,
    configFiles: target.files,
    yaml: fs.readFileSync(file, "utf8"),
    env: readEnvFile(path.join(path.dirname(file), ".env")),
  };
}

/** Validate a deploy body; writes nothing. */
export async function parseComposeDeploy(input: Record<string, unknown>): Promise<ComposeDeploySpec> {
  const name = parseProjectName(input.name);
  const yaml = typeof input.yaml === "string" ? input.yaml : "";
  if (!yaml.trim()) throw new HttpError(400, "Compose YAML is required");
  if (yaml.length > 512 * 1024) throw new HttpError(400, "Compose file is too large");
  const env = parseEnv(input.env);
  if (!fs.existsSync(managedComposeFile(name))) {
    const existing = (await listComposeProjects()).some((p) => p.Name === name);
    if (existing) {
      throw new HttpError(409, `A compose project named "${name}" already exists. Pick another name.`);
    }
  }
  return { name, yaml, env };
}

/** Write DATA_DIR/compose/<name>/{compose.yaml,.env}, validate it, then `up -d`. */
export async function deployCompose(spec: ComposeDeploySpec, send: (event: DockerJobEvent) => void): Promise<void> {
  const dir = path.join(composeRoot(), spec.name);
  const file = managedComposeFile(spec.name);
  const isNew = !fs.existsSync(file);
  fs.mkdirSync(dir, { recursive: true });
  const envFile = path.join(dir, ".env");
  const previous = isNew ? null : { yaml: fs.readFileSync(file, "utf8"), env: fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : null };
  fs.writeFileSync(file, spec.yaml.endsWith("\n") ? spec.yaml : `${spec.yaml}\n`);
  if (spec.env?.length) fs.writeFileSync(envFile, `${formatEnvFile(spec.env)}\n`, { mode: 0o600 });
  else fs.rmSync(envFile, { force: true });

  const base = ["compose", "-p", spec.name, "-f", file];
  send({ type: "log", line: `Checking ${path.relative(dataDir(), file)}…` });
  const check = await docker([...base, "config", "--quiet"], { cwd: dir });
  if (!check.ok) {
    // Leave the previous working version in place (or nothing, for a new project).
    if (previous) {
      fs.writeFileSync(file, previous.yaml);
      if (previous.env !== null) fs.writeFileSync(envFile, previous.env, { mode: 0o600 });
    } else {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    send({ type: "done", ok: false, message: `Invalid compose file: ${check.error}` });
    return;
  }
  await runDockerJob([...base, "up", "-d", "--remove-orphans"], send, {
    cwd: dir,
    successMessage: () => `${spec.name} is up`,
  });
}

export async function composeAction(
  name: string,
  action: ComposeAction,
  send: (event: DockerJobEvent) => void,
): Promise<void> {
  const target = await composeTarget(name);
  if ((action === "up" || action === "pull") && target.files.length === 0) {
    send({ type: "done", ok: false, message: "The compose file of this project is not on this server" });
    return;
  }
  const extra = action === "up" ? ["-d"] : [];
  const cwd = target.files[0] ? path.dirname(target.files[0]) : undefined;
  await runDockerJob([...target.args, action, ...extra], send, {
    cwd,
    successMessage: () => `${name}: ${action} done`,
  });
}

/** `down` (optionally removing volumes) and, for AgentMan projects, delete their folder. */
export async function removeComposeProject(
  name: string,
  removeVolumes: boolean,
  send: (event: DockerJobEvent) => void,
): Promise<void> {
  const target = await composeTarget(name);
  const cwd = target.files[0] ? path.dirname(target.files[0]) : undefined;
  let ok = true;
  await runDockerJob([...target.args, "down", "--remove-orphans", ...(removeVolumes ? ["-v"] : [])], (event) => {
    if (event.type === "done") ok = event.ok;
    if (event.type === "log" || !event.ok) send(event);
  }, { cwd });
  if (!ok) return;
  if (target.managed) fs.rmSync(path.join(composeRoot(), name), { recursive: true, force: true });
  send({ type: "done", ok: true, message: target.managed ? `${name} removed` : `${name} is down` });
}

export async function composeLogs(name: string, tail: number): Promise<string> {
  const target = await composeTarget(name);
  const cwd = target.files[0] ? path.dirname(target.files[0]) : undefined;
  const result = await docker([...target.args, "logs", "--no-color", "--timestamps", "--tail", String(tail)], {
    cwd,
  });
  if (!result.ok) throw new HttpError(502, result.error ?? "docker compose logs failed");
  return [result.stdout, result.stderr].filter((s) => s.trim()).join("\n").trimEnd();
}

// ---------------------------------------------------------------------------------------------
// Pull / run

export function pullImage(image: string, send: (event: DockerJobEvent) => void): Promise<void> {
  return runDockerJob(["pull", image], send, { successMessage: () => `Pulled ${image}` });
}

export function runContainer(
  args: string[],
  send: (event: DockerJobEvent) => void,
  successMessage = "Container started",
): Promise<void> {
  return runDockerJob(args, send, {
    successMessage: () => successMessage,
    id: (stdout) => stdout.split("\n").at(-1)?.trim().slice(0, 12) ?? "",
  });
}

// ---------------------------------------------------------------------------------------------
// Running summary (header badge) and fast start

/** Running containers and compose projects only: two cheap docker calls, no version probe. */
export async function getRunningSummary(): Promise<RunningSummary> {
  const [ps, ls] = await Promise.all([
    docker(["ps", "--no-trunc", "--format", CONTAINER_FORMAT], { timeout: 10_000 }),
    docker(["compose", "ls", "--format", "json"], { timeout: 10_000 }),
  ]);
  if (!ps.ok) return { available: false, error: ps.error, containers: [], composeProjects: [] };
  const containers = jsonLines<RawContainer>(ps.stdout).map(toContainer);
  const projects = ls.ok ? composeLsJson(ls.stdout) : [];
  return {
    available: true,
    error: null,
    containers,
    composeProjects: buildComposeProjects(projects, containers).filter((p) => p.running > 0),
  };
}

const MAX_QUICK_PORTS = 8;
const PORT_SEARCH_LIMIT = 200;

/** "redis", then "redis-2", … — container and project names alike. */
function withFreeSuffix(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Nothing on this machine listens on `port`. EACCES (privileged port, unprivileged server) counts
 * as free: docker binds the port, not us.
 */
function portFree(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const server = net.createServer();
  server.unref();
  server.once("error", (err: NodeJS.ErrnoException) => resolve(err.code !== "EADDRINUSE"));
  server.once("listening", () => server.close(() => resolve(true)));
  server.listen({ port, host: "0.0.0.0", exclusive: true });
  return promise;
}

/** Host ports published by running containers (docker-proxy may be off, so probing alone misses them). */
async function publishedHostPorts(): Promise<Set<number>> {
  const result = await docker(["ps", "--format", "{{.Ports}}"]);
  const used = new Set<number>();
  if (!result.ok) return used;
  for (const line of result.stdout.split("\n")) {
    for (const port of parsePorts(line)) if (port.hostPort) used.add(port.hostPort);
  }
  return used;
}

/** First port from `preferred` up that is neither published nor listened on; claims it in `used`. */
async function pickHostPort(preferred: number, used: Set<number>): Promise<number> {
  for (let port = preferred; port <= 65535 && port < preferred + PORT_SEARCH_LIMIT; port++) {
    if (used.has(port) || !(await portFree(port))) continue;
    used.add(port);
    return port;
  }
  throw new HttpError(409, `No free host port between ${preferred} and ${preferred + PORT_SEARCH_LIMIT}`);
}

/** Ports the image EXPOSEs, or null when the image is not on this host yet. */
async function exposedPorts(image: string): Promise<{ container: number; protocol: "tcp" | "udp" }[] | null> {
  const result = await docker(["image", "inspect", "--format", "{{json .Config.ExposedPorts}}", image]);
  if (!result.ok) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result.stdout.trim() || "null");
  } catch {
    // Treated as "exposes nothing".
  }
  return Object.keys((parsed as Record<string, unknown> | null) ?? {})
    .flatMap((key) => {
      const match = /^(\d+)\/(tcp|udp)$/.exec(key);
      return match ? [{ container: Number(match[1]), protocol: match[2] as "tcp" | "udp" }] : [];
    })
    .sort((a, b) => a.container - b.container)
    .slice(0, MAX_QUICK_PORTS);
}

/** Below 1024 the same port often needs root or clashes with a system service: 80 → 8080. */
function defaultHostPort(container: number): number {
  return container < 1024 ? 8000 + container : container;
}

export interface QuickRunPlan {
  input: Record<string, unknown>;
  image: string;
  name: string | null;
  /** null = publish what the image EXPOSEs. */
  ports: { container: number; host: number; protocol: "tcp" | "udp" }[] | null;
}

/** Validate a POST /docker/quick-run body (`QuickRunSpec`) before anything starts. */
export function parseQuickRun(input: Record<string, unknown>): QuickRunPlan {
  const image = parseImageRef(input.image);
  // Name, env, volumes, restart, network and command follow the plain run rules.
  buildRunArgs({ ...input, ports: [] });
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : null;
  if (input.ports !== undefined && !Array.isArray(input.ports)) throw new HttpError(400, "ports must be a list");
  let ports: QuickRunPlan["ports"] = input.autoPorts === true ? null : [];
  if (Array.isArray(input.ports)) {
    ports = input.ports.slice(0, MAX_QUICK_PORTS).map((value) => {
      const p = (value ?? {}) as Record<string, unknown>;
      const container = Number(p.container);
      if (!Number.isInteger(container) || container < 1 || container > 65535) {
        throw new HttpError(400, `Invalid container port: ${String(p.container)}`);
      }
      const host = p.host === undefined || p.host === null || p.host === "" ? null : Number(p.host);
      if (host !== null && (!Number.isInteger(host) || host < 1 || host > 65535)) {
        throw new HttpError(400, `Invalid host port: ${String(p.host)}`);
      }
      return {
        container,
        host: host ?? defaultHostPort(container),
        protocol: p.protocol === "udp" ? ("udp" as const) : ("tcp" as const),
      };
    });
  }
  return { input, image, name, ports };
}

/**
 * `docker run -d` with smart defaults: pull first (streamed) so EXPOSEd ports are known, map each
 * to a free host port, pick an unused name. The `done` event carries the container id.
 */
export async function quickRun(plan: QuickRunPlan, send: (event: DockerJobEvent) => void): Promise<void> {
  const { image } = plan;
  let exposed = await exposedPorts(image);
  if (exposed === null) {
    send({ type: "log", line: `$ docker pull ${image}` });
    let pulled = false;
    await runDockerJob(["pull", image], (event) => {
      if (event.type === "log") send(event);
      else if (event.ok) pulled = true;
      else send(event);
    });
    if (!pulled) return;
    exposed = (await exposedPorts(image)) ?? [];
  }
  const wanted =
    plan.ports ??
    exposed.map((p) => ({ ...p, host: defaultHostPort(p.container) }));
  if (plan.ports === null && wanted.length === 0) {
    send({ type: "log", line: "The image exposes no ports; nothing is published." });
  }

  const [used, names] = await Promise.all([
    publishedHostPorts(),
    docker(["ps", "-a", "--format", "{{.Names}}"]).then(
      (result) => new Set(result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)),
    ),
  ]);
  const ports: PortMapping[] = [];
  for (const p of wanted) {
    const host = await pickHostPort(p.host, used);
    send({
      type: "log",
      line:
        host === p.host
          ? `Publishing port ${host} → ${p.container}/${p.protocol}`
          : `Port ${p.host} is taken; publishing ${host} → ${p.container}/${p.protocol}`,
    });
    ports.push({ host: String(host), container: p.container, protocol: p.protocol });
  }

  const base =
    (image.split("@")[0].split("/").pop() ?? "")
      .split(":")[0]
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "") || "app";
  const name = withFreeSuffix(plan.name ?? base, names);
  const { args } = buildRunArgs({ ...plan.input, image, name, ports });
  // Not the full argument list: env values may be secrets.
  send({
    type: "log",
    line: `$ docker run -d --name ${name}${ports.map((p) => ` -p ${p.host}:${p.container}/${p.protocol}`).join("")} ${image}`,
  });
  await runContainer(
    args,
    send,
    ports.length ? `${name} is running on port ${ports.map((p) => p.host).join(", ")}` : `${name} is running`,
  );
}

const SHORT_PORT_RE =
  /^(\s*-\s*)(["']?)((?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):)?(\d{1,5}):(\d{1,5})((?:\/(?:tcp|udp))?)\2(\s*(?:#.*)?)$/;
const LONG_PORT_RE = /^(\s*published:\s*)(["']?)(\d{1,5})\2(\s*(?:#.*)?)$/;

/**
 * Move host ports of a compose file that are already in use to the next free ones. Only plain
 * `ports:` entries ("5432:5432", "127.0.0.1:80:80/tcp", `published: 8080`) are touched; ranges
 * and variables are left as written.
 */
export async function remapComposePorts(
  yaml: string,
  used: Set<number>,
): Promise<{ yaml: string; changes: string[] }> {
  const lines = yaml.split("\n");
  const changes: string[] = [];
  let portsIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.search(/\S/);
    if (indent === -1 || line.trimStart().startsWith("#")) continue;
    const header = /^(\s*)ports:\s*(?:#.*)?$/.exec(line);
    if (header) {
      portsIndent = header[1].length;
      continue;
    }
    if (portsIndent < 0) continue;
    // A list may sit at the key's own indent ("ports:\n- 80:80"); anything else at or above it ends the block.
    if (indent < portsIndent || (indent === portsIndent && !line.trimStart().startsWith("-"))) {
      portsIndent = -1;
      continue;
    }
    const short = SHORT_PORT_RE.exec(line);
    const long = short ? null : LONG_PORT_RE.exec(line);
    const hostText = short?.[4] ?? long?.[3];
    if (!hostText) continue;
    const host = Number(hostText);
    const next = await pickHostPort(host, used);
    if (next === host) continue;
    lines[i] = short
      ? `${short[1]}${short[2]}${short[3] ?? ""}${next}:${short[5]}${short[6]}${short[2]}${short[7]}`
      : `${long?.[1]}${long?.[2]}${next}${long?.[2]}${long?.[4]}`;
    changes.push(`Port ${host} is taken; using ${next} instead`);
  }
  return { yaml: lines.join("\n"), changes };
}

export interface QuickComposePlan {
  name: string | null;
  template: string | null;
  yaml: string | null;
  url: string | null;
  env: EnvVar[];
}

/** Validate a POST /docker/quick-compose body (`QuickComposeSpec`). */
export function parseQuickCompose(input: Record<string, unknown>): QuickComposePlan {
  const text = (key: string) => {
    const value = input[key];
    return typeof value === "string" && value.trim() ? value : null;
  };
  const template = text("template")?.trim() ?? null;
  const yaml = text("yaml");
  const url = text("url")?.trim() ?? null;
  if ([template, yaml, url].filter(Boolean).length !== 1) {
    throw new HttpError(400, "Send exactly one of template, yaml or url");
  }
  if (yaml && yaml.length > 512 * 1024) throw new HttpError(400, "Compose file is too large");
  if (url && url.length > 2048) throw new HttpError(400, "URL is too long");
  const name = input.name === undefined || input.name === null || input.name === "" ? null : parseProjectName(input.name);
  return { name, template, yaml, url, env: parseEnv(input.env) };
}

/**
 * One-click compose: resolve the file (template, pasted YAML or URL), pick a free project name,
 * move busy host ports, then deploy like POST /docker/compose. `done.id` is the project name.
 */
export async function quickCompose(plan: QuickComposePlan, send: (event: DockerJobEvent) => void): Promise<void> {
  let yaml = plan.yaml ?? "";
  if (plan.template) {
    send({ type: "log", line: "Loading the template…" });
    yaml = await getTemplateCompose(plan.template);
  } else if (plan.url) {
    send({ type: "log", line: `Downloading ${plan.url}…` });
    const fetched = await fetchComposeUrl(plan.url);
    yaml = fetched.yaml;
    send({ type: "log", line: `Got ${fetched.url}` });
  }
  if (!yaml.trim()) throw new HttpError(400, "The compose file is empty");

  const known = await listComposeProjects().catch(() => [] as RawComposeProject[]);
  const taken = new Set([...managedProjects(), ...known.map((p) => p.Name)]);
  const base =
    (plan.name ?? plan.template ?? "stack")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[^a-z0-9]+|-+$/g, "")
      .slice(0, 40) || "stack";
  const name = withFreeSuffix(base, taken);

  const remapped = await remapComposePorts(yaml, await publishedHostPorts());
  for (const line of remapped.changes) send({ type: "log", line });
  await deployCompose({ name, yaml: remapped.yaml, env: plan.env }, (event) =>
    send(event.type === "done" ? { ...event, id: name } : event),
  );
}
