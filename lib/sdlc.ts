import type { TodoPhase } from "@/lib/types";

/**
 * The seven SDLC phases, in order (https://www.atlassian.com/agile/software-development/sdlc).
 * Card agents name their todo phases after them; progress, transitions and the release gate are
 * all derived from `Task.todos`, so nothing about the SDLC is persisted.
 */
export const SDLC_PHASES = [
  "planning",
  "feasibility",
  "design",
  "implementation",
  "testing",
  "deployment",
  "maintenance",
] as const;

export type SdlcPhaseId = (typeof SDLC_PHASES)[number];

/** Static description of one SDLC phase. */
export interface SdlcPhaseInfo {
  id: SdlcPhaseId;
  /** 1..7 */
  step: number;
  label: string;
  /** One line: what happens in the phase, adapted to a coding agent. */
  description: string;
  /** Exit criteria = the quality gate to leave the phase; lowercase sentence fragment, no final period. */
  gate: string;
  /** Always part of a run (implementation, testing); the others only when the task needs them. */
  required: boolean;
}

/** Label, description, quality gate and requiredness of every SDLC phase. */
export const SDLC_PHASE_INFO: Record<SdlcPhaseId, SdlcPhaseInfo> = {
  planning: {
    id: "planning",
    step: 1,
    label: "Planning",
    description: "Optional: pin down scope and acceptance criteria and split the work into steps; card agents skip it and start right away.",
    gate: "goal, scope and acceptance criteria are clear and the work is split into steps",
    required: false,
  },
  feasibility: {
    id: "feasibility",
    step: 2,
    label: "Feasibility",
    description: "Check the approach is technically viable: analyse risks and unknowns, spike or prototype when unsure.",
    gate: "risks, unknowns and the approach are settled (spike or prototype if needed)",
    required: false,
  },
  design: {
    id: "design",
    step: 3,
    label: "Design",
    description: "Decide the architecture, interfaces, data shapes and UI the code will follow and stay compatible with.",
    gate: "interfaces, data shapes and UI are decided before any code depends on them",
    required: false,
  },
  implementation: {
    id: "implementation",
    step: 4,
    label: "Implementation",
    description: "Write the code to the design: complete, secure, maintainable and in the project's style.",
    gate: "the change is complete, with no stubs or TODOs, and follows the project's patterns",
    required: true,
  },
  testing: {
    id: "testing",
    step: 5,
    label: "Testing",
    description: "Verify the change fast: type-check, run only the tests covering the changed code and check the changed behavior once.",
    gate: "type checks and the tests covering the change pass and the changed behavior was checked once",
    required: true,
  },
  deployment: {
    id: "deployment",
    step: 6,
    label: "Deployment",
    description: "Release the work: update docs and changelog, write the report and ship it when asked.",
    gate: "docs and changelog are updated, the report is written and the work is released when asked",
    required: false,
  },
  maintenance: {
    id: "maintenance",
    step: 7,
    label: "Maintenance",
    description: "Support the delivered work: fix feedback and bugs, then re-verify and report after release.",
    gate: "the feedback is fixed, re-tested and reported without regressions",
    required: false,
  },
};

export type SdlcPhaseStatus = "skipped" | "pending" | "active" | "done";

/** Progress of one SDLC phase, aggregated over every todo phase mapped to it. */
export interface SdlcPhaseProgress {
  id: SdlcPhaseId;
  status: SdlcPhaseStatus;
  /** Completed items. */
  done: number;
  /** Items, abandoned ones excluded. */
  total: number;
  /** Content of its first in_progress item, else null. */
  current: string | null;
  /** Earliest `startedAt` of its items; null if none. */
  startedAt: string | null;
  /** Latest `completedAt` of its items when status is "done"; else null. */
  completedAt: string | null;
}

/** A breach of the SDLC transition rules. */
export interface SdlcViolation {
  /** The phase that started too early (or Deployment without Testing). */
  phase: SdlcPhaseId;
  /** The phase that had to be complete first. */
  requires: SdlcPhaseId;
  /** e.g. "Deployment started before Testing was complete", "Deployment started without a Testing phase" */
  message: string;
}

/** SDLC view of a card's todo list. */
export interface SdlcProgress {
  /** Always 7 entries, SDLC order. */
  phases: SdlcPhaseProgress[];
  /** Phase the agent is in; null when every included phase is done. */
  current: SdlcPhaseId | null;
  /** Included (non-skipped) phases that are done. */
  completed: number;
  /** Non-skipped phases. */
  included: number;
  /** Every todo phase was named with a canonical SDLC name (classifySdlcPhase hit). Enforcement only applies when true. */
  canonical: boolean;
  /** Transition-rule breaches, deduped by phase+requires, SDLC order of `phase`. [] when the process was followed. */
  violations: SdlcViolation[];
}

/** Text prefix of the feedback comment the manager adds when the release gate sends a card back. */
export const QUALITY_GATE_PREFIX = "**Quality gate:** ";

const PHASE_COUNT = SDLC_PHASES.length;
const IMPLEMENTATION = SDLC_PHASES.indexOf("implementation");
const TESTING = SDLC_PHASES.indexOf("testing");
const DEPLOYMENT = SDLC_PHASES.indexOf("deployment");

/** Regex alternation of literal words; a space matches any run of whitespace. */
function alternation(words: readonly string[]): string {
  return words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")).join("|");
}

/** Canonical names per phase; a name must start with one, followed by a non-letter or its end. */
const CANONICAL_ALIASES: Record<SdlcPhaseId, readonly string[]> = {
  planning: ["planning", "plan"],
  feasibility: ["feasibility"],
  design: ["system design", "design"],
  implementation: ["implementation", "implement", "development"],
  testing: ["testing", "tests", "test", "qa", "verification"],
  deployment: ["deployment", "deploy", "release"],
  maintenance: ["maintenance", "maintain"],
};

/**
 * Leading emoji/symbols and an optional numbering ("1.", "2 -", "Phase 3:", "Step 4 —", "Stage 5"),
 * then one capture group per phase in SDLC order holding its aliases.
 */
const CANONICAL_RE = new RegExp(
  "^[^\\p{L}\\p{N}]*(?:(?:(?:phase|step|stage)\\s*)?\\d+(?:\\.\\d+)*(?!\\p{L})[^\\p{L}\\p{N}]*)?" +
    `(?:${SDLC_PHASES.map((id) => `(${alternation(CANONICAL_ALIASES[id])})`).join("|")})(?!\\p{L})`,
  "iu",
);

/** Inference keywords; the table order breaks ties between keywords starting at the same position. */
const INFER_TABLE: readonly (readonly [SdlcPhaseId, readonly string[]])[] = [
  ["maintenance", ["maintain", "maintenance", "support", "monitor", "follow-up", "followup"]],
  [
    "deployment",
    [
      "deploy", "release", "ship", "rollout", "publish", "commit", "push", "merge", "handoff", "hand off",
      "deliver", "docs", "documentation", "changelog", "cleanup", "clean up", "finalize", "wrap up", "report",
    ],
  ],
  [
    "testing",
    [
      "test", "verify", "verification", "validate", "validation", "qa", "check", "review", "audit", "lint",
      "typecheck", "smoke", "e2e", "regression",
    ],
  ],
  ["design", ["design", "architect", "architecture", "spec", "schema", "contract", "interface", "mockup", "wireframe", "ui", "ux"]],
  ["feasibility", ["feasib", "risk", "spike", "prototype", "poc", "proof of concept", "evaluate", "assess"]],
  [
    "planning",
    ["plan", "scope", "requirement", "ingest", "research", "investigate", "explore", "discover", "understand", "context", "triage", "analy"],
  ],
  [
    "implementation",
    [
      "implement", "build", "develop", "code", "write", "edit", "fix", "refactor", "migrate", "wire", "integrate",
      "add", "create", "update", "change", "dispatch",
    ],
  ],
];

/**
 * Any keyword at a word start, one capture group per INFER_TABLE row. A non-global exec returns the
 * earliest position, and at that position the first matching alternative, i.e. the table order.
 */
const INFER_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${INFER_TABLE.map(([, words]) => `(${alternation(words)})`).join("|")})`,
  "iu",
);

/** Phase id of the first defined capture group; `ids[i]` belongs to group i + 1. */
function matchedPhase(match: RegExpExecArray | null, ids: readonly SdlcPhaseId[]): SdlcPhaseId | null {
  if (!match) return null;
  for (let group = 1; group < match.length; group++) {
    if (match[group] !== undefined) return ids[group - 1];
  }
  return null;
}

const INFER_IDS: readonly SdlcPhaseId[] = INFER_TABLE.map(([id]) => id);

/** Canonical SDLC name → phase; null otherwise. */
export function classifySdlcPhase(name: string): SdlcPhaseId | null {
  return matchedPhase(CANONICAL_RE.exec(name), SDLC_PHASES);
}

/** Keyword inference for legacy names / item texts (classifySdlcPhase first); null when nothing matches. */
export function inferSdlcPhase(text: string): SdlcPhaseId | null {
  return classifySdlcPhase(text) ?? matchedPhase(INFER_RE.exec(text), INFER_IDS);
}

/** SDLC index of a todo phase from its items' inferred phases; majority wins, ties go to the earliest step. */
function voteItems(tasks: TodoPhase["tasks"]): number {
  const votes = new Array<number>(PHASE_COUNT).fill(0);
  let best = -1;
  for (const task of tasks) {
    const id = inferSdlcPhase(task.content);
    if (id === null) continue;
    const index = SDLC_PHASES.indexOf(id);
    votes[index]++;
  }
  for (let index = 0; index < PHASE_COUNT; index++) {
    if (votes[index] > 0 && (best < 0 || votes[index] > votes[best])) best = index;
  }
  return best;
}

/**
 * SDLC index of every todo phase (canonical name, else inferred name, else its items' majority vote;
 * unresolved phases inherit the previous one, leading ones the first resolved), and whether every
 * name was canonical. Null when no todo phase resolves (or the list is empty).
 */
function resolvePhases(todos: readonly TodoPhase[]): { indices: number[]; canonical: boolean } | null {
  const indices = new Array<number>(todos.length);
  let canonical = true;
  let firstResolved = -1;
  for (let i = 0; i < todos.length; i++) {
    const { name, tasks } = todos[i];
    let id = classifySdlcPhase(name);
    if (id === null) {
      canonical = false;
      id = matchedPhase(INFER_RE.exec(name), INFER_IDS);
    }
    const index = id === null ? voteItems(tasks) : SDLC_PHASES.indexOf(id);
    indices[i] = index;
    if (index >= 0 && firstResolved < 0) firstResolved = index;
  }
  if (firstResolved < 0) return null;
  let inherited = firstResolved;
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= 0) inherited = indices[i];
    else indices[i] = inherited;
  }
  return { indices, canonical };
}

/**
 * The SDLC phase each todo phase counts toward, one entry per todo phase: its name, else its items'
 * majority, else the previous phase's (leading unresolved phases take the first resolved one).
 * Null when no todo phase resolves (or the list is empty).
 */
export function sdlcPhaseMap(todos: readonly TodoPhase[]): SdlcPhaseId[] | null {
  return resolvePhases(todos)?.indices.map((index) => SDLC_PHASES[index]) ?? null;
}

/** SDLC progress of a todo list; null when no todo phase can be mapped (or the list is empty). */
export function sdlcProgress(todos: readonly TodoPhase[]): SdlcProgress | null {
  // 1–4: map every todo phase to an SDLC index; unresolved ones inherit the previous resolved one.
  const resolved = resolvePhases(todos);
  if (resolved === null) return null;
  const { indices: mapped, canonical } = resolved;

  // 5: aggregate items per SDLC phase; abandoned items do not count.
  const phases = SDLC_PHASES.map(
    (id): SdlcPhaseProgress => ({
      id,
      status: "skipped",
      done: 0,
      total: 0,
      current: null,
      startedAt: null,
      completedAt: null,
    }),
  );
  let current = -1;
  for (let i = 0; i < todos.length; i++) {
    const index = mapped[i];
    const phase = phases[index];
    for (const task of todos[i].tasks) {
      if (task.status === "abandoned") continue;
      phase.total++;
      if (task.status === "completed") phase.done++;
      else if (task.status === "in_progress") {
        if (phase.current === null) phase.current = task.content;
        if (current < 0) current = index;
      }
      if (task.startedAt && (phase.startedAt === null || task.startedAt < phase.startedAt)) phase.startedAt = task.startedAt;
      if (task.completedAt && (phase.completedAt === null || task.completedAt > phase.completedAt)) {
        phase.completedAt = task.completedAt;
      }
    }
  }

  let completed = 0;
  let included = 0;
  for (let index = 0; index < PHASE_COUNT; index++) {
    const phase = phases[index];
    if (phase.total === 0) continue;
    included++;
    if (phase.done === phase.total) {
      phase.status = "done";
      completed++;
      continue;
    }
    phase.status = phase.done > 0 || phase.current !== null ? "active" : "pending";
    phase.completedAt = null;
    if (current < 0) current = index;
  }

  // 7: one violation per started phase (its earliest unfinished predecessor), plus Deployment
  // without Testing; the pairs are unique by construction, so no dedupe pass is needed.
  const violations: SdlcViolation[] = [];
  for (let index = 1; index < PHASE_COUNT; index++) {
    const status = phases[index].status;
    if (status !== "active" && status !== "done") continue;
    const label = SDLC_PHASE_INFO[SDLC_PHASES[index]].label;
    for (let before = 0; before < index; before++) {
      const earlier = phases[before].status;
      if (earlier === "skipped" || earlier === "done") continue;
      violations.push({
        phase: SDLC_PHASES[index],
        requires: SDLC_PHASES[before],
        message: `${label} started before ${SDLC_PHASE_INFO[SDLC_PHASES[before]].label} was complete`,
      });
      break;
    }
    if (index === DEPLOYMENT && phases[TESTING].status === "skipped" && phases[IMPLEMENTATION].status !== "skipped") {
      violations.push({ phase: "deployment", requires: "testing", message: "Deployment started without a Testing phase" });
    }
  }

  return {
    phases,
    current: current < 0 ? null : SDLC_PHASES[current],
    completed,
    included,
    canonical,
    violations,
  };
}

/** Why the card must not ship yet (Testing gate), or null when it may. Null for null / non-canonical progress. */
export function releaseGate(progress: SdlcProgress | null): string | null {
  if (!progress?.canonical) return null;
  const testing = progress.phases[TESTING];
  if (testing.status === "skipped") {
    return progress.phases[IMPLEMENTATION].status === "skipped"
      ? null
      : "No Testing phase: the implementation was never tested";
  }
  if (testing.status !== "done") return `Testing is not complete (${testing.done} of ${testing.total} items done)`;
  return null;
}

/** What moved between two SDLC snapshots of the same card: drives run events and steering. */
export interface SdlcChange {
  /** `after.current` when it differs from `before?.current` and is not null; else null. */
  entered: SdlcPhaseId | null;
  /** Phases "done" in `after` that were not "done" in `before` (before null → every done phase), SDLC order. */
  completed: SdlcPhaseId[];
  /** Violations in `after` not in `before` (key phase+requires). */
  violations: SdlcViolation[];
}

/** Diff of two SDLC snapshots (e.g. before and after a todo update). */
export function sdlcChange(before: SdlcProgress | null, after: SdlcProgress | null): SdlcChange {
  if (!after) return { entered: null, completed: [], violations: [] };
  const entered = after.current !== null && after.current !== before?.current ? after.current : null;
  const completed: SdlcPhaseId[] = [];
  for (let index = 0; index < PHASE_COUNT; index++) {
    if (after.phases[index].status === "done" && before?.phases[index].status !== "done") {
      completed.push(SDLC_PHASES[index]);
    }
  }
  const violations = before
    ? after.violations.filter(
        (violation) =>
          !before.violations.some((old) => old.phase === violation.phase && old.requires === violation.requires),
      )
    : after.violations;
  return { entered, completed, violations };
}
