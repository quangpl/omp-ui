import type { Task } from "@/lib/types";

/**
 * Classifies a card as software-development work (its agent edits the repository and applies the
 * SDLC workflow) versus everything else, which runs straight without the lifecycle. Heuristic and
 * deliberately conservative: when the text is ambiguous it counts as software work, because the
 * card runner, todo phases and quality gates are all built around that. Nothing is persisted — the
 * class is derived from the title and description on every run, and no UI depends on it.
 */

/**
 * Unambiguous engineering/code signals. Their presence keeps a task in the SDLC workflow, even when
 * a non-software word (e.g. "email" in "email notification feature") also appears.
 */
const SOFTWARE_MARKERS = [
  "api",
  "app",
  "application",
  "backend",
  "bug",
  "bugfix",
  "build",
  "ci/cd",
  "class",
  "cli",
  "code",
  "codebase",
  "commit",
  "compile",
  "compiler",
  "component",
  "config",
  "configuration",
  "crash",
  "css",
  "database",
  "debug",
  "debugger",
  "deploy",
  "deployment",
  "developer",
  "development",
  "docker",
  "e2e",
  "endpoint",
  "error",
  "exception",
  "feature",
  "framework",
  "frontend",
  "function",
  "git",
  "graphql",
  "hook",
  "html",
  "http",
  "implement",
  "implementation",
  "interface",
  "javascript",
  "jwt",
  "kubernetes",
  "library",
  "lint",
  "linter",
  "login",
  "memory leak",
  "merge request",
  "middleware",
  "migration",
  "module",
  "notification",
  "oauth",
  "orm",
  "package",
  "plugin",
  "profiler",
  "program",
  "pull request",
  "python",
  "race condition",
  "react",
  "refactor",
  "regression",
  "repository",
  "rest api",
  "route",
  "router",
  "runtime",
  "schema",
  "sdk",
  "server",
  "software",
  "sql",
  "stack trace",
  "test",
  "testing",
  "tests",
  "type check",
  "typecheck",
  "typescript",
  "ui",
  "ux",
  "web app",
  "webapp",
  "webhook",
  "websocket",
  "website",
] as const;

/**
 * Unambiguous content/research/creative signals: the deliverable is text, a plan or an answer, not
 * code. A task with one of these and no software marker runs straight.
 */
const NON_SOFTWARE_MARKERS = [
  "article",
  "bedtime story",
  "bio",
  "biography",
  "blog",
  "blog post",
  "caption",
  "content calendar",
  "cover letter",
  "email",
  "essay",
  "explain",
  "explanation",
  "fairy tale",
  "fiction",
  "headline",
  "how do",
  "how does",
  "investigate",
  "itinerary",
  "joke",
  "lesson plan",
  "letter of recommendation",
  "lyrics",
  "marketing plan",
  "meal plan",
  "newsletter",
  "novel",
  "paraphrase",
  "poem",
  "poetry",
  "press release",
  "proofread",
  "quiz",
  "recipe",
  "research",
  "resume",
  "riddle",
  "screenplay",
  "slogan",
  "social media post",
  "song",
  "speech",
  "story",
  "study plan",
  "summarize",
  "summary",
  "tagline",
  "toast",
  "translate",
  "translation",
  "travel plan",
  "trivia",
  "tweet",
  "what is",
  "why do",
  "why does",
  "workout",
] as const;

/** Case-insensitive alternation of the given phrases, each matched at whole-word boundaries. */
function matcher(phrases: readonly string[]): RegExp {
  const escaped = phrases.map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i");
}

const SOFTWARE_RE = matcher(SOFTWARE_MARKERS);
const NON_SOFTWARE_RE = matcher(NON_SOFTWARE_MARKERS);

/** Whether a card is software-development work (SDLC applies) rather than a straight non-software task. */
export function isSoftwareTask(task: Pick<Task, "title" | "description">): boolean {
  const text = `${task.title}\n${task.description}`;
  if (NON_SOFTWARE_RE.test(text) && !SOFTWARE_RE.test(text)) return false;
  return true;
}
