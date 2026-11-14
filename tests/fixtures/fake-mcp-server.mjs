#!/usr/bin/env node
// Test double for a stdio MCP server: newline-delimited JSON-RPC on stdin/stdout, no dependencies.
// Answers `initialize` (serverInfo fake-mcp 1.0.0) and, once `notifications/initialized` arrived,
// `tools/list` with two tools split across two pages (`nextCursor`). Prints a non-JSON banner line
// on stdout first, as some servers log there.
//
// Environment:
//   FAKE_MCP_TOKEN     Required: without it the server prints `missing FAKE_MCP_TOKEN (args: …)` to
//                      stderr (echoing its arguments) and exits with code 3.
//   FAKE_MCP_HANG      "1": never answer and never exit on its own.
//   FAKE_MCP_PID_FILE  File the server writes its pid to at startup.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const TOOLS = [
  { name: "echo", description: "  Echo the\n input back  ", inputSchema: { type: "object" } },
  { name: "add", description: "Add two numbers", inputSchema: { type: "object" } },
];

if (process.env.FAKE_MCP_PID_FILE) writeFileSync(process.env.FAKE_MCP_PID_FILE, String(process.pid));

if (!process.env.FAKE_MCP_TOKEN) {
  process.stderr.write(`missing FAKE_MCP_TOKEN (args: ${process.argv.slice(2).join(" ")})\n`);
  process.exitCode = 3;
} else if (process.env.FAKE_MCP_HANG === "1") {
  setInterval(() => {}, 60_000);
} else {
  serve();
}

function serve() {
  let initialized = false;
  process.stdout.write("fake-mcp ready\n");
  createInterface({ input: process.stdin }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === "notifications/initialized") initialized = true;
    if (message.id === undefined) return;
    if (message.method === "initialize") {
      reply(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "1.0.0" },
      });
    } else if (message.method === "tools/list" && !initialized) {
      fail(message.id, -32002, "not initialized");
    } else if (message.method === "tools/list" && message.params?.cursor === undefined) {
      reply(message.id, { tools: [TOOLS[0]], nextCursor: "page-2" });
    } else if (message.method === "tools/list" && message.params.cursor === "page-2") {
      reply(message.id, { tools: [TOOLS[1]] });
    } else if (message.method === "tools/list") {
      fail(message.id, -32602, "unknown cursor");
    } else {
      fail(message.id, -32601, `method not found: ${message.method}`);
    }
  });
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
