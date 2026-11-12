// Detects the question an agent left for the user in its run summary. Shared by the agent
// manager (sets Task.question when a run succeeds) and by tests.

/** Longest stored question (characters); summaries can be long, the card UI shows a preview. */
const MAX_QUESTION_LENGTH = 1200;

/** `…?`, `…?**`, `…?"`, `…?)` — a "?" followed only by closing markdown decoration. */
const QUESTION_LINE = /\?[\s*_`"'’)\]]*$/;

/** A markdown list entry: `- x`, `* x`, `+ x`, `1. x`, `2) x`. */
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s/;

/**
 * The question(s) the agent asked the user in `summary`, or null when it asked none.
 *
 * Fenced code blocks are ignored. A paragraph counts as a question when one of its lines ends
 * with "?" (trailing markdown decoration allowed); of a pure list paragraph only the question
 * items are kept, other paragraphs are kept whole so surrounding context (options, assumptions)
 * stays readable.
 */
export function extractQuestion(summary: string): string | null {
  if (!summary) return null;
  const withoutCode = summary.replace(/```[\s\S]*?(?:```|$)/g, "");
  const questions: string[] = [];
  for (const paragraph of withoutCode.split(/\n[ \t]*\n/)) {
    const lines = paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0 || !lines.some((line) => QUESTION_LINE.test(line))) continue;
    if (lines.every((line) => LIST_ITEM.test(line))) {
      questions.push(lines.filter((line) => QUESTION_LINE.test(line)).join("\n"));
    } else {
      questions.push(lines.join("\n"));
    }
  }
  if (questions.length === 0) return null;
  const joined = questions.join("\n\n");
  return joined.length > MAX_QUESTION_LENGTH ? `${joined.slice(0, MAX_QUESTION_LENGTH - 1)}…` : joined;
}

/** First line of a stored question, for one-line previews on cards. */
export function questionPreview(question: string): string {
  return question.split("\n", 1)[0] ?? question;
}
