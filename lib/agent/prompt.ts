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
  "Nobody can answer questions during this run, so do not stop to ask; make reasonable assumptions and mention them in your summary.";

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

/** A markdown list entry (`- x`, `* x`, `1. x`, `- [ ] x`); global + multiline for counting. */
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?\S/gm;
const SCOPE_NOUN =
  "(?:files?|pages?|screens?|views?|components?|endpoints?|routes?|modules?|packages?|services?|folders?|repos?|repositories)";
/** Phrases asking for broad or parallel work. */
const ORCHESTRATE_CUES = [
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
 * broad/parallel work.
 */
export function needsOrchestration(task: Task | null, feedback: Comment[]): boolean {
  const texts = feedback.map((c) => c.body);
  if (task) texts.push(task.title, task.description);
  const all = texts.join("\n");

  if (ORCHESTRATE_CUES.some((cue) => cue.test(all))) return true;
  if (all.split(/\s+/).filter(Boolean).length >= ORCHESTRATE_MIN_WORDS) return true;

  // Every list entry is an item; a feedback comment without a list is one item on its own.
  const items =
    (all.match(LIST_ITEM)?.length ?? 0) + feedback.filter((c) => !c.body.match(LIST_ITEM)).length;
  return items >= ORCHESTRATE_MIN_ITEMS;
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
