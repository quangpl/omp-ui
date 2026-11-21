import type { Comment, Task } from "@/lib/types";

/**
 * What a run sends to omp: the card's own text, nothing added. omp plans, orchestrates and verifies by
 * itself, exactly as when the same text is typed into its TUI.
 * - First run: the task plus any feedback already left on the card.
 * - Resume run (same omp session via `--resume`): the agent already has the task in context, so only
 *   the new feedback is sent (or the task again when there is none: the run may have been interrupted
 *   and the task edited since).
 * `senders` maps a card id to its title, for feedback sent by another card's agent.
 */
export function buildPrompt(
  task: Task,
  openFeedback: Comment[],
  isResume: boolean,
  senders: Record<string, string> = {},
): string {
  const feedback = openFeedback
    .filter((c) => c.author === "user" && !c.resolved)
    .map((c) => feedbackText(c, c.fromTaskId ? senders[c.fromTaskId] : null));
  if (isResume && feedback.length > 0) return feedback.join("\n\n");
  return [taskSection(task), ...feedback].join("\n\n");
}

/**
 * Message steered into a live session when the user (or another card's agent) comments while the
 * agent runs. omp handles it like chat input, so its magic keywords apply: user feedback goes in word
 * for word, like typing into omp mid-run. Another agent's message is introduced with its sender, and
 * its keywords are defused so they can't switch modes on the receiving agent.
 */
export function buildSteerMessage(comment: Comment, senderTitle: string | null | undefined): string {
  return feedbackText(comment, senderTitle);
}

function feedbackText(comment: Comment, senderTitle: string | null | undefined): string {
  const body = comment.body.trim();
  if (!comment.fromTaskId) return body;
  return `Message from the agent working on card "${senderTitle ?? comment.fromTaskId}" (${comment.fromTaskId}):\n\n${defuseMagicKeywords(body)}`;
}

function taskSection(task: Task): string {
  const description = task.description.trim();
  return [`# Task: ${task.title.trim()}`, "", description || "(no description)"].join("\n");
}

/** omp's magic keywords, matched like omp does: standalone, lowercase, not part of a path, file name or call. */
const MAGIC_KEYWORDS =
  /(?<![\p{L}\p{N}_./\\-])(?:orchestrate|ultrathink|chillax|workflowz|jevify)(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()/gu;

/** Breaks each magic keyword with a zero-width space so the text reads the same but omp ignores it. */
function defuseMagicKeywords(text: string): string {
  return text.replace(MAGIC_KEYWORDS, (word) => `${word.slice(0, 5)}\u200b${word.slice(5)}`);
}
