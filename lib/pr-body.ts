// Default PR/MR description: the agent's summary in short, its verification lines, and the task
// collapsed below. AgentMan-relative images and links are dropped (they don't resolve on the forge).
import { clip } from "@/lib/card-draft";
import { reportField, splitReport } from "@/lib/report";

const SUMMARY_MAX = 1500;
const DESCRIPTION_MAX = 2000;
const FOOTER = "---\nCreated from AgentMan";

const FENCE = /^([ \t]*)(`{3,}|~{3,})/;
/**
 * An inline code span (group 1, kept as is) or a markdown image / link (group 2 "!", group 3 its
 * text) whose URL is AgentMan-relative ("/api/v1/…", not protocol-relative "//"). One level of
 * nested brackets in the text and parens in the URL; bounded repeats keep long lines linear.
 */
const PROSE_LINK = new RegExp(
  [
    /(`+)[^`\n]*?\1(?!`)/.source,
    String.raw`(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\]){0,1000})\]\(\s*<?\/(?!\/)(?:[^()\n]|\([^()\n]*\)){0,2000}\)`,
  ].join("|"),
  "g",
);
const VERIFICATION = [
  ["Outcome", reportField("outcome|result|status")],
  ["Tests", reportField("tests?")],
  ["Changes", reportField("changes|changed files|diff")],
] as const;

interface Fence {
  indent: string;
  marker: string;
}

/** The code fence open after `line`, given the one open before it. */
function nextFence(open: Fence | null, line: string): Fence | null {
  const match = FENCE.exec(line);
  if (!match) return open;
  const [whole, indent, marker] = match;
  if (!open) return { indent, marker };
  const closes =
    marker[0] === open.marker[0] && marker.length >= open.marker.length && !line.slice(whole.length).trim();
  return closes ? null : open;
}

/** `PROSE_LINK` replacer: code spans as is, relative images dropped, relative links → their text. */
function rewriteLink(match: string, ticks: string | undefined, bang: string, label: string): string {
  if (ticks) return match;
  return bang ? "" : label.replace(PROSE_LINK, rewriteLink);
}

/** Drop AgentMan-relative images and keep only the text of such links, outside code. */
function stripRelative(text: string): string {
  let fence: Fence | null = null;
  return text
    .split("\n")
    .map((line) => {
      const inFence = fence !== null;
      fence = nextFence(fence, line);
      return inFence || fence ? line : line.replace(PROSE_LINK, rewriteLink);
    })
    .join("\n");
}

/**
 * Cut to `max` characters at a line boundary when one is close (else a word), ending with "…" and
 * closing a code fence the cut left open.
 */
function clipLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const newline = cut.lastIndexOf("\n");
  const atLine = newline > max * 0.5;
  const kept = atLine ? cut.slice(0, newline).trimEnd() : clip(text, max);
  const fence = kept.split("\n").reduce<Fence | null>(nextFence, null);
  const closed = fence ? `${kept}\n${fence.indent}${fence.marker}` : kept;
  if (!atLine) return closed;
  return fence ? `${closed}\n\n…` : `${closed}\n…`;
}

/** Trimmed, de-linked and clipped markdown with runs of blank lines collapsed. */
function tidy(text: string, max: number): string {
  return clipLines(
    stripRelative(text)
      .replace(/\n(?:[ \t]*\n){2,}/g, "\n\n")
      .trim(),
    max,
  );
}

/** "**Verification**" and "- **Outcome:** …" bullets from the report's Outcome, Tests and Changes. */
function verificationLines(report: string | null): string {
  if (!report) return "";
  const lines = VERIFICATION.flatMap(([label, field]) => {
    const value = stripRelative(field.exec(report)?.[1] ?? "").trim();
    return value ? [`- **${label}:** ${value}`] : [];
  });
  return lines.length ? ["**Verification**", ...lines].join("\n") : "";
}

/**
 * PR/MR description for a task: the latest run summary's prose, its verification bullets and the
 * task description collapsed in `<details>` (plain when there's no summary), then a footer.
 */
export function buildPrBody(description: string, summary: string | null): string {
  const { body, report } = summary?.trim() ? splitReport(summary.trim()) : { body: "", report: null };
  const prose = tidy(body, SUMMARY_MAX);
  const verification = verificationLines(report);
  const desc = tidy(description, DESCRIPTION_MAX);
  const task =
    desc && (prose || verification) ? `<details>\n<summary>Task</summary>\n\n${desc}\n\n</details>` : desc;
  return [prose, verification, task, FOOTER].filter(Boolean).join("\n\n");
}
