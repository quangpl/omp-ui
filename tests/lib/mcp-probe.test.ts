import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import type { McpServerConfig } from "@/lib/mcp-types";
import { probeMcpServer } from "@/lib/server/mcp-probe";

const FAKE_MCP = fileURLToPath(new URL("../fixtures/fake-mcp-server.mjs", import.meta.url));
const TOKEN = "mcp-secret-token-0123456789";
const SERVER_URL = "https://mcp.example.com/mcp";

const httpConfig: McpServerConfig = { type: "http", url: SERVER_URL, headers: { Authorization: `Bearer ${TOKEN}` } };

function stdioConfig(env: Record<string, string>, args: string[] = []): McpServerConfig {
  return { type: "stdio", command: process.execPath, args: [FAKE_MCP, ...args], env };
}

function rpc(id: number, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

const initializeResult = {
  protocolVersion: "2025-03-26",
  capabilities: { tools: {} },
  serverInfo: { name: "demo-server", version: "1.2.0" },
};

function respond(body: unknown, init: ResponseInit = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function sse(...messages: unknown[]): string {
  return messages.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join("");
}

function mockFetch(...responses: Response[]): Mock<typeof fetch> {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const response of responses) fetchImpl.mockResolvedValueOnce(response);
  return fetchImpl;
}

function sent(fetchImpl: Mock<typeof fetch>, call: number) {
  const [input, init] = fetchImpl.mock.calls[call];
  const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
  return { url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body };
}

describe("probeMcpServer: stdio", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-probe-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("initializes, lists tools from every page and passes config.env to the server", async () => {
    const result = await probeMcpServer(stdioConfig({ FAKE_MCP_TOKEN: TOKEN }));

    expect(result).toMatchObject({
      ok: true,
      message: "Connected to fake-mcp 1.0.0 · 2 tools",
      serverName: "fake-mcp",
      serverVersion: "1.0.0",
      tools: [
        { name: "echo", description: "Echo the input back" },
        { name: "add", description: "Add two numbers" },
      ],
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(result.checkedAt))).toBe(false);
  });

  it("reports an early exit with the stderr tail, secrets scrubbed", async () => {
    const result = await probeMcpServer(stdioConfig({}, [`--api-key=${TOKEN}`]), { secrets: [TOKEN] });

    expect(result).toMatchObject({ ok: false, serverName: null, serverVersion: null, tools: [] });
    expect(result.message).toBe("Server exited (code 3) before answering: missing FAKE_MCP_TOKEN (args: --api-key=••••)");
  });

  it("times out a server that never answers and kills it", async () => {
    const pidFile = path.join(tmp, "pid");
    const config = stdioConfig({ FAKE_MCP_TOKEN: TOKEN, FAKE_MCP_HANG: "1", FAKE_MCP_PID_FILE: pidFile });
    const result = await probeMcpServer(config, { timeoutMs: 1_000 });

    expect(result).toMatchObject({ ok: false, message: "Timed out after 1 s", tools: [] });
    const pid = Number(readFileSync(pidFile, "utf8"));
    let signalError: unknown;
    try {
      process.kill(pid, 0);
    } catch (err) {
      signalError = err;
    }
    expect(signalError).toMatchObject({ code: "ESRCH" });
  });

  it("explains a missing command", async () => {
    const result = await probeMcpServer({ type: "stdio", command: "agentman-no-such-command", args: [] });
    expect(result).toMatchObject({
      ok: false,
      message:
        "agentman-no-such-command not found on the AgentMan server — install it (e.g. Node.js for npx, uv for uvx)",
    });
  });
});

describe("probeMcpServer: http", () => {
  it("runs the handshake over JSON answers, forwarding the session id and negotiated version", async () => {
    const fetchImpl = mockFetch(
      respond(rpc(1, initializeResult), {
        headers: { "content-type": "application/json", "mcp-session-id": "session-42" },
      }),
      new Response(null, { status: 202 }),
      respond(rpc(2, { tools: [{ name: "search", description: "Search things" }, { name: "fetch" }] })),
      new Response(null, { status: 200 }),
    );
    const result = await probeMcpServer(httpConfig, { fetchImpl, secrets: [TOKEN] });

    expect(result).toMatchObject({
      ok: true,
      message: "Connected to demo-server 1.2.0 · 2 tools",
      serverName: "demo-server",
      serverVersion: "1.2.0",
      tools: [{ name: "search", description: "Search things" }, { name: "fetch" }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    const initialize = sent(fetchImpl, 0);
    expect(initialize).toMatchObject({ url: SERVER_URL, method: "POST" });
    expect(initialize.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agentman", version: "1" } },
    });
    expect(initialize.headers.get("content-type")).toBe("application/json");
    expect(initialize.headers.get("accept")).toBe("application/json, text/event-stream");
    expect(initialize.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(initialize.headers.has("mcp-session-id")).toBe(false);
    expect(initialize.headers.has("mcp-protocol-version")).toBe(false);

    const initialized = sent(fetchImpl, 1);
    expect(initialized.body).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
    const toolsList = sent(fetchImpl, 2);
    expect(toolsList.body).toMatchObject({ id: 2, method: "tools/list", params: {} });
    for (const request of [initialized, toolsList]) {
      expect(request.headers.get("mcp-session-id")).toBe("session-42");
      expect(request.headers.get("mcp-protocol-version")).toBe("2025-03-26");
      expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    }

    const teardown = sent(fetchImpl, 3);
    expect(teardown.method).toBe("DELETE");
    expect(teardown.headers.get("mcp-session-id")).toBe("session-42");
  });

  it("reads responses from SSE streams and stops reading once the answer arrived", async () => {
    // Streams are never closed: the probe must stop reading once it has the answer.
    const openStream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
        },
      });
    const fetchImpl = mockFetch(
      new Response(openStream(sse(rpc(1, initializeResult))), { headers: { "content-type": "text/event-stream" } }),
      new Response(null, { status: 202 }),
      new Response(
        openStream(
          sse(
            { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hi" } },
            rpc(2, { tools: [{ name: "a" }], nextCursor: "next" }),
          ),
        ),
        { headers: { "content-type": "text/event-stream" } },
      ),
      new Response(openStream(sse(rpc(3, { tools: [{ name: "b" }] }))), {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const result = await probeMcpServer(httpConfig, { fetchImpl });

    expect(result).toMatchObject({ ok: true, message: "Connected to demo-server 1.2.0 · 2 tools" });
    expect(result.tools).toEqual([{ name: "a" }, { name: "b" }]);
    expect(sent(fetchImpl, 3).body).toMatchObject({ id: 3, method: "tools/list", params: { cursor: "next" } });
    // No session id was issued: no DELETE.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("reports 401 as a token problem", async () => {
    const fetchImpl = mockFetch(respond({ error: "invalid_token" }, { status: 401, statusText: "Unauthorized" }));
    const result = await probeMcpServer(httpConfig, { fetchImpl, secrets: [TOKEN] });
    expect(result).toMatchObject({ ok: false, message: "401 Unauthorized: check the token", tools: [] });
  });

  it("scrubs secrets from an error that echoes the token", async () => {
    const fetchImpl = mockFetch(
      respond(`token ${TOKEN} is not valid for this tenant`, { status: 500, statusText: "Internal Server Error" }),
    );
    const result = await probeMcpServer(httpConfig, { fetchImpl, secrets: [TOKEN] });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("500 Internal Server Error: token •••• is not valid for this tenant");
  });

  it("reports a JSON-RPC error", async () => {
    const fetchImpl = mockFetch(respond({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "bad version" } }));
    const result = await probeMcpServer(httpConfig, { fetchImpl });
    expect(result).toMatchObject({ ok: false, message: "MCP error: bad version" });
  });

  it("reports network errors with the host", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND mcp.example.com") }));
    const result = await probeMcpServer(httpConfig, { fetchImpl });
    expect(result).toMatchObject({ ok: false, message: "Cannot reach mcp.example.com: getaddrinfo ENOTFOUND mcp.example.com" });
  });

  it("times out a server that never answers", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const result = await probeMcpServer(httpConfig, { fetchImpl, timeoutMs: 20 });
    expect(result).toMatchObject({ ok: false, message: "Timed out after 20 ms" });
  });
});
