import type { Comment, QueueSnapshot, Task, TaskStatus } from "@/lib/types";

/**
 * Controls omp agents for tasks. Implemented in lib/agent/manager.ts, obtained via
 * `getAgentManager()` (process-wide singleton). All methods persist state through the
 * Repository and publish ServerEvents themselves; API routes only call these hooks.
 */
export interface AgentManager {
  /**
   * Queue/start an agent run for the task. Moves the task to "in_progress".
   * No-op if already queued/running. Throws if the task does not exist.
   */
  start(taskId: string): Promise<Task>;
  /**
   * `start()`, but the queued run is held until `prepare` settles (the card writer turning the
   * card's free text into its title and brief). A failed `prepare` is logged and the run starts
   * anyway; stop() and deletion abort its signal. A server restart drops the hold: the card is
   * queued again and runs as it is.
   */
  startPrepared(taskId: string, prepare: (signal: AbortSignal) => Promise<void>): Promise<Task>;
  /** Abort the running/queued agent; task stays in its column, agentState -> "idle". */
  stop(taskId: string): Promise<Task | null>;
  /**
   * Called by PATCH /tasks/:id after a status change has been persisted.
   * - -> in_progress and board.autoRun and agent not active: start()
   * - -> todo while active: stop()
   * - -> done while active: stop()
   */
  onTaskMoved(task: Task, previousStatus: TaskStatus): Promise<void>;
  /**
   * Called after a user comment is persisted (feedback).
   * - agent running: steer the comment into the live session (it is resolved when the run succeeds)
   * - task "done" (or "in_progress" with agent idle/error): start a new run that resumes the
   *   same omp session with all unresolved feedback
   * - task "todo": nothing (feedback is included when the run starts)
   */
  onComment(task: Task, comment: Comment): Promise<void>;
  /** Called before a task is deleted: kill its process if any. */
  onTaskDeleted(taskId: string): Promise<void>;
  /** Snapshot for /health and the UI. */
  stats(): { running: string[]; queued: string[] };
  /** Running and queued cards (queued in start order) with titles and unfinished blockers. */
  queueSnapshot(): Promise<QueueSnapshot>;
  /** Move a queued card to `position` (0 = next). False when the card is not queued. */
  moveInQueue(taskId: string, position: number): boolean;
  /** Re-check queued cards, e.g. after a card's blockedBy changed. */
  refreshQueue(): void;
}
