import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  OmpRpcProcess,
  RpcCommandError,
  describeExit,
  type OmpRpcOptions,
  type RpcFrame,
} from "@/lib/agent/rpc";

const FAKE_OMP = fileURLToPath(new URL("../fixtures/fake-omp.mjs", import.meta.url));

interface LogEntry {
  pid: number;
  kind: string;
  argv?: string[];
  cwd?: string;
  command?: { type: string; id?: string; [key: string]: unknown };
  response?: { type: string; id: string; confirmed?: boolean; cancelled?: boolean };
  message?: string;
}

let dir: string;
let logFile: string;
const procs: OmpRpcProcess[] = [];

function readLog(): LogEntry[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

function commandsOf(type: string): NonNullable<LogEntry["command"]>[] {
  return readLog()
    .filter((e) => e.kind === "command" && e.command?.type === type)
    .map((e) => e.command!);
}

function spawnFake(
  options: Partial<OmpRpcOptions> & { fakeEnv?: Record<string, string> } = {},
): OmpRpcProcess {
  const { fakeEnv, ...rest } = options;
  const proc = new OmpRpcProcess({
    command: FAKE_OMP,
    args: ["--mode", "rpc"],
    cwd: dir,
    autoConfirm: true,
    env: {
      ...process.env,
      FAKE_OMP_LOG: logFile,
      FAKE_OMP_SESSION_DIR: dir,
      FAKE_OMP_SCENARIO: "success",
      ...fakeEnv,
    },
    ...rest,
  });
  procs.push(proc);
  return proc;
}

/** Resolves with the first frame matching `predicate` (frames are observed from now on). */
function nextFrame(proc: OmpRpcProcess, predicate: (frame: RpcFrame) => boolean): Promise<RpcFrame> {
  const { promise, resolve, reject } = Promise.withResolvers<RpcFrame>();
  const onFrame = (frame: RpcFrame) => {
    if (!predicate(frame)) return;
    proc.off("frame", onFrame);
    proc.off("exit", onExit);
    resolve(frame);
  };
  const onExit = () => {
    proc.off("frame", onFrame);
    reject(new Error("process exited before the expected frame"));
  };
  proc.on("frame", onFrame);
  proc.on("exit", onExit);
  return promise;
}

/** Reads one field of a response's `data` object. */
function dataField(data: unknown, key: string): unknown {
  if (typeof data !== "object" || data === null || !(key in data)) return undefined;
  return Reflect.get(data, key);
}

beforeAll(() => {
  // Spawned directly as an executable; make sure the bit survives checkouts.
  chmodSync(FAKE_OMP, 0o755);
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "omp-ui-rpc-test-"));
  logFile = path.join(dir, "fake-omp.log");
});

afterEach(async () => {
  for (const proc of procs.splice(0)) {
    proc.kill("SIGKILL");
    await proc.waitExit();
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("OmpRpcProcess startup", () => {
  it("resolves waitReady after ready and negotiates protocol v2 when supported", async () => {
    const proc = spawnFake();
    await proc.waitReady(10_000);

    expect(proc.pid).toBeTypeOf("number");
    expect(proc.exited).toBe(false);
    const negotiations = commandsOf("negotiate_protocol");
    expect(negotiations).toHaveLength(1);
    expect(negotiations[0]).toMatchObject({ protocolVersion: 2 });
    const argv = readLog().find((e) => e.kind === "argv");
    expect(argv?.argv).toEqual(["--mode", "rpc"]);
  });

  it("stays on protocol v1 without negotiating when v2 is not advertised", async () => {
    const proc = spawnFake({ fakeEnv: { FAKE_OMP_PROTOCOLS: "1" } });
    await proc.waitReady(10_000);

    const state = await proc.send({ type: "get_state" });
    expect(state.success).toBe(true);
    expect(commandsOf("negotiate_protocol")).toHaveLength(0);
  });

  it("rejects waitReady when ready never arrives in time", async () => {
    const proc = spawnFake({ fakeEnv: { FAKE_OMP_STARTUP: "silent" } });
    await expect(proc.waitReady(200)).rejects.toThrow(/did not become ready/);
    expect(proc.exited).toBe(false);
  });

  it("rejects waitReady when the process exits before it is ready", async () => {
    const proc = spawnFake({ fakeEnv: { FAKE_OMP_STARTUP: "exit" } });
    await expect(proc.waitReady(10_000)).rejects.toThrow(/exited before it was ready.*code 2/);
    const info = await proc.waitExit();
    expect(info.code).toBe(2);
    expect(info.stderr).toContain("refusing to start");
  });

  it("rejects with ENOENT when the binary does not exist", async () => {
    const missing = path.join(dir, "no-such-omp");
    const proc = spawnFake({ command: missing });

    const error = await proc.waitReady(10_000).then(
      () => null,
      (err: NodeJS.ErrnoException) => err,
    );
    expect(error).not.toBeNull();
    expect(error?.code).toBe("ENOENT");

    const info = await proc.waitExit();
    expect(info.error?.code).toBe("ENOENT");
    expect(info.code).toBeNull();
    expect(proc.exited).toBe(true);
    expect(describeExit(info)).toContain("ENOENT");
    await expect(proc.send({ type: "get_state" })).rejects.toThrow(/has exited/);
  });
});

describe("OmpRpcProcess commands", () => {
  it("returns the response for a command, including get_state data", async () => {
    const proc = spawnFake();
    await proc.waitReady(10_000);

    const response = await proc.send({ type: "get_state" });
    expect(response).toMatchObject({ type: "response", command: "get_state", success: true });
    const sessionFile = dataField(response.data, "sessionFile");
    expect(dataField(response.data, "isStreaming")).toBe(false);
    expect(typeof sessionFile).toBe("string");
    expect(path.dirname(path.dirname(String(sessionFile)))).toBe(dir);
    expect(existsSync(String(sessionFile))).toBe(true);
  });

  it("correlates out-of-order responses by id", async () => {
    const proc = spawnFake();
    await proc.waitReady(10_000);

    const order: string[] = [];
    const slow = proc.send({ type: "fake_echo", value: "slow", delayMs: 150 }).then((r) => {
      order.push("slow");
      return r;
    });
    const fast = proc.send({ type: "fake_echo", value: "fast" }).then((r) => {
      order.push("fast");
      return r;
    });

    const [slowResponse, fastResponse] = await Promise.all([slow, fast]);
    expect(order).toEqual(["fast", "slow"]);
    expect(slowResponse.data).toEqual({ value: "slow" });
    expect(fastResponse.data).toEqual({ value: "fast" });
    expect(slowResponse.id).not.toBe(fastResponse.id);
  });

  it("keeps a caller-supplied id", async () => {
    const proc = spawnFake();
    await proc.waitReady(10_000);

    const response = await proc.send({ type: "fake_echo", id: "my-id-1", value: 1 });
    expect(response.id).toBe("my-id-1");
    expect(commandsOf("fake_echo")[0]?.id).toBe("my-id-1");
  });

  it("rejects with RpcCommandError on a failure response and stays usable", async () => {
    const proc = spawnFake();
    await proc.waitReady(10_000);

    const error = await proc.send({ type: "set_model", provider: "x", modelId: "y" }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(RpcCommandError);
    expect(error).toMatchObject({
      message: "Unknown command: set_model",
      command: "set_model",
      code: "unknown_command",
    });

    const after = await proc.send({ type: "fake_echo", value: "still alive" });
    expect(after.data).toEqual({ value: "still alive" });
  });

  it("rejects a command that is not answered within its timeout", async () => {
    const proc = spawnFake();
    await proc.waitReady(10_000);

    await expect(
      proc.send({ type: "fake_echo", value: 1, delayMs: 5_000 }, { timeoutMs: 100 }),
    ).rejects.toThrow(/did not answer "fake_echo"/);
  });

  it("reassembles rpc_chunk sequences into one logical frame", async () => {
    const proc = spawnFake();
    await proc.waitReady(10_000);

    const response = await proc.send({ type: "fake_chunked", size: 20_000 });
    expect(dataField(response.data, "payload")).toBe("x".repeat(20_000));
  });

  it("reports a broken chunk sequence as a protocol error without dropping later frames", async () => {
    const proc = spawnFake();
    await proc.waitReady(10_000);

    const errors: string[] = [];
    proc.on("protocolError", (message) => errors.push(message));
    const response = await proc.send({ type: "fake_bad_chunk" });

    expect(response.data).toEqual({ ok: true });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/bad-1/);
  });

  it("streams agent frames for a prompt", async () => {
    const proc = spawnFake();
    await proc.waitReady(10_000);

    const frames: RpcFrame[] = [];
    proc.on("frame", (frame) => frames.push(frame));
    const end = nextFrame(proc, (f) => f.type === "agent_end");
    const response = await proc.send({ type: "prompt", message: "do it" });
    expect(response.data).toEqual({ agentInvoked: true });
    await end;

    const types = frames.map((f) => f.type);
    expect(types).toContain("agent_start");
    expect(types).toContain("message_update");
    expect(types).toContain("tool_execution_start");
    expect(types.indexOf("message_end")).toBeLessThan(types.indexOf("agent_end"));
    const last = await proc.send({ type: "get_last_assistant_text" });
    expect(dataField(last.data, "text")).toMatch(/^Fake summary/);
  });
});

describe("OmpRpcProcess extension UI requests", () => {
  it("confirms dialogs when autoConfirm is on and cancels other value dialogs", async () => {
    const proc = spawnFake({ autoConfirm: true });
    await proc.waitReady(10_000);

    const recorded = nextFrame(proc, (f) => f.type === "fake_ui_responses");
    await proc.send({ type: "prompt", message: "[fake:confirm] go" });
    const frame = await recorded;

    // The fire-and-forget notify request gets no reply, so only two responses arrive.
    expect(frame.responses).toEqual([
      { type: "extension_ui_response", id: "ui-confirm-1", confirmed: true },
      { type: "extension_ui_response", id: "ui-select-1", cancelled: true },
    ]);
    const logged = readLog().filter((e) => e.kind === "ui_response");
    expect(logged.map((e) => e.response?.id)).toEqual(["ui-confirm-1", "ui-select-1"]);
  });

  it("cancels confirm dialogs when autoConfirm is off", async () => {
    const proc = spawnFake({ autoConfirm: false });
    await proc.waitReady(10_000);

    const recorded = nextFrame(proc, (f) => f.type === "fake_ui_responses");
    await proc.send({ type: "prompt", message: "[fake:confirm] go" });
    const frame = await recorded;

    expect(frame.responses).toEqual([
      { type: "extension_ui_response", id: "ui-confirm-1", cancelled: true },
      { type: "extension_ui_response", id: "ui-select-1", cancelled: true },
    ]);
  });
});

describe("OmpRpcProcess exit handling", () => {
  it("rejects every pending command when the process exits and reports stderr", async () => {
    const proc = spawnFake();
    await proc.waitReady(10_000);

    const pendingEcho = proc.send({ type: "fake_echo", value: 1, delayMs: 10_000 }, { timeoutMs: 0 });
    const crash = proc.send({ type: "fake_crash" });
    const exitEvent = Promise.withResolvers<unknown>();
    proc.once("exit", exitEvent.resolve);

    await expect(crash).rejects.toThrow(/omp process exited \(code 3: fake omp: fatal crash/);
    await expect(pendingEcho).rejects.toThrow(/omp process exited/);

    const info = await proc.waitExit();
    expect(info).toMatchObject({ code: 3, signal: null });
    expect(info.stderr).toContain("fake omp: fatal crash");
    expect(proc.stderr).toContain("fake omp: fatal crash");
    expect(await exitEvent.promise).toBe(info);
    expect(proc.exited).toBe(true);
    await expect(proc.send({ type: "get_state" })).rejects.toThrow(/has exited \(code 3/);
  });

  it("close() ends stdin and the process exits cleanly", async () => {
    const proc = spawnFake();
    await proc.waitReady(10_000);

    await proc.close();
    const info = await proc.waitExit();
    expect(info).toMatchObject({ code: 0, signal: null });
    expect(readLog().some((e) => e.kind === "stdin_closed")).toBe(true);
  });

  it("kill() terminates a busy process", async () => {
    const proc = spawnFake();
    await proc.waitReady(10_000);
    await proc.send({ type: "prompt", message: "[fake:slow] wait" });

    proc.kill("SIGTERM");
    const info = await proc.waitExit();
    expect(info.signal).toBe("SIGTERM");
    expect(describeExit(info)).toContain("signal SIGTERM");
  });
});
