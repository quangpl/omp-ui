// Smart model selection: reads what a run is asked to do, sorts it into a profile, and picks the
// omp model role configured for that kind of work (fast `smol` for small mechanical edits, the
// reasoning `slow` role for hard problems, `designer` for UI work). A model pinned on the board
// always wins; anything else falls back to the default model.
import { execFile } from "node:child_process";
import { needsOrchestration } from "@/lib/agent/prompt";
import type { AppSettings, Board, Comment, Task } from "@/lib/types";

/**
 * Kind of work a run is: `quick` small mechanical edits (speed matters most), `deep` debugging,
 * performance, security and design-of-the-system work (quality matters most), `design` visual/UI
 * work, `standard` everything else.
 */
export type TaskProfile = "quick" | "standard" | "deep" | "design";

/** `omp config get modelRoles`: role name → model selector (may carry a `:thinking` suffix). */
export type ModelRoles = Record<string, string>;

export type ThinkingLevel = "low" | "high";

export interface ModelChoice {
  /** `--model` value (a model selector or `@role`); null leaves omp's own default. */
  model: string | null;
  /** `--thinking` value; set only when no role covers the profile. */
  thinking: ThinkingLevel | null;
  /**
   * `board`: pinned on the board; `auto`: picked for this task; `default`: settings default;
   * `session`: a resumed session keeps the model and thinking level it saved.
   */
  source: "board" | "auto" | "default" | "session";
  /** Null unless `source` is `auto`. */
  profile: TaskProfile | null;
  /** Human-readable why, for the run log. */
  reason: string;
}

/** Role tried for each profile; `standard` uses the default model. */
const PROFILE_ROLE: Record<Exclude<TaskProfile, "standard">, string> = {
  quick: "smol",
  deep: "slow",
  design: "designer",
};

/** Thinking level used instead when the profile's role is not configured; null keeps the model's. */
const PROFILE_THINKING: Record<TaskProfile, ThinkingLevel | null> = {
  quick: "low",
  deep: "high",
  design: null,
  standard: null,
};

const PROFILE_LABEL: Record<TaskProfile, string> = {
  quick: "small, mechanical change",
  deep: "needs deep reasoning",
  design: "visual/UI work",
  standard: "regular task",
};

interface Cue {
  label: string;
  pattern: RegExp;
}

const cue = (label: string, pattern: RegExp): Cue => ({ label, pattern });

/** Each counts 2: one is enough to call for deep reasoning. */
const DEEP_STRONG: Cue[] = [
  cue("debugging", /\b(?:debug(?:ging)?|root[- ]cause|investigat\w*|diagnos\w*)\b/i),
  cue("concurrency", /\b(?:race conditions?|deadlocks?|concurren\w*|thread[- ]safe\w*|mutex\w*|atomic(?:ity)?)\b/i),
  cue("memory leak", /\b(?:memory leaks?|leak(?:s|ing)?)\b/i),
  cue("flaky behavior", /\b(?:flak[ey]\w*|intermittent\w*|non-?deterministic|heisenbug)\b/i),
  cue("security", /\b(?:security|vulnerab\w*|exploit\w*|cve-\d+|xss|csrf|injection|sanitiz\w*|encrypt\w*)\b/i),
  cue("performance", /\b(?:performance|optimi[sz]\w*|bottlenecks?|latency|throughput|profil(?:e|ing)\b|slow(?:ness| down| loading)?\b)/i),
  cue("architecture", /\b(?:architect\w*|re-?architect\w*|system design|scalab\w*|distributed)\b/i),
  cue("migration", /\b(?:migrat\w*|schema changes?|data model)\b/i),
  cue("refactoring", /\b(?:refactor\w*|rewrite|re-?implement\w*)\b/i),
  cue("algorithm", /\b(?:algorithm\w*|complexity|recursion|parser|compiler|state machine)\b/i),
];

/** Each counts 1: a bug report alone is not deep, two hints together are. */
const DEEP_WEAK: Cue[] = [
  cue("bug", /\b(?:bugs?|crash\w*|regressions?|broken|not working|doesn'?t work|does not work|fails?|failing|exceptions?|stack ?trace)\b/i),
  cue("authentication", /\b(?:auth(?:entication|orization)?|oauth|permissions?|tokens?)\b/i),
  cue("data integrity", /\b(?:transactions?|consisten\w*|cach(?:e|ing)|sync(?:hroni[sz]\w*)?)\b/i),
];

/** Small mechanical edits; only count when the brief is short and nothing hard is asked. */
const QUICK: Cue[] = [
  cue("typo", /\b(?:typos?|spelling|misspell\w*|grammar)\b/i),
  cue("rename", /\brenam\w*\b/i),
  cue("wording", /\b(?:wording|copy ?text|label text|button text|reword\w*|rephras\w*)\b/i),
  cue("version bump", /\b(?:bump\w*|upgrade \S+ to|update (?:the )?version)\b/i),
  cue("docs", /\b(?:readme|changelog|docstrings?|comments? in the code|code comments?|jsdoc)\b/i),
  cue("formatting", /\b(?:lint(?:ing)?|format(?:ting)?|prettier|whitespace|indent\w*)\b/i),
  cue("small change", /\b(?:small|tiny|minor|trivial|simple|quick|one[- ]line)\s+(?:fix|change|tweak|update|edit)\b/i),
];

/** Visual and UI work. */
const DESIGN: Cue[] = [
  cue("UI", /\b(?:ui|ux|user interface|front-?end)\b/i),
  cue("layout", /\b(?:layout|landing page|hero section|dashboard design|responsive|mobile view)\b/i),
  cue("styling", /\b(?:css|tailwind|styl(?:e|es|ing)|theme|dark mode|colou?rs?|fonts?|typography|spacing|padding|margins?)\b/i),
  cue("visual design", /\b(?:redesign\w*|design system|visual\w*|look and feel|beautiful|polish\w*|animations?|transitions?|icons?|mock-?ups?|figma)\b/i),
];

/** Brief length (words) up to which a quick cue can make the run `quick`. */
const QUICK_MAX_WORDS = 60;
/** Brief length (words) from which a task counts one point towards `deep`. */
const DEEP_LONG_WORDS = 150;

/** Profile for the work a run is asked to do: the task and its feedback. */
export function classifyTask(task: Task, feedback: Comment[]): { profile: TaskProfile; cues: string[] } {
  const texts = feedback.map((c) => c.body);
  texts.push(task.title, task.description);
  const text = texts.join("\n");
  const words = text.split(/\s+/).filter(Boolean).length;
  const large = needsOrchestration(task, feedback);

  const matches = (cues: Cue[]) => cues.filter((c) => c.pattern.test(text)).map((c) => c.label);
  const strong = matches(DEEP_STRONG);
  const weak = matches(DEEP_WEAK);
  const deepScore = 2 * strong.length + weak.length + (words >= DEEP_LONG_WORDS ? 1 : 0);
  if (deepScore >= 2) {
    const cues = [...strong, ...weak];
    return { profile: "deep", cues: cues.length > 0 ? cues : ["long brief"] };
  }

  const quick = matches(QUICK);
  if (quick.length > 0 && deepScore === 0 && words <= QUICK_MAX_WORDS && !large) {
    return { profile: "quick", cues: quick };
  }

  const design = matches(DESIGN);
  if (design.length > 0) return { profile: "design", cues: design };
  return { profile: "standard", cues: [] };
}

/**
 * Model for a run. Precedence: the board's pinned model; then, with `autoModel` on, the omp role
 * configured for the task's profile (or the default model with a thinking level suited to it when
 * that role is not configured); then the settings default. `roles` null means the configured roles
 * are unknown, so auto selection only adjusts thinking.
 *
 * A resumed run with `autoModel` on and no pinned model passes neither `--model` nor `--thinking`:
 * omp restores the session's saved model and thinking level, like continuing a direct omp chat.
 * Switching models there (e.g. `@smol` for a short feedback comment) would re-send the whole cached
 * history to another model, a full prompt-cache miss. A pinned board model and the autoModel-off
 * default stay explicit user choices and still apply.
 */
export function chooseModel(input: {
  board: Pick<Board, "model">;
  settings: Pick<AppSettings, "defaultModel" | "autoModel">;
  task: Task;
  feedback: Comment[];
  isResume: boolean;
  roles: ModelRoles | null;
}): ModelChoice {
  const { board, settings, task, feedback, isResume, roles } = input;
  const pinned = board.model?.trim();
  if (pinned) return { model: pinned, thinking: null, source: "board", profile: null, reason: "set on the board" };

  const fallback = settings.defaultModel.trim() || null;
  if (!settings.autoModel) {
    return { model: fallback, thinking: null, source: "default", profile: null, reason: "default model" };
  }

  if (isResume) {
    return { model: null, thinking: null, source: "session", profile: null, reason: "resumed session keeps its model" };
  }

  const { profile, cues } = classifyTask(task, feedback);
  const why = `${PROFILE_LABEL[profile]}${cues.length > 0 ? `: ${cues.join(", ")}` : ""}`;
  const role = profile === "standard" ? null : PROFILE_ROLE[profile];
  if (role && roles?.[role]?.trim()) {
    return { model: `@${role}`, thinking: null, source: "auto", profile, reason: `${why} → ${role} role (${roles[role]})` };
  }
  const thinking = PROFILE_THINKING[profile];
  return {
    model: fallback,
    thinking,
    source: "auto",
    profile,
    reason: role ? `${why} → no ${role} role configured, default model${thinking ? ` with ${thinking} thinking` : ""}` : why,
  };
}

const ROLES_TIMEOUT_MS = 5_000;
/** Reads in flight per omp + folder: cards launching together share one `omp config` process. */
const rolesInFlight = new Map<string, Promise<ModelRoles | null>>();

/**
 * Model roles omp resolves in `cwd` (global config plus the project's `.omp`), via
 * `omp config get modelRoles --json`. Null when omp cannot report them (old omp, bad path).
 * Concurrent calls for the same omp and folder share one read; later calls read again.
 */
export function readModelRoles(ompPath: string, cwd: string, env: NodeJS.ProcessEnv): Promise<ModelRoles | null> {
  const key = JSON.stringify([ompPath, cwd]);
  const pending = rolesInFlight.get(key);
  if (pending) return pending;
  const { promise, resolve } = Promise.withResolvers<ModelRoles | null>();
  rolesInFlight.set(key, promise);
  execFile(
    ompPath,
    ["config", "get", "modelRoles", "--json"],
    { cwd, env, timeout: ROLES_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    (err, stdout) => {
      rolesInFlight.delete(key);
      resolve(err ? null : parseRoles(String(stdout)));
    },
  );
  return promise;
}

/** `{ "key": "modelRoles", "value": { role: selector } }`; a null value means no roles are set. */
function parseRoles(stdout: string): ModelRoles | null {
  let value: unknown;
  try {
    value = (JSON.parse(stdout) as { value?: unknown } | null)?.value;
  } catch {
    return null;
  }
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const roles: ModelRoles = {};
  for (const [name, selector] of Object.entries(value)) {
    if (typeof selector === "string" && selector.trim()) roles[name] = selector.trim();
  }
  return roles;
}
