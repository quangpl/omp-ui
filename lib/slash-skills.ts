// "/" picker shared by the new-card form and the inline composer: typing "/" opens a menu of
// OMP skills (from `omp skill list`) and OMP prompt shortcuts. Picking one inserts a token the
// downstream card agent understands: `skill://<name>` (omp loads the skill when it reads the
// card) or a magic keyword like `orchestrate`.
import type { OmpSkill } from "@/lib/types";

/** The `/word` being typed: `[start, end)` spans it in the text, `query` is the part after "/". */
export interface SlashToken {
  start: number;
  end: number;
  query: string;
}

/** One pickable entry: an installed omp skill or a built-in omp prompt shortcut. */
export interface SlashItem {
  kind: "skill" | "shortcut";
  name: string;
  description: string;
  /** Text that replaces the `/query` token. */
  insert: string;
}

/**
 * OMP prompt shortcuts the pipeline understands, beyond skills. `orchestrate` is omp's magic
 * keyword: the card writer and the run prompt both treat it as a cue to split the card across
 * parallel subagents.
 */
export const OMP_SHORTCUTS: readonly SlashItem[] = [
  {
    kind: "shortcut",
    name: "orchestrate",
    description: "Split this card into parallel subagent tasks, then verify and integrate the results.",
    insert: "orchestrate",
  },
];

/**
 * The slash token at `caret`, or null when the caret is not right after `/word`. The "/" must
 * start the text or follow whitespace, so URL paths (`https://…`, `a/b`) never open the menu.
 */
export function slashTokenAt(text: string, caret: number): SlashToken | null {
  const match = /(^|\s)\/([A-Za-z0-9_-]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[2].length - 1, end: caret, query: match[2] };
}

/** All pickable entries: shortcuts first, then every skill as a `skill://<name>` insert. */
export function slashItems(skills: readonly OmpSkill[]): SlashItem[] {
  return [
    ...OMP_SHORTCUTS,
    ...skills.map<SlashItem>((skill) => ({
      kind: "skill",
      name: skill.name,
      description: skill.description,
      insert: `skill://${skill.name}`,
    })),
  ];
}

/** Entries matching `query`: name prefixes first, then name substrings, then description hits. */
export function filterSlashItems(items: readonly SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  const rank = (item: SlashItem): number => {
    const name = item.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    if (item.description.toLowerCase().includes(q)) return 2;
    return 3;
  };
  return items
    .map((item) => ({ item, rank: rank(item) }))
    .filter(({ rank }) => rank < 3)
    .sort((a, b) => a.rank - b.rank)
    .map(({ item }) => item);
}

/** `text` with the token replaced by `item.insert` plus a space; `caret` is right after it. */
export function applySlashItem(
  text: string,
  token: SlashToken,
  item: SlashItem,
): { text: string; caret: number } {
  const insert = `${item.insert} `;
  return {
    text: text.slice(0, token.start) + insert + text.slice(token.end),
    caret: token.start + insert.length,
  };
}
