// Shared domain types. Used by DB drivers, API routes, agent runner, web UI,
// and (later) mobile clients. All timestamps are ISO-8601 strings; all ids are strings.

import { DEFAULT_PRIMARY_COLOR, type PrimaryColorId } from "@/lib/primary-colors";
import type { SdlcProgress } from "@/lib/sdlc";

export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

/** Lifecycle of the omp agent attached to a task. */
export type AgentState = "idle" | "queued" | "running" | "error";

export const USER_ROLES = ["admin", "user"] as const;
/** `admin`: manages users and the shared configuration, sees every user's data. `user`: own data only. */
export type UserRole = (typeof USER_ROLES)[number];

/** An omp-ui account. Never carries the password hash (see `UserAuthRecord` in lib/db/types.ts). */
export interface User {
  id: string;
  /** Unique, stored lowercase: 2–32 of `a-z 0-9 . _ -`, starting with a letter or digit. */
  username: string;
  /** Unique when set, stored lowercase. Null when the account has no email (e.g. the migrated admin). */
  email: string | null;
  role: UserRole;
  /** Inactive accounts cannot sign in; their sessions stop working at once. */
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Body of `POST /api/v1/users`. `role` defaults to "user"; `email` is optional. */
export interface CreateUserRequest {
  username: string;
  email?: string | null;
  password: string;
  role?: UserRole;
}

/** Body of `PATCH /api/v1/users/:id`; omitted fields stay unchanged. */
export interface UpdateUserRequest {
  username?: string;
  email?: string | null;
  role?: UserRole;
  isActive?: boolean;
}

/**
 * Answer of `DELETE /api/v1/users/:id`. With `?reassignTo=<userId>` the user's boards (with their
 * cards, comments, runs, schedulers) and credentials move to that user; without it they are deleted.
 */
export interface DeleteUserResult {
  ok: true;
  /** Boards moved to `reassignedTo`, or deleted when `reassignedTo` is null. */
  boards: number;
  credentials: number;
  reassignedTo: string | null;
}

/** `GET /api/v1/auth/status`. `user` is the signed-in account (null when not authenticated). */
export interface AuthStatus {
  /** At least one user exists (first-run setup done). */
  configured: boolean;
  authenticated: boolean;
  user: User | null;
}

/** A board is one project. A project has a primary folder plus optional extra folders. */
export interface Board {
  id: string;
  name: string;
  /** Primary project folder (absolute); omp runs here (`omp --cwd <workdir>`). */
  workdir: string;
  /**
   * Additional absolute folders that belong to the project (e.g. frontend + backend repos).
   * Passed to omp as repeated `--add-dir <folder>`. Never contains `workdir`. Default [].
   */
  extraFolders: string[];
  /** Optional omp model selector (`--model`), e.g. "sonnet" or "anthropic/claude-sonnet-4-5". */
  model: string | null;
  /** When true, moving a card into "In progress" starts the agent automatically. */
  autoRun: boolean;
  /**
   * Dedicated workspaces: each card's agent works in its own git worktree of every project
   * folder that is a git repository (branch `omp/<card>`), so parallel cards never share a
   * working tree. Non-git folders stay shared. Default false.
   */
  worktrees: boolean;
  /**
   * Branch "Push to main" lands on in every project repo (`git push origin HEAD:<pushBranch>`),
   * created on the remote when missing. Create PR still targets each repo's own default branch.
   * A valid git branch name (`isValidBranchName` in lib/push-branch.ts). Default "main".
   */
  pushBranch: string;
  /** Pinned projects lead the home dashboard; the rest follow under "Other projects". Default false. */
  pinned: boolean;
  /** When the project's board was last opened (ISO); null until first opened. Orders the sidebar's "Your projects". */
  lastAccessedAt: string | null;
  /**
   * Owning user (users.id). Null only for rows created before users existed, until boot assigns
   * them to the first admin. Tasks, comments, runs and schedulers inherit it from their board.
   */
  userId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BoardWithCounts extends Board {
  counts: Record<TaskStatus, number>;
  runningCount: number;
}

export interface Task {
  id: string;
  boardId: string;
  title: string;
  description: string;
  status: TaskStatus;
  /** Sort key inside its column (ascending). Fractional values allowed. */
  position: number;
  agentState: AgentState;
  agentError: string | null;
  /**
   * Question(s) the agent asked the user in its last run summary. Set when a run succeeds,
   * cleared when the next run starts or the user dismisses it (PATCH question: null).
   */
  question: string | null;
  /** omp session JSONL path; reused with `--resume` so feedback keeps context. */
  sessionFile: string | null;
  lastRunId: string | null;
  /**
   * Task queue dependencies: ids of cards on the same board that must be Done before this
   * card's agent starts. While any is not Done, a queued run waits. Default [].
   */
  blockedBy: string[];
  /** Card whose agent created this card (agent-to-agent delegation); null when a person did. */
  createdByTaskId: string | null;
  /**
   * When "Push to main" last landed this card's changes on the project's push branch; null if never.
   * Cards with it set show a struck-through title.
   */
  pushedAt: string | null;
  /**
   * Automatic retries used since the card's last successful run or manual start (Run, feedback).
   * A run that fails, or is interrupted by a server restart, is retried while this is below
   * `AppSettings.maxAutoRetries`.
   */
  autoRetries: number;
  /** When the next automatic retry of a failed run starts; null when none is scheduled. */
  retryAt: string | null;
  /**
   * The agent's todo list (omp `todo` tool), as of its latest update; replaced on every update
   * and kept after the run ends. [] when the agent never kept one.
   */
  todos: TodoPhase[];
  /** Latest code review decision; null until the card is reviewed. Never cleared by runs: compare `hash` with the diff. */
  review: TaskReview | null;
  /**
   * Memory and CPU of the card's latest agent run, as of its last sample: stored when the run
   * ends, cleared when the next run starts. While a run is going, live samples arrive as
   * `run.resources` events instead. Null when the card never ran (or ran before tracking).
   */
  resources: AgentResources | null;
  /**
   * Estimated model spend of the card's omp session: every model request its agent and subagents
   * made, over all runs, as priced by omp. Refreshed while a run goes and stored when it ends.
   * Null until the card's session reported any usage.
   */
  usage: TaskUsage | null;
  createdAt: string;
  updatedAt: string;
  /** Derived: total comments. */
  commentCount: number;
  /** Derived: unresolved user comments (pending feedback). */
  openCommentCount: number;
  /** Scheduler whose run created this card; null when a person or an agent created it. */
  schedulerId: string | null;
  /**
   * Whether the card's runs may split the work across parallel subagents (the New task form's
   * "Parallelize" toggle). null (cards created without a choice) counts as true.
   */
  parallelize: boolean | null;
  /**
   * Whether the card's agent runs without agentmemory (the "Ignore memory" toggle): no recall from past
   * sessions, nothing from its runs saved to memory, no memory tools. Default false. Takes effect from the
   * next run.
   */
  ignoreMemory: boolean;
  /** Owning user, inherited from the board (see Board.userId). */
  userId: string | null;
}

export type ReviewDecision = "approved" | "changes_requested";

/** A reviewer's decision on a card's changes (`POST /tasks/:id/review`). */
export interface TaskReview {
  decision: ReviewDecision;
  /** `TaskDiff.hash` of the changes the reviewer saw; null when unknown. A different current hash = stale review. */
  hash: string | null;
  /** Reviewer's note (required for changes_requested; optional for approved); null when none. */
  note: string | null;
  /** ISO time of the decision. */
  at: string;
}

/** `POST /tasks/:id/review` response: the updated card and, for request_changes, the posted feedback comment. */
export interface TaskReviewResult {
  task: Task;
  comment: Comment | null;
}

export type TodoItemStatus = "pending" | "in_progress" | "completed" | "abandoned";

export interface TodoItem {
  content: string;
  status: TodoItemStatus;
  /**
   * Stamped by the server, never by omp: when the item was first seen in progress during the
   * current run (completed without being seen in progress: the run's previous list update).
   */
  startedAt?: string;
  /** Stamped by the server: when the item was first seen completed. */
  completedAt?: string;
}

/** One phase of an agent's todo list; `name` may be "". */
export interface TodoPhase {
  name: string;
  tasks: TodoItem[];
}

export type CommentAuthor = "user" | "agent";

export interface Comment {
  id: string;
  taskId: string;
  author: CommentAuthor;
  body: string;
  resolved: boolean;
  resolvedAt: string | null;
  /** Run that addressed this feedback. */
  resolvedByRunId: string | null;
  /**
   * Agent-to-agent message: id of the card whose agent sent this comment. Such comments have
   * `author: "user"` (they are feedback the receiving agent must address). Null otherwise.
   */
  fromTaskId: string | null;
  /** Owning user, inherited from the task's board (see Board.userId). */
  userId: string | null;
  createdAt: string;
}

/** Live delivery state of a comment steered into a running agent (`comment.steer` events). */
export type SteerState = "sent" | "delivered" | "deferred";

export type RunStatus = "running" | "succeeded" | "failed" | "aborted";

export interface Run {
  id: string;
  taskId: string;
  status: RunStatus;
  /** Prompt sent to omp for this run. */
  prompt: string;
  /** Final assistant text, set on success. */
  summary: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
  /** Owning user, inherited from the task's board (see Board.userId). */
  userId: string | null;
  /**
   * Cluster node that executed the run (lib/cluster); null for runs of a standalone server.
   * `nodeName` is kept as it was at run time, so it still reads after the node left.
   */
  nodeId: string | null;
  nodeName: string | null;
}

/**
 * `agent` events carry a JSON-encoded `SubagentSnapshot` (full state of one subagent at that
 * point); the latest event per subagent id wins. `tool` events read `▸ name: detail`, plus the
 * call's intent on a second line when omp reported one apart from the detail.
 */
export type RunEventKind = "status" | "text" | "thinking" | "tool" | "error" | "agent";

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

/** A tool call a subagent made (newest first in `recentTools`). */
export interface SubagentToolCall {
  tool: string;
  /** Intent or argument summary. */
  detail?: string;
  isError?: boolean;
}

/** One subagent the run delegated work to (omp `task` tool / orchestration). */
export interface SubagentSnapshot {
  /** omp agent id (`agent://<id>`); nested subagents are dot-qualified (`Parent.Child`). */
  id: string;
  /** Agent definition: `task`, `scout`, `reviewer`… */
  agent: string;
  /** Spawn order within its batch. */
  index?: number;
  status: SubagentStatus;
  description?: string;
  /** The brief it was given (truncated). */
  task?: string;
  model?: string;
  /** What it says it is doing now. */
  intent?: string;
  /** Tool running right now. */
  currentTool?: string;
  currentToolDetail?: string;
  recentTools?: SubagentToolCall[];
  /** Last lines of its output (newest first). */
  recentOutput?: string[];
  toolCount?: number;
  requests?: number;
  tokens?: number;
  cost?: number;
  durationMs?: number;
  /** Final report (truncated). */
  output?: string;
  error?: string;
  /** Tokens in its context window as of its latest model response (its "mana" used). */
  contextTokens?: number;
}

/**
 * How full an agent's context window is: the agent's "mana" on the Visualize page is what is
 * left, `1 - tokens / contextWindow`.
 */
export interface ContextUsage {
  /** Tokens in the context right now. */
  tokens: number;
  /** Model's context window in tokens; 0 when unknown. */
  contextWindow: number;
}

/**
 * Model usage of a card's omp session (main agent plus subagents, all runs), summed from the
 * `usage` omp records on each model response in the session files. `costUsd` is omp's estimate
 * from the model's list prices.
 */
export interface TaskUsage {
  costUsd: number;
  /** input + output + cacheRead + cacheWrite, as omp counts `totalTokens`. */
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Model responses counted. */
  requests: number;
  /** When it was computed (ISO). */
  updatedAt: string;
}

/**
 * Memory and CPU of a card's agent: its omp process plus every process it started (subagents,
 * tools, shells). Sampled every few seconds while the run is going.
 */
export interface AgentResources {
  /** Resident memory (RSS) of the process tree at the latest sample, bytes. */
  memoryBytes: number;
  /** Highest `memoryBytes` sampled during the run. */
  peakMemoryBytes: number;
  /** CPU use since the previous sample, percent of one core (200 = two cores busy). */
  cpuPercent: number;
  /** CPU time (user + system) the process tree used since the run started, seconds. */
  cpuSeconds: number;
  /** When the latest sample was taken (ISO). */
  sampledAt: string;
}

export interface RunEvent {
  /** Monotonic per-database integer sequence; used as the `after` cursor. */
  seq: number;
  runId: string;
  taskId: string;
  kind: RunEventKind;
  text: string;
  createdAt: string;
}

/**
 * A recurring card: on every match of its cron expression (in its time zone) the scheduler
 * creates a regular card on its board from `prompt`, through the same free-text flow as the
 * "New task" form (the card takes the prompt as typed and its agent starts at once).
 */
export interface Scheduler {
  id: string;
  boardId: string;
  /** Display name; defaults to the prompt's first line. */
  name: string;
  /** Free text each created card is made from (same as the "New task" form's text). */
  prompt: string;
  /** 5-field cron expression or macro (`@hourly`, `@daily`, …); see lib/cron.ts. */
  cron: string;
  /** IANA time zone the cron expression is evaluated in, e.g. "Europe/Berlin" or "UTC". */
  timezone: string;
  /** Disabled schedulers keep their config and history but never fire on their own. */
  enabled: boolean;
  /** Stop (disable) after this many runs; null = repeat forever. */
  maxRuns: number | null;
  /** Runs so far (scheduled and manual), successful or not. */
  runCount: number;
  /** When it last fired (scheduled or manual); null if never. */
  lastRunAt: string | null;
  /** Next scheduled fire time; null when disabled, exhausted or the cron never matches again. */
  nextRunAt: string | null;
  /** Outcome of the last run; null if never run. */
  lastStatus: SchedulerRunStatus | null;
  /** Card created by the last successful run. */
  lastTaskId: string | null;
  /** Error of the last run when it failed. */
  lastError: string | null;
  /** Owning user, inherited from the board (see Board.userId). */
  userId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `created`: the run created its card. `failed`: creating the card failed (see `error`). */
export type SchedulerRunStatus = "created" | "failed";

/** One execution of a scheduler (history row). Kept when its card is deleted. */
export interface SchedulerRun {
  id: string;
  schedulerId: string;
  /** Card it created; null when it failed. The card may since have been deleted. */
  taskId: string | null;
  trigger: "scheduled" | "manual";
  /** Cron slot this run was for (scheduled), or the click time (manual). */
  scheduledFor: string;
  status: SchedulerRunStatus;
  error: string | null;
  createdAt: string;
}

/** History row as served by the API: the run plus a live snapshot of its card (null if gone). */
export interface SchedulerRunView extends SchedulerRun {
  task: Pick<Task, "id" | "title" | "status" | "agentState" | "agentError" | "lastRunId"> | null;
  /** Status of the card's latest agent run; null when it has none or the card is gone. */
  runStatus: RunStatus | null;
}

/** One line of a scheduler's aggregated log: scheduler events plus its cards' agent run events. */
export interface SchedulerLogEntry {
  at: string;
  /** "scheduler": fired/failed lines written by the scheduler; else the run event's kind. */
  kind: "scheduler" | RunEventKind;
  text: string;
  schedulerRunId: string;
  taskId: string | null;
  runId: string | null;
}

/**
 * A scheduler the scheduler assistant proposed (validated, not saved yet): the exact body of
 * POST /api/v1/schedulers once the user confirms it.
 */
export interface SchedulerDraft {
  boardId: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  maxRuns: number | null;
}

/** One turn of the "Create with Agent" conversation (POST /api/v1/schedulers/chat). */
export interface SchedulerChatMessage {
  role: "user" | "assistant";
  text: string;
}

/** POST /api/v1/schedulers/chat body: the whole conversation so far, the last message the user's. */
export interface SchedulerChatRequest {
  messages: SchedulerChatMessage[];
  /** The user's IANA time zone (the browser's), used when they name none. */
  timezone: string;
  /** Project the conversation defaults to; null/omitted = the first one. */
  boardId?: string | null;
  /** The draft currently shown, so follow-ups ("make it 10:00") revise it. */
  draft?: SchedulerDraft | null;
}

/**
 * One NDJSON line of POST /api/v1/schedulers/chat: progress lines while the assistant works, then
 * exactly one `done` (its reply and the draft it proposed this turn, else null) or `error`.
 */
export type SchedulerChatEvent =
  | { type: "activity"; text: string }
  | { type: "done"; reply: string; draft: SchedulerDraft | null }
  | { type: "error"; error: string };

export type ApprovalMode = "yolo" | "write" | "always-ask";

export interface AppSettings {
  /**
   * Max omp processes running at once; extra runs wait in "queued". `"auto"` (default) derives
   * the limit from the machine's cores and free memory (see QueueSnapshot.concurrency).
   */
  maxConcurrentAgents: number | "auto";
  /** omp executable path or name on PATH. */
  ompPath: string;
  /** Passed as `--approval-mode`. Headless runs cannot answer prompts, so "yolo" is default. */
  approvalMode: ApprovalMode;
  /** Default `--model` when a board has none. Empty = omp default. */
  defaultModel: string;
  /**
   * When a board has no model: pick one per run from the task (omp's `smol` role for small edits,
   * `slow` for hard problems, `designer` for UI work), falling back to `defaultModel`.
   */
  autoModel: boolean;
  /**
   * Smart queue: when several cards of a project wait in the agent queue, a planner agent orders
   * them (prerequisites and quick unblockers first) and adds the "Runs after" links it finds, so
   * independent cards run in parallel and dependent ones wait for what they build on.
   */
  smartQueue: boolean;
  /** What a card's agent may do with a web browser (omp's `browser` tool). */
  browser: BrowserMode;
  /**
   * Retry failed runs automatically (resuming the omp session) with exponential backoff, and
   * resume interrupted and failed In progress cards when the server restarts.
   */
  autoRetry: boolean;
  /** Automatic retries per card before it stays failed (0-20); a success or a manual run resets the count. Ignored by persistentRetry. */
  maxAutoRetries: number;
  /**
   * Keep retrying failed In progress cards until they are Done or stopped: quota/usage-limit
   * failures wait 5, 10, 15, 30 min then hourly; other failures back off up to 10 min. A card
   * interrupted by a server restart still uses its maxAutoRetries budget. Needs autoRetry.
   */
  persistentRetry: boolean;
  /** Run the AgentMan-data cleanup automatically; "off" (default) leaves it to "Clean up now". */
  cleanupSchedule: CleanupSchedule;
  /** What scheduled and manual "Clean up now" runs remove (default: every safe target). */
  cleanupTargets: ScheduledCleanupId[];
  /** Show a browser notification when a card on the open board finishes (moves to Done). Permission is per browser; the UI asks for it when turning this on. */
  taskCompletionNotifications: boolean;
  /**
   * Optional sections shown in the navigation menu (sidebar, phone tabs, home "Go to"); default: all.
   * Sections added after the list was saved show until hidden (lib/settings.ts `knownDashboardMenus`).
   */
  visibleDashboardMenus: DashboardMenuId[];
  /**
   * UI primary color preset (Settings → Appearance; lib/primary-colors.ts). Applied server-side as
   * `<html data-primary>` so pages load in it.
   */
  primaryColor: PrimaryColorId;
  /**
   * Telegram bot token (Settings → Chat integrations), AES-256-GCM sealed with the credentials key
   * (lib/server/chat/store.ts); "" when none. Never plaintext in the database; GET /settings
   * answers "" or REDACTED_SECRET, and PATCH /settings ignores it (set via /chat/telegram/connect).
   */
  telegramBotToken: string;
  /** Discord bot token; same storage and API rules as `telegramBotToken`. */
  discordBotToken: string;
  /**
   * Run time limit: a run still working after `runTimeLimitMinutes` is stopped and the card fails
   * without an automatic retry (a retry would hit the same limit). Checked by the run supervisor
   * (lib/agent/run-guards.ts) every few seconds, so changes apply to runs already working.
   */
  runTimeLimit: boolean;
  runTimeLimitMinutes: number;
  /**
   * Stall watchdog: a run whose omp process sends nothing for `stallTimeoutMinutes` (no output,
   * tool or progress frames; board-tool waits excepted) is aborted and fails like a crash, so
   * automatic retries resume it.
   */
  stallWatchdog: boolean;
  stallTimeoutMinutes: number;
  /**
   * Per-run budget: stop a run (failed, no automatic retry) once its omp session plus its
   * subagents report more than `runBudgetUsd` dollars or `runBudgetTokens` tokens; 0 = no cap.
   */
  runBudget: boolean;
  runBudgetUsd: number;
  runBudgetTokens: number;
  /**
   * Loop detection (lib/agent/loop-detector.ts): an agent repeating the same tool call, the same
   * failing call, or ping-ponging between two calls is warned once via a steer message; if it
   * keeps looping the run fails without an automatic retry.
   */
  loopDetection: boolean;
  /**
   * Git checkpoints (lib/server/checkpoints.ts): before each run, snapshot the run's git folders
   * (tracked and untracked files, without touching the working tree or index) so the card's
   * changes can be rolled back from the card's Checkpoints panel.
   */
  gitCheckpoints: boolean;
  /**
   * Export each finished run as OpenTelemetry spans (GenAI semantic conventions) over OTLP/HTTP
   * JSON to `telemetryEndpoint` (lib/server/telemetry.ts). Extra request headers come from
   * OTEL_EXPORTER_OTLP_HEADERS.
   */
  telemetryExport: boolean;
  /** OTLP/HTTP traces URL, e.g. http://localhost:4318/v1/traces; "" = not configured. */
  telemetryEndpoint: string;
  /**
   * Load guard: hold queued cards (start no new runs) while the 1-minute load average per CPU
   * core is above `loadGuardPercent` %; running agents are not touched.
   */
  loadGuard: boolean;
  loadGuardPercent: number;
  /**
   * Subagent limits (Hermes-style delegation caps), written into each run's omp config overlay:
   * at most `subagentMaxConcurrency` subagents at once, scaled down to the run's fair share of
   * the machine's cores and free memory (lib/agent/concurrency.ts subagentConcurrency); nesting
   * at most `subagentMaxDepth` levels (1 = subagents cannot delegate further); each subagent
   * stopped after `subagentTimeoutMinutes` (0 = no limit). Applies to runs started while on.
   */
  subagentLimits: boolean;
  subagentMaxConcurrency: number;
  subagentMaxDepth: number;
  subagentTimeoutMinutes: number;
  /**
   * Early context compaction (Hermes compresses at 50 % of the window): omp compacts a run's
   * context once it fills `contextCompactPercent` % of the model's window, so each model request
   * resends fewer tokens. Applies to runs started while on.
   */
  contextCompaction: boolean;
  contextCompactPercent: number;
  /**
   * Wrap-up nudge (Hermes' iteration-budget summary request): once a run has used
   * `wrapUpPercent` % of its run time limit or run budget, the agent is told once to finish its
   * current step, verify and write its summary, so the hard stop rarely discards work.
   * Needs the run time limit or run budget on.
   */
  wrapUpNudge: boolean;
  wrapUpPercent: number;
  /**
   * Cluster mode (lib/cluster): the primary also runs cards on its own machine. Off = the
   * primary only coordinates and every card runs on a replica node. Ignored outside cluster mode.
   */
  clusterRunLocal: boolean;
  /**
   * Cluster mode: seconds replicas wait after losing the primary before they elect and promote
   * a new one (CLUSTER_FAILOVER_LIMITS).
   */
  clusterFailoverSeconds: number;
  /**
   * Cluster mode (primary): auto-healing. The primary health-checks every online node and asks a
   * node to restart (its bin/supervisor.mjs starts it again) after `clusterHealFailures` failed
   * checks in a row, or once it stayed offline `clusterHealOfflineSeconds`. Restart attempts back
   * off and pause after `clusterHealMaxRestarts` in a row (docs/CLUSTER.md, "Auto-healing").
   * Defaults come from OMP_UI_CLUSTER_AUTO_HEAL and OMP_UI_CLUSTER_HEAL_* (lib/settings.ts).
   */
  clusterAutoHeal: boolean;
  /** Seconds between two health checks of an online node (CLUSTER_HEAL_LIMITS). */
  clusterHealIntervalSeconds: number;
  /** Seconds a node has to answer one health check. */
  clusterHealTimeoutSeconds: number;
  /** Failed health checks in a row before the node is restarted. */
  clusterHealFailures: number;
  /** Seconds an offline node may take to come back before a restart is attempted. */
  clusterHealOfflineSeconds: number;
  /** Restart attempts in a row (the node did not stay healthy in between) before auto-restart pauses for that node. */
  clusterHealMaxRestarts: number;
  /**
   * Cluster mode (replicas): disconnect watchdog. A replica without a session with its primary for
   * `clusterRestartAfterSeconds` (CLUSTER_RESTART_LIMITS; at least clusterFailoverSeconds + 60 s, so
   * a failover election always runs first) restarts itself through bin/supervisor.mjs and joins
   * again; every further restart without a session in between doubles the wait (at most 1 h unless
   * the setting is longer). Nodes without the supervisor only post a notice and keep reconnecting.
   * Defaults come from OMP_UI_CLUSTER_AUTO_RESTART and OMP_UI_CLUSTER_RESTART_AFTER_SEC (lib/settings.ts).
   */
  clusterAutoRestart: boolean;
  clusterRestartAfterSeconds: number;
}

/**
 * Bounds of the numeric orchestration settings (Settings → Orchestration), shared by the UI,
 * PATCH /settings validation and stored-settings sanitizing.
 */
export const ORCHESTRATION_LIMITS = {
  runTimeLimitMinutes: { min: 5, max: 1440 },
  stallTimeoutMinutes: { min: 2, max: 240 },
  runBudgetUsd: { min: 0, max: 10_000 },
  runBudgetTokens: { min: 0, max: 1_000_000_000 },
  loadGuardPercent: { min: 10, max: 1000 },
  subagentMaxConcurrency: { min: 1, max: 32 },
  subagentMaxDepth: { min: 1, max: 3 },
  subagentTimeoutMinutes: { min: 0, max: 480 },
  contextCompactPercent: { min: 20, max: 95 },
  wrapUpPercent: { min: 50, max: 95 },
} as const;
export type OrchestrationNumberKey = keyof typeof ORCHESTRATION_LIMITS;

/** Bounds of `AppSettings.clusterFailoverSeconds`. */
export const CLUSTER_FAILOVER_LIMITS = { min: 5, max: 600 } as const;

/** Bounds of the numeric auto-healing settings (`AppSettings.clusterHeal*`), whole numbers. */
export const CLUSTER_HEAL_LIMITS = {
  clusterHealIntervalSeconds: { min: 5, max: 600 },
  clusterHealTimeoutSeconds: { min: 1, max: 120 },
  clusterHealFailures: { min: 1, max: 20 },
  clusterHealOfflineSeconds: { min: 10, max: 3600 },
  clusterHealMaxRestarts: { min: 1, max: 20 },
} as const;
export type ClusterHealNumberKey = keyof typeof CLUSTER_HEAL_LIMITS;

/** Bounds of `AppSettings.clusterRestartAfterSeconds` (whole seconds). */
export const CLUSTER_RESTART_LIMITS = { min: 60, max: 86_400 } as const;

/** What GET /settings answers for a stored secret (chat bot tokens). */
export const REDACTED_SECRET = "********";

export const CHAT_PLATFORMS = ["telegram", "discord"] as const;
/** Chat apps that can control AgentMan (Settings → Chat integrations). */
export type ChatPlatform = (typeof CHAT_PLATFORMS)[number];
export type ChatConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** One chat integration's state, from GET /chat/status and the connect/disconnect routes. */
export interface ChatPlatformStatus {
  platform: ChatPlatform;
  /** A bot token is stored. */
  configured: boolean;
  state: ChatConnectionState;
  /** Why the bot is not connected (invalid token, network…); null when fine. */
  error: string | null;
  /** The bot account; null until a token was validated. */
  bot: { id: string; name: string; username: string | null } | null;
  /** Telegram: https://t.me/<username>; Discord: OAuth2 invite URL that adds the bot to a server. */
  botUrl: string | null;
  /** How updates arrive: Telegram long polling or webhook, Discord gateway. */
  mode: "polling" | "webhook" | "gateway" | null;
  /** Telegram webhook mode: the public URL Telegram posts to; null in polling mode. */
  webhookUrl: string | null;
  /** Last 4 characters of the stored token; null when none. */
  tokenHint: string | null;
  /** Chat users currently signed in to an omp-ui account (`/login [username] <password>`). */
  authorizedUsers: number;
}

export interface ChatStatusResponse {
  telegram: ChatPlatformStatus;
  discord: ChatPlatformStatus;
}

/** Navigation menu sections the user may hide (Settings → Menu); each one's page is `/<id>`. */
export const DASHBOARD_MENU_IDS = [
  "visualize",
  "containers",
  "terminal",
  "files",
  "artifacts",
  "memory",
  "credentials",
  "mcp",
  "stats",
  "settings",
] as const;
export type DashboardMenuId = (typeof DASHBOARD_MENU_IDS)[number];

/**
 * Artifacts page period filter (GET /artifacts?from=&to=): a card counts when its latest succeeded
 * run ended at or after `from` and before `to` (ISO timestamps; either may be omitted = unbounded).
 */
export interface ArtifactPeriod {
  from?: string;
  to?: string;
}

/** One project on the Artifacts page (GET /artifacts), with its final results in the period. */
export interface ArtifactProject {
  boardId: string;
  name: string;
  workdir: string;
  pinned: boolean;
  /** Cards whose latest succeeded run ended in the period. */
  resultCount: number;
  /** Final attachments across those cards. */
  attachmentCount: number;
  /** When the newest of those runs ended; null when none in the period. */
  latestAt: string | null;
}

/**
 * A final deliverable of a card: a file of the card's shared files (`/api/v1/tasks/:id/files/…`)
 * linked or embedded in its final run summary. Other files of the card (screenshots and notes made
 * while working) are not artifacts.
 */
export interface ArtifactFile {
  /** Path relative to the card's files folder, `/`-separated. */
  name: string;
  /** `/api/v1/tasks/:id/files/<name>` (as linked in the summary, path segments encoded). */
  url: string;
  /** Bytes; null when the file no longer exists. */
  size: number | null;
  /** Null when the file no longer exists. */
  modifiedAt: string | null;
}

/** One card's final result (GET /artifacts/:boardId), newest `finishedAt` first. */
export interface ArtifactResult {
  taskId: string;
  boardId: string;
  title: string;
  status: TaskStatus;
  /** The card's latest succeeded run. */
  runId: string;
  /** That run's final summary (markdown). */
  summary: string;
  /** That run's `endedAt`. */
  finishedAt: string;
  attachments: ArtifactFile[];
}

export interface ArtifactProjectResults {
  board: { id: string; name: string; workdir: string };
  results: ArtifactResult[];
}

/**
 * Browser control for agents: `off` disables omp's browser; `headless` (default) runs an
 * invisible browser; `visible` shows its window on the server's desktop; `relay` drives the
 * server user's own Chrome through omp's browser relay (`omp browser-relay`).
 */
export const BROWSER_MODES = ["off", "headless", "visible", "relay"] as const;
export type BrowserMode = (typeof BROWSER_MODES)[number];

/** How often the scheduled AgentMan-data cleanup runs (Settings → Cleanup). */
export const CLEANUP_SCHEDULES = ["off", "weekly", "monthly"] as const;
export type CleanupSchedule = (typeof CLEANUP_SCHEDULES)[number];

/** AgentMan-data cleanups a schedule may run (Docker prunes stay manual on the Maintenance page). */
export const SCHEDULED_CLEANUP_IDS = [
  "orphan-card-files",
  "orphan-board-files",
  "orphan-workspaces",
  "shipped-workspaces",
  "run-configs",
  "drafts",
  "diff-cache",
  "rotated-logs",
  "database",
] as const satisfies readonly CleanupId[];
export type ScheduledCleanupId = (typeof SCHEDULED_CLEANUP_IDS)[number];

export const DEFAULT_SETTINGS: AppSettings = {
  maxConcurrentAgents: "auto",
  ompPath: "omp",
  approvalMode: "yolo",
  defaultModel: "",
  autoModel: true,
  smartQueue: true,
  browser: "headless",
  autoRetry: true,
  maxAutoRetries: 5,
  persistentRetry: true,
  cleanupSchedule: "off",
  // Worktrees of shipped cards may still be wanted; they are opt-in.
  cleanupTargets: SCHEDULED_CLEANUP_IDS.filter((id) => id !== "shipped-workspaces"),
  taskCompletionNotifications: false,
  visibleDashboardMenus: [...DASHBOARD_MENU_IDS],
  primaryColor: DEFAULT_PRIMARY_COLOR,
  telegramBotToken: "",
  discordBotToken: "",
  // Orchestration guards are opt-in: off, nothing changes for existing installs.
  runTimeLimit: false,
  runTimeLimitMinutes: 120,
  stallWatchdog: false,
  stallTimeoutMinutes: 20,
  runBudget: false,
  runBudgetUsd: 5,
  runBudgetTokens: 0,
  loopDetection: false,
  gitCheckpoints: false,
  telemetryExport: false,
  telemetryEndpoint: "",
  loadGuard: false,
  loadGuardPercent: 150,
  subagentLimits: false,
  subagentMaxConcurrency: 8,
  subagentMaxDepth: 1,
  subagentTimeoutMinutes: 30,
  contextCompaction: false,
  contextCompactPercent: 50,
  wrapUpNudge: false,
  wrapUpPercent: 80,
  clusterRunLocal: true,
  clusterFailoverSeconds: 20,
  clusterAutoHeal: true,
  clusterHealIntervalSeconds: 15,
  clusterHealTimeoutSeconds: 10,
  clusterHealFailures: 3,
  clusterHealOfflineSeconds: 30,
  clusterHealMaxRestarts: 3,
  clusterAutoRestart: true,
  clusterRestartAfterSeconds: 300,
};

/** An installed omp skill (from `omp skill list`): pickable with "/" when composing a card. */
export interface OmpSkill {
  name: string;
  description: string;
  /** Where omp found it, e.g. "native:user" or a plugin name. */
  source: string;
}

/** One "@" mention candidate from GET /boards/:id/project-files. */
export interface ProjectFileHit {
  /** Shown in the picker, relative to its project folder; directories end with "/". */
  path: string;
  kind: "file" | "dir";
  /** Text to put after "@": relative to the board workdir, or absolute for extra folders; directories end with "/". */
  insert: string;
  /** Basename of the extra project folder holding the hit; omitted for the workdir. */
  folder?: string;
}

/**
 * A project file's text from GET /boards/:id/project-files/content (Review tab / Files page editor).
 * `path` is the same id as `ProjectFileHit.insert`: relative to the board workdir, or absolute inside an extra folder.
 */
export interface ProjectFileContent {
  path: string;
  content: string;
  /** Bytes on disk. */
  size: number;
  /** Last modification time; send it back on save so a concurrent change is refused (409). */
  mtimeMs: number;
}

/**
 * A Files-tree mutation (POST /boards/:id/project-files/ops, POST /fs/ops). Paths are file ids as in
 * `ProjectFileHit.insert` (relative to the workdir / folder, or absolute inside an extra folder);
 * directories may end with "/". Targets must not exist yet (409); missing parents of a new path are created.
 */
export type FileOp =
  | { op: "create-file"; path: string }
  | { op: "create-dir"; path: string }
  /** Rename or move a file or directory. */
  | { op: "rename"; from: string; to: string }
  /** Copy a file or directory (recursively). */
  | { op: "copy"; from: string; to: string }
  /** Delete a file or directory (recursively, permanently). */
  | { op: "delete"; path: string };

/** The item a `FileOp` produced (`path` normalized; directories end with "/"); for delete, the removed item. */
export interface FileOpResult {
  path: string;
  kind: "file" | "dir";
}

/** Server-sent events on GET /api/v1/events. */
export type ServerEvent =
  | { type: "board.updated"; board: Board }
  | { type: "board.deleted"; boardId: string }
  | { type: "task.updated"; task: Task }
  | { type: "task.deleted"; taskId: string; boardId: string }
  /** A scheduler was created or changed (config, enabled, or it ran). */
  | { type: "scheduler.updated"; scheduler: Scheduler }
  | { type: "scheduler.deleted"; schedulerId: string; boardId: string }
  | { type: "comment.added"; comment: Comment; boardId: string }
  | { type: "comment.updated"; comment: Comment; boardId: string }
  | { type: "comment.deleted"; commentId: string; taskId: string; boardId: string }
  /**
   * Live, NOT persisted: what became of a comment steered into the card's running agent. `sent`:
   * omp took it mid-run (it reaches the agent at its next step); `delivered`: it reached the agent;
   * `deferred`: the run could not take it (wrapping up, or omp declined), the next run picks it up.
   */
  | { type: "comment.steer"; commentId: string; taskId: string; boardId: string; state: SteerState }
  | { type: "run.updated"; run: Run; boardId: string }
  | { type: "run.event"; event: RunEvent; boardId: string }
  /** Files of a card (`taskId`) or the board's shared files (`taskId` null) changed. */
  | { type: "files.updated"; boardId: string; taskId: string | null }
  /**
   * The agent queue changed: running and queued task ids, queued in start order.
   * `nodes`: cluster mode, the machine each running card runs on (task id → node); `{}` otherwise.
   */
  | {
      type: "queue.updated";
      running: string[];
      queued: string[];
      nodes: Record<string, { id: string; name: string }>;
    }
  /** Live, NOT persisted: subagent progress between its persisted `agent` events. */
  | { type: "run.agent"; runId: string; taskId: string; boardId: string; agent: SubagentSnapshot }
  /**
   * Live, NOT persisted: how full the run's context window is, after each assistant message and
   * context compaction. The latest value is also served as `DashboardLiveAgent.context`.
   * `usage`: the omp session's own spend so far (USD and total tokens, from `get_session_stats`;
   * subagents excluded); absent when omp did not report it.
   */
  | {
      type: "run.context";
      runId: string;
      taskId: string;
      boardId: string;
      context: ContextUsage;
      usage?: { costUsd: number; tokens: number };
    }
  /**
   * Live, NOT persisted: memory and CPU of the run's process tree, every few seconds while it
   * runs. The last sample is stored as `Task.resources` when the run ends.
   */
  | { type: "run.resources"; runId: string; taskId: string; boardId: string; resources: AgentResources }
  /**
   * Live, NOT persisted: streaming assistant output while a message is being generated.
   * `text` is the accumulated content of the current message so far (not just the delta), so a
   * client that missed frames still renders correctly. Superseded by the persisted `run.event`
   * (kind text/thinking) published at message end — clients drop the live block then.
   */
  | {
      type: "run.delta";
      runId: string;
      taskId: string;
      boardId: string;
      kind: "text" | "thinking";
      text: string;
    }
  /** Cluster membership, roles or node resources changed (lib/cluster); the full status. */
  | { type: "cluster.updated"; status: ClusterStatus }
  /** Something happened in the cluster a person should see (node offline, promotion, …). */
  | { type: "cluster.notice"; notice: ClusterNotice };

export interface ApiError {
  error: string;
}

/** A file shared on a card or on a board (GET /tasks/:id/files, GET /boards/:id/files). */
export interface SharedFile {
  /** Path relative to the files folder, `/`-separated (agents may create sub-folders). */
  name: string;
  /** Absolute path on the server (what an agent reads/writes). */
  path: string;
  size: number;
  modifiedAt: string;
}

export interface SharedFiles {
  /** Absolute folder holding these files; agents get it as an extra workspace directory. */
  folder: string;
  files: SharedFile[];
}

/** One project folder of a card's dedicated workspace (GET /tasks/:id/workspace). */
export interface WorkspaceFolder {
  /** Project folder on the board. */
  source: string;
  /** Where the agent works: the worktree, or `source` for a non-git (shared) folder. */
  path: string;
  /** Worktree branch; null for a shared folder. */
  branch: string | null;
  /** True when `path` is a dedicated git worktree. */
  isolated: boolean;
  /** False until the card's first run creates the worktree. */
  exists: boolean;
}

export interface TaskWorkspace {
  /** Board has dedicated workspaces on (Board.worktrees). */
  enabled: boolean;
  folders: WorkspaceFolder[];
}

/** One entry of the agent queue (GET /queue). */
export interface QueueEntry {
  taskId: string;
  boardId: string;
  boardName: string;
  title: string;
  state: "running" | "queued";
  /** Blocking cards (Task.blockedBy) that are not Done yet; the run waits for them. */
  waitingFor: string[];
  /** Held until the smart-queue planner has ordered its project's queued cards. */
  planning: boolean;
  /** Why the smart-queue planner put the card where it is (one line); null when not planned. */
  planNote: string | null;
  /** Card whose agent created this card (Task.createdByTaskId); null when a person did. */
  createdByTaskId: string | null;
  /** SDLC progress derived from the card's todo list (lib/sdlc.ts); null until the agent keeps one. */
  sdlc: SdlcProgress | null;
  /** Cluster node running the card (running entries in cluster mode); null otherwise. */
  node: { id: string; name: string } | null;
}

/** The agent limit in effect and where it comes from (GET /queue). */
export interface ConcurrencyInfo {
  /** `auto`: derived from the machine; `manual`: the number set in Settings or MAX_AGENTS. */
  mode: "auto" | "manual";
  /** Agents allowed to run at once right now. */
  limit: number;
  /**
   * What bounds an automatic limit (logical cores, free memory, or the hard cap); null when manual.
   * `load`: the load guard holds new runs (either mode); the limit is then the agents running.
   * `resources`: the resource guard (memory/CPU %, see ResourcePressure) holds new runs (either
   * mode, wins over `load`); the limit is then the agents running.
   */
  boundBy: "cpu" | "memory" | "max" | "load" | "resources" | null;
  /** Logical cores available to the server. */
  cpus: number;
  freeMemoryBytes: number;
  totalMemoryBytes: number;
  /** One line for the UI, e.g. "Auto: 12 parallel (16 cores, 28 GB free)". */
  reason: string;
  /**
   * Auto mode: memory one agent is expected to need, learned from the peak memory of recent runs
   * (lib/agent/concurrency.ts AgentMemoryModel; AGENT_MEMORY_BYTES until enough runs finished).
   */
  agentMemoryBytes?: number;
  /**
   * Auto mode: memory still promised to running agents that have not grown to `agentMemoryBytes`
   * yet (just started); subtracted from the free memory so a burst of launches cannot overcommit.
   */
  committedMemoryBytes?: number;
  /**
   * Cluster mode (primary): `limit` = `localLimit` (this machine's own limit; 0 when
   * `clusterRunLocal` is off) + `remoteSlots` (the slots of the `nodes` online replicas that can run
   * omp and take new cards) + the cards running on online replicas that take none (stale status,
   * failing health checks, a resource or load guard holding).
   */
  cluster?: { localLimit: number; nodes: number; remoteSlots: number };
  /** Latest resource-guard sample; null before the first one and on a replica (its holds go to the primary with its status). */
  pressure?: ResourcePressure | null;
}

export interface QueueSnapshot {
  /** Max agents running at once (the effective limit, `concurrency.limit`). */
  limit: number;
  concurrency: ConcurrencyInfo;
  running: QueueEntry[];
  /** Start order. */
  queued: QueueEntry[];
  /** Projects whose queued cards the smart-queue planner is ordering right now. */
  planning: { boardId: string; boardName: string }[];
}

/** A machine resource the resource guard watches. */
export type PressureResource = "memory" | "cpu";

/**
 * System-wide memory/CPU guard (lib/agent/resource-guard.ts), sampled every 5 s: holds queued cards
 * (starts no new runs; running agents are never touched) while memory or sustained CPU is at or
 * above its hold %, and releases them once each held resource is below its resume % (hysteresis).
 * Thresholds come from OMP_UI_* variables, re-read live from `.env`.
 */
export interface ResourcePressure {
  /** Memory in use, % of the total (container limit included), as of `sampledAt`. */
  memoryPercent: number;
  /** Host CPU busy %, averaged over `cpuWindowSec`; null until two samples exist. */
  cpuPercent: number | null;
  /** Seconds the CPU average spans: the sustain window, or less shortly after start. */
  cpuWindowSec: number;
  /** OMP_UI_MEMORY_HOLD_PCT (default 75; 0 = memory guard off). */
  memoryHoldPct: number;
  /** OMP_UI_MEMORY_RESUME_PCT (default hold − 10, i.e. 65). */
  memoryResumePct: number;
  /** OMP_UI_CPU_HOLD_PCT (default 75; 0 = CPU guard off). */
  cpuHoldPct: number;
  /** OMP_UI_CPU_RESUME_PCT (default hold − 10, i.e. 65). */
  cpuResumePct: number;
  /** OMP_UI_CPU_SUSTAIN_SEC: the CPU average must stay at/above the hold % over this window (default 30). */
  cpuSustainSec: number;
  /** Resources holding new runs right now; empty = not holding. */
  holding: PressureResource[];
  /** When the current hold began (ISO); null while not holding. */
  heldSince: string | null;
  /**
   * OMP_UI_RESOURCE_RESTART_MIN: graceful restart after this many minutes of memory pressure; 0 = off
   * (default, and always when the server does not run under bin/supervisor.mjs).
   */
  restartAfterMin: number;
  /**
   * The memory hold outlasted `restartAfterMin`: the server restarts once no agent runs,
   * provided cards are queued (CPU pressure never restarts).
   */
  restartPending: boolean;
  sampledAt: string;
}

// --- Cluster mode (lib/cluster) ---------------------------------------------------------------

/**
 * Role of this omp-ui server. `standalone`: no cluster (default). `primary`: coordinates the
 * cluster, owns the database and dispatches runs to nodes. `replica`: a joined node that runs
 * cards for the primary, keeps a replicated copy of its state and can be promoted to primary.
 */
export type ClusterRole = "standalone" | "primary" | "replica";

/** A node's machine, as it reports it every few seconds. */
export interface NodeResources {
  hostname: string;
  platform: string;
  arch: string;
  cpus: number;
  /** 1-minute load average (0 on Windows). */
  loadAvg1: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  sampledAt: string;
}

/** Whether a node can start omp, and with which binary. */
export interface NodeOmpInfo {
  ready: boolean;
  version: string | null;
  /** `primary`: the primary's binary, shared automatically; `local`: omp installed on the node. */
  source: "primary" | "local" | null;
  /** Why it is not ready (downloading, unsupported platform, …); null when ready. */
  reason: string | null;
}

export interface ClusterNodeStatus {
  nodeId: string;
  name: string;
  role: "primary" | "replica";
  /** This entry is the server answering the request. */
  self: boolean;
  online: boolean;
  /** `host:port` of the node's cluster channel. */
  address: string;
  /** The node's own web UI, e.g. http://10.0.0.7:3000; null when unknown. */
  httpUrl: string | null;
  version: string;
  joinedAt: string;
  lastSeenAt: string;
  resources: NodeResources | null;
  /** Agents allowed at once on the node (its automatic or manual limit). */
  slots: number;
  /** Cards running on the node now. */
  runningTaskIds: string[];
  omp: NodeOmpInfo;
  /** Replicas: how far the replicated copy of the primary's state is behind; null for the primary. */
  replication: { seq: number; at: string | null; lagSeconds: number | null } | null;
  latencyMs: number | null;
  /** Auto-healing view of a replica (the primary's answer only); null for the primary itself and on replicas. */
  health: ClusterNodeHealth | null;
}

/**
 * - `ok`: passes its health checks.
 * - `failing`: `failures` checks failed in a row, still below `clusterHealFailures`.
 * - `offline`: offline; a restart is attempted after `clusterHealOfflineSeconds` (`nextAttemptAt`).
 * - `restarting`: asked to restart, waiting for it to reconnect.
 * - `paused`: `clusterHealMaxRestarts` attempts in a row did not help; no more automatic restarts
 *   until it has been online and healthy for 10 minutes, or the auto-healing settings change.
 * - `off`: auto-healing is turned off (`clusterAutoHeal`).
 */
export type ClusterNodeHealthState = "ok" | "failing" | "offline" | "restarting" | "paused" | "off";

export interface ClusterNodeHealth {
  state: ClusterNodeHealthState;
  /** Failed health checks in a row. */
  failures: number;
  /** Latest problem (failed check, unreachable or refused restart); null while healthy. */
  problem: string | null;
  /** Restart attempts in a row without the node staying healthy for 10 minutes. */
  restarts: number;
  lastCheckAt: string | null;
  lastRestartAt: string | null;
  /** When the next restart attempt is due while offline or backing off; null otherwise. */
  nextAttemptAt: string | null;
}

export interface ClusterNotice {
  id: string;
  level: "info" | "warning" | "error";
  message: string;
  at: string;
}

/** GET /cluster: this server's view of the cluster. */
export interface ClusterStatus {
  role: ClusterRole;
  nodeId: string;
  nodeName: string;
  /** Election term of the current primary (bumped by every promotion); 0 when standalone. */
  term: number;
  /**
   * The cluster's home primary (the node that enabled cluster mode). After a failover it is
   * promoted back automatically once it returns and has caught up (failback); null when standalone.
   */
  preferredPrimaryId: string | null;
  /** TCP port of this server's cluster channel. */
  port: number;
  /** Replicas: the primary they follow; null otherwise. */
  primary: { nodeId: string | null; name: string; httpUrl: string } | null;
  /** Replicas: the link to the primary; null otherwise. */
  connection: {
    state: "connected" | "connecting" | "electing";
    since: string;
    error: string | null;
    latencyMs: number | null;
  } | null;
  /** `AppSettings.clusterRunLocal`. */
  runLocal: boolean;
  /** Every known node, this one included (empty when standalone). */
  nodes: ClusterNodeStatus[];
  totals: {
    nodes: number;
    online: number;
    cpus: number;
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    slots: number;
    running: number;
  };
  /** Latest notices, newest first (at most 20). */
  notices: ClusterNotice[];
}

/** GET /cluster/token (admins): what a new machine needs to join. */
export interface ClusterJoinInfo {
  token: string;
  /** The primary's base URL the command uses. */
  url: string;
  /** One line to paste on the new machine, e.g. `curl -fsSL <url>/api/v1/cluster/join | sh -s -- <token>`. */
  joinCommand: string;
}

/** POST /cluster/test: can this server reach (and authenticate with) the given primary? */
export interface ClusterTestResult {
  ok: boolean;
  latencyMs: number | null;
  node: { nodeId: string; name: string; role: ClusterRole; term: number; version: string } | null;
  error: string | null;
}

/** GET /cluster/info (public): what a joining machine needs before it authenticates. */
export interface ClusterInfo {
  version: string;
  protocol: number;
  role: ClusterRole;
  /**
   * A replica's link to its primary (the state only: the route is public, the error text stays
   * behind authentication); null on a primary or standalone server. The join script waits for
   * `connected`.
   */
  connection: "connected" | "connecting" | "electing" | null;
  /** TCP port of the cluster channel. */
  port: number;
  platform: string;
  arch: string;
  nodeVersion: string;
  /**
   * The primary's omp binary (downloadable from /cluster/runtime/omp when platform/arch match);
   * `sha256` lets the join script verify it and store it where the node's server looks for it.
   */
  omp: { available: boolean; version: string | null; sha256: string | null };
}

/** A card with its project's name, for cross-project lists on the home dashboard. */
export type DashboardCard = Pick<
  Task,
  | "id"
  | "boardId"
  | "title"
  | "status"
  | "agentState"
  | "agentError"
  | "commentCount"
  | "openCommentCount"
  | "lastRunId"
  | "updatedAt"
> & { boardName: string };

/**
 * Why a card needs the user: its agent `failed`, or it sits In progress with no agent working
 * on it (`stalled`: stopped, or never started on a board without auto-run).
 */
export type AttentionReason = "failed" | "stalled";

export interface DashboardBoard extends BoardWithCounts {
  /** Latest card change on the board, else the board's own update. */
  lastActivityAt: string;
  /** Cards on this board that need the user (see AttentionReason). */
  attentionCount: number;
  /** Cards on this board waiting on the user by the home page's broader rules (NeedsYouReason). */
  needsYouCount: number;
  /** Agent runs that ended in the last 30 days (stopped runs are not counted). */
  runs30d: { succeeded: number; failed: number };
  /** Git status per project folder (workdir first); cached for a few seconds on the server. */
  git: GitStatus[];
}

/**
 * Why a card waits on the user on the home page, most urgent first: the agent asked a
 * `question`; it `failed`; it failed and an automatic retry is scheduled (`retrying`); unresolved
 * `feedback` comments with no agent working; `stalled` (see AttentionReason); or it is Done but
 * its changes were not pushed yet (`unpushed`, only for projects that can push, recent cards).
 */
export type NeedsYouReason = "question" | "failed" | "retrying" | "feedback" | "stalled" | "unpushed";

export interface NeedsYouCard extends DashboardCard {
  /** Every reason that applies, most urgent first. */
  reasons: NeedsYouReason[];
  /** The agent's question (truncated); null unless `reasons` includes "question". */
  question: string | null;
  retryAt: string | null;
  pushedAt: string | null;
}

/** A running or queued agent on the home page (one per QueueSnapshot entry). */
export interface DashboardLiveAgent {
  taskId: string;
  /** When the current run started; null while queued. */
  startedAt: string | null;
  /** Model the run uses, when known (board/settings model or the auto-selected one). */
  model: string | null;
  /** Latest thing the agent did (tool call, status or first line of its text). */
  activity: string | null;
  activityAt: string | null;
  /** Context window fill of the current run, when the agent reported it; null otherwise. */
  context: ContextUsage | null;
}

/** Agent runs and shipped cards in a time window. */
export interface DashboardStatsWindow {
  /** Runs that ended in the window (succeeded, failed or stopped). */
  runs: number;
  succeeded: number;
  failed: number;
  /** Mean wall time of succeeded + failed runs; null when there were none. */
  avgDurationMs: number | null;
  /** Cards pushed to the project's push branch (Task.pushedAt). */
  shipped: number;
  /** Cards created. */
  created: number;
}

export interface DashboardStats {
  /** Last 24 hours. */
  day: DashboardStatsWindow;
  /** Last 7 × 24 hours. */
  week: DashboardStatsWindow;
  /** The same 7 days as rolling 24-hour buckets, oldest first. */
  daily: Pick<DashboardStatsWindow, "runs" | "succeeded" | "failed" | "shipped">[];
}

export type DashboardActivityKind = "created" | "succeeded" | "failed" | "stopped" | "pushed";

/** One entry of the home page's recent activity feed. */
export interface DashboardActivity {
  kind: DashboardActivityKind;
  at: string;
  taskId: string;
  boardId: string;
  boardName: string;
  title: string;
  /** Run wall time for succeeded/failed/stopped. */
  durationMs: number | null;
  /** First line of the error for failed runs; "by an agent" style notes otherwise. */
  detail: string | null;
}

/** GET /dashboard — everything the home page shows, in one request. */
export interface Dashboard {
  generatedAt: string;
  /** Most recently active first. */
  boards: DashboardBoard[];
  /** Cards per column across every project. */
  totals: Record<TaskStatus, number>;
  /**
   * Failed first, then stalled; most recently changed first within each. At most 12; the full
   * count is the sum of `boards[].attentionCount`.
   */
  attention: (DashboardCard & { reason: AttentionReason })[];
  /** Done cards an agent worked on, most recently finished first (at most 6). */
  finished: DashboardCard[];
  /** Cards waiting on the user, most urgent first (at most 50; the full count is `needsYouTotal`). */
  needsYou: NeedsYouCard[];
  needsYouTotal: number;
  queue: QueueSnapshot;
  /** Run details for every running and queued entry of `queue`. */
  live: DashboardLiveAgent[];
  stats: DashboardStats;
  /** Newest first, at most 12. */
  activity: DashboardActivity[];
  /** Getting-started progress beyond "has a project". */
  setup: {
    hasCard: boolean;
    hasRun: boolean;
    hasDone: boolean;
    /** A card was pushed to the project's push branch at least once. */
    hasPush: boolean;
    /** The settings were saved at least once. */
    settingsSaved: boolean;
    /** The docker CLI reaches a daemon (cached for a few minutes). */
    dockerAvailable: boolean;
  };
}

/** GET /fs/browse — server-side folder picker. */
export interface FsEntry {
  name: string;
  /** Absolute path. */
  path: string;
  isGitRepo: boolean;
}

export interface FsBrowseResult {
  /** Absolute path being listed. */
  path: string;
  /** Parent directory, or null at filesystem root. */
  parent: string | null;
  /** WORKSPACE_DIR: default start folder and clone destination. */
  workspaceRoot: string;
  /** Sub-directories only (no files), hidden dirs excluded, sorted by name. */
  entries: FsEntry[];
}

export type GitProvider = "github" | "gitlab" | "other";

/** GET /boards/:id/git returns one entry per project folder (workdir first, then extraFolders). */
export interface GitStatus {
  /** Absolute project folder this status describes. */
  folder: string;
  isRepo: boolean;
  branch: string | null;
  /** origin's default branch (origin/HEAD), falling back to "main"/"master". */
  defaultBranch: string | null;
  remoteUrl: string | null;
  /** https URL of the repository web page, if derivable from the remote. */
  webUrl: string | null;
  provider: GitProvider | null;
  /** Uncommitted changes present. */
  dirty: boolean;
  changedFiles: number;
  /** Commits ahead/behind the upstream of the current branch (0 if no upstream). */
  ahead: number;
  behind: number;
  /** `gh` (GitHub) or `glab` (GitLab) CLI is installed for creating PR/MRs. */
  prCliAvailable: boolean;
}

export interface GitBranch {
  /** Branch name without `refs/heads/` / `origin/`. */
  name: string;
  /** Exists only on origin; switching to it creates a local branch tracking it. */
  remoteOnly: boolean;
}

/** GET /boards/:id/git/branches?folder=<abs>: local branches (newest first), then origin-only ones. */
export interface GitBranches {
  folder: string;
  /** Checked-out branch, or null on a detached HEAD. */
  current: string | null;
  branches: GitBranch[];
}

/** POST /boards/:id/git/branches: the folder's status after switching, then pulling (fast-forward only). */
export interface GitSwitchResult extends GitStatus {
  /** Commits fast-forwarded from the upstream after the switch (0: up to date, no upstream, or failed). */
  pulled: number;
  /** Why the pull failed (the switch itself still happened); null when it succeeded or was skipped. */
  pullError: string | null;
}

/** Outcome for one folder of a push / PR action. */
export interface GitRepoActionResult {
  folder: string;
  /** Branch that was pushed (null if nothing happened for this folder). */
  branch: string | null;
  /** Commit created for uncommitted changes, or null if the tree was clean. */
  commit: string | null;
  /** PR/MR URL (pr) or repository/commit URL (push), if known. */
  url: string | null;
  /** Combined git/gh/glab output, for display. */
  output: string;
  /** Error for this folder; other folders still proceed. */
  error: string | null;
  /** True when the folder had nothing to commit or push. */
  skipped: boolean;
}

/**
 * POST /tasks/:id/git/push and POST /tasks/:id/git/pr. Acts on every project folder that is a
 * git repo with changes (uncommitted or unpushed), or only on `folders` when given.
 */
export interface GitActionResult {
  action: "push" | "pr";
  results: GitRepoActionResult[];
  /** The agent comment posted on the task describing the result (links included). */
  comment: Comment;
}

/** POST /boards/:id/git/push — header quick push of every project repo to the project's push branch. */
export interface BoardPushResult {
  results: GitRepoActionResult[];
}

/** GET /system/restart — can the "Restart server" button restart this server, and the last restart. */
export interface RestartStatus {
  /** Whether the button can restart this server; `reason` says why not. */
  available: boolean;
  /**
   * "cli": started by `omp-ui up`/`start`; "pm2": supervised by pm2; "systemd": the omp-ui.service user
   * unit (restarted via `systemctl --user restart`; its `up --foreground` rebuilds when the sources changed).
   */
  mode: "cli" | "pm2" | "systemd" | null;
  reason: string | null;
  /** Agents that a restart would interrupt. */
  running: number;
  /** Tail of the last restart's output (`DATA_DIR/restart.log`), or null when there was none. */
  log: string | null;
  /** The last restart's build failed, so the previous build was started instead. */
  buildFailed: boolean;
  /** A restart was requested and its CLI process is still running. */
  restarting: boolean;
}

/** GET /stats/system — host + app statistics. Byte counts are bytes; times are seconds. */
export interface SystemStats {
  generatedAt: string;
  host: {
    hostname: string;
    platform: string;
    arch: string;
    release: string;
    uptimeSec: number;
    nodeVersion: string;
  };
  /** usagePercent is sampled over ~200ms across all cores (0–100). */
  cpu: { model: string; cores: number; loadAvg: [number, number, number]; usagePercent: number };
  memory: { totalBytes: number; usedBytes: number; freeBytes: number };
  /** Filesystem holding DATA_DIR (statfs); null if unavailable. */
  disk: { path: string; totalBytes: number; usedBytes: number; freeBytes: number } | null;
  process: { pid: number; uptimeSec: number; rssBytes: number; heapUsedBytes: number };
  app: {
    version: string;
    db: "sqlite" | "mongodb" | "postgres";
    boards: number;
    tasks: Record<TaskStatus, number>;
    agentsRunning: number;
    agentsQueued: number;
  };
  /** Resource guard: latest memory/CPU % against its thresholds; null where it does not run (replica, before boot). */
  resourceGuard: ResourcePressure | null;
}

// ---------------------------------------------------------------------------------------------
// Maintenance: GET /stats/maintenance (analyze) and POST /stats/maintenance (clean up / free)

/**
 * What a process is to AgentMan:
 * - server: this server or one of its ancestors (supervisor, pm2…); never ended from the UI
 * - card-agent: a running card's omp agent (stop the card instead)
 * - helper: a pooled omp helper (advisor, queue planner…) of this server
 * - orphan-agent: an omp agent of this DATA_DIR that this server no longer tracks (left by a crash)
 * - agent-spawned: started by an omp process (dev servers, browsers, test runners…)
 * - omp: another omp process (your own sessions, daemons)
 * - user: any other process of the server's user
 * - system: a process of another user (not killable)
 */
export type ProcessTag =
  | "server"
  | "card-agent"
  | "helper"
  | "orphan-agent"
  | "agent-spawned"
  | "omp"
  | "user"
  | "system";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  user: string;
  /** Executable name, e.g. "node", "omp", "chrome". */
  name: string;
  /** Full command line (truncated). */
  command: string;
  /** Share of one core over the sample window (can exceed 100 on several cores). */
  cpuPercent: number;
  rssBytes: number;
  /** Seconds since the process started; null when unknown. */
  elapsedSec: number | null;
  tag: ProcessTag;
  /** card-agent / orphan-agent: the card it runs for, when known. */
  taskId: string | null;
  taskTitle: string | null;
  taskBoardId: string | null;
  /** Owned by the server's user and not protected: POST { action: "kill" } accepts it. */
  killable: boolean;
}

/** Storage the cleanup can free. Docker ids map to `docker <kind> prune -f`. */
export const CLEANUP_IDS = [
  "orphan-card-files",
  "orphan-board-files",
  "orphan-workspaces",
  "shipped-workspaces",
  "run-configs",
  "drafts",
  "diff-cache",
  "rotated-logs",
  "database",
  "docker-images",
  "docker-builder",
  "docker-containers",
  "docker-volumes",
  "docker-networks",
] as const;
export type CleanupId = (typeof CLEANUP_IDS)[number];

export interface CleanupItem {
  id: CleanupId;
  label: string;
  description: string;
  /** Bytes the cleanup should free (an estimate for Docker and the database); null when unknown. */
  bytes: number | null;
  /** Files, folders or objects it would remove. */
  count: number;
  /** "safe": regenerated or unused data, included in "Clean up all safe items"; "review": may remove something you still want. */
  risk: "safe" | "review";
  /** Nothing to do (count 0 / bytes 0) or not applicable on this setup. */
  empty: boolean;
}

/** Space used outside AgentMan's own data; shown for context, never deleted from the UI. */
export interface StorageUsage {
  label: string;
  path: string;
  bytes: number | null;
  note: string;
}

export type MaintenanceAction =
  | { kind: "cleanup"; ids: CleanupId[] }
  | { kind: "kill"; pids: number[] }
  | { kind: "release-memory" }
  | { kind: "stop-card"; taskId: string };

export interface MaintenanceRecommendation {
  id: string;
  area: "cpu" | "memory" | "storage";
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  /** One-click fix; null when it needs a look first. */
  action: MaintenanceAction | null;
  actionLabel: string | null;
}

export interface MaintenanceReport {
  generatedAt: string;
  /** How long the analysis took. */
  durationMs: number;
  /** Process list could not be read (unsupported platform…); null when it worked. */
  processError: string | null;
  /** Top CPU and memory users plus every agent-related process. */
  processes: ProcessInfo[];
  cpu: { cores: number; usagePercent: number; loadAvg: [number, number, number] };
  memory: {
    totalBytes: number;
    /** Memory the OS can hand out without swapping (MemAvailable on Linux). */
    availableBytes: number;
    swapTotalBytes: number | null;
    swapUsedBytes: number | null;
    server: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number };
    /** Warm omp helper workers waiting for the next call. */
    idleHelpers: { count: number; rssBytes: number };
  };
  storage: {
    disk: SystemStats["disk"];
    dataDir: string;
    dataBytes: number | null;
    cleanup: CleanupItem[];
    /** Sum of non-empty "safe" cleanup items. */
    safeBytes: number;
    other: StorageUsage[];
    dockerError: string | null;
  };
  recommendations: MaintenanceRecommendation[];
}

export interface MaintenanceStepResult {
  /** A cleanup id, `kill:<pid>`, `release-memory` or `stop-card:<id>`. */
  id: string;
  ok: boolean;
  message: string;
  /** Bytes freed on disk or in memory, when measurable. */
  freedBytes: number | null;
}

export interface MaintenanceResult {
  results: MaintenanceStepResult[];
  freedBytes: number;
}

/** A cleanup the schedule may run, as shown in Settings (texts from the Maintenance targets). */
export interface CleanupTargetInfo {
  id: ScheduledCleanupId;
  label: string;
  description: string;
  risk: "safe" | "review";
}

/** GET|POST /api/v1/settings/cleanup: the scheduled cleanup's configuration and last outcome. */
export interface CleanupStatus {
  schedule: CleanupSchedule;
  targets: ScheduledCleanupId[];
  /** Every schedulable target with label/description/risk taken from lib/maintenance.ts TARGETS. */
  available: CleanupTargetInfo[];
  /** ISO. */
  lastRunAt: string | null;
  lastTrigger: "manual" | "scheduled" | null;
  lastResult: MaintenanceResult | null;
  /** ISO; null when schedule is "off". */
  nextRunAt: string | null;
  /** A cleanup is in progress right now. */
  running: boolean;
}

/** A `.tar.gz` of this server's data: an automatic backup taken before an import (DATA_DIR/backups). */
export interface DataBackup {
  name: string;
  size: number;
  /** ISO. */
  createdAt: string;
}

/** GET /api/v1/data-transfer: what an export of this server holds, and whether an import may run. */
export interface DataTransferStatus {
  driver: "sqlite" | "mongodb" | "postgres";
  users: number;
  projects: number;
  cards: number;
  schedulers: number;
  /** Bytes of card and project shared files (DATA_DIR/files). */
  filesBytes: number;
  /** "env": CREDENTIALS_KEY seals the saved secrets, so exports leave the key out. */
  credentialsKey: "env" | "file";
  /** Agents running or queued: an import waits until there are none. */
  activeAgents: number;
  /** An import is in progress. */
  importing: boolean;
  /** Newest first. */
  backups: DataBackup[];
}

/**
 * How the imported secrets can be opened. "restored": the archive's credentials key is installed;
 * "ignored": installed, but this server's CREDENTIALS_KEY takes precedence; "set-env": the source
 * server used CREDENTIALS_KEY, so set the same value here; "none": the source had no key.
 */
export type ImportedCredentialsKey = "restored" | "ignored" | "set-env" | "none";

/** POST /api/v1/data-transfer/import. */
export interface DataImportResult {
  source: { appVersion: string; createdAt: string; driver: string };
  /** Rows imported per table (settings, users, boards, tasks, comments, runs, run_events, schedulers, scheduler_runs). */
  counts: Record<string, number>;
  /** Rows left out because what they belong to (project, card, run, scheduler) is not in the archive. */
  skipped: number;
  /** Shared files restored. */
  files: number;
  credentialsKey: ImportedCredentialsKey;
  /** Cards whose agent was running or queued in the source: stopped (Resume continues them). */
  interrupted: number;
  /** The data this server held before the import. */
  backup: DataBackup;
  /** The caller's session ended (the import replaced the accounts or the token secret): sign in again. */
  signedOut: boolean;
}

export interface AiQuotaLimit {
  id: string;
  label: string;
  /** e.g. "5 Hour", "7 Day". */
  windowLabel: string | null;
  resetsAt: string | null;
  used: number | null;
  limit: number | null;
  /** 0–1. */
  usedFraction: number | null;
  /** e.g. "percent", "requests", "tokens", "usd". */
  unit: string | null;
  /** Provider-reported status, e.g. "ok", "warning", "exhausted". */
  status: string | null;
}

export interface AiProviderQuota {
  provider: string;
  /** Account label (email/org) if reported. */
  account: string | null;
  fetchedAt: string | null;
  limits: AiQuotaLimit[];
}

export interface AiModelUsage {
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

/** GET /stats/ai — from `omp usage --json` (quota) and `omp stats --json` (usage). Cached 60s. */
export interface AiStats {
  generatedAt: string;
  quota: { available: boolean; error: string | null; providers: AiProviderQuota[] };
  usage: {
    available: boolean;
    error: string | null;
    totals: {
      requests: number;
      failedRequests: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      costUsd: number;
      firstAt: string | null;
      lastAt: string | null;
    } | null;
    byModel: AiModelUsage[];
  };
}

/** A value omp's config.yml holds for one editable key; null = not set (omp's default applies). */
export type OmpConfigValue = string | number | boolean | null;

export type OmpConfigFieldType = "model" | "enum" | "boolean" | "number" | "string";

/** One editable key of omp's user config (GET /omp-config `schema`). */
export interface OmpConfigField {
  /** Dotted omp setting key, e.g. "defaultThinkingLevel"; model roles are "modelRoles.<role>". */
  key: string;
  label: string;
  type: OmpConfigFieldType;
  group: "models" | "behavior" | "tools";
  help: string;
  /** `enum` choices, in omp's order. */
  options?: { value: string; label: string }[];
  /** `number` bounds (integers). */
  min?: number;
  max?: number;
  placeholder?: string;
}

/** GET/PUT /omp-config: omp's user-level config.yml. */
export interface OmpConfigSnapshot {
  /** Absolute path of the config file (it may not exist yet). */
  path: string;
  /** Where the previous version is kept on every save. */
  backupPath: string;
  format: "yaml";
  exists: boolean;
  /** Content hash of `raw`; send it back on PUT to refuse saving over a newer file. */
  version: string;
  raw: string;
  /** Schema key → value set in the file (null when unset). */
  values: Record<string, OmpConfigValue>;
  /** Schema key → value omp uses when the file leaves it unset. */
  defaults: Record<string, OmpConfigValue>;
  schema: OmpConfigField[];
  /** Every key the file sets (dotted, as `omp config list --scope global` reports it) → its value; secrets left out. */
  settings: Record<string, OmpSettingValue>;
  /** Secret keys (omp redacts them) the file sets. */
  secretsSet: string[];
}

/** Any value of an omp setting: scalars, lists (`array`) and mappings (`record`). */
export type OmpSettingValue = string | number | boolean | null | OmpSettingValue[] | { [key: string]: OmpSettingValue };

export type OmpSettingType = "boolean" | "number" | "string" | "enum" | "array" | "record";

/** One of every setting omp knows (GET /omp-config/settings), from `omp config list` on an empty config. */
export interface OmpSettingInfo {
  key: string;
  type: OmpSettingType;
  description: string;
  /** `enum` choices, as `omp config set` validates them; empty when omp did not report them. */
  options: string[];
  /** omp's built-in default (null when it has none, or for secrets). */
  default: OmpSettingValue;
  /** omp redacts the value (tokens, passwords). */
  secret: boolean;
}

/** PUT /omp-config: structured `values` (form keys or any omp setting key; null unsets it) or a whole `raw` file. */
export type OmpConfigUpdate =
  | { values: Record<string, OmpSettingValue>; version?: string }
  | { raw: string; version?: string };

/** One chat model of `omp models --json`. */
export interface OmpModel {
  /** "provider/model-id": what omp's model settings take (optionally with ":<thinking>"). */
  selector: string;
  name: string;
  provider: string;
  /** Thinking levels the model supports; empty when it does not reason. */
  thinking: string[];
}

/** `AGENTMEMORY_ENABLED`: auto (default) starts the memory server when agentmemory is installed. */
export type MemoryEnabledMode = "auto" | "true" | "false";

/** GET /memory: the local agentmemory server (https://github.com/rohitg00/agentmemory) and its OMP hook-up. */
export interface MemoryStatus {
  enabled: MemoryEnabledMode;
  /** The `agentmemory` CLI was found (global install on PATH, or the npx cache). */
  installed: boolean;
  /** How the CLI was found. */
  installSource: "path" | "npx" | null;
  /** Server version when it answers, else the CLI's. */
  version: string | null;
  /** REST API base (`AGENTMEMORY_URL`, default http://127.0.0.1:3111). */
  url: string;
  /** Live viewer; binds to loopback on the server host by default. */
  viewerUrl: string;
  /** The REST API answered at all (even with an error). */
  reachable: boolean;
  /** `/agentmemory/health` reports ok/healthy/degraded. */
  healthy: boolean;
  /** A start through AgentMan is still running. */
  starting: boolean;
  /** Why the server is not healthy (unreachable, unauthorized, …). */
  error: string | null;
  /** Overall status of `/agentmemory/status` (ok|info|warn|error) and its one-line headline. */
  level: string | null;
  headline: string | null;
  /** Problems `/agentmemory/status` lists, each with its fix. */
  problems: { level: string; message: string; fix?: string }[];
  /** "bm25" (keyless) or the embedding provider ("local", "openai", …). */
  embeddings: string;
  /** Whether `embeddings` comes from the running server or from ~/.agentmemory/.env. */
  embeddingsSource: "server" | "config";
  /** LLM provider for summaries/consolidation ("noop" when keyless); null when the server is down. */
  llm: string | null;
  stats: MemoryStats | null;
  omp: {
    /** omp's agent dir (`omp config path`); null when omp is missing. */
    agentDir: string | null;
    /** `agentmemory connect omp` installed the extension and listed it in config.yml `extensions`. */
    connected: boolean;
    /** The connector also wired the MCP toolset (`--with-mcp`). */
    mcp: boolean;
    error: string | null;
  };
}

export interface MemoryStats {
  memories: number | null;
  sessions: number | null;
  observations: number | null;
  lessons: number | null;
}

/**
 * A git snapshot of one project folder's files (tracked and untracked, minus ignored ones) taken
 * before a card's run or before a restore. Stored as a commit under
 * `refs/agentman/checkpoints/<taskId>/<id>` without touching the branch, index or working tree.
 */
export interface TaskCheckpoint {
  /** Ref name tail; unique per task and repository. */
  id: string;
  /** Project folder (or the card's worktree of it) the snapshot was taken in. */
  folder: string;
  /** Commit sha of the snapshot. */
  sha: string;
  /** Run that started right after this snapshot; null for "Before restore" snapshots. */
  runId: string | null;
  label: string;
  createdAt: string;
  /** Files that differed from HEAD (uncommitted changes) when the snapshot was taken. */
  filesChanged?: number;
}
