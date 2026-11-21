import { SDLC_PHASE_INFO, SDLC_PHASES, sdlcProgress } from "@/lib/sdlc";
import { isSoftwareTask } from "@/lib/task-kind";
import type { Board, BrowserMode, Comment, Task } from "@/lib/types";
import { TASK_DOCKER_LABEL, taskComposeProject } from "@/lib/task-docker";

/** Per-run facts beyond the card: shared folders, browser, message senders. */
export interface RunContext {
  /** The card's shared files folder. */
  taskFiles: string;
  /** The board's shared files folder (all cards). */
  boardFiles: string;
  browser: BrowserMode;
  /** Titles of the cards whose agents sent feedback, by card id. */
  senders: Record<string, string>;
  /**
   * Set by the manager for an automatic retry after a failed run: the failure message and the
   * 1-based automatic retry number.
   */
  previousFailure?: { message: string; attempt: number };
}

/** Automatic retry number from which the prompt asks for a different approach (Hermes' failure-streak nudge). */
export const FAILURE_STREAK_NUDGE = 3;
/** Longest failure message quoted in the prompt. */
const FAILURE_MESSAGE_MAX = 500;

/**
 * Task artifact cleanup policy (docs/TASK-CLEANUP.md): once the work is verified, before any commit or
 * push, the agent removes what it created only to do the task, so a card's result is its final message plus the
 * files it links. Docker resources started only for the card are marked with the
 * `agentman.task=<card id>` label or the `task-<card id>` compose project (lib/task-docker.ts); AgentMan
 * removes marked leftovers when a run moves the card to Done or the card is deleted.
 */
function cleanupInstruction(task: Task): string {
  const project = taskComposeProject(task.id);
  const label = `${TASK_DOCKER_LABEL}=${task.id}`;
  return (
    "Once the work is done and verified, before you commit or push anything and before your final message, clean up everything you created only to do this task: analytics and profiling output, throwaway scripts and tests, test-runner output (e.g. test-results/, playwright-report/, coverage/), scratch notes, logs and dumps, and work-in-progress files in this card's shared files folder that your final message does not link; stop the dev servers, browsers and other background processes you started; and remove the Docker containers, compose stacks, volumes, networks and images you created for it. Keep only the result: your final message, the files it links, and the changes the task asked for (including tests meant to stay). Never delete or remove anything you did not create: files that existed before this task, files the user uploaded, other cards' files and changes (they may share this working tree), Docker resources that were already there, or permanent project infrastructure such as test suites and Docker configuration. " +
    "Put scratch files in a temporary folder outside the project (e.g. `mktemp -d`) so they are easy to remove. " +
    `Mark every Docker resource you start only for this task: run compose stacks as \`docker compose -p ${project}\` and add \`--label ${label}\` to \`docker run\`, \`docker create\`, \`docker build\`, \`docker volume create\` and \`docker network create\`. ` +
    `Before you finish, stop and remove them (\`docker compose -p ${project} down -v --remove-orphans\`, \`docker rm -f\`, \`docker volume rm\`, \`docker network rm\`, \`docker image rm\`) and check that \`docker ps -a --filter label=${label}\` and \`docker ps -a --filter label=com.docker.compose.project=${project}\` list nothing; AgentMan also removes marked leftovers when a run moves the card to Done or the card is deleted. ` +
    "A container the task asks you to leave running is a result, not a leftover: do not mark it or the image it runs from (containers inherit their image's labels), and name it in your final message."
  );
}

const PUSH_INSTRUCTION =
  "Do not push on your own; the user ships the work from the card. But when the task or the user's feedback explicitly asks you to push to main (or the default branch) or to open a pull/merge request, do it directly without asking for confirmation: commit, push, and open the PR/MR (gh or glab), then add `Branch:` and `PR:` lines with the branch and the PR/MR URL to your final message.";

const HEADLESS_INSTRUCTION =
  "Nobody can answer questions during this run, so do not stop to ask. When you or one of your subagents are unsure which way to go (approach, library, design or behavior choice, unclear scope), call the ask_advisor tool and follow its decision. Leave a question for the user (at the end of your final message) only when it needs their own judgment: personal preference or taste, private information, business/legal/money decisions, or destructive actions the task does not ask for; meanwhile make the most reasonable, easily reversible assumption and mention it in your final message.";

const SDLC_LABELS = SDLC_PHASES.map((id) => SDLC_PHASE_INFO[id].label);

/**
 * The SDLC workflow every run follows: todo-list phases named after the SDLC phases (the server derives
 * progress and enforces the gates from those names), with each phase's exit criteria as its quality gate.
 */
const SDLC_INSTRUCTION = [
  `Work through the software development lifecycle as three simple phases. Keep your todo list with the todo tool and name its phases exactly after the SDLC phases, in this order: ${SDLC_LABELS.join(", ")}.`,
  `Finish (or drop) every item of a phase before starting the next; each phase's exit criteria are its quality gate: ${SDLC_PHASES.map((id) => `${SDLC_PHASE_INFO[id].label}: ${SDLC_PHASE_INFO[id].gate}`).join("; ")}.`,
  "Keep Testing fast and targeted: type-check, run only the tests covering the changed code (by file or test name, not whole suites) and check the changed behavior once; no full production builds, complete or end-to-end suites, repeated runs or extra audits unless the change specifically needs them, since broad testing is left to the quality gatekeeper.",
  "Testing must pass before the work ships. A small fix needs one or two items per phase, not ceremony.",
].join(" ");

/**
 * What a non-software task gets instead of the SDLC workflow: do the work directly, with no todo
 * phases named after SDLC phases and no quality/release gates.
 */
const DIRECT_INSTRUCTION =
  "This is not a software-development task, so skip the software-development lifecycle (SDLC) and any complicated workflow: do not create todo phases named after SDLC phases or follow their quality gates, and instead do the task directly right away.";

/** Where a feedback round sits in the SDLC: a fresh round once every included phase is done, else the current phase. */
function feedbackSdlcInstruction(task: Task): string {
  const progress = sdlcProgress(task.todos ?? []);
  if (progress && progress.current === null) {
    return "This feedback is on delivered work: run a fresh Analyze → Implement → Testing round for it (understand the feedback, fix, re-test) without reopening the earlier phases.";
  }
  return "Continue in the current SDLC phase and add the new items to the phase they belong to.";
}

/** Separate work items (list entries, feedback comments) at which a run is orchestrated. */
const ORCHESTRATE_MIN_ITEMS = 4;
/** Word count at which a task is considered too large for a single agent. */
const ORCHESTRATE_MIN_WORDS = 300;

/** A markdown list entry (`- x`, `* x`, `1. x`, `- [ ] x`). */
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?\S/;
/** Opening/closing line of a fenced code block. */
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
/** A section heading on its own line: `## Title`, `**Title**`, or `Title:`. */
const HEADING = /^[ \t]*(?:#{1,6}[ \t]+(.+?)[ \t#]*|\*\*([^*]+)\*\*:?|([A-Z][^:\n]{0,40}):)[ \t]*$/;
/** Sections whose list entries check, explain or bound the work rather than add to it. */
const REFERENCE_SECTION =
  /^(?:acceptance|verif|tests?\b|testing|done when|definition of done|context|background|current|notes?\b|assumptions?|out of scope|non-goals?|constraints?|references?|links?|(?:relevant |key )?files?\b|open questions?|questions?)/i;
const SCOPE_NOUN =
  "(?:files?|pages?|screens?|views?|components?|endpoints?|routes?|modules?|packages?|services?|folders?|repos?|repositories)";
/** Phrases asking for broad or parallel work, or omp's `orchestrate` keyword itself. */
const ORCHESTRATE_CUES = [
  /\borchestrate\b/i,
  /\bin parallel\b/i,
  /\bsub-?agents?\b/i,
  /\b(?:across|throughout)\s+(?:the\s+)?(?:whole\s+|entire\s+)?(?:code\s?base|repo(?:sitory)?|project|app)\b/i,
  new RegExp(`\\b(?:every|each|all(?:\\s+(?:of\\s+)?the)?)\\s+${SCOPE_NOUN}\\b`, "i"),
];

/**
 * Prompt for one agent run.
 * - First run: the full task plus any feedback already left on the card.
 * - Resume run (same omp session via `--resume`): the agent already has the task in context,
 *   so only the new feedback is sent (or a "continue" nudge when there is none).
 * - System prompt off: only the task and the user's open feedback, with no instructions added.
 */
export function buildPrompt(
  task: Task,
  board: Board,
  openFeedback: Comment[],
  isResume: boolean,
  context?: RunContext,
  useSystemPrompt = true,
): string {
  if (!useSystemPrompt) {
    return plainPrompt(task, openFeedback, isResume, context?.senders ?? {});
  }
  const senders = context?.senders ?? {};
  const feedback = openFeedback.filter((c) => c.author === "user" && !c.resolved);
  const folders = projectFolders(board);
  const where = folders ? "this project (any of the folders above)" : `this repository (${board.workdir})`;

  const failure = previousFailureNote(context);
  // Non-software tasks run straight: the SDLC phases, gates and staffing are software-work process.
  const software = isSoftwareTask(task);
  const workflow = software ? SDLC_INSTRUCTION : DIRECT_INSTRUCTION;

  if (isResume && feedback.length > 0) {
    return [
      "New feedback on this task:",
      "",
      numberedFeedback(feedback, senders),
      "",
      ...(failure ? [failure, ""] : []),
      ...(folders ? [folders, ""] : []),
      `Address all of the feedback above in ${where}. Make the changes and verify them.`,
      workflow,
      ...(software ? [feedbackSdlcInstruction(task)] : []),
      HEADLESS_INSTRUCTION,
      cleanupInstruction(task),
      PUSH_INSTRUCTION,
    ].join("\n");
  }

  if (isResume) {
    return [
      "Continue working on this task until it is complete. The previous run may have been interrupted, and the task may have been edited since.",
      "",
      taskSection(task),
      "",
      ...(failure ? [failure, ""] : []),
      ...(folders ? [folders, ""] : []),
      `Check the current state of ${where}, finish any remaining work, and verify it.`,
      workflow,
      ...(software ? ["Continue from the SDLC phase your todo list shows."] : []),
      HEADLESS_INSTRUCTION,
      cleanupInstruction(task),
      PUSH_INSTRUCTION,
    ].join("\n");
  }

  const lines = [
    `You are working on a task from the "${board.name}" board.`,
    "",
    taskSection(task),
    ...(folders ? ["", folders] : []),
  ];
  if (feedback.length > 0) {
    lines.push("", "## Feedback from the user", "", numberedFeedback(feedback, senders));
  }
  if (context) {
    lines.push("", "## Workspace and collaboration", "", ...collaborationLines(task, context));
  }
  if (failure) {
    lines.push("", "## Previous attempt", "", failure);
  }
  lines.push(
    "",
    "## Instructions",
    "",
    `- Work in ${where} and make the change described above${feedback.length > 0 ? ", taking all of the feedback into account" : ""}.`,
    `- ${workflow}`,
    "- Verify it with the narrowest checks that cover the change.",
    `- ${HEADLESS_INSTRUCTION}`,
    `- ${cleanupInstruction(task)}`,
    `- ${PUSH_INSTRUCTION}`,
  );
  return lines.join("\n");
}

/**
 * The prompt with AgentMan's system prompt off: what a person would type into omp. A first run gets
 * the task and its open feedback; a resumed session already has the task, so it gets only the new
 * feedback (one comment as typed), or the task again when there is none (it may have been edited).
 */
function plainPrompt(task: Task, openFeedback: Comment[], isResume: boolean, senders: Record<string, string>): string {
  const feedback = openFeedback.filter((c) => c.author === "user" && !c.resolved);
  if (feedback.length === 0) return taskSection(task);
  const [only] = feedback;
  const text = feedback.length === 1 && !only!.fromTaskId ? only!.body.trim() : numberedFeedback(feedback, senders);
  if (isResume) return text;
  return [taskSection(task), "", "## Feedback from the user", "", text].join("\n");
}

/**
 * Whether the work is large enough to hand to omp's multi-agent orchestration: many separate
 * items (description list entries plus feedback comments), a long brief, or an explicit ask for
 * broad/parallel work. Fenced code (pasted code, logs) is ignored, and so are list entries under
 * headings like "Acceptance criteria", "Context" or "Notes": they describe the work, they don't add to it.
 */
export function needsOrchestration(task: Task | null, feedback: Comment[]): boolean {
  const texts = feedback.map((c) => c.body);
  if (task) texts.push(task.title, task.description);
  const scans = texts.map(scanBrief);
  const prose = scans.map((scan) => scan.prose).join("\n");

  if (ORCHESTRATE_CUES.some((cue) => cue.test(prose))) return true;
  if (prose.split(/\s+/).filter(Boolean).length >= ORCHESTRATE_MIN_WORDS) return true;

  // Every work list entry is an item; a feedback comment without one is one item on its own.
  const items = scans.reduce((sum, scan) => sum + scan.items, 0);
  const lone = scans.slice(0, feedback.length).filter((scan) => scan.items === 0).length;
  return items + lone >= ORCHESTRATE_MIN_ITEMS;
}

/** The text outside fenced code blocks, and its list entries that are not in a reference section. */
function scanBrief(text: string): { prose: string; items: number } {
  const prose: string[] = [];
  let fence: string | null = null;
  let reference = false;
  let items = 0;
  for (const line of text.split("\n")) {
    const marker = line.match(FENCE)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    prose.push(line);
    const heading = line.match(HEADING);
    if (heading) reference = REFERENCE_SECTION.test((heading[1] ?? heading[2] ?? heading[3] ?? "").trim());
    else if (!reference && LIST_ITEM.test(line)) items += 1;
  }
  return { prose: prose.join("\n"), items };
}

/** "Project folders: primary …, plus …" when the board spans several folders, else null. */
function projectFolders(board: Board): string | null {
  const extra = (board.extraFolders ?? []).filter((f) => f && f !== board.workdir);
  if (extra.length === 0) return null;
  return `Project folders: primary ${board.workdir}, plus ${extra.join(", ")}. You may read and change files in any of them as the task requires.`;
}

/**
 * Message steered into a live session when the user (or another card's agent) comments while the
 * agent runs. omp handles it like chat input, so its magic keywords apply. User feedback goes in
 * word for word, like typing into omp mid-run, so the agent acts on it right away. Another agent's
 * message is introduced with its sender, and its keywords are defused so they can't switch modes on
 * the receiving agent.
 */
export function buildSteerMessage(comment: Comment, senderTitle: string | null | undefined): string {
  const body = comment.body.trim();
  if (!comment.fromTaskId) return body;
  return [
    `New message from the agent working on card "${senderTitle ?? comment.fromTaskId}" (${comment.fromTaskId}):`,
    "",
    defuseMagicKeywords(body),
    "",
    "Take it into account in your current work and mention briefly how you addressed it in your final message.",
  ].join("\n");
}

/** omp's magic keywords, matched like omp does: standalone, lowercase, not part of a path, file name or call. */
const MAGIC_KEYWORDS =
  /(?<![\p{L}\p{N}_./\\-])(?:orchestrate|ultrathink|chillax|workflowz|jevify)(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()/gu;

/** Breaks each magic keyword with a zero-width space so the text reads the same but omp ignores it. */
function defuseMagicKeywords(text: string): string {
  return text.replace(MAGIC_KEYWORDS, (word) => `${word.slice(0, 5)}\u200b${word.slice(5)}`);
}

/**
 * The paragraph telling an automatic retry why the previous run failed, or null on a normal run.
 * The error text is untrusted: one-lined, clipped, and its magic keywords defused.
 */
function previousFailureNote(context: RunContext | undefined): string | null {
  const failure = context?.previousFailure;
  if (!failure) return null;
  const oneLine = failure.message.replace(/\s+/g, " ").trim().replace(/\.+$/, "");
  const clipped = oneLine.length > FAILURE_MESSAGE_MAX ? `${oneLine.slice(0, FAILURE_MESSAGE_MAX - 1)}…` : oneLine;
  const parts = [
    clipped ? `The previous run failed: ${defuseMagicKeywords(clipped)}.` : "The previous run failed.",
    "Before continuing, find out why it failed, and do not repeat the step that failed.",
  ];
  if (failure.attempt >= FAILURE_STREAK_NUDGE) {
    parts.push(
      `This is automatic retry ${failure.attempt} and the same approach has failed repeatedly: step back and take a different approach (smaller steps, another tool or method) instead of retrying it as is.`,
    );
  }
  return parts.join(" ");
}

function collaborationLines(task: Task, context: RunContext): string[] {
  const lines = [
    "- You work directly in the project folders, on the git branch that is checked out there, next to other cards' agents and the user. Stay on that branch: don't switch or create branches unless the task asks for it. The user ships only the changes you make from the card (see the push rule in the instructions).",
    `- Files: ${context.taskFiles} holds files shared on this card; read the ones relevant to the task, and save deliverables meant for the user there (reports, exports, screenshots). Feedback starting with \`> re: <path>\` is about that file in this folder (e.g. a screenshot). ${context.boardFiles} is shared by every card of this board; use it to hand files to other cards' agents.`,
    `- Other agents may be working on other cards of this board at the same time. Your card id is ${task.id}. Board tools: board_list_cards and board_read_card show the cards; board_create_card delegates a clearly separable piece of work to a new card with its own agent (give it a complete brief; prefer doing small work yourself); board_message_card sends a message to another card's agent; board_wait_for_cards waits until cards finish and returns their summaries.`,
  ];
  if (context.browser !== "off") {
    lines.push(
      `- Browser: you can drive a web browser through the \`browser\` API in eval (open pages, click, fill forms, take screenshots) to check web pages and UIs${context.browser === "relay" ? "; it is the user's own Chrome, so open your own tab and never act on their logged-in accounts beyond the task" : ""}. Screenshots are saved to ${context.taskFiles}/screenshots, where the user can see them.`,
    );
  }
  return lines;
}

function taskSection(task: Task): string {
  const description = task.description.trim();
  return [`# Task: ${task.title.trim()}`, "", description || "(no description)"].join("\n");
}

function numberedFeedback(comments: Comment[], senders: Record<string, string>): string {
  return comments
    .map((c, i) => {
      const [first = "", ...rest] = c.body.trim().split("\n");
      const from = c.fromTaskId
        ? `[From the agent on card "${senders[c.fromTaskId] ?? c.fromTaskId}" (${c.fromTaskId})] `
        : "";
      const indent = " ".repeat(String(i + 1).length + 2);
      return [`${i + 1}. ${from}${first}`, ...rest.map((line) => (line ? indent + line : line))].join(
        "\n",
      );
    })
    .join("\n");
}
