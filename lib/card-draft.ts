// Free text → card. Limits shared by the new-card form and the API, the no-agent fallback
// (first line → title, the text → description), and turning a reviewed draft into a new card.
import type { CardDraft } from "@/lib/types";

/** Longest card title the API accepts. */
export const TITLE_MAX = 200;
/** Longest card description the API accepts. */
export const DESCRIPTION_MAX = 20_000;
/** Longest free text a new card accepts (characters). */
export const BRIEF_MAX = 2_000_000;
/** Text at least this long is also kept on the card, word for word, when its description differs. */
export const ATTACH_BRIEF_MIN = 2_000;
/** Name of that copy among the card's files. */
export const BRIEF_FILE = "brief.md";
/** One line up to this long is used as the title as typed (the inline composer skips the agent). */
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

/** What POST /boards/:id/tasks gets for a reviewed draft (plus status/position from the caller). */
export interface DraftCardInput {
  title: string;
  description: string;
  blockedBy: string[];
  /** The original text, saved on the card as `brief.md` (set when the description doesn't hold all of it). */
  brief?: string;
}

/**
 * Card fields for `draft` made from `text`: the orchestrate line when asked for, and the original
 * text attached when it is long and the description is not simply that text.
 */
export function draftToCard(draft: CardDraft, text: string): DraftCardInput {
  const room = DESCRIPTION_MAX - (draft.orchestrate ? ORCHESTRATE_LINE.length + 2 : 0);
  const base = clip(draft.description.trim(), room);
  const description = draft.orchestrate ? [base, ORCHESTRATE_LINE].filter(Boolean).join("\n\n") : base;
  const original = text.trim();
  const attach = original.length >= ATTACH_BRIEF_MIN && base !== original;
  return {
    title: draft.title.trim(),
    description,
    blockedBy: draft.waitFor.map((card) => card.id),
    ...(attach ? { brief: original } : {}),
  };
}
