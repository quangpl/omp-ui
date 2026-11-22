// "Create with Agent" on the Schedulers page (POST /api/v1/schedulers/chat): the user describes a
// scheduler in plain language and a short omp helper agent turns it into a validated draft through
// the `omp_ui_propose_scheduler` host tool. Nothing is saved here: the page shows the draft and
// the user creates it (POST /api/v1/schedulers) or keeps chatting to revise it. The conversation
// lives in the browser and is sent whole with every turn.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runOmpHelper } from "@/lib/agent/omp-helper";
import { chooseHelperModel } from "@/lib/agent/provider-quota";
import { clip } from "@/lib/card-draft";
import { childEnv } from "@/lib/child-env";
import type { Repository } from "@/lib/db/types";
import { dataDir } from "@/lib/files";
import { resolveBoard } from "@/lib/server/chat/assistant";
import { HttpError } from "@/lib/server/http";
import { mcpAgentEnv } from "@/lib/server/mcp-env";
import {
  SCHEDULER_TOOL_PROPERTIES,
  assertScheduleMatches,
  parseNewScheduler,
  scheduleSummary,
  schedulerForAgent,
} from "@/lib/server/scheduler-ops";
import { parseMaxRuns, parseModel, parseTimeZone } from "@/lib/server/validate";
import { getAppSettings } from "@/lib/settings";
import type { BoardWithCounts, SchedulerChatMessage, SchedulerChatRequest, SchedulerDraft } from "@/lib/types";

/** The assistant is cancelled after this long. */
const TIMEOUT_SECONDS = 180;
/** Turns kept from the conversation (the newest), characters kept per earlier turn and for the new message. */
const MAX_TURNS = 30;
const HISTORY_CLIP = 4000;
const MESSAGE_MAX = 20_000;
/** Activity line while a draft is being checked. */
const PROPOSING = "Checking the schedule…";

type Json = Record<string, unknown>;

/** `set_host_tools` definitions of the scheduler assistant's tools (JSON Schema parameters). */
export const SCHEDULER_ASSISTANT_TOOLS = [
  {
    name: "omp_ui_propose_scheduler",
    label: "Propose scheduler",
    description:
      "Validate a complete scheduler and show it to the user as the draft they can create with one click (replaces the previous draft). Defaults: the user's time zone, the default project. Returns the draft with its schedule in words and the next run times, or the problem to fix.",
    parameters: {
      type: "object",
      properties: {
        ...SCHEDULER_TOOL_PROPERTIES,
        project: { type: "string", description: "Project number, id, id prefix or name; default: the default project." },
      },
      required: ["prompt", "cron"],
      additionalProperties: false,
    },
  },
  {
    name: "omp_ui_list_schedulers",
    label: "List schedulers",
    description: "List the user's existing schedulers (name, project, schedule in words, time zone, next run, active or paused).",
    parameters: {
      type: "object",
      properties: { project: { type: "string", description: "Only this project's (number, id, id prefix or name)." } },
      additionalProperties: false,
    },
  },
] as const;

/** Validate a POST /api/v1/schedulers/chat body (400 on bad input). */
export function parseSchedulerChatRequest(body: Json): SchedulerChatRequest {
  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) throw new HttpError(400, "messages must be a non-empty list");
  const parsed = messages.map((message: unknown, index): SchedulerChatMessage => {
    const m = (message ?? {}) as Json;
    if ((m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string" || !m.text.trim()) {
      throw new HttpError(400, `messages[${index}] must be { role: "user" | "assistant", text }`);
    }
    return { role: m.role, text: m.text.trim() };
  });
  const last = parsed[parsed.length - 1];
  if (last.role !== "user") throw new HttpError(400, "The last message must be the user's");
  if (last.text.length > MESSAGE_MAX) throw new HttpError(400, `The message must be at most ${MESSAGE_MAX} characters`);
  if (body.boardId !== undefined && body.boardId !== null && typeof body.boardId !== "string") {
    throw new HttpError(400, "boardId must be a string");
  }
  return {
    messages: parsed.slice(-MAX_TURNS),
    timezone: body.timezone === undefined ? "UTC" : parseTimeZone(body.timezone),
    boardId: typeof body.boardId === "string" && body.boardId ? body.boardId : null,
    draft: parseDraft(body.draft),
  };
}

/** The draft the page shows, as sent back; only its shape is checked (it is context for the agent). */
function parseDraft(value: unknown): SchedulerDraft | null {
  if (value === undefined || value === null) return null;
  const d = value as Json;
  const strings = ["boardId", "name", "prompt", "cron", "timezone"] as const;
  if (typeof value !== "object" || strings.some((key) => typeof d[key] !== "string") || typeof d.enabled !== "boolean") {
    throw new HttpError(400, "draft must be a scheduler draft or null");
  }
  return {
    boardId: d.boardId as string,
    name: d.name as string,
    prompt: d.prompt as string,
    cron: d.cron as string,
    timezone: d.timezone as string,
    enabled: d.enabled,
    maxRuns: d.maxRuns === undefined ? null : parseMaxRuns(d.maxRuns),
    model: d.model === undefined ? null : parseModel(d.model),
  };
}

export interface SchedulerAssistantResult {
  reply: string;
  /** The last draft proposed this turn; null when the assistant only answered (e.g. asked a question). */
  draft: SchedulerDraft | null;
}

/**
 * One turn of the conversation: the helper agent answers the last user message, proposing drafts
 * through its tools. `repo` is the signed-in user's scoped repository, so only their projects and
 * schedulers are visible. Rejects on failure, timeout or abort.
 */
export async function runSchedulerAssistant(options: {
  repo: Repository;
  request: SchedulerChatRequest;
  signal: AbortSignal;
  onActivity: (text: string) => void;
}): Promise<SchedulerAssistantResult> {
  const { repo, request, signal, onActivity } = options;
  const boards = await repo.listBoards();
  if (boards.length === 0) throw new HttpError(400, "There are no projects yet: create a project first.");
  const defaultBoard = boards.find((board) => board.id === request.boardId) ?? boards[0];
  const settings = await getAppSettings(repo);
  const cwd = path.join(dataDir(), "scheduler-assistant");
  await mkdir(cwd, { recursive: true });
  let draft: SchedulerDraft | null = null;
  const { model, config } = await chooseHelperModel({ settings, pinned: null, roles: [] });
  const reply = await runOmpHelper({
    command: settings.ompPath,
    cwd,
    addDirs: [],
    model,
    thinking: null,
    config,
    timeoutSeconds: TIMEOUT_SECONDS,
    env: childEnv(await mcpAgentEnv()),
    prompt: buildPrompt(request, boards, defaultBoard),
    signal,
    label: "scheduler assistant",
    onActivity,
    writing: "Writing the answer…",
    // Only the omp_ui_* tools: chat text never gets to read or change server files.
    tools: "",
    hostTools: {
      tools: SCHEDULER_ASSISTANT_TOOLS,
      run: async (name, args) => {
        const result = await runSchedulerTool(repo, request, defaultBoard, name, args, onActivity);
        if (result.draft) draft = result.draft;
        return result.text;
      },
    },
  });
  return { reply, draft };
}

/** Run one scheduler assistant tool; throws for a tool error (the agent sees the message). */
export async function runSchedulerTool(
  repo: Repository,
  request: Pick<SchedulerChatRequest, "timezone">,
  defaultBoard: BoardWithCounts,
  name: string,
  args: Json,
  onActivity: (text: string) => void = () => undefined,
): Promise<{ text: string; draft?: SchedulerDraft }> {
  switch (name) {
    case "omp_ui_propose_scheduler": {
      onActivity(PROPOSING);
      const boards = await repo.listBoards();
      const project = typeof args.project === "string" ? args.project.trim() : "";
      const board = project ? resolveBoard(boards, project) : defaultBoard;
      const draft = await parseNewScheduler(repo, {
        boardId: board.id,
        prompt: args.prompt,
        cron: args.cron,
        timezone: args.timezone === undefined || args.timezone === "" ? request.timezone : args.timezone,
        ...(typeof args.name === "string" && args.name.trim() ? { name: args.name } : {}),
        ...(args.maxRuns !== undefined ? { maxRuns: args.maxRuns } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
      });
      assertScheduleMatches(draft);
      return {
        text: JSON.stringify({
          proposed: {
            name: draft.name,
            project: board.name,
            cron: draft.cron,
            ...scheduleSummary(draft),
          },
          note: 'Shown to the user as a draft with a "Create scheduler" button; it is not created yet.',
        }),
        draft,
      };
    }
    case "omp_ui_list_schedulers": {
      const boards = await repo.listBoards();
      const project = typeof args.project === "string" ? args.project.trim() : "";
      const board = project ? resolveBoard(boards, project) : null;
      const schedulers = await repo.listSchedulers(board?.id);
      return { text: JSON.stringify({ schedulers: schedulers.map((s) => schedulerForAgent(s, boards)) }) };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Wall-clock time now in `timeZone`, e.g. "Tue, Nov 17, 2026, 14:05". */
function localNow(timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
}

function buildPrompt(request: SchedulerChatRequest, boards: BoardWithCounts[], defaultBoard: BoardWithCounts): string {
  const history = request.messages.slice(0, -1);
  const message = request.messages[request.messages.length - 1].text;
  const draft = request.draft;
  const draftBoard = draft ? boards.find((board) => board.id === draft.boardId) : undefined;
  return [
    "You are OMP-UI's scheduler assistant. OMP-UI runs omp coding agents on projects. A scheduler creates a new card on a project on a cron schedule; each card's agent starts at once with the scheduler's prompt as its whole brief and does the work in the project's folders.",
    'The user is on the Schedulers page and describes, in plain language, a scheduler they want. Turn it into a scheduler draft with omp_ui_propose_scheduler. The user reviews the draft and clicks "Create scheduler" themselves; you cannot create, change, run or delete schedulers.',
    "",
    "How to work:",
    "- Propose as soon as you know what the agent should do each time. Pick sensible defaults for anything not said (09:00, the default project, the user's time zone, repeating forever, active) and mention the ones that matter. Ask one short question instead only when what the agent should do, or which project, is truly unclear.",
    "- Every call proposes the complete scheduler again: to revise the current draft, pass all its fields with the changes. A failed call returns the problem: fix the arguments and call again.",
    "- prompt: a self-contained brief for the coding agent of each run, written as instructions (what to do, where, how to verify, what to deliver). Keep the user's details and wording; add only what makes it actionable. Never mention the schedule in it. That agent does not see this conversation.",
    '- cron: five fields "minute hour day-of-month month day-of-week" (0-59, 0-23, 1-31, 1-12 or JAN-DEC, 0-7 or SUN-SAT where 0 and 7 are Sunday); each a comma list of *, n, a-b, */n or a-b/n. Or @hourly, @daily, @weekly, @monthly, @yearly. Times are wall-clock times in the time zone. Examples: weekdays at 09:00 "0 9 * * 1-5"; every 2 hours "0 */2 * * *"; the 1st of every month at 08:00 "0 8 1 * *".',
    '- maxRuns: only for a limited count ("once", "3 times", "for the next 4 weeks" = count the runs). A one-off at a date: that minute, hour, day and month in cron with maxRuns 1.',
    "- name: a short label for the schedulers list (at most 60 characters).",
    '- The page shows the draft (project, schedule, next runs, brief) right under your answer, so do not repeat it. Afterwards answer in one or two short sentences: the schedule in words with the time zone, any defaults you assumed, and that they can click "Create scheduler" or ask for changes. Never claim it is created.',
    "- Reply in the user's language, plain text or light markdown (no headings, no tables), at most about 300 characters.",
    "",
    `Now: ${new Date().toISOString()} (the user's time zone: ${request.timezone}, where it is ${localNow(request.timezone)})`,
    `Projects: ${boards.map((board, index) => `${index + 1}. ${board.name} (${board.id.slice(0, 8)}, ${board.workdir})`).join("; ")}`,
    `Default project: ${defaultBoard.name} (${defaultBoard.id.slice(0, 8)})`,
    draft
      ? `Current draft shown to the user: ${JSON.stringify({ ...draft, boardId: undefined, project: draftBoard?.name ?? draft.boardId })}`
      : "Current draft: none yet",
    ...(history.length > 0
      ? [
          "",
          "Conversation so far (oldest first):",
          ...history.map((m) => `${m.role === "user" ? "User" : "You"}: ${clip(m.text, HISTORY_CLIP)}`),
        ]
      : []),
    "",
    "The user's new message:",
    "<new-message>",
    message,
    "</new-message>",
  ].join("\n");
}
