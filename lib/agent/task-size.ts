import type { Comment, Task } from "@/lib/types";

/** Separate work items (list entries, feedback comments) at which a task counts as large. */
const LARGE_MIN_ITEMS = 4;
/** Word count at which a task counts as large. */
const LARGE_MIN_WORDS = 300;

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
const LARGE_CUES = [
  /\borchestrate\b/i,
  /\bin parallel\b/i,
  /\bsub-?agents?\b/i,
  /\b(?:across|throughout)\s+(?:the\s+)?(?:whole\s+|entire\s+)?(?:code\s?base|repo(?:sitory)?|project|app)\b/i,
  new RegExp(`\\b(?:every|each|all(?:\\s+(?:of\\s+)?the)?)\\s+${SCOPE_NOUN}\\b`, "i"),
];

/**
 * Whether the work is large: many separate items (description list entries plus feedback comments), a
 * long brief, or an explicit ask for broad/parallel work. Fenced code (pasted code, logs) is ignored,
 * and so are list entries under headings like "Acceptance criteria", "Context" or "Notes": they
 * describe the work, they don't add to it.
 */
export function isLargeTask(task: Task | null, feedback: Comment[]): boolean {
  const texts = feedback.map((c) => c.body);
  if (task) texts.push(task.title, task.description);
  const scans = texts.map(scanBrief);
  const prose = scans.map((scan) => scan.prose).join("\n");

  if (LARGE_CUES.some((cue) => cue.test(prose))) return true;
  if (prose.split(/\s+/).filter(Boolean).length >= LARGE_MIN_WORDS) return true;

  // Every work list entry is an item; a feedback comment without one is one item on its own.
  const items = scans.reduce((sum, scan) => sum + scan.items, 0);
  const lone = scans.slice(0, feedback.length).filter((scan) => scan.items === 0).length;
  return items + lone >= LARGE_MIN_ITEMS;
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
