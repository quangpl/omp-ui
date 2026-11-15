// OmpRpcProcess over a fake RpcTransport (the seam remote cluster runs use): framing, response
// correlation, the dispatch gate's ordering, exit handling and the close() escalation.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OmpRpcProcess,
  killAllOmpProcesses,
  liveOmpPids,
  type RpcExitInfo,
  type RpcFrame,
  type RpcTransport,
  type RpcTransportHandlers,
} from "@/lib/agent/rpc";

class FakeTransport implements RpcTransport {
  readonly pid = undefined;
  stdinOpen = true;
  /** Raw stdin writes. */
  readonly written: string[] = [];
  /** end() and signal() calls, in order. */
  readonly calls: string[] = [];
  /** Decides the gate of each frame; null = dispatch at once. */
  gateFor: (frame: RpcFrame) => Promise<void> | null = () => null;
  private handlers: RpcTransportHandlers | null = null;

  write(data: string): boolean {
    if (!this.stdinOpen) return false;
    this.written.push(data);
    return true;
  }

  end(): void {
    this.stdinOpen = false;
    this.calls.push("end");
  }

  signal(signal: NodeJS.Signals): void {
    this.calls.push(signal);
  }

  setRef(): void {}

  start(handlers: RpcTransportHandlers): void {
    this.handlers = handlers;
  }

  gate(frame: RpcFrame): Promise<void> | null {
    return this.gateFor(frame);
  }

  /** omp writes one frame to stdout. */
  emit(frame: object): void {
    this.handlers!.stdout(`${JSON.stringify(frame)}\n`);
  }

  /** Raw stdout text, arbitrary chunk boundaries. */
  stdout(text: string): void {
    this.handlers!.stdout(text);
  }

  stdoutEnd(): void {
    this.handlers!.stdoutEnd();
  }

  stderr(text: string): void {
    this.handlers!.stderr(text);
  }

  exit(info: Partial<RpcExitInfo> = {}): void {
    this.handlers!.exit({ code: 0, signal: null, stderr: "", ...info });
  }

  /** Commands written to stdin, parsed. */
  commands(): { type: string; id?: string; [key: string]: unknown }[] {
    return this.written.map((line) => JSON.parse(line));
  }
}

const opened: { proc: OmpRpcProcess; transport: FakeTransport }[] = [];

function open(): { proc: OmpRpcProcess; transport: FakeTransport; frames: RpcFrame[] } {
  const transport = new FakeTransport();
  const proc = new OmpRpcProcess({ command: "omp", args: [], cwd: "/", autoConfirm: false, transport });
  const frames: RpcFrame[] = [];
  proc.on("frame", (frame) => frames.push(frame));
  opened.push({ proc, transport });
  return { proc, transport, frames };
}

/** Lets promise callbacks (gate settlement, response delivery) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  // Leave nothing in the process-wide registry.
  for (const { proc, transport } of opened.splice(0)) {
    if (!proc.exited) transport.exit();
  }
});

describe("OmpRpcProcess over an RpcTransport", () => {
  it("exposes the transport and spawns nothing", () => {
    const { proc, transport } = open();
    expect(proc.transport).toBe(transport);
    expect(proc.pid).toBeUndefined();
    expect(liveOmpPids().size).toBe(0);
  });

  it("becomes ready and correlates responses with their commands", async () => {
    const { proc, transport } = open();
    transport.emit({ type: "ready" });
    await proc.waitReady(1_000);

    const pending = proc.send({ type: "get_state" });
    const [command] = transport.commands();
    expect(command).toMatchObject({ type: "get_state" });
    expect(transport.written[0]!.endsWith("\n")).toBe(true);

    transport.emit({ type: "response", id: "unrelated", command: "get_state", success: true });
    transport.emit({ type: "response", id: command!.id, command: "get_state", success: true, data: { ok: 1 } });
    await expect(pending).resolves.toMatchObject({ success: true, data: { ok: 1 } });
  });

  it("reassembles frames split across stdout chunks", async () => {
    const { proc, transport, frames } = open();
    transport.stdout('{"type":"no');
    transport.stdout('tice","message":"hi"}\n{"type":"ready"}');
    transport.stdoutEnd();
    await proc.waitReady(1_000);
    expect(frames.map((f) => f.type)).toEqual(["notice", "ready"]);
  });

  it("holds agent_end and every later frame until its gate resolves, in order", async () => {
    const { proc, transport, frames } = open();
    transport.emit({ type: "ready" });
    await proc.waitReady(1_000);
    const flushed = Promise.withResolvers<void>();
    transport.gateFor = (frame) => (frame.type === "agent_end" ? flushed.promise : null);

    const pending = proc.send({ type: "get_last_assistant_text" });
    const id = transport.commands()[0]!.id;
    let answered = false;
    void pending.then(() => (answered = true));

    transport.emit({ type: "message_end" });
    transport.emit({ type: "agent_end" });
    transport.emit({ type: "response", id, command: "get_last_assistant_text", success: true });
    transport.emit({ type: "notice", message: "after" });
    await settle();
    expect(frames.map((f) => f.type)).toEqual(["ready", "message_end"]);
    expect(answered).toBe(false);

    flushed.resolve();
    await settle();
    expect(frames.map((f) => f.type)).toEqual(["ready", "message_end", "agent_end", "response", "notice"]);
    expect(answered).toBe(true);
  });

  it("dispatches a frame whose gate rejects, and gates later frames again", async () => {
    const { transport, frames } = open();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const gates = [first.promise, second.promise];
    transport.gateFor = (frame) => (frame.type === "host_tool_call" ? (gates.shift() ?? null) : null);

    transport.emit({ type: "host_tool_call", id: "a" });
    transport.emit({ type: "notice", message: "1" });
    transport.emit({ type: "host_tool_call", id: "b" });
    transport.emit({ type: "notice", message: "2" });
    await settle();
    expect(frames).toEqual([]);

    first.reject(new Error("flush failed"));
    await settle();
    expect(frames.map((f) => f.id ?? f.message)).toEqual(["a", "1"]);

    second.resolve();
    await settle();
    expect(frames.map((f) => f.id ?? f.message)).toEqual(["a", "1", "b", "2"]);
  });

  it("reports the exit only after the held frames were dispatched", async () => {
    const { proc, transport } = open();
    const flushed = Promise.withResolvers<void>();
    transport.gateFor = (frame) => (frame.type === "agent_end" ? flushed.promise : null);
    const seen: string[] = [];
    proc.on("frame", (frame) => seen.push(frame.type));
    proc.on("exit", () => seen.push("exit"));

    transport.emit({ type: "agent_end" });
    transport.exit({ code: 0 });
    await settle();
    expect(seen).toEqual([]);
    expect(proc.exited).toBe(false);

    flushed.resolve();
    await settle();
    expect(seen).toEqual(["agent_end", "exit"]);
    expect(proc.exited).toBe(true);
  });

  it("rejects pending sends on exit and keeps the stderr tail", async () => {
    const { proc, transport } = open();
    const pending = proc.send({ type: "get_state" });
    transport.stderr("boom\n");
    transport.exit({ code: 1 });

    await expect(pending).rejects.toThrow(/omp process exited/);
    await expect(proc.waitExit()).resolves.toMatchObject({ code: 1, stderr: "boom\n" });
    await expect(proc.send({ type: "get_state" })).rejects.toThrow(/has exited/);
    await expect(proc.waitReady(1_000)).rejects.toThrow();
  });

  it("close() ends stdin, then escalates to SIGTERM and SIGKILL", async () => {
    vi.useFakeTimers();
    const { proc, transport } = open();
    const closing = proc.close();
    expect(transport.calls).toEqual(["end"]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(transport.calls).toEqual(["end", "SIGTERM"]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(transport.calls).toEqual(["end", "SIGTERM", "SIGKILL"]);

    transport.exit({ code: null, signal: "SIGKILL" });
    await closing;
    expect(proc.exited).toBe(true);
  });

  it("close() sends no signal when omp exits after stdin ends", async () => {
    vi.useFakeTimers();
    const { proc, transport } = open();
    const closing = proc.close();
    await vi.advanceTimersByTimeAsync(1_000);
    transport.exit({ code: 0 });
    await closing;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.calls).toEqual(["end"]);
  });

  it("kill() and killAllOmpProcesses() signal through the transport", () => {
    const { proc, transport } = open();
    proc.kill("SIGTERM");
    killAllOmpProcesses("SIGINT");
    expect(transport.calls).toEqual(["SIGTERM", "SIGINT"]);

    transport.exit({ code: null, signal: "SIGINT" });
    proc.kill();
    expect(transport.calls).toEqual(["SIGTERM", "SIGINT"]);
  });
});
