import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, call, freshEnv, setupAdmin, sleep, teardown, tempDir, waitFor } from "./helpers";

import * as cancelRoute from "@/app/api/v1/terminal/cancel/route";
import * as executeRoute from "@/app/api/v1/terminal/execute/route";
import * as sessionRoute from "@/app/api/v1/terminal/session/route";
import * as streamRoute from "@/app/api/v1/terminal/stream/route";
import { resetTerminalSessionForTests } from "@/lib/server/terminal";
import type { TerminalBlock, TerminalSnapshot, TerminalStreamEvent } from "@/lib/terminal-types";

/** A subscriber of GET /terminal/stream: every data frame, with its arrival time. */
interface Stream {
  events: { at: number; event: TerminalStreamEvent }[];
  close(): Promise<void>;
}

async function openStream(): Promise<Stream> {
  const controller = new AbortController();
  const res = await call(streamRoute, "GET", "/terminal/stream", { signal: controller.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: Stream["events"] = [];
  const pump = (async () => {
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      buffer += value;
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        let named = false;
        const data: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) named = true;
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (!named && data.length) events.push({ at: Date.now(), event: JSON.parse(data.join("\n")) });
      }
    }
  })();
  return {
    events,
    async close() {
      await reader.cancel().catch(() => undefined);
      controller.abort();
      await pump;
    },
  };
}

/** Client-side view of a stream: what the UI would show after applying every event in order. */
function view(stream: Stream): { cwd: string; blocks: Map<string, TerminalBlock>; output: Record<string, string> } {
  let cwd = "";
  const blocks = new Map<string, TerminalBlock>();
  let output: Record<string, string> = {};
  for (const { event } of stream.events) {
    if (event.type === "snapshot") {
      cwd = event.snapshot.cwd;
      blocks.clear();
      for (const block of event.snapshot.blocks) blocks.set(block.id, block);
      output = { ...event.snapshot.output };
    } else if (event.type === "block") {
      cwd = event.cwd;
      blocks.set(event.block.id, event.block);
    } else {
      output[event.id] = (output[event.id] ?? "") + event.data;
    }
  }
  return { cwd, blocks, output };
}

/** Wait until the stream shows block `id` finished; returns it with its full output. */
async function waitDone(stream: Stream, id: string, timeout = 10_000) {
  const block = await waitFor(() => {
    const b = view(stream).blocks.get(id);
    return b?.status === "done" ? b : null;
  }, timeout);
  return { block, output: view(stream).output[id] ?? "" };
}

/** A fresh subscriber's first frame (like a browser opening /terminal). */
async function snapshot(): Promise<TerminalSnapshot> {
  const stream = await openStream();
  const first = await waitFor(() => stream.events[0]);
  await stream.close();
  expect(first.event.type).toBe("snapshot");
  return (first.event as Extract<TerminalStreamEvent, { type: "snapshot" }>).snapshot;
}

const pids = new Set<number>();

async function execute(command: string, cwd?: string): Promise<TerminalBlock> {
  const res = await api<TerminalBlock>(executeRoute, "POST", "/terminal/execute", { body: { command, cwd } });
  expect(res.status).toBe(201);
  if (res.body.pid) pids.add(res.body.pid);
  return res.body;
}

/** True once neither the pid nor its process group exists any more. */
function gone(pid: number): boolean {
  for (const target of [pid, -pid]) {
    try {
      process.kill(target, 0);
      return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
  }
  return true;
}

let workDir: string;
let termDir: string;

beforeAll(async () => {
  await freshEnv();
  await setupAdmin();
  workDir = tempDir("work");
  termDir = tempDir("terminal");
  resetTerminalSessionForTests({ dir: termDir });
});

afterAll(async () => {
  resetTerminalSessionForTests();
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await teardown();
});

describe("terminal session", () => {
  it("runs a command and streams its output", async () => {
    const stream = await openStream();
    const block = await execute("echo hello", workDir);
    expect(block).toMatchObject({ command: "echo hello", cwd: workDir, status: "running", exitCode: null });
    expect(typeof block.pid).toBe("number");
    const { block: done, output } = await waitDone(stream, block.id);
    await stream.close();
    expect(output).toBe("hello\n");
    expect(done).toMatchObject({ exitCode: 0, signal: null, cancelled: false, outputBytes: 6, endCwd: workDir });
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("merges stdout and stderr and reports the exit code", async () => {
    const stream = await openStream();
    const block = await execute("echo out; echo err >&2; exit 3", workDir);
    const { block: done, output } = await waitDone(stream, block.id);
    await stream.close();
    expect(output).toContain("out\n");
    expect(output).toContain("err\n");
    expect(done.exitCode).toBe(3);
  });

  it("keeps `cd` for the next command", async () => {
    const stream = await openStream();
    const first = await execute("cd /tmp", workDir);
    const { block } = await waitDone(stream, first.id);
    expect(realpathSync(block.endCwd!)).toBe(realpathSync("/tmp"));
    expect(realpathSync(view(stream).cwd)).toBe(realpathSync("/tmp"));
    const next = await execute("pwd");
    expect(realpathSync(next.cwd)).toBe(realpathSync("/tmp"));
    const { output } = await waitDone(stream, next.id);
    await stream.close();
    expect(realpathSync(output.trim())).toBe(realpathSync("/tmp"));
  });

  it("streams output as it is written", async () => {
    const stream = await openStream();
    const block = await execute("echo a; sleep 1; echo b", workDir);
    await waitDone(stream, block.id);
    await stream.close();
    const at = (text: string) =>
      stream.events.find(({ event }) => event.type === "output" && event.id === block.id && event.data.includes(text))!
        .at;
    expect(at("b") - at("a")).toBeGreaterThanOrEqual(700);
  });

  it("does not split multi-byte characters", async () => {
    const stream = await openStream();
    const block = await execute("printf '\\303'; sleep 0.4; printf '\\251\\n'", workDir);
    const { output } = await waitDone(stream, block.id);
    await stream.close();
    expect(output).toBe("é\n");
  });

  it("keeps running with nobody attached and replays it on the next visit", async () => {
    const block = await execute("sleep 1; echo later", workDir);
    await sleep(1_200);
    const snap = await waitFor(async () => {
      const s = await snapshot();
      return s.blocks.find((b) => b.id === block.id)?.status === "done" ? s : null;
    });
    expect(snap.blocks.find((b) => b.id === block.id)).toMatchObject({ exitCode: 0 });
    expect(snap.output[block.id]).toBe("later\n");
    expect(snap.skipped[block.id]).toBeUndefined();
  });

  it("recovers running commands after an app restart", async () => {
    const block = await execute("sleep 1; echo survived; exit 4", workDir);
    resetTerminalSessionForTests({ dir: termDir });
    await sleep(1_500);
    const snap = await waitFor(async () => {
      const s = await snapshot();
      return s.blocks.find((b) => b.id === block.id)?.status === "done" ? s : null;
    });
    const done = snap.blocks.find((b) => b.id === block.id)!;
    expect(done.exitCode).toBe(4);
    expect(done.error).toBeUndefined();
    expect(snap.output[block.id]).toBe("survived\n");
  });

  it("cancels a running command", async () => {
    const stream = await openStream();
    const block = await execute("sleep 30", workDir);
    const res = await api(cancelRoute, "POST", "/terminal/cancel", { body: { id: block.id } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const { block: done } = await waitDone(stream, block.id, 5_000);
    await stream.close();
    expect(done).toMatchObject({ cancelled: true, exitCode: null });
    await waitFor(() => gone(block.pid!), 3_000);
    // Cancelling a finished command is a no-op.
    expect((await api(cancelRoute, "POST", "/terminal/cancel", { body: { id: block.id } })).status).toBe(200);
  });

  it("clears finished blocks and keeps running ones", async () => {
    const stream = await openStream();
    const finished = await execute("echo bye", workDir);
    await waitDone(stream, finished.id);
    const running = await execute("sleep 30", workDir);
    expect(existsSync(path.join(termDir, `${finished.id}.log`))).toBe(true);

    const res = await api(sessionRoute, "DELETE", "/terminal/session");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    await waitFor(() => stream.events.at(-1)?.event.type === "snapshot");
    expect([...view(stream).blocks.keys()]).toEqual([running.id]);
    expect(existsSync(path.join(termDir, `${finished.id}.log`))).toBe(false);
    expect(existsSync(path.join(termDir, `${running.id}.log`))).toBe(true);

    await api(cancelRoute, "POST", "/terminal/cancel", { body: { id: running.id } });
    await waitDone(stream, running.id, 5_000);
    await stream.close();
  });

  it("validates requests", async () => {
    for (const command of ["", "   \n", undefined, 42]) {
      const res = await api(executeRoute, "POST", "/terminal/execute", { body: { command, cwd: workDir } });
      expect(res.status).toBe(400);
    }
    for (const cwd of ["relative/dir", path.join(workDir, "missing")]) {
      const res = await api(executeRoute, "POST", "/terminal/execute", { body: { command: "true", cwd } });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(`Directory not found: ${cwd}`);
    }
    const unknown = await api(cancelRoute, "POST", "/terminal/cancel", { body: { id: "nope" } });
    expect(unknown.status).toBe(404);
  });

  it("requires authentication", async () => {
    const calls = [
      api(streamRoute, "GET", "/terminal/stream", { token: null }),
      api(executeRoute, "POST", "/terminal/execute", { body: { command: "true" }, token: null }),
      api(cancelRoute, "POST", "/terminal/cancel", { body: { id: "x" }, token: null }),
      api(sessionRoute, "DELETE", "/terminal/session", { token: null }),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(401);
  });
});

describe("terminal limits", () => {
  beforeAll(() => {
    resetTerminalSessionForTests({ dir: tempDir("terminal-limits"), maxOutputBytes: 1_000, timeoutMs: 1_000 });
  });

  it("truncates and kills a command that writes too much", async () => {
    const stream = await openStream();
    const block = await execute("head -c 5000 /dev/zero | tr '\\0' x; sleep 30", workDir);
    const { block: done, output } = await waitDone(stream, block.id, 5_000);
    await stream.close();
    expect(done).toMatchObject({ truncated: true, outputBytes: 1_000, timedOut: false });
    expect(output).toBe("x".repeat(1_000));
  });

  it("kills a command after the timeout", async () => {
    const stream = await openStream();
    const block = await execute("sleep 30", workDir);
    const { block: done } = await waitDone(stream, block.id, 6_000);
    await stream.close();
    expect(done).toMatchObject({ timedOut: true, exitCode: null });
  });
});
