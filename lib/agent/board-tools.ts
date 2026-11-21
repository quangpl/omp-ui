// Agent-to-agent collaboration: tools the server registers on every omp agent run over RPC
// (`set_host_tools`) and executes itself when omp sends `host_tool_call`. They are scoped to the
// calling card's board: an agent sees the board's cards, delegates work to new cards (each with
// its own agent), messages other cards' agents, and waits for cards to finish.
import type { Repository } from "@/lib/db/types";
import { publish, subscribe } from "@/lib/events";
import { listFiles } from "@/lib/files";
import { HttpError } from "@/lib/server/http";

import { TASK_STATUSES, type Comment, type Task, type TaskStatus } from "@/lib/types";

/** Cards one card's agent may create (runaway delegation guard). */
const MAX_CREATED_PER_CARD = 20;
/** Delegation chain depth: a person's card → agent card → agent card → agent card. */
const MAX_DELEGATION_DEPTH = 3;
const DEFAULT_WAIT_SECONDS = 900;
const MAX_WAIT_SECONDS = 3600;
const MAX_SUMMARY = 4000;
const MAX_COMMENT = 2000;
const RECENT_COMMENTS = 15;

/** What the tools need from the agent manager. */
export interface BoardToolHost {
  repo: Repository;
  /** Queue the card's agent (AgentManager.start). */
  start(taskId: string): Promise<Task>;
  /** Deliver feedback to the card's agent (AgentManager.onComment). */
  onComment(task: Task, comment: Comment): Promise<void>;
  /** Whether the card's agent is queued or running. */
  isBusy(taskId: string): boolean;
  /** The calling run starts (+1) / stops (-1) waiting; a waiting run lends its slot to the queue. */
  lendSlot(delta: 1 | -1): void;
}

export interface BoardToolCaller {
  taskId: string;
  boardId: string;
}

/** `set_host_tools` definitions (JSON Schema parameters). */
export const BOARD_TOOLS = [
  {
    name: "board_list_cards",
    label: "Board cards",
    description:
      "List the cards on this project's board (yours included): id, title, column and agent state. Other agents may be working on other cards right now.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...TASK_STATUSES], description: "Only cards in this column." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "board_read_card",
    label: "Read card",
    description:
      "Read one card of this board: description, recent comments, its agent's latest summary or error, its shared files (absolute paths you can read).",
    parameters: {
      type: "object",
      properties: { cardId: { type: "string" } },
      required: ["cardId"],
      additionalProperties: false,
    },
  },
  {
    name: "board_create_card",
    label: "Delegate to a new card",
    description:
      "Create a card on this board for a self-contained piece of work. With start=true (default) its own agent starts working on it in parallel (it waits in the agent queue while all slots are busy). Write a complete brief: the new agent does not see your conversation. Use board_wait_for_cards to collect the result.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short card title." },
        description: { type: "string", description: "Full, self-contained brief (markdown)." },
        start: { type: "boolean", description: "Start its agent now (default true). False parks it in To do." },
      },
      required: ["title", "description"],
      additionalProperties: false,
    },
  },
  {
    name: "board_message_card",
    label: "Message a card's agent",
    description:
      "Send a message to the agent of another card on this board, as feedback it must address: steered into its live session if it is running, otherwise it resumes that card's agent (a card in To do gets it when it starts).",
    parameters: {
      type: "object",
      properties: {
        cardId: { type: "string" },
        message: { type: "string" },
      },
      required: ["cardId", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "board_wait_for_cards",
    label: "Wait for cards",
    description:
      "Wait until every listed card's agent is no longer queued or running, then return each card's column, agent state and latest summary or error. While you wait, your agent slot is lent to the queue so the cards can run.",
    parameters: {
      type: "object",
      properties: {
        cardIds: { type: "array", items: { type: "string" }, minItems: 1 },
        timeoutSeconds: {
          type: "number",
          description: `Give up after this many seconds (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}).`,
        },
      },
      required: ["cardIds"],
      additionalProperties: false,
    },
  },
] as const;

export type BoardToolName = (typeof BOARD_TOOLS)[number]["name"];

export const BOARD_TOOL_NAMES: ReadonlySet<string> = new Set(BOARD_TOOLS.map((t) => t.name));

/** Run one tool call; the returned text is the tool result. Throws for a tool error. */
export async function runBoardTool(
  host: BoardToolHost,
  caller: BoardToolCaller,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  switch (name as BoardToolName) {
    case "board_list_cards":
      return listCards(host, caller, args);
    case "board_read_card":
      return readCard(host, caller, args);
    case "board_create_card":
      return createCard(host, caller, args);
    case "board_message_card":
      return messageCard(host, caller, args);
    case "board_wait_for_cards":
      return waitForCards(host, caller, args, signal);
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

// --- Tools -----------------------------------------------------------------------------------

async function listCards(host: BoardToolHost, caller: BoardToolCaller, args: Record<string, unknown>): Promise<string> {
  const status = args.status;
  if (status !== undefined && !(TASK_STATUSES as readonly unknown[]).includes(status)) {
    throw new Error(`status must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  const tasks = (await host.repo.listTasks(caller.boardId)).filter((t) => status === undefined || t.status === status);
  return JSON.stringify(
    tasks.map((t) => ({ ...cardHeader(t), ...(t.id === caller.taskId ? { you: true } : {}) })),
    null,
    2,
  );
}

async function readCard(host: BoardToolHost, caller: BoardToolCaller, args: Record<string, unknown>): Promise<string> {
  const task = await boardCard(host, caller, args.cardId);
  const [comments, runs, files] = await Promise.all([
    host.repo.listComments(task.id),
    host.repo.listRuns(task.id),
    listFiles("tasks", task.id),
  ]);
  const latest = runs[0];
  return JSON.stringify(
    {
      ...cardHeader(task),
      description: task.description,
      latestRun: latest
        ? {
            status: latest.status,
            summary: latest.summary ? truncate(latest.summary, MAX_SUMMARY) : null,
            error: latest.error,
          }
        : null,
      recentComments: comments.slice(-RECENT_COMMENTS).map((c) => ({
        from: c.fromTaskId ? `agent of card ${c.fromTaskId}` : c.author === "agent" ? "agent" : "user",
        resolved: c.resolved,
        body: truncate(c.body, MAX_COMMENT),
        at: c.createdAt,
      })),
      files: { folder: files.folder, files: files.files.map((f) => ({ path: f.path, size: f.size })) },
    },
    null,
    2,
  );
}

async function createCard(host: BoardToolHost, caller: BoardToolCaller, args: Record<string, unknown>): Promise<string> {
  const repo = host.repo;
  const title = text(args.title, "title", 200);
  const description = typeof args.description === "string" ? args.description.trim().slice(0, 20000) : "";
  const start = args.start === undefined ? true : args.start === true;

  const tasks = await repo.listTasks(caller.boardId);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (tasks.filter((t) => t.createdByTaskId === caller.taskId).length >= MAX_CREATED_PER_CARD) {
    throw new Error(`This card's agent already created ${MAX_CREATED_PER_CARD} cards; finish with those.`);
  }
  let depth = 0;
  for (let id: string | null = caller.taskId; id; id = byId.get(id)?.createdByTaskId ?? null) {
    if (++depth > MAX_DELEGATION_DEPTH) {
      throw new Error("Delegation is nested too deeply here; do this work yourself.");
    }
  }
  const task = await repo.createTask({
    boardId: caller.boardId,
    title,
    description,
    status: start ? "in_progress" : "todo",
    createdByTaskId: caller.taskId,
  });
  publish({ type: "task.updated", task });
  const result = start ? await host.start(task.id) : task;
  return JSON.stringify({ created: cardHeader(result) }, null, 2);
}

async function messageCard(host: BoardToolHost, caller: BoardToolCaller, args: Record<string, unknown>): Promise<string> {
  const task = await boardCard(host, caller, args.cardId);
  if (task.id === caller.taskId) throw new Error("That is your own card.");
  const comment = await host.repo.addComment({
    taskId: task.id,
    author: "user",
    body: text(args.message, "message", 10000),
    fromTaskId: caller.taskId,
  });
  publish({ type: "comment.added", comment, boardId: task.boardId });
  const counted = (await host.repo.getTask(task.id)) ?? task;
  publish({ type: "task.updated", task: counted });
  await host.onComment(counted, comment);
  const after = (await host.repo.getTask(task.id)) ?? counted;
  const delivery =
    after.status === "todo"
      ? "The card is in To do; its agent gets the message when it starts."
      : host.isBusy(after.id)
        ? "Delivered to its agent (it is running or queued)."
        : "Delivered.";
  return `${delivery} ${JSON.stringify(cardHeader(after))}`;
}

async function waitForCards(
  host: BoardToolHost,
  caller: BoardToolCaller,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  if (!Array.isArray(args.cardIds) || args.cardIds.length === 0 || args.cardIds.some((v) => typeof v !== "string")) {
    throw new Error("cardIds must be a non-empty list of card ids.");
  }
  const ids = [...new Set(args.cardIds as string[])];
  if (ids.includes(caller.taskId)) throw new Error("You cannot wait for your own card.");
  for (const id of ids) await boardCard(host, caller, id);
  const seconds = Math.min(
    MAX_WAIT_SECONDS,
    Math.max(1, typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : DEFAULT_WAIT_SECONDS),
  );

  const settled = async (): Promise<boolean> => {
    for (const id of ids) {
      if (host.isBusy(id)) return false;
      const task = await host.repo.getTask(id);
      if (task && (task.agentState === "queued" || task.agentState === "running")) return false;
    }
    return true;
  };

  let timedOut = false;
  if (!(await settled())) {
    const { promise, resolve } = Promise.withResolvers<void>();
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        if (await settled()) resolve();
      } finally {
        checking = false;
      }
    };
    const unsubscribe = subscribe((event) => {
      if (event.type === "task.updated" && ids.includes(event.task.id)) void check();
      if (event.type === "task.deleted" && ids.includes(event.taskId)) void check();
    });
    // Belt and braces against a missed event.
    const poll = setInterval(() => void check(), 5_000);
    const timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, seconds * 1000);
    const onAbort = () => resolve();
    signal.addEventListener("abort", onAbort);
    host.lendSlot(1);
    try {
      await promise;
    } finally {
      host.lendSlot(-1);
      unsubscribe();
      clearInterval(poll);
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) throw new Error("Cancelled");
  }

  const cards = await Promise.all(
    ids.map(async (id) => {
      const task = await host.repo.getTask(id);
      if (!task) return { id, deleted: true };
      const latest = (await host.repo.listRuns(id))[0];
      return {
        ...cardHeader(task),
        summary: latest?.summary ? truncate(latest.summary, MAX_SUMMARY) : null,
        error: latest?.status === "failed" ? latest.error : null,
      };
    }),
  );
  return JSON.stringify(
    { ...(timedOut ? { timedOut: true, note: `Some cards were still busy after ${seconds}s.` } : {}), cards },
    null,
    2,
  );
}

// --- Helpers ---------------------------------------------------------------------------------

function cardHeader(t: Task): {
  id: string;
  title: string;
  status: TaskStatus;
  agentState: Task["agentState"];
  agentError?: string;
  createdByCard?: string;
} {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    agentState: t.agentState,
    ...(t.agentError ? { agentError: t.agentError } : {}),
    ...(t.createdByTaskId ? { createdByCard: t.createdByTaskId } : {}),
  };
}

async function boardCard(host: BoardToolHost, caller: BoardToolCaller, id: unknown): Promise<Task> {
  if (typeof id !== "string" || !id.trim()) throw new Error("cardId is required.");
  const task = await host.repo.getTask(id.trim());
  if (!task || task.boardId !== caller.boardId) throw new Error(`No card ${id} on this board.`);
  return task;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim().slice(0, max);
}

/** Validation helpers throw HttpError; tools report plain errors. */
async function hostValidate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw err instanceof HttpError ? new Error(err.message) : err;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
