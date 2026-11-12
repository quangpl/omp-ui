import type { Board, Comment, Task } from "@/lib/types";

const SUMMARY_INSTRUCTION =
  "Finish with a concise summary of what you did (this summary is shown to the user on the card): what changed, how you verified it, and anything left for the user to decide.";

const HEADLESS_INSTRUCTION =
  "Nobody can answer questions during this run, so do not stop to ask; make reasonable assumptions and mention them in your summary.";

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
): string {
  const feedback = openFeedback.filter((c) => c.author === "user" && !c.resolved);
  const folders = projectFolders(board);
  const where = folders ? "this project (any of the folders above)" : `this repository (${board.workdir})`;

  if (isResume && feedback.length > 0) {
    return [
      "New feedback on this task:",
      "",
      numberedFeedback(feedback),
      "",
      ...(folders ? [folders, ""] : []),
      `Address all of the feedback above in ${where}. Make the changes and verify them.`,
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
    lines.push("", "## Feedback from the user", "", numberedFeedback(feedback));
  }
  lines.push(
    "",
    "## Instructions",
    "",
    `- Work in ${where} and make the change described above${feedback.length > 0 ? ", taking all of the feedback into account" : ""}.`,
    "- Verify it: run the relevant build, tests, or a quick check as appropriate.",
    `- ${HEADLESS_INSTRUCTION}`,
    `- ${SUMMARY_INSTRUCTION}`,
  );
  return lines.join("\n");
}

/** "Project folders: primary …, plus …" when the board spans several folders, else null. */
function projectFolders(board: Board): string | null {
  const extra = (board.extraFolders ?? []).filter((f) => f && f !== board.workdir);
  if (extra.length === 0) return null;
  return `Project folders: primary ${board.workdir}, plus ${extra.join(", ")}. You may read and change files in any of them as the task requires.`;
}

/** Message steered into a live session when the user comments while the agent runs. */
export function buildSteerMessage(comment: Comment): string {
  return [
    "New feedback from the user on this task:",
    "",
    comment.body.trim(),
    "",
    "Take it into account in your current work and mention how you addressed it in your final summary.",
  ].join("\n");
}

function taskSection(task: Task): string {
  const description = task.description.trim();
  return [`# Task: ${task.title.trim()}`, "", description || "(no description)"].join("\n");
}

function numberedFeedback(comments: Comment[]): string {
  return comments
    .map((c, i) => {
      const [first = "", ...rest] = c.body.trim().split("\n");
      const indent = " ".repeat(String(i + 1).length + 2);
      return [`${i + 1}. ${first}`, ...rest.map((line) => (line ? indent + line : line))].join(
        "\n",
      );
    })
    .join("\n");
}
