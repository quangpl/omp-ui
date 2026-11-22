// MCP-level check for /mcp: starts (stdio) or calls (http) a configured MCP server, runs the
// `initialize` handshake and lists its tools, then cleans up. Proves the server actually works with
// the saved credential, not just that the credential authenticates. Server only: spawns processes.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { STATUS_CODES } from "node:http";
import os from "node:os";

import { childEnv } from "@/lib/child-env";
import type { McpProbeResult, McpServerConfig, McpTool } from "@/lib/mcp-types";

export interface McpProbeOptions {
  /** Budget for the whole handshake. Defaults: 90 s for stdio (npx/uvx may download first), 20 s for http. */
  timeoutMs?: number;
  /** Secret values to scrub from the message (the config holds them in clear). */
  secrets?: string[];
  /** Injected by tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const STDIO_TIMEOUT_MS = 90_000;
const HTTP_TIMEOUT_MS = 20_000;
/** Grace period between SIGTERM and SIGKILL, and for the final http DELETE. */
const CLEANUP_MS = 2_000;
const MAX_MESSAGE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_STDERR_CHARS = 4_096;
const MAX_TOOL_PAGES = 10;
const PROTOCOL_VERSION = "2025-06-18";
const INITIALIZE_PARAMS = {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "omp-ui", version: "1" },
};

/** One way of exchanging JSON-RPC messages with a server. */
interface Transport {
  /** Send a request and resolve with its `result`; rejects on a JSON-RPC `error` or transport failure. */
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string): Promise<void>;
  /** Release everything; never throws. */
  close(): Promise<void>;
}

interface Handshake {
  serverName: string | null;
  serverVersion: string | null;
  tools: McpTool[];
}

/** Thrown inside a probe to fail with exactly this message. */
class ProbeFailure extends Error {}

/**
 * Run `initialize` + `tools/list` against `config` (real secret values, not placeholders). Never
 * throws: every failure comes back as `{ ok: false, message }` with `options.secrets` scrubbed.
 */
export async function probeMcpServer(config: McpServerConfig, options: McpProbeOptions = {}): Promise<McpProbeResult> {
  const timeoutMs = options.timeoutMs ?? (config.type === "stdio" ? STDIO_TIMEOUT_MS : HTTP_TIMEOUT_MS);
  const started = performance.now();
  let latencyMs = 0;
  let outcome: Handshake | string;
  let transport: Transport | undefined;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    transport =
      config.type === "stdio"
        ? new StdioTransport(config, signal)
        : new HttpTransport(config, options.fetchImpl ?? fetch, signal);
    outcome = await handshake(transport);
  } catch (err) {
    outcome = describeError(err, signal, timeoutMs);
  } finally {
    latencyMs = Math.round(performance.now() - started);
    await transport?.close();
  }
  const checkedAt = new Date().toISOString();
  const secrets = options.secrets ?? [];
  if (typeof outcome === "string") {
    return { ok: false, message: clean(outcome, secrets), serverName: null, serverVersion: null, tools: [], latencyMs, checkedAt };
  }
  return { ok: true, message: clean(connectedMessage(outcome), secrets), ...outcome, latencyMs, checkedAt };
}

async function handshake(transport: Transport): Promise<Handshake> {
  const init = record(await transport.request("initialize", INITIALIZE_PARAMS));
  if (!init) throw new ProbeFailure("Invalid initialize result");
  const serverInfo = record(init.serverInfo);
  await transport.notify("notifications/initialized");
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const result = record(await transport.request("tools/list", cursor ? { cursor } : {}));
    if (!result) throw new ProbeFailure("Invalid tools/list result");
    if (Array.isArray(result.tools)) for (const tool of result.tools) addTool(tools, tool);
    cursor = str(result.nextCursor);
    if (!cursor) break;
  }
  return { serverName: str(serverInfo?.name) ?? null, serverVersion: str(serverInfo?.version) ?? null, tools };
}

function addTool(tools: McpTool[], input: unknown): void {
  const tool = record(input);
  const name = str(tool?.name);
  if (!name) return;
  const description = str(tool?.description);
  tools.push(description ? { name, description: truncate(collapse(description), MAX_DESCRIPTION_LENGTH) } : { name });
}

function connectedMessage({ serverName, serverVersion, tools }: Handshake): string {
  const server = [serverName, serverVersion].filter(Boolean).join(" ");
  const count = `${tools.length} tool${tools.length === 1 ? "" : "s"}`;
  return `${server ? `Connected to ${server}` : "Connected"} · ${count}`;
}

/** `result` of a JSON-RPC response, or a failure carrying its `error`. */
function unwrap(message: Record<string, unknown>): unknown {
  const error = record(message.error);
  if (error) throw new ProbeFailure(`MCP error: ${str(error.message) ?? "unknown error"}`);
  if (!("result" in message)) throw new ProbeFailure("Invalid JSON-RPC response");
  return message.result;
}

function rpcMessage(id: number | undefined, method: string, params?: Record<string, unknown>): string {
  return JSON.stringify(id === undefined ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params });
}

// ---- stdio ----

interface Pending {
  resolve: (message: Record<string, unknown>) => void;
  reject: (err: unknown) => void;
}

/** Newline-delimited JSON-RPC over the stdin/stdout of a child process in its own process group. */
class StdioTransport implements Transport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly onAbort: () => void;
  private failure: unknown = null;
  private nextId = 1;
  private stdout = "";
  private stderr = "";

  constructor(
    private readonly config: Extract<McpServerConfig, { type: "stdio" }>,
    private readonly signal: AbortSignal,
  ) {
    this.child = spawn(config.command, config.args, {
      env: childEnv(config.env ?? {}),
      cwd: os.tmpdir(),
      stdio: "pipe",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8").on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR_CHARS);
    });
    // A server that exits early closes stdin under our writes (EPIPE); the exit reports it.
    this.child.stdin.on("error", () => {});
    this.child.on("error", (err) => this.fail(new ProbeFailure(this.spawnError(err))));
    this.child.on("close", (code, signalName) => this.fail(new ProbeFailure(this.exitMessage(code, signalName))));
    this.onAbort = () => this.fail(signal.reason);
    if (signal.aborted) this.onAbort();
    else signal.addEventListener("abort", this.onAbort, { once: true });
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.failure !== null) throw this.failure;
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
    this.pending.set(id, { resolve, reject });
    this.child.stdin.write(`${rpcMessage(id, method, params)}\n`);
    return unwrap(await promise);
  }

  async notify(method: string): Promise<void> {
    if (this.failure !== null) throw this.failure;
    this.child.stdin.write(`${rpcMessage(undefined, method)}\n`);
  }

  /** End stdin, SIGTERM the process group, SIGKILL it if the server outlives the grace period. */
  async close(): Promise<void> {
    this.signal.removeEventListener("abort", this.onAbort);
    this.fail(new ProbeFailure("Probe closed"));
    this.child.stdin.end();
    if (this.child.pid === undefined) return; // Never started (ENOENT, EACCES, …).
    // Even after the server exited, its children (npx → node) may still run in the group.
    signalGroup(this.child, "SIGTERM");
    if (!(await waitForExit(this.child, CLEANUP_MS))) {
      signalGroup(this.child, "SIGKILL");
      await waitForExit(this.child, CLEANUP_MS);
    }
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }

  private onStdout(chunk: string): void {
    this.stdout += chunk;
    let newline = this.stdout.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (line) this.onLine(line);
      newline = this.stdout.indexOf("\n");
    }
  }

  /** Servers may log to stdout; anything that is not a response to a pending request is ignored. */
  private onLine(line: string): void {
    let message: Record<string, unknown> | undefined;
    try {
      message = record(JSON.parse(line));
    } catch {
      return;
    }
    if (!message || typeof message.id !== "number" || "method" in message) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.resolve(message);
  }

  /** Reject everything pending and every later call; the first failure wins. */
  private fail(err: unknown): void {
    if (this.failure !== null) return;
    this.failure = err;
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }

  private spawnError(err: NodeJS.ErrnoException): string {
    if (err.code === "ENOENT") {
      return `${this.config.command} not found on the OMP-UI server — install it (e.g. Node.js for npx, uv for uvx)`;
    }
    return `Cannot start ${this.config.command}: ${err.message}`;
  }

  private exitMessage(code: number | null, signalName: NodeJS.Signals | null): string {
    const how = code !== null ? `code ${code}` : `signal ${signalName ?? "unknown"}`;
    const stderr = this.stderr.trim();
    const tail = stderr.length > MAX_MESSAGE_LENGTH ? `…${stderr.slice(-MAX_MESSAGE_LENGTH)}` : stderr;
    return `Server exited (${how}) before answering${tail ? `: ${tail}` : ""}`;
  }
}

/** Signal the whole process group on POSIX (the server was spawned detached, as its leader). */
function signalGroup(child: ChildProcessWithoutNullStreams, signalName: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signalName);
    else child.kill(signalName);
  } catch {
    // The group is already gone.
  }
}

/** Resolves true once the child exited (Node has reaped it), false after `ms`. */
function waitForExit(child: ChildProcessWithoutNullStreams, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const onExit = () => {
    clearTimeout(timer);
    resolve(true);
  };
  const timer = setTimeout(() => {
    child.off("exit", onExit);
    resolve(false);
  }, ms);
  child.once("exit", onExit);
  return promise;
}

// ---- http (Streamable HTTP) ----

/** Each message is a POST; the answer is a JSON body or an SSE stream carrying the response. */
class HttpTransport implements Transport {
  private readonly url: URL;
  private nextId = 1;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;

  constructor(
    private readonly config: Extract<McpServerConfig, { type: "http" }>,
    private readonly fetchImpl: typeof fetch,
    private readonly signal: AbortSignal,
  ) {
    try {
      this.url = new URL(config.url);
    } catch {
      throw new ProbeFailure("Invalid server URL");
    }
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.send("POST", rpcMessage(id, method, params), this.signal);
    if (method === "initialize") this.sessionId = response.headers.get("mcp-session-id");
    const result = unwrap(await readResponse(response, id));
    if (method === "initialize") this.protocolVersion = str(record(result)?.protocolVersion) ?? PROTOCOL_VERSION;
    return result;
  }

  /** The server answers a notification with 202 and no body (or an empty 200). */
  async notify(method: string): Promise<void> {
    const response = await this.send("POST", rpcMessage(undefined, method), this.signal);
    await response.body?.cancel().catch(() => {});
  }

  /** Best-effort session teardown; failures are irrelevant to the probe. */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      const response = await this.fetchImpl(this.url, {
        method: "DELETE",
        headers: this.headers(),
        signal: AbortSignal.timeout(CLEANUP_MS),
      });
      await response.body?.cancel().catch(() => {});
    } catch {
      // Ignored: the session expires on its own.
    }
  }

  private headers(): Headers {
    const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
    for (const [name, value] of Object.entries(this.config.headers ?? {})) headers.set(name, value);
    if (this.sessionId) headers.set("mcp-session-id", this.sessionId);
    if (this.protocolVersion) headers.set("mcp-protocol-version", this.protocolVersion);
    return headers;
  }

  private async send(method: string, body: string, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, { method, headers: this.headers(), body, signal });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new ProbeFailure(`Cannot reach ${this.url.host}: ${networkCause(err)}`);
    }
    if (response.ok) return response;
    const status = `${response.status} ${response.statusText || STATUS_CODES[response.status] || ""}`.trim();
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new ProbeFailure(`${status}: check the token`);
    }
    const text = collapse(await response.text().catch(() => ""));
    throw new ProbeFailure(text ? `${status}: ${truncate(text, 120)}` : status);
  }
}

/** The JSON-RPC response with `id` from a JSON body (single or batch) or an SSE stream. */
async function readResponse(response: Response, id: number): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) return readEventStream(response, id);
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ProbeFailure(text.trim() ? `Unexpected response: ${truncate(collapse(text), 120)}` : "Empty response");
  }
  const found = findResponse(body, id);
  if (!found) throw new ProbeFailure("No JSON-RPC response in the answer");
  return found;
}

/** Read SSE events until one carries the response to `id`, then stop reading. */
async function readEventStream(response: Response, id: number): Promise<Record<string, unknown>> {
  if (!response.body) throw new ProbeFailure("Empty response");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let data: string[] = [];
  /** Dispatch the event collected so far; returns the response when it is the one we wait for. */
  const dispatch = () => {
    const payload = data.join("\n");
    data = [];
    if (!payload) return undefined;
    try {
      return findResponse(JSON.parse(payload), id);
    } catch {
      return undefined;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? "\n\n" : value;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          const found = dispatch();
          if (found) return found;
        } else if (line.startsWith("data:")) {
          data.push(line.slice(line[5] === " " ? 6 : 5));
        }
        newline = buffer.indexOf("\n");
      }
      if (done) throw new ProbeFailure("Server closed the stream without answering");
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function findResponse(body: unknown, id: number): Record<string, unknown> | undefined {
  const messages = Array.isArray(body) ? body : [body];
  for (const item of messages) {
    const message = record(item);
    if (message && message.id === id && !("method" in message)) return message;
  }
  return undefined;
}

/** undici reports every connection problem as "fetch failed"; the cause says what happened. */
function networkCause(err: unknown): string {
  const e = (typeof err === "object" && err !== null ? err : {}) as { message?: unknown; cause?: unknown };
  const cause = (typeof e.cause === "object" && e.cause !== null ? e.cause : {}) as { message?: unknown; code?: unknown };
  return str(cause.message) ?? str(cause.code) ?? str(e.message) ?? String(err);
}

// ---- shared helpers ----

function describeError(err: unknown, signal: AbortSignal, timeoutMs: number): string {
  if (err instanceof ProbeFailure) return err.message;
  const e = (typeof err === "object" && err !== null ? err : {}) as { name?: unknown; message?: unknown };
  if (signal.aborted || e.name === "TimeoutError" || e.name === "AbortError") {
    return `Timed out after ${formatDuration(timeoutMs)}`;
  }
  return str(e.message) ?? (String(err) || "Check failed");
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${Number((ms / 1000).toFixed(1))} s` : `${ms} ms`;
}

function record(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
}

function str(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input.trim() : undefined;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Scrub secrets (longest first, so a value containing another is scrubbed whole), collapse, cap. */
function clean(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length >= 4) out = out.split(secret).join("••••");
  }
  return truncate(collapse(out), MAX_MESSAGE_LENGTH) || "Check failed";
}
