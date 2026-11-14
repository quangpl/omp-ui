// The advisor: a senior-engineer omp agent that answers the questions a card's agent (or one of its
// subagents) would otherwise leave for the user, so people are asked only what needs a person.
// - During a run, the agent calls the `ask_advisor` host tool and gets a decision back.
// - When a run ends with questions in its summary, the advisor triages them: it answers what it
//   can (sending the agent back to work when an answer changes the result) and keeps for the user
//   only the questions that need their own judgment.
// It runs on a warm `omp --mode rpc` helper worker in the project with read-only tools, like the
// card writer.
import { readModelRoles } from "@/lib/agent/model-select";
import { existingFolders, extractJsonObject, runOmpHelper } from "@/lib/agent/omp-helper";
import { clip } from "@/lib/card-draft";
import { childEnv } from "@/lib/child-env";
import { mcpAgentEnv } from "@/lib/server/mcp-env";
import type { AppSettings, Board, Task } from "@/lib/types";

/** The advisor is cancelled after this long. */
const TIMEOUT_SECONDS = 210;
/** Longest question / context / option list taken from the agent (characters). */
const MAX_FIELD = 6_000;
const MAX_OPTIONS = 12;
/** Longest card description and run summary put in the advisor's prompt. */
const MAX_BRIEF = 12_000;
/** Longest answer kept from the advisor. */
const MAX_ANSWER = 4_000;

/** Starts a feedback comment the advisor sends back to the card's agent (also the loop guard). */
export const ADVISOR_FEEDBACK_PREFIX = "**Advisor:** ";

/** Who may answer only the user, and who the advisor is otherwise. Shared by both prompts. */
const USER_ONLY = [
  "Only the user can answer:",
  "- their personal preferences or taste where the card gives no hint (product naming, branding, copywriting tone, a visual style choice between equally good options);",
  "- private facts that cannot be found in the project or the card (credentials, accounts, people, prices, deadlines, which environment or customer something is for);",
  "- business, legal or money decisions (paid services, licensing, pricing, what to promise customers);",
  "- destructive or irreversible actions the card does not already ask for (deleting data, rewriting history, force-pushing, publishing, deploying to production, spending money).",
  "Everything else you decide yourself: technical approach, libraries, architecture, file layout, behavior details, edge cases, error handling, UX details that follow from the goal, how far the scope reaches when the goal implies it, tests and verification. Choose what best serves the user's goal, fits the existing code and conventions, and is simplest to maintain. When the card already answers the question, follow the card.",
];

/** `set_host_tools` definition of the advisor tool. */
export const ADVISOR_TOOL = {
  name: "ask_advisor",
  label: "Ask the advisor",
  description:
    "Get a decision instead of asking the user. Call it whenever you (or one of your subagents) are unsure which way to go: an approach, a library, a design or behavior choice, unclear scope, conflicting requirements. A senior engineer who knows this card and can read the project picks the best option and says why; follow it. Questions only the user can answer (personal preference or taste, private information, business/legal/money decisions, destructive actions the card does not ask for) come back marked for the user: then continue with the most reasonable, easily reversible choice and ask that question at the end of your final summary.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question, self-contained." },
      options: {
        type: "array",
        items: { type: "string" },
        description: "The options you see, if any (one line each).",
      },
      context: {
        type: "string",
        description: "What you found so far, constraints, the trade-offs, and which option you lean towards and why.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
} as const;

/** What the advisor works with: the card, the project and how to run omp. */
export interface AdvisorScope {
  task: Pick<Task, "title" | "description">;
  board: Pick<Board, "name" | "model">;
  /** Folder the card's agent works in, and the other project folders it may read. */
  workdir: string;
  extraFolders: readonly string[];
  settings: AppSettings;
  signal: AbortSignal;
  onActivity?: (text: string) => void;
}

export interface AdvisorQuestion {
  question: string;
  options: string[];
  context: string;
}

/** The advisor's answer to one `ask_advisor` call. */
export interface AdvisorDecision {
  /** The question needs the user's own judgment; `decision` is then only a suggestion. */
  needsUser: boolean;
  decision: string;
  reason: string;
}

/** The advisor's verdict on the questions a run's summary ends with. */
export interface QuestionTriage {
  /** Questions the advisor answered, with its answers. */
  answers: { question: string; answer: string }[];
  /** What is left for the user (questions only they can answer), or null. */
  userQuestion: string | null;
  /** Instructions for the agent when an answer requires more work or a change; null otherwise. */
  followUp: string | null;
}

/** Validated `ask_advisor` arguments. Throws for a missing question. */
export function parseAdvisorArgs(args: Record<string, unknown>): AdvisorQuestion {
  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (!question) throw new Error("question is required");
  const options = Array.isArray(args.options)
    ? args.options
        .filter((o): o is string => typeof o === "string" && o.trim() !== "")
        .slice(0, MAX_OPTIONS)
        .map((o) => clip(o.trim(), 500))
    : [];
  const context = typeof args.context === "string" ? clip(args.context.trim(), MAX_FIELD) : "";
  return { question: clip(question, MAX_FIELD), options, context };
}

/** Ask the advisor one question from a running agent. */
export async function consultAdvisor(scope: AdvisorScope, ask: AdvisorQuestion): Promise<AdvisorDecision> {
  const reply = await runAdvisor(scope, buildConsultPrompt(scope, ask));
  return parseDecision(reply);
}

/** Let the advisor answer the questions a finished run left in its summary. */
export async function triageQuestions(
  scope: AdvisorScope,
  input: { question: string; summary: string },
): Promise<QuestionTriage> {
  const reply = await runAdvisor(scope, buildTriagePrompt(scope, input));
  return parseTriage(reply);
}

/** Tool result the agent gets for its `ask_advisor` call. */
export function formatDecision(decision: AdvisorDecision): string {
  if (decision.needsUser) {
    return [
      "Only the user can answer this, and nobody can answer during this run.",
      decision.reason && `Why: ${decision.reason}`,
      decision.decision && `Advisor's suggestion meanwhile: ${decision.decision}`,
      "Do not stop: continue with the most reasonable, easily reversible choice, and ask the user this question at the end of your final summary (as a line ending with \"?\").",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `Advisor's decision: ${decision.decision}`,
    decision.reason && `Why: ${decision.reason}`,
    "Proceed with it; do not ask the user about this.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildConsultPrompt(scope: Pick<AdvisorScope, "task" | "board" | "workdir">, ask: AdvisorQuestion): string {
  return [
    `You are the advisor for an autonomous coding agent working on a card of the "${scope.board.name}" board, in ${scope.workdir}. Nobody else can answer the agent during its run. It asks you instead of the user: decide like the tech lead of this project.`,
    "",
    ...cardSection(scope.task),
    "",
    "<question>",
    ask.question,
    "</question>",
    ...(ask.options.length > 0 ? ["", "Options the agent sees:", ...ask.options.map((o) => `- ${o}`)] : []),
    ...(ask.context ? ["", "<agent_context>", ask.context, "</agent_context>"] : []),
    "",
    ...USER_ONLY,
    "",
    "How to work: when the answer depends on the code, look it up with a few quick glob/grep/read calls (skim, stop once you know). Do not change files or run commands. Pick one clear answer; you may choose an option not listed.",
    "Decide like a senior engineer following the SDLC: keep the quality gates (design before implementation, testing before release), but don't add process the task doesn't need.",
    "",
    "Reply with only this JSON object — no other text, no code fence:",
    '{"needsUser": false, "decision": "the answer, specific enough to act on", "reason": "why, in one or two sentences"}',
    'Set needsUser to true only for a question only the user can answer; then "decision" is the choice you suggest meanwhile.',
  ].join("\n");
}

export function buildTriagePrompt(
  scope: Pick<AdvisorScope, "task" | "board" | "workdir">,
  input: { question: string; summary: string },
): string {
  return [
    `You are the advisor for an autonomous coding agent that just finished a run on a card of the "${scope.board.name}" board, in ${scope.workdir}. Its final summary ends with questions for the user. The user wants to be asked only what really needs a person: answer the others yourself, like the tech lead of this project.`,
    "",
    ...cardSection(scope.task),
    "",
    "<agent_summary>",
    clip(input.summary.trim(), MAX_BRIEF),
    "</agent_summary>",
    "",
    "<questions>",
    input.question,
    "</questions>",
    "",
    ...USER_ONLY,
    "",
    "How to work: when an answer depends on the code, look it up with a few quick glob/grep/read calls (skim, stop once you know). Do not change files or run commands. A question that is only a rhetorical offer (\"Want me to also…?\") counts as answered: decide whether the work is worth doing for the card's goal.",
    "",
    "Reply with only this JSON object — no other text, no code fence:",
    '{"answers": [{"question": "…", "answer": "…"}], "userQuestion": null, "followUp": null}',
    "- answers: every question you answered yourself, each with your answer and a short why.",
    '- userQuestion: the questions only the user can answer, rewritten clearly in the language of the card, each on its own line ending with "?" (add the options and what the agent assumed meanwhile); null when there are none.',
    "- followUp: when one of your answers means the agent must do more work or change what it did, the instructions for it (concrete, self-contained); null when its result already matches your answers.",
  ].join("\n");
}

/** The decision in the advisor's reply. Throws when it gave none. */
export function parseDecision(reply: string): AdvisorDecision {
  const data = extractJsonObject(reply);
  const decision = clip(stringField(data?.decision), MAX_ANSWER);
  if (!data || !decision) throw new Error("The advisor did not answer with a decision.");
  return { needsUser: data.needsUser === true, decision, reason: clip(stringField(data.reason), MAX_ANSWER) };
}

/** The triage in the advisor's reply. Throws when it gave none. */
export function parseTriage(reply: string): QuestionTriage {
  const data = extractJsonObject(reply);
  if (!data) throw new Error("The advisor did not answer with a triage.");
  const answers = (Array.isArray(data.answers) ? data.answers : [])
    .map((a) => (typeof a === "object" && a !== null ? (a as Record<string, unknown>) : {}))
    .map((a) => ({ question: clip(stringField(a.question), MAX_FIELD), answer: clip(stringField(a.answer), MAX_ANSWER) }))
    .filter((a) => a.answer);
  return {
    answers,
    userQuestion: clip(stringField(data.userQuestion), MAX_FIELD) || null,
    followUp: clip(stringField(data.followUp), MAX_ANSWER) || null,
  };
}

/** Agent-authored comment listing the advisor's answers. */
export function formatAnswers(answers: QuestionTriage["answers"]): string {
  return [
    "**Advisor** answered the agent's questions:",
    "",
    ...answers.map((a) => (a.question ? `- ${a.question.replace(/\s+/g, " ")} → ${a.answer}` : `- ${a.answer}`)),
  ].join("\n");
}

async function runAdvisor(scope: AdvisorScope, prompt: string): Promise<string> {
  const { settings, workdir, board, signal } = scope;
  const env = childEnv(await mcpAgentEnv());
  const [addDirs, roles] = await Promise.all([
    existingFolders(scope.extraFolders, workdir),
    readModelRoles(settings.ompPath, workdir, env),
  ]);
  signal.throwIfAborted();
  // omp's own `advisor` role, else the reasoning `slow` role, else the usual model thinking harder.
  const role = roles?.advisor ? "@advisor" : roles?.slow ? "@slow" : null;
  return runOmpHelper({
    command: settings.ompPath,
    cwd: workdir,
    addDirs,
    model: role ?? (board.model?.trim() || settings.defaultModel.trim() || null),
    thinking: role ? null : "high",
    timeoutSeconds: TIMEOUT_SECONDS,
    env,
    prompt,
    signal,
    label: "advisor",
    onActivity: scope.onActivity,
  });
}

function cardSection(task: AdvisorScope["task"]): string[] {
  const description = task.description.trim();
  return [
    "<card>",
    `Title: ${task.title}`,
    ...(description ? ["", clip(description, MAX_BRIEF)] : []),
    "</card>",
  ];
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
