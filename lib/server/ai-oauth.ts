// Server-only OAuth sign-in for Settings → AI Providers: runs `omp login <id>` with piped stdio and
// turns its terminal dialog into an `AiOAuthSession` the browser polls. omp prints the page to
// authorize at (or a device code), waits for the redirect on a localhost callback port of this
// server, and meanwhile reads a pasted redirect URL / code (or another answer) from stdin. On
// success omp stores and refreshes the tokens in its own credential store (~/.omp), which every
// omp child reads: nothing is saved in Settings and no token passes through this module.
//
// Sessions live in this process only (on globalThis, shared across dev hot reloads): one running
// login per id (they share omp's callback port), each killed after LOGIN_TIMEOUT_MS; finished
// sessions are kept for FINISHED_TTL_MS so a late poll still sees the outcome.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";

import { getAiOAuthLogin, type AiOAuthLogin, type AiOAuthSession } from "@/lib/ai-providers";
import { childEnv } from "@/lib/child-env";
import { HttpError } from "@/lib/server/http";

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const FINISHED_TTL_MS = 15 * 60_000;
const MAX_OUTPUT_LINES = 40;
const MAX_LINE_LENGTH = 500;
const MAX_INPUT_LENGTH = 8 * 1024;
const KILL_GRACE_MS = 2_000;

const OPEN_URL_LINE = "Open this URL in your browser:";
// omp's escape sequences (colors, cursor moves), in case it decides to color piped output.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** An unterminated output line ending like this is a readline question omp waits on. */
const PROMPT_END = /[:?)]\s*$/;

interface Entry {
  session: AiOAuthSession;
  child: ChildProcess | null;
  /** Unterminated stdout/stderr tail (a question, or a line still arriving). */
  partial: string;
  /** The previous complete line was OPEN_URL_LINE. */
  expectUrl: boolean;
  cancelled: boolean;
  timedOut: boolean;
  timer: NodeJS.Timeout | undefined;
}

const g = globalThis as unknown as { __ompUiAiOAuth?: Map<string, Entry> };
const sessions = (g.__ompUiAiOAuth ??= new Map<string, Entry>());

function snapshot(entry: Entry): AiOAuthSession {
  return { ...entry.session, output: [...entry.session.output] };
}

function prune(): void {
  const cutoff = Date.now() - FINISHED_TTL_MS;
  for (const [id, entry] of sessions) {
    const finishedAt = entry.session.finishedAt;
    if (finishedAt && Date.parse(finishedAt) < cutoff) sessions.delete(id);
  }
}

function pushOutput(entry: Entry, line: string): void {
  const output = entry.session.output;
  output.push(line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line);
  if (output.length > MAX_OUTPUT_LINES) output.splice(0, output.length - MAX_OUTPUT_LINES);
}

/** Sort one complete line of omp's dialog into the session fields. */
function handleLine(entry: Entry, raw: string): void {
  const line = raw.trim();
  const expectUrl = entry.expectUrl;
  entry.expectUrl = false;
  if (!line) return;
  const { session } = entry;
  if (line === OPEN_URL_LINE) {
    entry.expectUrl = true;
    return;
  }
  if (expectUrl && /^https?:\/\/\S+$/.test(line)) {
    // Only https pages are offered as a link; anything else stays visible as text.
    if (line.startsWith("https://")) session.url = line;
    else pushOutput(entry, line);
    return;
  }
  // A link to omp's callback server on the server machine: useless from another browser. omp
  // also tries to open a browser on the server, which the UI's own button replaces.
  if (line.startsWith("Local shortcut (this machine only):")) return;
  if (line.startsWith("A browser window should open.")) return;
  const code = /^Enter code:\s*(\S+)$/.exec(line);
  if (code) {
    session.userCode = code[1];
    return;
  }
  const failed = /^Login failed:\s*(.+)$/.exec(line);
  if (failed) {
    session.error = failed[1];
    return;
  }
  const loggedIn = /^Logged in to .+? as (.+)$/.exec(line);
  if (loggedIn) session.account = loggedIn[1];
  // "Credentials saved to <path>" names a file on the server; it is not the browser's business.
  if (/^Credentials saved to /.test(line)) return;
  pushOutput(entry, line);
}

function updatePrompt(entry: Entry): void {
  const tail = entry.partial.trim();
  entry.session.prompt = tail && PROMPT_END.test(tail) ? tail : null;
}

function onData(entry: Entry, chunk: Buffer | string): void {
  if (entry.session.status !== "running") return;
  const text = (entry.partial + String(chunk)).replace(ANSI, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  entry.partial = lines.pop() ?? "";
  for (const line of lines) handleLine(entry, line);
  updatePrompt(entry);
}

function finish(entry: Entry, status: AiOAuthSession["status"], error: string | null): void {
  const { session } = entry;
  if (session.status !== "running") return;
  if (entry.partial.trim()) handleLine(entry, entry.partial);
  entry.partial = "";
  clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.child = null;
  session.status = status;
  session.prompt = null;
  session.error = status === "succeeded" ? null : error;
  session.finishedAt = new Date().toISOString();
}

function onExit(entry: Entry, code: number | null, signal: NodeJS.Signals | null): void {
  const { session } = entry;
  if (entry.cancelled) return finish(entry, "cancelled", null);
  if (entry.timedOut) return finish(entry, "failed", "Timed out waiting for the sign-in. Start it again.");
  // `omp login` exits 0 without storing anything when the provider returned no credentials.
  const nothingStored = session.output.find((line) => /^No credentials were stored/.test(line));
  if (code === 0 && !session.error && !nothingStored) return finish(entry, "succeeded", null);
  finish(
    entry,
    "failed",
    session.error ?? nothingStored ?? `omp login exited with ${code !== null ? `code ${code}` : `signal ${signal}`}`,
  );
}

function stop(entry: Entry): void {
  const child = entry.child;
  if (!child) return;
  // Closing stdin cancels omp's pending question; the signal stops the callback server.
  child.stdin?.end();
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, KILL_GRACE_MS).unref();
}

function requireLogin(loginId: unknown): AiOAuthLogin {
  const login = typeof loginId === "string" ? getAiOAuthLogin(loginId) : undefined;
  if (!login) throw new HttpError(400, "Unknown OAuth sign-in");
  return login;
}

function requireEntry(id: string): Entry {
  prune();
  const entry = sessions.get(id);
  if (!entry) throw new HttpError(404, "Sign-in not found or expired: start it again");
  return entry;
}

/**
 * Start `omp login <loginId>` (an id from the catalog only). A running sign-in for the same id is
 * cancelled first: both would wait on the same callback port.
 */
export function startAiOAuth(ompPath: string, loginId: unknown): AiOAuthSession {
  const login = requireLogin(loginId);
  prune();
  for (const entry of sessions.values()) {
    if (entry.session.loginId === login.id && entry.session.status === "running") {
      entry.cancelled = true;
      stop(entry);
      finish(entry, "cancelled", null);
    }
  }

  const entry: Entry = {
    session: {
      id: randomUUID(),
      loginId: login.id,
      label: login.label,
      status: "running",
      url: null,
      userCode: null,
      prompt: null,
      output: [],
      account: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    },
    child: null,
    partial: "",
    expectUrl: false,
    cancelled: false,
    timedOut: false,
    timer: undefined,
  };
  sessions.set(entry.session.id, entry);

  let child: ChildProcess;
  try {
    child = spawn(ompPath, ["login", login.id], {
      cwd: os.tmpdir(),
      env: childEnv({ NO_COLOR: "1" }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    finish(entry, "failed", `Could not start omp: ${err instanceof Error ? err.message : String(err)}`);
    return snapshot(entry);
  }
  entry.child = child;
  child.stdout?.on("data", (chunk: Buffer) => onData(entry, chunk));
  child.stderr?.on("data", (chunk: Buffer) => onData(entry, chunk));
  // EPIPE when omp exits while an answer is being written: the exit handler reports the outcome.
  child.stdin?.on("error", () => undefined);
  child.on("error", (err: NodeJS.ErrnoException) => {
    const message =
      err.code === "ENOENT"
        ? `omp not found at ${ompPath}. Install from https://omp.sh or set OMP_PATH`
        : err.code === "EACCES"
          ? `omp at ${ompPath} is not executable (permission denied)`
          : `Could not start omp: ${err.message}`;
    finish(entry, "failed", message);
  });
  child.on("close", (code, signal) => onExit(entry, code, signal));
  entry.timer = setTimeout(() => {
    entry.timedOut = true;
    stop(entry);
  }, LOGIN_TIMEOUT_MS);
  entry.timer.unref();
  return snapshot(entry);
}

export function getAiOAuth(id: string): AiOAuthSession {
  return snapshot(requireEntry(id));
}

/** Answer omp's pending question (a pasted redirect URL or code, a domain, "yes"). */
export function answerAiOAuth(id: string, input: unknown): AiOAuthSession {
  const entry = requireEntry(id);
  if (typeof input !== "string") throw new HttpError(400, "input must be a string");
  const answer = input.trim();
  if (answer.length > MAX_INPUT_LENGTH) throw new HttpError(400, "The answer is too long");
  if (/[\r\n]/.test(answer)) throw new HttpError(400, "The answer must be a single line");
  if (entry.session.status !== "running" || !entry.child?.stdin?.writable) {
    throw new HttpError(409, "This sign-in has ended: start it again");
  }
  if (entry.session.prompt === null) throw new HttpError(409, "omp is not waiting for an answer right now");
  // The answer is never echoed into the output: it may be an authorization code.
  pushOutput(entry, entry.session.prompt);
  entry.partial = "";
  entry.session.prompt = null;
  entry.child.stdin.write(`${answer}\n`);
  return snapshot(entry);
}

export function cancelAiOAuth(id: string): AiOAuthSession {
  const entry = requireEntry(id);
  if (entry.session.status === "running") {
    entry.cancelled = true;
    stop(entry);
    finish(entry, "cancelled", null);
  }
  return snapshot(entry);
}
