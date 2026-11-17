// "/" picker items shared by the new-card form and the inline composer: typing "/" opens a menu
// of OMP skills (from `omp skill list`) and OMP prompt shortcuts. Picking one inserts a token the
// downstream card agent understands: `skill://<name>` (omp loads the skill when it reads the
// card) or a magic keyword like `orchestrate`. Token detection and insertion live in
// `@/lib/composer-autocomplete`.
import type { OmpSkill } from "@/lib/types";

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
 * keyword: omp and the run prompt both treat it as a cue to split the card across parallel
 * subagents.
 */
export const OMP_SHORTCUTS: readonly SlashItem[] = [
  {
    kind: "shortcut",
    name: "orchestrate",
    description: "Split this card into parallel subagent tasks, then verify and integrate the results.",
    insert: "orchestrate",
  },
];

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
