// Warm `omp --mode rpc` workers for the short helper agents (advisor, summaries, assistants).
// Starting omp costs seconds; a worker that finished a call cleanly starts a fresh session
// (`new_session`) and waits, idle, for the next call with the same arguments. Workers spawn
// lazily, idle ones are capped and closed after a while, and every worker is an OmpRpcProcess, so
// rpc.ts's shutdown hooks kill them with the server.
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { OmpRpcProcess } from "@/lib/agent/rpc";

/** An idle worker is closed after this long without a call. */
const IDLE_TIMEOUT_MS = 5 * 60_000;
/** `new_session` must answer within this long, else the worker is closed. */
const RESET_TIMEOUT_MS = 10_000;
/** Idle workers kept warm across all argument sets: half the cores, between 2 and 8. */
const MAX_IDLE = Math.max(2, Math.min(8, Math.floor(availableParallelism() / 2)));

export interface WorkerSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Keep the worker warm for later calls; false for one-off arguments (e.g. a temp folder). */
  reusable: boolean;
}

/** A worker lent to one call. Call exactly one of release/discard when done. */
export interface WorkerLease {
  readonly proc: OmpRpcProcess;
  /** The call ended cleanly: reset the session and keep the worker warm (or close it). */
  release(): void;
  /** The call failed, timed out or was cancelled: kill the worker. */
  discard(): void;
}

interface IdleWorker {
  key: string;
  proc: OmpRpcProcess;
  timer: NodeJS.Timeout;
  onExit: () => void;
}

const g = globalThis as unknown as { __ompUiRpcPool?: IdleWorker[] };

function idleWorkers(): IdleWorker[] {
  return (g.__ompUiRpcPool ??= []);
}

/** An idle worker started with the same arguments and environment, else a new one (not ready yet: `waitReady`). */
export function acquireWorker(spec: WorkerSpec): WorkerLease {
  const env = createHash("sha1").update(JSON.stringify(Object.entries(spec.env))).digest("hex");
  const key = JSON.stringify([spec.command, spec.cwd, spec.args, env]);
  if (spec.reusable) {
    const idle = idleWorkers();
    // Most recently used first: it is the least likely to be closed soon.
    for (let i = idle.length - 1; i >= 0; i--) {
      const worker = idle[i]!;
      if (worker.key !== key) continue;
      unpark(worker);
      if (!worker.proc.exited) return lease(worker.proc, key, true);
    }
  }
  const proc = new OmpRpcProcess({ command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env, autoConfirm: false });
  return lease(proc, key, spec.reusable);
}

function lease(proc: OmpRpcProcess, key: string, reusable: boolean): WorkerLease {
  let returned = false;
  return {
    proc,
    release() {
      if (returned) return;
      returned = true;
      if (reusable && !proc.exited) void recycle(proc, key);
      else void proc.close();
    },
    discard() {
      if (returned) return;
      returned = true;
      proc.kill("SIGTERM");
      void proc.close();
    },
  };
}

/** Fresh session, then park the worker as idle; any failure closes it instead. */
async function recycle(proc: OmpRpcProcess, key: string): Promise<void> {
  try {
    const response = await proc.send({ type: "new_session" }, { timeoutMs: RESET_TIMEOUT_MS });
    const data = response.data;
    if (typeof data === "object" && data !== null && "cancelled" in data && data.cancelled === true) {
      throw new Error("new_session was cancelled");
    }
  } catch {
    proc.kill("SIGTERM");
    void proc.close();
    return;
  }
  if (proc.exited) return;
  const idle = idleWorkers();
  while (idle.length >= MAX_IDLE) {
    const oldest = idle[0]!;
    unpark(oldest);
    void oldest.proc.close();
  }
  const worker: IdleWorker = {
    key,
    proc,
    timer: setTimeout(() => {
      unpark(worker);
      void proc.close();
    }, IDLE_TIMEOUT_MS),
    onExit: () => unpark(worker),
  };
  worker.timer.unref();
  proc.once("exit", worker.onExit);
  proc.setRef(false);
  idle.push(worker);
}

/** Take the worker out of the idle list (no-op when it is not there). */
function unpark(worker: IdleWorker): void {
  const idle = idleWorkers();
  const index = idle.indexOf(worker);
  if (index !== -1) idle.splice(index, 1);
  clearTimeout(worker.timer);
  worker.proc.off("exit", worker.onExit);
  worker.proc.setRef(true);
}

/** Pids of the warm workers waiting for a call. */
export function idleWorkerPids(): number[] {
  return idleWorkers().flatMap((w) => (w.proc.pid === undefined || w.proc.exited ? [] : [w.proc.pid]));
}

/** Close every idle worker (they respawn on demand); returns how many were closed. */
export function closeIdleWorkers(): number {
  const idle = [...idleWorkers()];
  for (const worker of idle) {
    unpark(worker);
    void worker.proc.close();
  }
  return idle.length;
}
