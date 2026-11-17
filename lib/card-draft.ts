// Free text → card. Limits shared by the new-card form and the API, and the card made from the
// text as typed: its first line (or sentence) as the title, the text as the description.

/** Longest card title the API accepts. */
export const TITLE_MAX = 200;
/** Longest card description the API accepts. */
export const DESCRIPTION_MAX = 20_000;
/** Longest free text a new card accepts (characters). */
export const BRIEF_MAX = 2_000_000;
/** Name of the word-for-word copy of a text too long for the description, among the card's files. */
export const BRIEF_FILE = "brief.md";
/** Added to the description of a card that has its text attached as `BRIEF_FILE`. */
export const BRIEF_NOTE = `The user's full original request, word for word, is in ${BRIEF_FILE} among this card's files.`;
/** One line up to this long is used as the title as typed. */
const PLAIN_TITLE_MAX = 100;
/** Length a title taken from a longer text is cut to. */
const DERIVED_TITLE_MAX = 80;

/** Cut to `max` characters at a word boundary when one is close, ending with "…". */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Card fields from `text` as typed. A short single line is the title with no description;
 * otherwise the first line (or its first sentence) is the title and the text the description.
 * A text over `DESCRIPTION_MAX` is `attached`: the caller keeps it whole as `BRIEF_FILE` and the
 * description is clipped, ending with `BRIEF_NOTE`.
 */
export function cardFromText(text: string): { title: string; description: string; attached: boolean } {
  const trimmed = text.trim();
  if (trimmed.length > 0 && trimmed.length <= PLAIN_TITLE_MAX && !trimmed.includes("\n")) {
    return { title: trimmed, description: "", attached: false };
  }
  const firstLine =
    trimmed
      .split("\n")
      .map((line) => line.replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)/, "").trim())
      .find(Boolean) ?? "";
  const sentence = firstLine.length > DERIVED_TITLE_MAX ? (firstLine.match(/^.+?[.!?](?=\s)/)?.[0] ?? firstLine) : firstLine;
  const title = clip(sentence, DERIVED_TITLE_MAX);
  if (trimmed.length <= DESCRIPTION_MAX) return { title, description: trimmed, attached: false };
  const room = DESCRIPTION_MAX - BRIEF_NOTE.length - 2;
  return { title, description: `${clip(trimmed, room)}\n\n${BRIEF_NOTE}`, attached: true };
}
