import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { buildPrompt, buildSteerMessage } from "@/lib/agent/prompt";
import { OmpRpcProcess, describeExit, type RpcExitInfo, type RpcFrame } from "@/lib/agent/rpc";
import {
  describeTaskCall,
  isTerminalSubagent,
  lifecyclePatch,
  mergeSubagent,
  progressPatch,
  taskToolPatches,
  type SubagentPatch,
} from "@/lib/agent/subagents";
import type { AgentManager } from "@/lib/agent/types";
import { childEnv } from "@/lib/child-env";
import { getRepo } from "@/lib/db";
import type { Repository, UpdateTaskInput } from "@/lib/db/types";
import { publish } from "@/lib/events";
import { getAppSettings } from "@/lib/settings";
import type { AppSettings, Comment, RunEventKind, SubagentSnapshot, Task, TaskStatus } from "@/lib/types";

const READY_TIMEOUT_MS = 60_000;
const ABORT_TIMEOUT_MS = 5_000;
const SUMMARY_TIMEOUT_MS = 15_000;
const PUMP_RETRY_MS = 5_000;
const MAX_EVENT_TEXT = 50_000;
const MAX_THINKING_TEXT = 2_000;
const MAX_TOOL_TEXT = 300;
const MAX_TOOL_ERROR_TEXT = 1_000;
/** Live `run.delta` events: at most one per run+kind per window (leading + trailing). */
const DELTA_THROTTLE_MS = 120;
const MAX_THINKING_DELTA = 4_000;
/** Live `run.agent` progress: at most one per subagent per window (status changes are persisted). */
const SUBAGENT_LIVE_THROTTLE_MS = 300;

type DeltaKind = "text" | "thinking";

/** A subagent of the run: its merged state, and what was last persisted / published live. */
interface TrackedSubagent {
  snapshot: SubagentSnapshot;
  persisted: string;
  published: string;
  publishedAt: number;
}

/** Streaming accumulator for one kind of content of the assistant message in progress. */
interface DeltaStream {
  /** Accumulated text per content block index. */
  blocks: Map<number, string>;
  lastSentAt: number;
  lastSentText: string;
  /** Pending trailing publish. */
  timer: NodeJS.Timeout | undefined;
}

/** In-memory state of one task's run, from dequeue until it is released. */
interface ActiveRun {
  taskId: string;
  boardId: string;
  ompPath: string;
  runId: string | null;
  promptId: string;
  proc: OmpRpcProcess | null;
  /** Feedback comments this run addresses (prompt set + steered); resolved on success. */
  feedbackIds: Set<string>;
  promptSent: boolean;
  /** Completed, failed, stopped or deleted: frames from here on are ignored. */
  finished: boolean;
  /** stop() is shutting the process down itself; release() must not close it again. */
  closing: boolean;
  /** Feedback arrived that this run could not take; start a new run once it is released. */
  restartAfter: boolean;
  /** Streaming text of the assistant message in progress. */
  currentText: string;
  /** Live (unpersisted) accumulators behind `run.delta` events. */
  deltas: Record<DeltaKind, DeltaStream>;
  /** Text of the last completed assistant message that had any. */
  lastText: string;
  lastStopReason: string | null;
  lastError: string | null;
  /** Subagents the run delegated to, by id. */
  subagents: Map<string, TrackedSubagent>;
  /** Serializes startup, frame handling and teardown so persistence stays ordered. */
  chain: Promise<void>;
}

type Json = Record<string, unknown>;

class OmpAgentManager implements AgentManager {
  /** start() calls between their guard and the "queued" write. */
  private readonly claiming = new Set<string>();
  private readonly queue: string[] = [];
  private readonly active = new Map<string, ActiveRun>();
  private pumping = false;
  private pumpAgain = false;
  private pumpRetry: NodeJS.Timeout | undefined;

  constructor(private readonly repo: Repository) {}

  stats(): { running: string[]; queued: string[] } {
    return { running: [...this.active.keys()], queued: [...this.claiming, ...this.queue] };
  }

  async start(taskId: string): Promise<Task> {
    if (this.isTracked(taskId)) {
      const task = await this.repo.getTask(taskId);
      if (!task) throw new Error("Task not found");
      return task;
    }
    this.claiming.add(taskId);
    let task: Task | null;
    try {
      const current = await this.repo.getTask(taskId);
      if (!current) throw new Error("Task not found");
      const patch: UpdateTaskInput = { agentState: "queued", agentError: null };
      if (current.status !== "in_progress") {
        patch.status = "in_progress";
        patch.position = await this.topPosition(current.boardId, "in_progress", taskId);
      }
      task = await this.repo.updateTask(taskId, patch);
      if (!task) throw new Error("Task not found");
    } catch (err) {
      this.claiming.delete(taskId);
      throw err;
    }
    if (!this.claiming.delete(taskId)) {
      // stop() or onTaskDeleted() ran while this start was being queued.
      const idle = await this.repo.updateTask(taskId, { agentState: "idle" });
      if (idle) publish({ type: "task.updated", task: idle });
      return idle ?? task;
    }
    this.queue.push(taskId);
    publish({ type: "task.updated", task });
    void this.pump();
    return task;
  }

  async stop(taskId: string): Promise<Task | null> {
    const wasClaiming = this.claiming.delete(taskId);
    if (this.removeFromQueue(taskId) || wasClaiming) return this.setIdle(taskId);

    const run = this.active.get(taskId);
    if (run && !run.finished) {
      run.finished = true;
      run.closing = true;
      void this.shutdown(run);
      const { promise, resolve } = Promise.withResolvers<Task | null>();
      // Runs after any in-flight startup step has unwound, so it sees the final runId.
      this.enqueue(run, async () => {
        let task: Task | null = null;
        try {
          if (run.runId) {
            const updated = await this.repo.updateRun(run.runId, {
              status: "aborted",
              error: "Stopped by user",
              endedAt: nowIso(),
            });
            if (updated) publish({ type: "run.updated", run: updated, boardId: run.boardId });
            await this.settleSubagents(run);
            await this.event(run, "status", "Stopped by user");
          }
          task = await this.setIdle(taskId);
        } catch (err) {
          console.error(`[agent] failed to record stop of task ${taskId}:`, err);
        } finally {
          this.release(run);
          resolve(task);
        }
      });
      return promise;
    }
    if (run) {
      // Already completing; its own teardown sets the final state.
      return this.repo.getTask(taskId);
    }

    const task = await this.repo.getTask(taskId);
    if (task && (task.agentState !== "idle" || task.agentError !== null)) {
      return this.setIdle(taskId);
    }
    return task;
  }

  async onTaskMoved(task: Task, previousStatus: TaskStatus): Promise<void> {
    try {
      if (task.status === previousStatus) return;
      const busy = this.isTracked(task.id);
      if (task.status === "in_progress") {
        if (busy) return;
        const board = await this.repo.getBoard(task.boardId);
        if (board?.autoRun) await this.start(task.id);
        return;
      }
      if (busy) await this.stop(task.id);
    } catch (err) {
      await this.recordTaskError(task.id, err);
    }
  }

  async onComment(task: Task, comment: Comment): Promise<void> {
    try {
      if (comment.author !== "user" || comment.resolved) return;
      const run = this.active.get(task.id);
      if (run && !run.finished) {
        this.enqueue(run, () => this.steer(run, comment));
        return;
      }
      if (run) {
        // The run is wrapping up; pick the feedback up in a fresh run afterwards.
        run.restartAfter = true;
        return;
      }
      // Queued runs build their prompt from all unresolved feedback when they start.
      if (this.claiming.has(task.id) || this.queue.includes(task.id)) return;
      if (task.status === "todo") return;
      await this.start(task.id);
    } catch (err) {
      await this.recordTaskError(task.id, err);
    }
  }

  async onTaskDeleted(taskId: string): Promise<void> {
    this.claiming.delete(taskId);
    this.removeFromQueue(taskId);
    const run = this.active.get(taskId);
    if (!run) return;
    run.finished = true;
    run.restartAfter = false;
    run.closing = true;
    this.active.delete(taskId);
    if (run.proc) terminate(run.proc);
    void this.pump();
  }

  // --- Queue -----------------------------------------------------------------------------

  private isTracked(taskId: string): boolean {
    return this.claiming.has(taskId) || this.queue.includes(taskId) || this.active.has(taskId);
  }

  private removeFromQueue(taskId: string): boolean {
    const index = this.queue.indexOf(taskId);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    return true;
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        if (this.queue.length === 0) break;
        // Re-read every time a slot frees so settings changes apply without a restart.
        const settings = await getAppSettings(this.repo);
        while (this.queue.length > 0 && this.active.size < settings.maxConcurrentAgents) {
          const taskId = this.queue.shift();
          if (taskId !== undefined) this.launch(taskId, settings);
        }
      } while (this.pumpAgain);
    } catch (err) {
      console.error("[agent] failed to schedule queued runs:", err);
      clearTimeout(this.pumpRetry);
      this.pumpRetry = setTimeout(() => void this.pump(), PUMP_RETRY_MS);
    } finally {
      this.pumping = false;
    }
  }

  private launch(taskId: string, settings: AppSettings): void {
    const run: ActiveRun = {
      taskId,
      boardId: "",
      ompPath: settings.ompPath,
      runId: null,
      promptId: "",
      proc: null,
      feedbackIds: new Set(),
      promptSent: false,
      finished: false,
      closing: false,
      restartAfter: false,
      currentText: "",
      deltas: { text: newDeltaStream(), thinking: newDeltaStream() },
      lastText: "",
      lastStopReason: null,
      lastError: null,
      subagents: new Map(),
      chain: Promise.resolve(),
    };
    this.active.set(taskId, run);
    this.enqueue(run, () => this.startRun(run, settings));
  }

  private enqueue(run: ActiveRun, step: () => Promise<void>): void {
    run.chain = run.chain.then(step).catch(async (err: unknown) => {
      // After stop/delete the process is torn down on purpose; its rejections are expected.
      if (run.finished) return;
      await this.fail(run, errorMessage(err, run.ompPath));
    });
  }

  /** Drop the run from the active set, close its process, and refill the free slot. */
  private release(run: ActiveRun): void {
    run.finished = true;
    this.resetDeltas(run);
    if (this.active.get(run.taskId) === run) this.active.delete(run.taskId);
    if (run.proc && !run.closing) {
      run.closing = true;
      void run.proc.close();
    }
    if (run.restartAfter) {
      run.restartAfter = false;
      void this.restart(run.taskId);
    }
    void this.pump();
  }

  private async restart(taskId: string): Promise<void> {
    try {
      const task = await this.repo.getTask(taskId);
      if (task && task.status !== "todo") await this.start(taskId);
    } catch (err) {
      await this.recordTaskError(taskId, err);
    }
  }

  /** Abort the agent gracefully if it is working, then close the process. */
  private async shutdown(run: ActiveRun): Promise<void> {
    const proc = run.proc;
    if (!proc) return;
    try {
      if (run.promptSent && !proc.exited) {
        await proc.send({ type: "abort" }, { timeoutMs: ABORT_TIMEOUT_MS }).catch(() => undefined);
        await proc.close();
      } else {
        terminate(proc);
      }
    } catch (err) {
      console.error(`[agent] failed to shut down omp for task ${run.taskId}:`, err);
    }
  }

  // --- Run lifecycle ---------------------------------------------------------------------

  private async startRun(run: ActiveRun, settings: AppSettings): Promise<void> {
    const repo = this.repo;
    const task = await repo.getTask(run.taskId);
    const board = task ? await repo.getBoard(task.boardId) : null;
    if (!task || !board) {
      // Deleted while queued.
      this.release(run);
      return;
    }
    run.boardId = task.boardId;
    if (run.finished) return;

    const feedback = (await repo.listComments(task.id)).filter(
      (c) => c.author === "user" && !c.resolved,
    );
    const resumeFile = task.sessionFile && existsSync(task.sessionFile) ? task.sessionFile : null;
    const folders = await Promise.all(
      (board.extraFolders ?? []).map(async (folder) => ({ folder, ok: await isDirectory(folder) })),
    );
    const extraFolders = folders.filter((f) => f.ok).map((f) => f.folder);
    const missingFolders = folders.filter((f) => !f.ok).map((f) => f.folder);
    // The prompt lists only folders the agent can actually reach.
    const prompt = buildPrompt(task, { ...board, extraFolders }, feedback, resumeFile !== null);
    const created = await repo.createRun({ taskId: task.id, prompt });
    run.runId = created.id;
    run.promptId = `prompt-${created.id}`;
    for (const c of feedback) run.feedbackIds.add(c.id);
    publish({ type: "run.updated", run: created, boardId: run.boardId });
    if (run.finished) return;

    const running = await repo.updateTask(task.id, {
      agentState: "running",
      agentError: null,
      lastRunId: created.id,
    });
    if (running) publish({ type: "task.updated", task: running });
    if (run.finished) return;

    if (!(await isDirectory(board.workdir))) {
      throw new Error(`Board directory not found: ${board.workdir}`);
    }

    const model = board.model?.trim() || settings.defaultModel;
    const args = [
      "--mode",
      "rpc",
      "--cwd",
      board.workdir,
      "--no-title",
      "--approval-mode",
      settings.approvalMode,
    ];
    for (const folder of extraFolders) args.push("--add-dir", folder);
    if (model) args.push("--model", model);
    if (resumeFile) args.push("--resume", resumeFile);
    const extra = process.env.OMP_EXTRA_ARGS?.trim();
    if (extra) args.push(...extra.split(/\s+/));

    await this.event(
      run,
      "status",
      [
        resumeFile ? "Resuming agent session" : "Starting agent",
        `in ${board.workdir}`,
        model ? `(model ${model})` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    if (run.finished) return;
    for (const folder of missingFolders) {
      await this.event(run, "status", `Skipped missing folder ${folder}`);
    }
    if (run.finished) return;

    const proc = new OmpRpcProcess({
      command: settings.ompPath,
      args,
      cwd: board.workdir,
      env: childEnv(),
      autoConfirm: settings.approvalMode === "yolo",
    });
    run.proc = proc;
    proc.on("frame", (frame) => this.enqueue(run, () => this.onFrame(run, frame)));
    proc.on("protocolError", (message) =>
      this.enqueue(run, () => this.onTransportError(run, message, undefined)),
    );
    proc.on("exit", (info) => this.enqueue(run, () => this.onExit(run, info)));

    await proc.waitReady(READY_TIMEOUT_MS);
    if (run.finished) return;

    try {
      const state = await proc.send({ type: "get_state" });
      const sessionFile = isObject(state.data) ? asString(state.data.sessionFile) : undefined;
      if (sessionFile && sessionFile !== task.sessionFile) {
        const updated = await repo.updateTask(task.id, { sessionFile });
        if (updated) publish({ type: "task.updated", task: updated });
      }
    } catch (err) {
      if (run.finished) return;
      await this.event(run, "error", `Could not read the omp session state: ${errorMessage(err, run.ompPath)}`);
    }
    if (run.finished) return;

    // Orchestrated runs: stream subagent lifecycle + progress. Older omp versions lack it; the
    // `task` tool's own updates still carry progress then.
    await proc.send({ type: "set_subagent_subscription", level: "progress" }).catch(() => undefined);
    if (run.finished) return;

    run.promptSent = true;
    const response = await proc.send({ id: run.promptId, type: "prompt", message: prompt });
    if (run.finished) return;
    await this.event(run, "status", "Prompt sent to agent");
    if (isObject(response.data) && response.data.agentInvoked === false) await this.complete(run);
  }

  private async onFrame(run: ActiveRun, frame: RpcFrame): Promise<void> {
    if (run.finished) return;
    switch (frame.type) {
      case "message_start":
        this.resetDeltas(run);
        break;
      case "message_update": {
        const event = frame.assistantMessageEvent;
        if (!isObject(event)) break;
        const delta = asString(event.delta) ?? "";
        const index = asNumber(event.contentIndex) ?? 0;
        if (event.type === "text_delta") {
          run.currentText += delta;
          this.onDelta(run, "text", index, delta);
        } else if (event.type === "thinking_delta") {
          this.onDelta(run, "thinking", index, delta);
        }
        break;
      }
      case "message_end": {
        if (isObject(frame.message) && frame.message.role === "assistant") {
          await this.onAssistantMessage(run, frame.message);
        } else {
          this.resetDeltas(run);
        }
        break;
      }
      case "tool_execution_start":
        await this.event(run, "tool", describeToolStart(frame));
        break;
      case "tool_execution_update":
        for (const patch of taskToolPatches(frame)) await this.trackSubagent(run, patch);
        break;
      case "tool_execution_end":
        for (const patch of taskToolPatches(frame)) await this.trackSubagent(run, patch);
        if (frame.isError === true) {
          const name = asString(frame.toolName) ?? "tool";
          const detail = truncate(oneLineTrim(resultText(frame.result)), MAX_TOOL_ERROR_TEXT);
          await this.event(run, "error", `✗ ${name} failed${detail ? `: ${detail}` : ""}`);
        }
        break;
      case "agent_end": {
        if (frame.isTerminal === false) break;
        const messages = Array.isArray(frame.messages) ? frame.messages : [];
        const last = messages.findLast((m): m is Json => isObject(m) && m.role === "assistant");
        if (last) {
          run.lastStopReason = asString(last.stopReason) ?? run.lastStopReason;
          run.lastError = assistantError(last) ?? run.lastError;
          if (!run.lastText) run.lastText = blockText(last.content, "text");
        }
        await this.complete(run);
        break;
      }
      case "prompt_result":
        if (frame.agentInvoked === false && (frame.id === undefined || frame.id === run.promptId)) {
          await this.complete(run);
        }
        break;
      case "response":
        // A scheduled prompt can be acknowledged and later fail asynchronously with the same id.
        if (frame.id === run.promptId && frame.success === false) {
          await this.fail(run, asString(frame.error) ?? "omp rejected the prompt");
        }
        break;
      case "auto_retry_start": {
        const attempt = asNumber(frame.attempt);
        const max = asNumber(frame.maxAttempts);
        const delay = asNumber(frame.delayMs);
        const reason = asString(frame.errorMessage);
        await this.event(
          run,
          "status",
          `Retrying${attempt !== undefined ? ` (attempt ${attempt}${max !== undefined ? `/${max}` : ""})` : ""}${delay !== undefined ? ` in ${Math.round(delay / 1000)}s` : ""}${reason ? ` after error: ${reason}` : ""}`,
        );
        break;
      }
      case "auto_retry_end":
        if (frame.success === true) await this.event(run, "status", "Retry succeeded");
        else await this.event(run, "error", `Retries exhausted${asString(frame.finalError) ? `: ${asString(frame.finalError)}` : ""}`);
        break;
      case "auto_compaction_start":
        await this.event(run, "status", "Compacting conversation context");
        break;
      case "auto_compaction_end": {
        const failure = asString(frame.errorMessage);
        if (failure) await this.event(run, "error", `Context compaction failed: ${failure}`);
        break;
      }
      case "notice": {
        const message = asString(frame.message);
        if (message) await this.event(run, frame.level === "error" ? "error" : "status", message);
        break;
      }
      case "extension_error":
        await this.event(
          run,
          "error",
          `Extension error${asString(frame.extensionPath) ? ` (${asString(frame.extensionPath)})` : ""}: ${asString(frame.error) ?? "unknown error"}`,
        );
        break;
      case "subagent_lifecycle": {
        const patch = lifecyclePatch(frame.payload);
        if (patch) await this.trackSubagent(run, patch);
        break;
      }
      case "subagent_progress": {
        const patch = isObject(frame.payload) ? progressPatch(frame.payload.progress) : null;
        if (patch) await this.trackSubagent(run, patch);
        break;
      }
      case "rpc_frame_error":
        await this.onTransportError(
          run,
          asString(frame.error) ?? "omp could not deliver a frame",
          asString(frame.originalType),
        );
        break;
    }
  }

  private async onAssistantMessage(run: ActiveRun, message: Json): Promise<void> {
    const thinking = blockText(message.content, "thinking");
    const text = blockText(message.content, "text");
    // Final live state first, so clients see it before the persisted run.event supersedes it.
    this.flushDelta(run, "thinking", thinking);
    this.flushDelta(run, "text", text);
    this.resetDeltas(run);
    if (thinking) await this.event(run, "thinking", truncate(thinking, MAX_THINKING_TEXT));
    if (text) {
      await this.event(run, "text", text);
      run.lastText = text;
    }
    run.currentText = "";
    run.lastStopReason = asString(message.stopReason) ?? null;
    run.lastError = assistantError(message) ?? null;
    if (run.lastStopReason === "error") {
      await this.event(run, "error", `Model error: ${run.lastError ?? "unknown error"}`);
    }
  }

  // --- Live deltas -----------------------------------------------------------------------

  private onDelta(run: ActiveRun, kind: DeltaKind, index: number, delta: string): void {
    if (!delta) return;
    const stream = run.deltas[kind];
    stream.blocks.set(index, (stream.blocks.get(index) ?? "") + delta);
    if (stream.timer) return; // the trailing publish will carry this delta
    const wait = stream.lastSentAt + DELTA_THROTTLE_MS - Date.now();
    if (wait <= 0) {
      this.publishDelta(run, kind, joinBlocks(stream.blocks));
      return;
    }
    stream.timer = setTimeout(() => {
      stream.timer = undefined;
      this.publishDelta(run, kind, joinBlocks(stream.blocks));
    }, wait);
  }

  /** Publish the message's final content if it streamed and differs from the last delta. */
  private flushDelta(run: ActiveRun, kind: DeltaKind, finalText: string): void {
    const stream = run.deltas[kind];
    clearTimeout(stream.timer);
    stream.timer = undefined;
    if (stream.blocks.size === 0) return;
    this.publishDelta(run, kind, finalText || joinBlocks(stream.blocks));
  }

  private publishDelta(run: ActiveRun, kind: DeltaKind, accumulated: string): void {
    if (run.finished || !run.runId) return;
    const stream = run.deltas[kind];
    const text = kind === "thinking" ? tail(accumulated, MAX_THINKING_DELTA) : accumulated;
    if (!text || text === stream.lastSentText) return;
    stream.lastSentAt = Date.now();
    stream.lastSentText = text;
    publish({
      type: "run.delta",
      runId: run.runId,
      taskId: run.taskId,
      boardId: run.boardId,
      kind,
      text,
    });
  }

  /** Drop accumulated deltas and any pending trailing publish (throttle window is kept). */
  private resetDeltas(run: ActiveRun): void {
    for (const stream of Object.values(run.deltas)) {
      clearTimeout(stream.timer);
      stream.timer = undefined;
      stream.blocks.clear();
      stream.lastSentText = "";
    }
  }

  /**
   * A logical frame was lost. If it was the terminal `agent_end`, complete now; otherwise ask
   * omp whether it is still working so a lost completion can never leave the task running.
   */
  private async onTransportError(
    run: ActiveRun,
    message: string,
    originalType: string | undefined,
  ): Promise<void> {
    if (run.finished) return;
    await this.event(run, "error", `Transport error: ${message}`);
    if (originalType === "agent_end") {
      await this.complete(run);
      return;
    }
    const proc = run.proc;
    if (!run.promptSent || !proc || proc.exited) return;
    try {
      const state = await proc.send({ type: "get_state" });
      if (!run.finished && isObject(state.data) && state.data.isStreaming === false) {
        await this.complete(run);
      }
    } catch {
      // The exit handler covers a dead process.
    }
  }

  private async onExit(run: ActiveRun, info: RpcExitInfo): Promise<void> {
    if (run.finished) return;
    await this.fail(
      run,
      info.error
        ? errorMessage(info.error, run.ompPath)
        : `omp exited unexpectedly (${describeExit(info)})`,
    );
  }

  private async steer(run: ActiveRun, comment: Comment): Promise<void> {
    try {
      if (run.finished || this.active.get(run.taskId) !== run || !run.proc) {
        // The run ended before the feedback could be steered; apply the normal comment rules.
        const task = await this.repo.getTask(run.taskId);
        if (task) await this.onComment(task, comment);
        return;
      }
      // Already part of this run's prompt.
      if (run.feedbackIds.has(comment.id)) return;
      try {
        await run.proc.send({ type: "steer", message: buildSteerMessage(comment) });
      } catch (err) {
        if (run.finished) {
          const task = await this.repo.getTask(run.taskId);
          if (task) await this.onComment(task, comment);
          return;
        }
        run.restartAfter = true;
        await this.event(
          run,
          "error",
          `Could not send feedback to the agent (it will be picked up by the next run): ${errorMessage(err, run.ompPath)}`,
        );
        return;
      }
      run.feedbackIds.add(comment.id);
      await this.event(run, "status", "Feedback sent to agent");
    } catch (err) {
      console.error(`[agent] failed to steer feedback for task ${run.taskId}:`, err);
    }
  }

  private async complete(run: ActiveRun): Promise<void> {
    if (run.finished) return;
    if (run.lastStopReason === "error" || run.lastStopReason === "aborted") {
      await this.fail(
        run,
        run.lastStopReason === "error"
          ? (run.lastError ?? "The model returned an error")
          : "The agent run was aborted",
      );
      return;
    }
    run.finished = true;
    const repo = this.repo;
    try {
      let summary = "";
      if (run.proc && !run.proc.exited) {
        try {
          const response = await run.proc.send(
            { type: "get_last_assistant_text" },
            { timeoutMs: SUMMARY_TIMEOUT_MS },
          );
          summary = (isObject(response.data) ? asString(response.data.text) : undefined)?.trim() ?? "";
        } catch {
          // Fall back to the streamed text below.
        }
      }
      if (!summary) summary = run.lastText || run.currentText.trim();

      if (run.runId) {
        const updated = await repo.updateRun(run.runId, {
          status: "succeeded",
          summary: summary || null,
          error: null,
          endedAt: nowIso(),
        });
        if (updated) publish({ type: "run.updated", run: updated, boardId: run.boardId });
        await this.settleSubagents(run);
        await this.event(run, "status", "Agent finished");
      }

      const comment = await repo.addComment({
        taskId: run.taskId,
        author: "agent",
        body: summary || "Done.",
        resolved: true,
      });
      publish({ type: "comment.added", comment, boardId: run.boardId });

      if (run.runId && run.feedbackIds.size > 0) {
        const resolved = await repo.resolveComments([...run.feedbackIds], run.runId);
        for (const c of resolved) publish({ type: "comment.updated", comment: c, boardId: run.boardId });
      }

      const position = await this.topPosition(run.boardId, "done", run.taskId);
      const task = await repo.updateTask(run.taskId, {
        status: "done",
        position,
        agentState: "idle",
        agentError: null,
      });
      if (task) publish({ type: "task.updated", task });
    } catch (err) {
      console.error(`[agent] failed to record the result for task ${run.taskId}:`, err);
      await this.writeTaskError(run.taskId, `Failed to record the agent result: ${errorMessage(err, run.ompPath)}`);
    } finally {
      this.release(run);
    }
  }

  private async fail(run: ActiveRun, message: string): Promise<void> {
    if (run.finished) return;
    run.finished = true;
    const repo = this.repo;
    try {
      if (run.runId) {
        const updated = await repo.updateRun(run.runId, {
          status: "failed",
          error: message,
          endedAt: nowIso(),
        });
        if (updated) publish({ type: "run.updated", run: updated, boardId: run.boardId });
        await this.settleSubagents(run);
        await this.event(run, "error", message);
      }
      const task = await repo.updateTask(run.taskId, { agentState: "error", agentError: message });
      if (task) {
        publish({ type: "task.updated", task });
        const comment = await repo.addComment({
          taskId: run.taskId,
          author: "agent",
          body: `Agent failed: ${message}`,
          resolved: true,
        });
        publish({ type: "comment.added", comment, boardId: task.boardId });
      }
    } catch (err) {
      console.error(`[agent] failed to record the failure of task ${run.taskId}:`, err);
    } finally {
      this.release(run);
    }
  }

  // --- Persistence helpers ---------------------------------------------------------------

  /** Persist + broadcast a run event. Never throws: a log write must not kill a run. */
  private async event(run: ActiveRun, kind: RunEventKind, text: string): Promise<void> {
    if (!run.runId || !text) return;
    try {
      const event = await this.repo.appendRunEvent({
        runId: run.runId,
        taskId: run.taskId,
        kind,
        text: truncate(text, MAX_EVENT_TEXT),
      });
      publish({ type: "run.event", event, boardId: run.boardId });
    } catch (err) {
      console.error(`[agent] failed to store a run event for task ${run.taskId}:`, err);
    }
  }

  /**
   * Merge a subagent update. A new subagent, a status change or its final report is persisted
   * as an `agent` run event; anything else (tool calls, token counts) is only published live.
   */
  private async trackSubagent(run: ActiveRun, patch: SubagentPatch): Promise<void> {
    if (run.finished || !run.runId) return;
    const tracked = run.subagents.get(patch.id);
    const snapshot = mergeSubagent(tracked?.snapshot, patch);
    if (!tracked) {
      const entry: TrackedSubagent = { snapshot, persisted: "", published: "", publishedAt: 0 };
      run.subagents.set(patch.id, entry);
      await this.persistSubagent(run, entry);
      return;
    }
    const milestone =
      snapshot.status !== tracked.snapshot.status ||
      snapshot.output !== tracked.snapshot.output ||
      snapshot.error !== tracked.snapshot.error;
    tracked.snapshot = snapshot;
    if (milestone) {
      await this.persistSubagent(run, tracked);
      return;
    }
    const json = JSON.stringify(snapshot);
    const now = Date.now();
    if (json === tracked.published || now - tracked.publishedAt < SUBAGENT_LIVE_THROTTLE_MS) return;
    tracked.published = json;
    tracked.publishedAt = now;
    publish({ type: "run.agent", runId: run.runId, taskId: run.taskId, boardId: run.boardId, agent: snapshot });
  }

  private async persistSubagent(run: ActiveRun, tracked: TrackedSubagent): Promise<void> {
    const json = JSON.stringify(tracked.snapshot);
    if (json === tracked.persisted) return;
    tracked.persisted = json;
    tracked.published = json;
    await this.event(run, "agent", json);
  }

  /** Run ended: persist every subagent's final state; any still working died with the process. */
  private async settleSubagents(run: ActiveRun): Promise<void> {
    for (const tracked of run.subagents.values()) {
      if (!isTerminalSubagent(tracked.snapshot.status)) {
        tracked.snapshot = mergeSubagent(tracked.snapshot, {
          id: tracked.snapshot.id,
          status: "aborted",
          currentTool: null,
          currentToolDetail: null,
        });
      }
      await this.persistSubagent(run, tracked);
    }
  }

  private async setIdle(taskId: string): Promise<Task | null> {
    const task = await this.repo.updateTask(taskId, { agentState: "idle", agentError: null });
    if (task) publish({ type: "task.updated", task });
    return task;
  }

  /** Error from a hook (start/stop/steer plumbing); a tracked run owns the task state instead. */
  private async recordTaskError(taskId: string, err: unknown): Promise<void> {
    const message = errorMessage(err, "omp");
    console.error(`[agent] task ${taskId}: ${message}`);
    if (!this.isTracked(taskId)) await this.writeTaskError(taskId, message);
  }

  /** Never throws. */
  private async writeTaskError(taskId: string, message: string): Promise<void> {
    try {
      const task = await this.repo.updateTask(taskId, { agentState: "error", agentError: message });
      if (task) publish({ type: "task.updated", task });
    } catch (err) {
      console.error(`[agent] failed to record the error for task ${taskId}:`, err);
    }
  }

  /** Position that puts a card at the top of a column. */
  private async topPosition(boardId: string, status: TaskStatus, excludeId: string): Promise<number> {
    const tasks = await this.repo.listTasks(boardId);
    let min = Number.POSITIVE_INFINITY;
    for (const t of tasks) {
      if (t.status === status && t.id !== excludeId && t.position < min) min = t.position;
    }
    return Number.isFinite(min) ? min - 1024 : 0;
  }
}

// --- Frame helpers ---------------------------------------------------------------------------

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Joined `text` or `thinking` blocks of an assistant message's content. */
function blockText(content: unknown, kind: "text" | "thinking"): string {
  if (typeof content === "string") return kind === "text" ? content.trim() : "";
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isObject(block) || block.type !== kind) continue;
    const value = asString(block[kind])?.trim();
    if (value) parts.push(value);
  }
  return parts.join("\n\n");
}

function assistantError(message: Json): string | undefined {
  return asString(message.errorMessage) ?? asString(message.error);
}

function describeToolStart(frame: RpcFrame): string {
  const name = asString(frame.toolName) ?? "tool";
  const args = isObject(frame.args) ? frame.args : undefined;
  const intent = asString(frame.intent) ?? asString(args?.intent);
  const detail =
    (name === "task" ? describeTaskCall(args, intent) || undefined : undefined) ??
    asString(args?.command) ??
    intent ??
    asString(args?.path) ??
    (args && Object.keys(args).length > 0 ? JSON.stringify(args) : "");
  const line = oneLineTrim(detail);
  return truncate(`▸ ${name}${line ? `: ${line}` : ""}`, MAX_TOOL_TEXT);
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  if (isObject(result) && Array.isArray(result.content)) {
    return result.content
      .map((block) => (isObject(block) && block.type === "text" ? (asString(block.text) ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(result);
}

function oneLineTrim(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Keeps the end of a growing text (live thinking shows its latest part). */
function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
}

function newDeltaStream(): DeltaStream {
  return { blocks: new Map(), lastSentAt: 0, lastSentText: "", timer: undefined };
}

/** Streamed blocks rendered like the persisted event (`blockText`): trimmed, joined by blank lines. */
function joinBlocks(blocks: Map<number, string>): string {
  return [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, value]) => value.trim())
    .filter(Boolean)
    .join("\n\n");
}

function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(err: unknown, ompPath: string): string {
  const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
  if (code === "ENOENT") return `omp not found at ${ompPath}. Install from https://omp.sh or set OMP_PATH`;
  if (code === "EACCES") return `omp at ${ompPath} is not executable (permission denied)`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** SIGTERM now, escalate to SIGKILL via close() if omp does not exit. */
function terminate(proc: OmpRpcProcess): void {
  proc.kill("SIGTERM");
  void proc.close();
}

// --- Singleton -------------------------------------------------------------------------------

const g = globalThis as unknown as { __ompUiAgentManager?: Promise<AgentManager> };

async function createAgentManager(): Promise<AgentManager> {
  const repo = await getRepo();
  // Nothing survives a restart: child processes died with the previous server.
  await repo.abortRunningRuns("Server restarted");
  const stale = await repo.listTasksByAgentState(["running", "queued"]);
  for (const task of stale) {
    const updated = await repo.updateTask(task.id, {
      agentState: "error",
      agentError: "Interrupted by server restart",
    });
    if (updated) publish({ type: "task.updated", task: updated });
  }
  return new OmpAgentManager(repo);
}

/** Process-wide agent manager; the first call performs boot recovery. */
export async function getAgentManager(): Promise<AgentManager> {
  g.__ompUiAgentManager ??= createAgentManager().catch((err: unknown) => {
    g.__ompUiAgentManager = undefined;
    throw err;
  });
  return g.__ompUiAgentManager;
}
