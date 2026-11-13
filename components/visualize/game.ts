// Game layer of the Visualize page: worker identities, crew level and achievements derived from
// the dashboard. Live "what is this worker doing" lines live in activity.ts.
import type { Dashboard } from "@/lib/types";

/** Done cards are worth this much XP each. */
export const XP_PER_CARD = 100;

/** FNV-1a: stable, well-spread 32-bit hash so a card keeps its worker across reloads. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const WORKER_NAMES = [
  "Ada", "Bolt", "Cog", "Dash", "Echo", "Flux", "Gizmo", "Hex", "Ion", "Jolt", "Kilo", "Lumen",
  "Mox", "Nova", "Orbit", "Pixel", "Quark", "Rivet", "Sprocket", "Turbo", "Volt", "Widget", "Zip",
  "Byte", "Cobalt", "Ember", "Fuse", "Glitch", "Nano", "Servo",
];

/** OKLCH hues far enough apart that two workers side by side never look alike. */
const WORKER_HUES = [25, 55, 90, 145, 195, 235, 275, 320];

export interface WorkerIdentity {
  name: string;
  /** OKLCH hue of the worker's paint job. */
  hue: number;
}

/** Each card gets its own worker: a name and a colour, stable for the card's lifetime. */
export function workerIdentity(taskId: string): WorkerIdentity {
  const h = hash(taskId);
  return { name: WORKER_NAMES[h % WORKER_NAMES.length], hue: WORKER_HUES[(h >>> 8) % WORKER_HUES.length] };
}

// ---------------------------------------------------------------------------------------------
// Crew level

const RANKS = ["Rookie crew", "Apprentices", "Journeymen", "Craftsfolk", "Experts", "Masters", "Legends"];

export interface CrewLevel {
  level: number;
  rank: string;
  xp: number;
  /** XP at which the current level started and the next one starts. */
  levelStartXp: number;
  nextLevelXp: number;
  /** 0..1 through the current level. */
  progress: number;
}

/** Done cards needed to reach `level` (1-based): 0, 2, 6, 12, 20, …; each level needs 2 more. */
function cardsForLevel(level: number): number {
  return level * (level - 1);
}

/** Crew level from the number of Done cards across every project. */
export function crewLevel(doneCards: number): CrewLevel {
  const done = Math.max(0, Math.floor(doneCards));
  let level = 1;
  while (cardsForLevel(level + 1) <= done) level += 1;
  const start = cardsForLevel(level);
  const next = cardsForLevel(level + 1);
  return {
    level,
    rank: RANKS[Math.min(RANKS.length - 1, Math.floor((level - 1) / 2))],
    xp: done * XP_PER_CARD,
    levelStartXp: start * XP_PER_CARD,
    nextLevelXp: next * XP_PER_CARD,
    progress: (done - start) / (next - start),
  };
}

// ---------------------------------------------------------------------------------------------
// Achievements

export type AchievementId =
  | "first-card"
  | "first-run"
  | "first-ship"
  | "ten-shipped"
  | "fifty-shipped"
  | "full-house"
  | "multi-project"
  | "all-clear";

export interface Achievement {
  id: AchievementId;
  title: string;
  description: string;
  unlocked: boolean;
}

/** Badges earned so far; locked ones are listed too so the user sees what to aim for. */
export function achievements(dashboard: Dashboard): Achievement[] {
  const { boards, totals, queue, setup } = dashboard;
  const attention = boards.reduce((sum, b) => sum + b.attentionCount, 0);
  return [
    { id: "first-card", title: "First job", description: "Add a task", unlocked: setup.hasCard },
    { id: "first-run", title: "Clocked in", description: "Run an agent on a card", unlocked: setup.hasRun },
    { id: "first-ship", title: "First ship", description: "Get a card to Done", unlocked: totals.done >= 1 },
    { id: "ten-shipped", title: "Ten shipped", description: "10 cards Done", unlocked: totals.done >= 10 },
    { id: "fifty-shipped", title: "Half century", description: "50 cards Done", unlocked: totals.done >= 50 },
    {
      id: "full-house",
      title: "Full house",
      description: "Every desk busy at once (right now)",
      unlocked: queue.limit > 0 && queue.running.length >= queue.limit,
    },
    {
      id: "multi-project",
      title: "Multi-site",
      description: "Run 3 or more projects",
      unlocked: boards.length >= 3,
    },
    {
      id: "all-clear",
      title: "All clear",
      description: "Nothing failed or stalled (right now)",
      unlocked: totals.done > 0 && attention === 0,
    },
  ];
}

