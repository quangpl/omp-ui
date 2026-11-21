#!/usr/bin/env node
// Test double for `omp --mode rpc`: speaks the newline-delimited JSON RPC protocol on stdio.
//
// Environment:
//   FAKE_OMP_LOG          JSON-lines file; every process appends {pid, kind, ...} entries:
//                         "argv" (argv, cwd, sorted envKeys and allowlisted env values at startup),
//                         "command" (each stdin command),
//                         "ui_response" (each extension_ui_response), "steer" (steered messages: RPC
//                         `steer`, or `prompt` with streamingBehavior while a run is active, logged with
//                         via: "prompt" and the streamingBehavior; like omp, an idle `prompt` with
//                         streamingBehavior starts a prompt).
//   FAKE_OMP_SCENARIO     Default prompt behaviour: success | question | error | quota | crash | slow |
//                         confirm | stream | orchestrate | board_tools | todos | todos_done | todos_steer |
//                         todos_feedback | loop | spend | sdlc_flow | sdlc_gate | sdlc_skip | sdlc_hold.
//                         "error" ends the run with an assistant error (a plain model failure); "quota"
//                         ends it with a quota / usage-limit error (429), as a provider out of quota does.
//                         "todos" reports two `todo` tool results (the agent's todo list), then succeeds.
//                         "todos_done" reports a todo list with every item completed, then succeeds.
//                         "todos_steer" reports that list, waits for a steer, then reports it again with
//                         an item for the feedback appended (in_progress), then with that item completed,
//                         then succeeds. "todos_feedback" does the same without waiting for a steer (the
//                         feedback came with the prompt, as in a resumed run).
//                         The sdlc_* scenarios report todo lists whose phases carry SDLC names (canonical):
//                         "sdlc_flow" works through Analyze → Implement → Testing
//                         (one item each, in_progress then completed, one `todo` update per step,
//                         FAKE_OMP_STEP_MS apart), then succeeds. "sdlc_gate" reports Analyze and
//                         Implement completed and Testing ["Run the tests" pending], then succeeds.
//                         "sdlc_skip" reports that list plus Testing in_progress while Implement is
//                         pending, then succeeds on a steer (or after 1.5 s without one). "sdlc_hold"
//                         reports Analyze completed, Implement in_progress and Testing pending, then
//                         sends nothing until a steer or abort, like "slow".
//                         "loop" repeats the same `read` call (same args, same result) every ~30 ms,
//                         40 times, then succeeds; it stops early if the run is aborted meanwhile.
//                         "question" succeeds with a summary that ends in a question for the user.
//                         "stream" emits 2 thinking_delta + 15 text_delta frames ~80ms apart, then succeeds.
//                         "orchestrate" runs a `task` call with two subagents (Scout succeeds, Builder
//                         fails), reporting progress via task tool updates and, when subscribed via
//                         set_subagent_subscription, subagent_lifecycle/subagent_progress frames.
//                         "spend" ends one assistant message (stopReason toolUse), then works silently
//                         like "slow" (the session's spend is in get_session_stats; see below).
//                         "slow" acknowledges the prompt, then sends nothing until a steer or abort.
//   FAKE_OMP_COST_PER_MESSAGE  USD each assistant message adds to `get_session_stats` (default 0);
//                         `tokens.total` grows by 1000 per assistant message, `contextUsage.tokens` too.
//   FAKE_OMP_STEP_MS      Delay between orchestrate and sdlc_flow steps (default 80).
//                         "board_tools" calls the host tools listed in the prompt as
//                         `<calls>[{"toolName", "arguments"}]</calls>` one after another (`"$created"`
//                         in arguments becomes the id of the card the last board_create_card made),
//                         then succeeds with `Tool results: <JSON list of {toolName, isError, text}>`.
//                         A prompt containing "[fake:<scenario>]" overrides it for that prompt.
//   FAKE_OMP_SESSION_DIR  Parent dir for the per-process session temp dir (default: os tmpdir).
//   FAKE_OMP_PROTOCOLS    Comma-separated supportedProtocolVersions advertised in ready (default "1,2").
//   FAKE_OMP_MODEL_ROLES  JSON object `omp config get modelRoles --json` reports (default {});
//                         "fail" makes that command exit 1. Logged as a "config" entry, not "argv".
//   FAKE_OMP_SKILLS       JSON array of {name, description} that `omp skill list --json` reports as
//                         {"skills": [...]} (default []). Logged as a "skill" entry, not "argv".
//   `omp models --json`   Prints {"models": [...]}: each provider's chat models only when its key is
//                         in the environment (see FAKE_MODELS: 2 openai models iff OPENAI_API_KEY,
//                         1 groq model iff GROQ_API_KEY). Logged as a "models" entry with the names
//                         (never values) of the provider env vars it saw, not "argv".
//   FAKE_OMP_USAGE        JSON array `omp usage --json` reports as {"reports": [...]} (default []).
//                         Logged as a "usage" entry, not "argv".
//   FAKE_OMP_STATS        JSON object `omp stats --json` prints (default {}). Logged as a "stats"
//                         entry, not "argv".
//   `omp login <id>`      Speaks omp's login dialog on stdio (logged as a "login" entry): prints the
//                         page to open, then asks for the pasted code ("Paste the authorization code
//                         (or full redirect URL): "); "good-code" or a URL with code=good-code
//                         logs in ("Logged in to Fake <id> as fake@example.com", exit 0), anything
//                         else fails ("Login failed: Invalid authorization code", exit 1), closed
//                         stdin cancels. "github-copilot" first asks for an Enterprise domain, then
//                         prints a device URL and "Enter code: FAKE-1234" and logs in after
//                         FAKE_OMP_LOGIN_DEVICE_MS (default 300).
//
// Helper workers (started with --no-session: advisor, summary agent, chat assistant) are
// pooled and reused across prompts via new_session. They log "helper_argv" at startup instead of
// "argv", every prompt as a "helper" entry {argv, cwd, prompt}, and other commands as
// "helper_command" instead of "command", so card-run assertions only see card runs. A helper prompt
// starting with "You are AgentMan's chat assistant" (or "…scheduler assistant") is answered by
// chatAssistant: it calls the host tools the message lists as `<calls>[…]</calls>` and answers
// "Chat reply: …"; `[fake-chat:slow]` never answers, `[fake-chat:fail]` exits 1 (see chatAssistant).
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

if (argv[0] === "config") {
  log("config", { argv, cwd: process.cwd() });
  const roles = process.env.FAKE_OMP_MODEL_ROLES || "{}";
  if (roles === "fail") process.exit(1);
  process.stdout.write(`${JSON.stringify({ key: argv[2], value: JSON.parse(roles) }, null, 2)}\n`);
  process.exit(0);
}

if (argv[0] === "skill") {
  log("skill", { argv });
  const skills = JSON.parse(process.env.FAKE_OMP_SKILLS || "[]");
  process.stdout.write(`${JSON.stringify({ skills }, null, 2)}\n`, () => process.exit(0));
  await new Promise(() => undefined);
}

/** Chat models `omp models --json` lists per provider env var, like omp after a provider signs in. */
const FAKE_MODELS = {
  OPENAI_API_KEY: [
    { provider: "openai", kind: "chat", selector: "openai/gpt-fake", name: "GPT Fake", thinking: [] },
    { provider: "openai", kind: "chat", selector: "openai/gpt-fake-mini", name: "GPT Fake Mini", thinking: [] },
  ],
  GROQ_API_KEY: [{ provider: "groq", kind: "chat", selector: "groq/llama-fake", name: "Llama Fake", thinking: [] }],
};

/** Print `data` as JSON and exit 0 once stdout is flushed. */
async function printJson(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`, () => process.exit(0));
  await new Promise(() => undefined);
}

if (argv[0] === "models") {
  const envVars = Object.keys(FAKE_MODELS).filter((key) => process.env[key]);
  log("models", { argv, envVars });
  await printJson({ models: envVars.flatMap((key) => FAKE_MODELS[key]) });
}

if (argv[0] === "usage") {
  log("usage", { argv });
  await printJson({ reports: JSON.parse(process.env.FAKE_OMP_USAGE || "[]") });
}

if (argv[0] === "stats") {
  log("stats", { argv });
  await printJson(JSON.parse(process.env.FAKE_OMP_STATS || "{}"));
}

if (argv[0] === "login") {
  const id = argv[1] ?? "";
  log("login", { argv });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) =>
    new Promise((resolve) => {
      rl.once("close", () => resolve(null));
      rl.question(question, resolve);
    });
  const out = (text) => process.stdout.write(text);
  const fail = (reason) => {
    process.stderr.write(`Login failed: ${reason}\n`, () => process.exit(1));
  };
  const succeed = () => {
    out(`\nLogged in to Fake ${id} as fake@example.com\nCredentials saved to /tmp/fake-omp/agent.db\n`);
    process.stdout.write("", () => process.exit(0));
  };
  if (id === "github-copilot") {
    const domain = await ask("GitHub Enterprise URL/domain (blank for github.com) (company.ghe.com): ");
    if (domain === null) {
      fail("Login cancelled: stdin closed");
    } else {
      out("\nOpen this URL in your browser:\nhttps://github.com/login/device\nEnter code: FAKE-1234\n\n");
      setTimeout(succeed, Number(process.env.FAKE_OMP_LOGIN_DEVICE_MS || 300));
    }
  } else {
    out(`\nOpen this URL in your browser:\nhttps://auth.example.test/authorize?login=${id}&state=fake\n`);
    out("Local shortcut (this machine only): http://localhost:54545/launch\n");
    out("Complete login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.\n\n");
    out("Waiting for browser authentication...\n");
    const code = await ask("Paste the authorization code (or full redirect URL): ");
    if (code === null) fail("Login cancelled: stdin closed");
    else if (code === "good-code" || /[?&]code=good-code(&|$)/.test(code)) succeed();
    else fail("Invalid authorization code");
  }
  await new Promise(() => undefined);
}

// Helper replies (advisor prompts on a helper worker): one assistant message
// chosen by a `[fake-advisor:<mode>]` marker in the prompt (the card's text is part of it):
//   (none)       consult: a decision; triage: every question left for the user, unchanged.
//   user         consult: marked for the user.
//   answer       triage: answers the question and sends the agent back to work (followUp); the
//                followUp carries "[fake:question] [fake-advisor:answer]", so the next run asks again.
//   fail         exits 1 without an answer.
// A code-changes summary prompt ("You summarise code changes…") is answered with a fixed one-line summary.
// Returns the reply text, or { fail: stderr line }.
function helperReply(prompt) {
  if (prompt.startsWith("You summarise code changes for a reviewer.")) {
    return "Adds a Changes tab that shows the card's diff with a short summary.";
  }
  const mode = /\[fake-advisor:([a-z_]+)\]/.exec(prompt)?.[1] ?? "";
  if (mode === "fail") return { fail: "fake omp: advisor exploded" };
  const questions = /<questions>\n([\s\S]*?)\n<\/questions>/.exec(prompt)?.[1];
  let reply;
  if (questions === undefined) {
    reply =
      mode === "user"
        ? { needsUser: true, decision: "Use the existing blue", reason: "Brand colors are the user's call." }
        : { needsUser: false, decision: "Use offset pagination with 20 items per page", reason: "Matches the other list endpoints." };
  } else if (mode === "answer") {
    reply = {
      answers: [{ question: questions, answer: "20 items, like the other endpoints." }],
      userQuestion: null,
      followUp: "Set the default page size to 20 and add a test for it. [fake:question] [fake-advisor:answer]",
    };
  } else {
    reply = { answers: [], userQuestion: questions, followUp: null };
  }
  return JSON.stringify(reply);
}

/** A pooled helper worker (advisor, summary agent, chat assistant) rather than a card run. */
const helper = argv.includes("--no-session");

/** Environment variables whose values the "argv" entry records (credentials in, AgentMan secrets out). */
const LOGGED_ENV = [
  "HOME",
  "SSH_AUTH_SOCK",
  "ANTHROPIC_API_KEY",
  "GH_TOKEN",
  "ADMIN_PASSWORD",
  "AUTH_SECRET",
  "DATABASE_URL",
];

log(helper ? "helper_argv" : "argv", {
  argv,
  cwd: process.cwd(),
  envKeys: Object.keys(process.env).sort(),
  env: Object.fromEntries(
    LOGGED_ENV.filter((key) => key in process.env).map((key) => [key, process.env[key]]),
  ),
});

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
/** set_subagent_subscription level. */
let subagentLevel = "off";
/** Host tool results by host_tool_call id (resolve, or the result if it came first). */
const hostWaiters = new Map();
const hostResults = new Map();
let hostCallSeq = 0;
/** Assistant messages ended so far: what `get_session_stats` reports as spent. */
let assistantMessages = 0;

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
  if (frame.type === "message_end" && frame.message?.role === "assistant") assistantMessages++;
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
  emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "npm test", intent: "Running the tests" } });
  emit({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "all tests passed" }] },
    isError: false,
  });
  finishRun(assistant(text, "stop"));
}

const STREAM_THINKING = ["Planning the change. ", "Checking the tests first."];
const STREAM_WORDS = [
  "Streamed ", "summary: ", "I ", "updated ", "the ", "login ", "form, ", "added ", "validation, ",
  "wrote ", "tests, ", "and ", "verified ", "everything ", "passes.",
];
const STREAM_DELAY_MS = 80;

/** Slow token-by-token stream; stops early if the run is aborted meanwhile. */
async function streamSuccessfully(current) {
  const thinking = STREAM_THINKING.join("");
  const text = STREAM_WORDS.join("");
  const message = (content) => ({ ...assistant("", "stop"), content });
  emit({ type: "message_start", message: message([]) });
  for (const delta of STREAM_THINKING) {
    if (run !== current) return;
    emit({
      type: "message_update",
      message: message([]),
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta },
    });
    await new Promise((resolve) => setTimeout(resolve, STREAM_DELAY_MS));
  }
  for (const delta of STREAM_WORDS) {
    if (run !== current) return;
    emit({
      type: "message_update",
      message: message([]),
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta },
    });
    await new Promise((resolve) => setTimeout(resolve, STREAM_DELAY_MS));
  }
  if (run !== current) return;
  finishRun(
    message([
      { type: "thinking", thinking },
      { type: "text", text },
    ]),
  );
}

const ORCHESTRATE_AGENTS = [
  { id: "Scout", agent: "scout", task: "Map the login form code and its tests." },
  { id: "Builder", agent: "task", task: "Add validation to the login form." },
];

/** A `task` call fanning out to two subagents; stops early if the run is aborted meanwhile. */
async function orchestrate(current) {
  const stepMs = Number(process.env.FAKE_OMP_STEP_MS) || STREAM_DELAY_MS;
  const step = () => new Promise((resolve) => setTimeout(resolve, stepMs));
  const callId = "call-task-1";
  const progress = ORCHESTRATE_AGENTS.map((a, index) => ({
    index,
    id: a.id,
    agent: a.agent,
    agentSource: "bundled",
    status: "running",
    task: a.task,
    assignment: a.task,
    description: a.task,
    recentTools: [],
    recentOutput: [],
    toolCount: 0,
    requests: 0,
    tokens: 0,
    cost: 0,
    durationMs: 0,
  }));
  const subscribed = () => subagentLevel !== "off";
  const lifecycle = (p, status) =>
    subscribed() &&
    emit({
      type: "subagent_lifecycle",
      payload: { id: p.id, agent: p.agent, agentSource: "bundled", description: p.description, status, index: p.index, parentToolCallId: callId },
    });
  const update = () => {
    emit({
      type: "tool_execution_update",
      toolCallId: callId,
      toolName: "task",
      partialResult: { content: [], details: { results: [], totalDurationMs: 0, progress } },
    });
    if (subscribed()) {
      for (const p of progress) {
        emit({
          type: "subagent_progress",
          payload: { index: p.index, agent: p.agent, agentSource: "bundled", task: p.task, assignment: p.assignment, progress: p, parentToolCallId: callId },
        });
      }
    }
  };

  emit({
    type: "tool_execution_start",
    toolCallId: callId,
    toolName: "task",
    intent: "Splitting the work",
    args: { context: "Login form", tasks: ORCHESTRATE_AGENTS.map((a) => ({ name: a.id, agent: a.agent, task: a.task })) },
  });
  for (const p of progress) lifecycle(p, "started");
  for (let tick = 1; tick <= 3; tick++) {
    await step();
    if (run !== current) return;
    for (const p of progress) {
      p.currentTool = tick % 2 ? "read" : "bash";
      p.currentToolIntent = tick % 2 ? `Reading src/login-${tick}.tsx` : "Running the tests";
      p.lastIntent = p.currentToolIntent;
      p.recentTools.unshift({ tool: "grep", intent: `Searching step ${tick}`, isError: false, endMs: Date.now() });
      p.recentOutput = [`step ${tick} output`, ...p.recentOutput].slice(0, 8);
      p.toolCount = tick * 2;
      p.requests = tick;
      p.tokens = tick * 1000;
      p.cost = tick * 0.01;
      p.durationMs = tick * stepMs;
    }
    update();
  }
  await step();
  if (run !== current) return;
  const [scout, builder] = progress;
  scout.status = "completed";
  builder.status = "failed";
  for (const p of progress) {
    p.currentTool = undefined;
    p.currentToolIntent = undefined;
  }
  lifecycle(scout, "completed");
  lifecycle(builder, "failed");
  const results = [
    { ...scout, exitCode: 0, output: "Found the form in src/login.tsx; tests live in tests/login.test.ts.", stderr: "", truncated: false },
    { ...builder, exitCode: 1, output: "", stderr: "Type error in src/login.tsx", error: "Type error in src/login.tsx", truncated: false },
  ];
  emit({
    type: "tool_execution_end",
    toolCallId: callId,
    toolName: "task",
    result: { content: [{ type: "text", text: "2 agents finished" }], details: { results, totalDurationMs: 4 * stepMs, progress } },
    isError: false,
  });
  completeSuccessfully("Fake summary: orchestrated the work across two subagents.");
}

function scenarioOf(message) {
  const match = /\[fake:([a-z_]+)\]/.exec(String(message ?? ""));
  return match ? match[1] : defaultScenario;
}

/**
 * Resolves with the host's reply to UI request `id`. readline emits every line of one stdin
 * chunk synchronously, so a reply can arrive before the scenario resumes and asks for it:
 * already-received replies resolve immediately instead of waiting forever.
 */
function waitForUi(id) {
  const received = uiResponses.find((r) => r.id === id);
  if (received) return Promise.resolve(received);
  const { promise, resolve } = Promise.withResolvers();
  uiWaiters.set(id, resolve);
  return promise;
}

function waitForHostResult(id) {
  const received = hostResults.get(id);
  if (received) return Promise.resolve(received);
  const { promise, resolve } = Promise.withResolvers();
  hostWaiters.set(id, resolve);
  return promise;
}

async function boardTools(message) {
  const match = /<calls>([\s\S]*?)<\/calls>/.exec(String(message));
  const calls = match ? JSON.parse(match[1]) : [];
  const results = [];
  let created = null;
  for (const call of calls) {
    const args = JSON.parse(JSON.stringify(call.arguments ?? {}).replaceAll('"$created"', JSON.stringify(created)));
    const id = `host_${++hostCallSeq}`;
    emit({ type: "host_tool_call", id, toolCallId: `toolu_${id}`, toolName: call.toolName, arguments: args });
    const reply = await waitForHostResult(id);
    const text = reply.result?.content?.map((c) => c.text).join("") ?? "";
    if (call.toolName === "board_create_card" && !reply.isError) created = JSON.parse(text).created.id;
    results.push({ toolName: call.toolName, isError: reply.isError === true, text });
  }
  completeSuccessfully(`Tool results: ${JSON.stringify(results)}`);
}

/**
 * The chat assistant (a helper prompt starting with "You are AgentMan's chat assistant"): takes the
 * message between the <new-message> and </new-message> lines. When it holds
 * `<calls>[{"toolName", "arguments"}]</calls>`, it reports one tool call (intent "Using AgentMan's
 * tools"), calls those host tools one after another (`"$created"` in arguments becomes the id of
 * the card the last agentman_create_card made, from its `{card: {id}}` result), then answers
 * `Chat reply: <JSON list of {toolName, isError, text}>`; otherwise it answers `Chat reply: <message>`.
 * A `[fake-chat:<mode>]` marker in the message changes that:
 *   slow         reports the tool call, then never answers (until aborted or killed).
 *   fail         exits 1 without an answer.
 */
async function chatAssistant(prompt) {
  const current = run;
  const text = /^<new-message>\n([\s\S]*?)\n<\/new-message>$/m.exec(prompt)?.[1] ?? "";
  const modes = [...text.matchAll(/\[fake-chat:([a-z]+)\]/g)].map((m) => m[1]);
  if (modes.includes("fail")) {
    process.stderr.write("fake omp: chat assistant exploded\n", () => process.exit(1));
    return;
  }
  const match = /<calls>([\s\S]*?)<\/calls>/.exec(text);
  const calls = match ? JSON.parse(match[1]) : [];
  if (calls.length > 0 || modes.includes("slow")) {
    emit({ type: "tool_execution_start", toolCallId: "chat-1", toolName: "agentman", args: {}, intent: "Using AgentMan's tools" });
  }
  if (modes.includes("slow")) return;
  if (calls.length === 0) {
    finishRun(assistant(`Chat reply: ${text}`, "stop"));
    return;
  }
  const results = [];
  let created = null;
  for (const call of calls) {
    const args = JSON.parse(JSON.stringify(call.arguments ?? {}).replaceAll('"$created"', JSON.stringify(created)));
    const id = `host_${++hostCallSeq}`;
    emit({ type: "host_tool_call", id, toolCallId: `toolu_${id}`, toolName: call.toolName, arguments: args });
    const reply = await waitForHostResult(id);
    if (run !== current) return;
    const result = reply.result?.content?.map((c) => c.text).join("") ?? "";
    if (call.toolName === "agentman_create_card" && !reply.isError) created = JSON.parse(result).card.id;
    results.push({ toolName: call.toolName, isError: reply.isError === true, text: result });
  }
  finishRun(assistant(`Chat reply: ${JSON.stringify(results)}`, "stop"));
}

/** Fake `todo` tool results as omp reports them (`result.details.phases`); the last one stays. */
const FAKE_TODO_PHASES = [
  [
    { name: "Build", tasks: [{ content: "Write the code", status: "in_progress" }, { content: "Add tests", status: "pending" }] },
    { name: "Ship", tasks: [{ content: "Update docs", status: "pending" }] },
  ],
  [
    { name: "Build", tasks: [{ content: "Write the code", status: "completed" }, { content: "Add tests", status: "in_progress" }] },
    { name: "Ship", tasks: [{ content: "Update docs", status: "pending" }, { content: "Old idea", status: "abandoned" }] },
  ],
];

/** The todos_done / todos_steer / todos_feedback list: every item completed. */
const FAKE_DONE_TODO_PHASES = [
  { name: "Build", tasks: [{ content: "Write the code", status: "completed" }, { content: "Add tests", status: "completed" }] },
  { name: "Ship", tasks: [{ content: "Update docs", status: "completed" }] },
];

/** The completed list plus an item for the feedback, in `status`. */
function feedbackTodoPhases(status) {
  return [...FAKE_DONE_TODO_PHASES, { name: "Feedback", tasks: [{ content: "Address the feedback", status }] }];
}

function emitTodo(toolCallId, op, phases) {
  emit({ type: "tool_execution_start", toolCallId, toolName: "todo", args: { op } });
  emit({
    type: "tool_execution_end",
    toolCallId,
    toolName: "todo",
    result: { content: [{ type: "text", text: "Remaining items…" }], details: { op: "update", phases, storage: "session" } },
    isError: false,
  });
}

function emitTodos() {
  FAKE_TODO_PHASES.forEach((phases, i) => emitTodo(`todo-${i + 1}`, i === 0 ? "init" : "done", phases));
}

/** todos_steer (`waitForSteer`) and todos_feedback; stops if the run is aborted meanwhile. */
async function feedbackTodos(current, waitForSteer) {
  emitTodo("todo-1", "init", FAKE_DONE_TODO_PHASES);
  if (waitForSteer && !current.steers.length) {
    const { promise, resolve } = Promise.withResolvers();
    current.onSteer = resolve;
    await promise;
  }
  if (run !== current) return;
  emitTodo("todo-2", "append", feedbackTodoPhases("in_progress"));
  emitTodo("todo-3", "done", feedbackTodoPhases("completed"));
  completeSuccessfully("Fake summary: addressed the feedback.");
}

/** sdlc_flow: one [phase, item] per SDLC phase it works through, in order. */
const SDLC_FLOW_PHASES = [
  ["Analyze", "Scope the change"],
  ["Implement", "Write the code"],
  ["Testing", "Run the tests"],
];

/** The sdlc_flow list with item `active` in `status`: earlier items completed, later ones pending. */
function sdlcFlowPhases(active, status) {
  return SDLC_FLOW_PHASES.map(([name, content], i) => ({
    name,
    tasks: [{ content, status: i < active ? "completed" : i === active ? status : "pending" }],
  }));
}

/** sdlc_flow: every item in_progress, then completed, one update per step; stops if the run is aborted meanwhile. */
async function sdlcFlow(current) {
  const stepMs = Number(process.env.FAKE_OMP_STEP_MS) || STREAM_DELAY_MS;
  let update = 0;
  for (let i = 0; i < SDLC_FLOW_PHASES.length; i++) {
    for (const status of ["in_progress", "completed"]) {
      if (run !== current) return;
      update += 1;
      emitTodo(`todo-${update}`, update === 1 ? "init" : "update", sdlcFlowPhases(i, status));
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  }
  if (run !== current) return;
  completeSuccessfully("Fake summary: worked through every SDLC phase.");
}

/** sdlc_gate: implemented, but the Testing item never ran. */
const SDLC_GATE_PHASES = [
  { name: "Analyze", tasks: [{ content: "Scope the change", status: "completed" }] },
  { name: "Implement", tasks: [{ content: "Write the code", status: "completed" }] },
  { name: "Testing", tasks: [{ content: "Run the tests", status: "pending" }] },
];

/** sdlc_skip: Testing started while Implement is still pending. */
const SDLC_SKIP_PHASES = [
  { name: "Analyze", tasks: [{ content: "Scope the change", status: "completed" }] },
  { name: "Implement", tasks: [{ content: "Write the code", status: "pending" }] },
  { name: "Testing", tasks: [{ content: "Run the tests", status: "in_progress" }] },
];

/** sdlc_hold: in the middle of Implement. */
const SDLC_HOLD_PHASES = [
  { name: "Analyze", tasks: [{ content: "Scope the change", status: "completed" }] },
  { name: "Implement", tasks: [{ content: "Write the code", status: "in_progress" }] },
  { name: "Testing", tasks: [{ content: "Run the tests", status: "pending" }] },
];

/** How long sdlc_skip waits for the host's quality-gate steer before it succeeds anyway. */
const SDLC_SKIP_WAIT_MS = 1_500;

/** sdlc_skip: succeeds once steered (or after SDLC_SKIP_WAIT_MS); stops if the run is aborted meanwhile. */
async function sdlcSkip(current) {
  emitTodo("todo-1", "init", SDLC_SKIP_PHASES);
  if (!current.steers.length) {
    const { promise, resolve } = Promise.withResolvers();
    current.onSteer = resolve;
    const timer = setTimeout(resolve, SDLC_SKIP_WAIT_MS);
    await promise;
    clearTimeout(timer);
  }
  if (run !== current) return;
  completeSuccessfully("Fake summary: shipped the change.");
}

const LOOP_REPEATS = 40;
const LOOP_DELAY_MS = 30;

/** The same `read` call with the same result over and over; stops if the run is aborted meanwhile. */
async function loopCalls(current) {
  for (let n = 1; n <= LOOP_REPEATS; n++) {
    if (run !== current) return;
    const toolCallId = `loop-${n}`;
    emit({ type: "tool_execution_start", toolCallId, toolName: "read", args: { path: "src/a.ts", intent: `Reading again (${n})` } });
    emit({
      type: "tool_execution_end",
      toolCallId,
      toolName: "read",
      result: { content: [{ type: "text", text: "export const a = 1;" }] },
      isError: false,
    });
    await new Promise((resolve) => setTimeout(resolve, LOOP_DELAY_MS));
  }
  if (run !== current) return;
  completeSuccessfully("Fake summary: read the file many times.");
}

async function startPrompt(command) {
  const scenario = scenarioOf(command.message);
  run = { scenario, steers: [] };
  respond(command, { agentInvoked: true });
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  const helperPrompt = String(command.message ?? "");
  if (helper && /^You are AgentMan's (chat|scheduler) assistant/.test(helperPrompt)) {
    await chatAssistant(helperPrompt);
    return;
  }
  if (helper) {
    const reply = helperReply(String(command.message ?? ""));
    if (typeof reply === "object") process.stderr.write(`${reply.fail}\n`, () => process.exit(1));
    else finishRun(assistant(reply, "stop"));
    return;
  }

  switch (scenario) {
    case "success":
      completeSuccessfully("Fake summary: implemented the task and ran the tests.");
      break;
    case "question":
      completeSuccessfully(
        "Fake summary: added the endpoint.\n\nShould pagination default to 20 or 50 items per page?",
      );
      break;
    case "error":
      finishRun(assistant("", "error", "Fake model error: upstream failed"));
      break;
    case "quota":
      finishRun(assistant("", "error", "Fake model error: 429 You have exceeded your quota (usage limit reached)"));
      break;
    case "crash":
      process.stderr.write("fake omp: segmentation fault\n", () => process.exit(1));
      break;
    case "slow":
      // Completes on steer, or ends aborted on abort.
      break;
    case "spend":
      emit({ type: "message_start", message: assistant("", "toolUse") });
      emit({ type: "message_end", message: assistant("Working on it.", "toolUse") });
      // Then works silently until aborted, like "slow".
      break;
    case "stream":
      await streamSuccessfully(run);
      break;
    case "orchestrate":
      await orchestrate(run);
      break;
    case "todos":
      emitTodos();
      completeSuccessfully("Fake summary: worked through the todo list.");
      break;
    case "todos_done":
      emitTodo("todo-1", "init", FAKE_DONE_TODO_PHASES);
      completeSuccessfully("Fake summary: worked through the todo list.");
      break;
    case "todos_steer":
    case "todos_feedback":
      await feedbackTodos(run, scenario === "todos_steer");
      break;
    case "sdlc_flow":
      await sdlcFlow(run);
      break;
    case "sdlc_gate":
      emitTodo("todo-1", "init", SDLC_GATE_PHASES);
      completeSuccessfully("Fake summary: implemented the change.");
      break;
    case "sdlc_skip":
      await sdlcSkip(run);
      break;
    case "sdlc_hold":
      emitTodo("todo-1", "init", SDLC_HOLD_PHASES);
      // Completes on steer, or ends aborted on abort, like "slow".
      break;
    case "loop":
      await loopCalls(run);
      break;
    case "board_tools":
      await boardTools(command.message);
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

/** A message steered into the active run (RPC `steer`, or `prompt` with streamingBehavior). */
function steer(message, details = {}) {
  log("steer", { message, ...details });
  if (!run) return;
  run.steers.push(message);
  run.onSteer?.();
  if (run.scenario === "slow" || run.scenario === "sdlc_hold") {
    const current = run;
    setImmediate(() => {
      if (run === current) {
        completeSuccessfully(`Fake summary: addressed ${current.steers.length} steered message(s).`);
      }
    });
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
  if (command.type === "host_tool_result") {
    log("host_tool_result", { result: command });
    hostResults.set(command.id, command);
    const waiter = hostWaiters.get(command.id);
    if (waiter) {
      hostWaiters.delete(command.id);
      waiter(command);
    }
    return;
  }
  if (!helper) log("command", { command });
  else if (command.type === "prompt") log("helper", { argv, cwd: process.cwd(), prompt: String(command.message ?? "") });
  else log("helper_command", { command });

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
    case "set_subagent_subscription":
      subagentLevel = command.level;
      respond(command, { level: command.level });
      return;
    case "set_host_tools":
      respond(command, { toolNames: command.tools.map((t) => t.name) });
      return;
    case "get_last_assistant_text":
      respond(command, { text: lastAssistantText });
      return;
    case "get_session_stats": {
      const costPerMessage = Number(process.env.FAKE_OMP_COST_PER_MESSAGE) || 0;
      const tokens = assistantMessages * 1000;
      respond(command, {
        tokens: { total: tokens },
        cost: assistantMessages * costPerMessage,
        contextUsage: { tokens, contextWindow: 200_000 },
      });
      return;
    }
    case "new_session":
      if (run) finishRun(assistant("", "aborted", "Session replaced"));
      lastAssistantText = null;
      respond(command, { cancelled: false });
      return;
    case "prompt":
      if (run) {
        if (command.streamingBehavior === "steer" || command.streamingBehavior === "followUp") {
          respond(command);
          steer(command.message, { via: "prompt", streamingBehavior: command.streamingBehavior });
          return;
        }
        fail(command, "Agent is already streaming; pass streamingBehavior");
        return;
      }
      appendFileSync(sessionFile, `${JSON.stringify({ type: "user", message: command.message })}\n`);
      await startPrompt(command);
      return;
    case "steer":
      respond(command);
      steer(command.message);
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
