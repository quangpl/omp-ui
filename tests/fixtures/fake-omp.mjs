#!/usr/bin/env node
// Test double for `omp --mode rpc`: speaks the newline-delimited JSON RPC protocol on stdio.
//
// Environment:
//   FAKE_OMP_LOG          JSON-lines file; every process appends {pid, kind, ...} entries:
//                         "argv" (argv + cwd at startup), "command" (each stdin command),
//                         "ui_response" (each extension_ui_response), "steer" (steered messages).
//   FAKE_OMP_SCENARIO     Default prompt behaviour: success | error | crash | slow | confirm.
//                         A prompt containing "[fake:<scenario>]" overrides it for that prompt.
//   FAKE_OMP_SESSION_DIR  Parent dir for the per-process session temp dir (default: os tmpdir).
//   FAKE_OMP_STARTUP      normal (default) | silent (never sends ready) | exit (exits 2 before ready).
//   FAKE_OMP_PROTOCOLS    Comma-separated supportedProtocolVersions advertised in ready (default "1,2").
//
// Test-only commands (answered like real commands): fake_echo {value, delayMs}, fake_crash,
// fake_chunked {size}, fake_bad_chunk.
import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const logFile = process.env.FAKE_OMP_LOG;
const defaultScenario = process.env.FAKE_OMP_SCENARIO || "success";

function log(kind, data) {
  if (!logFile) return;
  appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, kind, ...data })}\n`);
}

function flag(name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

log("argv", { argv, cwd: process.cwd() });

const startup = process.env.FAKE_OMP_STARTUP || "normal";
if (startup === "exit") {
  process.stderr.write("fake omp: refusing to start\n", () => process.exit(2));
}

// Session file: reuse the resumed one, otherwise create one under a fresh temp dir.
let sessionFile = flag("--resume");
if (!sessionFile || !existsSync(sessionFile)) {
  const parent = process.env.FAKE_OMP_SESSION_DIR || tmpdir();
  const dir = mkdtempSync(path.join(parent, "fake-omp-session-"));
  sessionFile = path.join(dir, "session.jsonl");
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: path.basename(dir) })}\n`);
}
const sessionId = path.basename(path.dirname(sessionFile));

let protocolVersion = 1;
let lastAssistantText = null;
/** Active agent run, or null. */
let run = null;
/** Pending extension UI requests: id -> resolve. */
const uiWaiters = new Map();
const uiResponses = [];
let chunkSeq = 0;

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(command, data) {
  emit({
    ...(command.id !== undefined ? { id: command.id } : {}),
    type: "response",
    command: command.type,
    success: true,
    ...(data !== undefined ? { data } : {}),
  });
}

function fail(command, error, code) {
  emit({
    ...(command.id !== undefined ? { id: command.id } : {}),
    type: "response",
    command: command.type,
    success: false,
    error,
    ...(code ? { code } : {}),
  });
}

function assistant(text, stopReason, errorMessage) {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "fake",
    provider: "fake",
    model: "fake-model",
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function finishRun(message) {
  emit({ type: "message_end", message });
  if (message.stopReason !== "error" && message.stopReason !== "aborted") {
    lastAssistantText = message.content.find((b) => b.type === "text")?.text ?? lastAssistantText;
  }
  emit({ type: "agent_end", messages: [message] });
  run = null;
}

function completeSuccessfully(text) {
  emit({ type: "message_start", message: assistant("", "stop") });
  for (const delta of [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))]) {
    emit({
      type: "message_update",
      message: assistant("", "stop"),
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
    });
  }
  emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "npm test" } });
  emit({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "all tests passed" }] },
    isError: false,
  });
  finishRun(assistant(text, "stop"));
}

function scenarioOf(message) {
  const match = /\[fake:([a-z_]+)\]/.exec(String(message ?? ""));
  return match ? match[1] : defaultScenario;
}

function waitForUi(id) {
  return new Promise((resolve) => uiWaiters.set(id, resolve));
}

async function startPrompt(command) {
  const scenario = scenarioOf(command.message);
  run = { scenario, steers: [] };
  respond(command, { agentInvoked: true });
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });

  switch (scenario) {
    case "success":
      completeSuccessfully("Fake summary: implemented the task and ran the tests.");
      break;
    case "error":
      finishRun(assistant("", "error", "Fake model error: rate limited"));
      break;
    case "crash":
      process.stderr.write("fake omp: segmentation fault\n", () => process.exit(1));
      break;
    case "slow":
      // Completes on steer, or ends aborted on abort.
      break;
    case "confirm": {
      emit({ type: "extension_ui_request", id: "ui-notify-1", method: "notify", message: "heads up" });
      emit({ type: "extension_ui_request", id: "ui-confirm-1", method: "confirm", title: "Run?", message: "Proceed?" });
      emit({ type: "extension_ui_request", id: "ui-select-1", method: "select", title: "Pick", options: ["a", "b"] });
      await waitForUi("ui-confirm-1");
      await waitForUi("ui-select-1");
      emit({ type: "fake_ui_responses", responses: [...uiResponses] });
      completeSuccessfully("Fake summary: confirmed.");
      break;
    }
    default:
      finishRun(assistant("", "error", `unknown fake scenario ${scenario}`));
  }
}

function emitChunked(frame) {
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  const chunkId = `rpc-${++chunkSeq}`;
  const pieceSize = 3 * 1024; // multiple of 3 so every piece is padding-free base64
  const count = Math.ceil(bytes.length / pieceSize);
  for (let index = 0; index < count; index++) {
    const data = bytes.subarray(index * pieceSize, (index + 1) * pieceSize).toString("base64");
    emit({ type: "rpc_chunk", chunkId, index, count, byteLength: bytes.length, data });
  }
}

async function handle(command) {
  if (command.type === "extension_ui_response") {
    log("ui_response", { response: command });
    uiResponses.push(command);
    const waiter = uiWaiters.get(command.id);
    if (waiter) {
      uiWaiters.delete(command.id);
      waiter(command);
    }
    return;
  }
  log("command", { command });

  switch (command.type) {
    case "negotiate_protocol":
      if (command.protocolVersion === 2) {
        respond(command, { protocolVersion: 2 });
        protocolVersion = 2;
      } else {
        fail(command, `Unsupported protocol version ${command.protocolVersion}`);
      }
      return;
    case "get_state":
      respond(command, {
        isStreaming: run !== null,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        interruptMode: "immediate",
        sessionFile,
        sessionId,
        autoCompactionEnabled: true,
        fastModeEnabled: false,
        fastModeActive: false,
        tokensPerSecond: null,
        messageCount: 0,
        queuedMessageCount: 0,
        todoPhases: [],
      });
      return;
    case "get_last_assistant_text":
      respond(command, { text: lastAssistantText });
      return;
    case "prompt":
      if (run) {
        fail(command, "Agent is already streaming; pass streamingBehavior");
        return;
      }
      appendFileSync(sessionFile, `${JSON.stringify({ type: "user", message: command.message })}\n`);
      await startPrompt(command);
      return;
    case "steer":
      respond(command);
      log("steer", { message: command.message });
      if (run) {
        run.steers.push(command.message);
        if (run.scenario === "slow") {
          const current = run;
          setImmediate(() => {
            if (run === current) {
              completeSuccessfully(`Fake summary: addressed ${current.steers.length} steered message(s).`);
            }
          });
        }
      }
      return;
    case "abort":
      respond(command);
      if (run) finishRun(assistant("", "aborted", "Request was aborted"));
      return;
    case "fake_echo": {
      const delay = Number(command.delayMs) || 0;
      if (delay > 0) setTimeout(() => respond(command, { value: command.value }), delay);
      else respond(command, { value: command.value });
      return;
    }
    case "fake_crash":
      process.stderr.write("fake omp: fatal crash\n", () => process.exit(3));
      return;
    case "fake_chunked": {
      const payload = "x".repeat(Number(command.size) || 10_000);
      const frame = { id: command.id, type: "response", command: command.type, success: true, data: { payload } };
      if (protocolVersion === 2) emitChunked(frame);
      else emit(frame);
      return;
    }
    case "fake_bad_chunk":
      // A sequence that starts at index 1 is invalid; then answer normally.
      emit({ type: "rpc_chunk", chunkId: "bad-1", index: 1, count: 2, byteLength: 4, data: "YWJj" });
      respond(command, { ok: true });
      return;
    default:
      fail(command, `Unknown command: ${command.type}`, "unknown_command");
  }
}

if (startup === "normal") {
  const versions = (process.env.FAKE_OMP_PROTOCOLS || "1,2").split(",").map(Number);
  emit({
    type: "ready",
    protocolVersion: 1,
    supportedProtocolVersions: versions,
    maxFrameBytes: 1_048_576,
    maxReassembledFrameBytes: 67_108_864,
  });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    emit({ type: "response", command: "parse", success: false, error: "Malformed JSON" });
    return;
  }
  void handle(command);
});
// EOF is a deliberate disconnect: exit cleanly even if a run or timer is still pending.
rl.on("close", () => {
  log("stdin_closed", {});
  process.exit(0);
});
