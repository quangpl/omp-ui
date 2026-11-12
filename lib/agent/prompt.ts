import type { Board, BrowserMode, Comment, Task } from "@/lib/types";

/** Per-run facts beyond the card: shared folders, workspace, browser, message senders. */
export interface RunContext {
  /** The card's shared files folder. */
  taskFiles: string;
  /** The board's shared files folder (all cards). */
  boardFiles: string;
  /** Branch of the card's dedicated worktree(s); null when it works in the project folders. */
  workspaceBranch: string | null;
  browser: BrowserMode;
  /** Titles of the cards whose agents sent feedback, by card id. */
  senders: Record<string, string>;
}

const SUMMARY_INSTRUCTION =
  "Finish with a concise summary of what you did (this summary is shown to the user on the card): what changed, how you verified it, and anything left for the user to decide.";

const HEADLESS_INSTRUCTION =
  "Nobody can answer questions during this run, so do not stop to ask. When you or one of your subagents are unsure which way to go (approach, library, design or behavior choice, unclear scope), call the ask_advisor tool and follow its decision. Leave a question for the user (at the end of your summary) only when it needs their own judgment: personal preference or taste, private information, business/legal/money decisions, or destructive actions the task does not ask for; meanwhile make the most reasonable, easily reversible assumption and mention it in your summary.";

/**
 * Contains omp's `orchestrate` magic keyword (standalone, lowercase, in prose — not in backticks),
 * which makes omp attach its multi-agent orchestration contract to the message.
 */
const ORCHESTRATE_INSTRUCTION =
  "This task spans several pieces of work: orchestrate it by splitting it into parallel subagent tasks, then verify and integrate the results.";

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
 */
export function buildPrompt(
  task: Task,
  board: Board,
  openFeedback: Comment[],
  isResume: boolean,
  context?: RunContext,
): string {
  const senders = context?.senders ?? {};
  const feedback = openFeedback.filter((c) => c.author === "user" && !c.resolved);
  const folders = projectFolders(board);
  const where = folders ? "this project (any of the folders above)" : `this repository (${board.workdir})`;

  if (isResume && feedback.length > 0) {
    return [
      "New feedback on this task:",
      "",
      numberedFeedback(feedback, senders),
      "",
      ...(folders ? [folders, ""] : []),
      `Address all of the feedback above in ${where}. Make the changes and verify them.`,
      ...(needsOrchestration(null, feedback) ? [ORCHESTRATE_INSTRUCTION] : []),
      HEADLESS_INSTRUCTION,
      SUMMARY_INSTRUCTION,
    ].join("\n");
  }

  if (isResume) {
    return [
      "Continue working on this task until it is complete. The previous run may have been interrupted, and the task may have been edited since.",
      "",
      taskSection(task),
      "",
      ...(folders ? [folders, ""] : []),
      `Check the current state of ${where}, finish any remaining work, and verify it.`,
      ...(needsOrchestration(task, []) ? [ORCHESTRATE_INSTRUCTION] : []),
      HEADLESS_INSTRUCTION,
      SUMMARY_INSTRUCTION,
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
  lines.push(
    "",
    "## Instructions",
    "",
    `- Work in ${where} and make the change described above${feedback.length > 0 ? ", taking all of the feedback into account" : ""}.`,
    ...(needsOrchestration(task, feedback) ? [`- ${ORCHESTRATE_INSTRUCTION}`] : []),
    "- Verify it: run the relevant build, tests, or a quick check as appropriate.",
    `- ${HEADLESS_INSTRUCTION}`,
    `- ${SUMMARY_INSTRUCTION}`,
  );
  return lines.join("\n");
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

/** Message steered into a live session when the user (or another card's agent) comments while the agent runs. */
export function buildSteerMessage(comment: Comment, senderTitle?: string | null): string {
  return [
    comment.fromTaskId
      ? `New message from the agent working on card "${senderTitle ?? comment.fromTaskId}" (${comment.fromTaskId}):`
      : "New feedback from the user on this task:",
    "",
    comment.body.trim(),
    "",
    "Take it into account in your current work and mention how you addressed it in your final summary.",
  ].join("\n");
}

function collaborationLines(task: Task, context: RunContext): string[] {
  const lines = [
    ...(context.workspaceBranch
      ? [
          `- You work in a dedicated git worktree on branch \`${context.workspaceBranch}\`, separate from other cards' agents. Stay on this branch; do not push — the user ships it from the card.`,
        ]
      : []),
    `- Files: ${context.taskFiles} holds files shared on this card; read the ones relevant to the task, and save deliverables meant for the user there (reports, exports, screenshots). ${context.boardFiles} is shared by every card of this board; use it to hand files to other cards' agents.`,
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
