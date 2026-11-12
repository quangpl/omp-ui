// Free text → card. Limits shared by the new-card form and the API, the no-agent fallback
// (first line → title, the text → description), and turning the card writer's draft into card fields.
import type { CardDraft } from "@/lib/types";

/** Longest card title the API accepts. */
export const TITLE_MAX = 200;
/** Longest card description the API accepts. */
export const DESCRIPTION_MAX = 20_000;
/** Longest free text a new card accepts (characters). */
export const BRIEF_MAX = 2_000_000;
/** Text at least this long is also kept on the card, word for word, as `BRIEF_FILE`. */
export const ATTACH_BRIEF_MIN = 2_000;
/** Name of that copy among the card's files. */
export const BRIEF_FILE = "brief.md";
/** Added to the description of a card that has its text attached as `BRIEF_FILE`. */
export const BRIEF_NOTE = `The user's full original request, word for word, is in ${BRIEF_FILE} among this card's files.`;
/** One line up to this long is used as the title as typed (the card writer is skipped). */
export const PLAIN_TITLE_MAX = 100;
/** Length the fallback cuts a title to. */
const FALLBACK_TITLE_MAX = 80;

/**
 * Appended to the description of a card that should be orchestrated. Holds omp's `orchestrate`
 * magic keyword (standalone, lowercase, in prose), which makes omp split the run across parallel
 * subagents.
 */
export const ORCHESTRATE_LINE =
  "orchestrate: split this work into parallel subagent tasks, then verify and integrate the results.";

/** A short single line: good enough as a title without asking the agent. */
export function isPlainTitle(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= PLAIN_TITLE_MAX && !trimmed.includes("\n");
}

/** Cut to `max` characters at a word boundary when one is close, ending with "…". */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Card from the text as typed: its first line (or sentence) as the title, the text as the description. */
export function fallbackDraft(text: string): CardDraft {
  const trimmed = text.trim();
  const firstLine =
    trimmed
      .split("\n")
      .map((line) => line.replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)/, "").trim())
      .find(Boolean) ?? "";
  const sentence = firstLine.length > FALLBACK_TITLE_MAX ? (firstLine.match(/^.+?[.!?](?=\s)/)?.[0] ?? firstLine) : firstLine;
  const title = clip(sentence, FALLBACK_TITLE_MAX);
  const description = trimmed === title ? "" : clip(trimmed, DESCRIPTION_MAX);
  return { title, description, orchestrate: false, waitFor: [] };
}

/** Title, description and "Run after" cards of a new card. */
export interface CardFields {
  title: string;
  description: string;
  blockedBy: string[];
}

/**
 * Card fields for `draft`: its description plus the orchestrate line when asked for and
 * `BRIEF_NOTE` when the original text is `attached`, within `DESCRIPTION_MAX`.
 */
export function draftToCard(
  draft: CardDraft,
  attached: boolean,
): CardFields {
  const extras = [draft.orchestrate ? ORCHESTRATE_LINE : "", attached ? BRIEF_NOTE : ""].filter(Boolean);
  const room = DESCRIPTION_MAX - extras.reduce((total, line) => total + line.length + 2, 0);
  return {
    title: draft.title.trim(),
    description: [clip(draft.description.trim(), room), ...extras].filter(Boolean).join("\n\n"),
    blockedBy: draft.waitFor.map((card) => card.id),
  };
}
