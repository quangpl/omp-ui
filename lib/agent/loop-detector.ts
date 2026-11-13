/**
 * Loop detection for agent runs (settings `loopDetection`), modelled on OpenHands' StuckDetector
 * and SWE-agent: a run that keeps making the same tool call with the same outcome, keeps hitting
 * the same error, or ping-pongs between two calls is not making progress and only burns tokens.
 *
 * The detector sees tool calls as omp reports them (`tool_execution_start` → `tool_execution_end`,
 * matched by toolCallId) and keeps a short history of completed calls. It is pure bookkeeping: the
 * manager decides what a detection means (steer first, then fail the run).
 */

type Json = Record<string, unknown>;

export type LoopPattern = "repeat" | "error" | "alternate";

export interface LoopDetection {
  pattern: LoopPattern;
  /** One line for the run log and the failure message, e.g. `read src/a.ts repeated 4 times with the same result`. */
  summary: string;
}

/** Identical call + identical result this many times in a row is a loop. */
export const REPEAT_THRESHOLD = 4;
/** Identical call failing with the identical error this many times in a row is a loop. */
export const ERROR_THRESHOLD = 3;
/** A,B,A,B,A,B: this many completed calls alternating between two different ones is a loop. */
export const ALTERNATE_THRESHOLD = 6;

/**
 * Tools whose repetition is how they work, not a loop: todo list updates, subagent delegation,
 * waiting on other cards, and questions to the advisor or the user.
 */
const IGNORED_TOOLS: Record<string, true> = { todo: true, task: true, board_wait_for_cards: true, ask_advisor: true, ask: true };
/** Arg fields that describe the call rather than change it (omp's intent narration). */
const VOLATILE_ARGS: Record<string, true> = { intent: true, i: true };
/** Outcomes compare this much of the result text (plus its length): enough to tell results apart. */
const OUTCOME_TEXT = 200;
const LABEL_TEXT = 80;
const ERROR_SNIPPET = 120;
/** Calls started but never ended (aborted mid-call) are dropped beyond this many. */
const MAX_PENDING = 64;

interface Call {
  /** Tool name + stable JSON of the args. */
  signature: string;
  /** Short human label: `read src/a.ts`. */
  label: string;
}

interface Completed extends Call {
  isError: boolean;
  /** isError + result length + leading result text: equal outcomes compare equal. */
  outcome: string;
  /** Leading error text, for the summary. */
  errorText: string;
}

export class LoopDetector {
  private readonly pending = new Map<string, Call>();
  private history: Completed[] = [];

  /** Record a `tool_execution_start` frame. */
  start(toolCallId: unknown, toolName: unknown, args: unknown): void {
    if (typeof toolCallId !== "string" || typeof toolName !== "string") return;
    const call = unwrapDeviceCall(toolName, isObject(args) ? args : {});
    if (Object.hasOwn(IGNORED_TOOLS, call.name)) return;
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.pending.set(toolCallId, {
      signature: `${call.name} ${stableJson(stripVolatile(call.args))}`,
      label: describeCall(call.name, call.args),
    });
  }

  /**
   * Record a `tool_execution_end` frame; returns a detection when this call completes a loop.
   * A detection clears the history, so the next one needs a fresh loop.
   */
  end(toolCallId: unknown, isError: unknown, result: unknown): LoopDetection | null {
    if (typeof toolCallId !== "string") return null;
    const call = this.pending.get(toolCallId);
    if (!call) return null;
    this.pending.delete(toolCallId);
    const failed = isError === true;
    const text = resultText(result);
    this.history.push({
      ...call,
      isError: failed,
      outcome: `${failed ? "error" : "ok"}:${text.length}:${text.slice(0, OUTCOME_TEXT)}`,
      errorText: failed ? oneLine(text) : "",
    });
    if (this.history.length > ALTERNATE_THRESHOLD) this.history.shift();
    const detection = this.detect();
    if (detection) this.history = [];
    return detection;
  }

  private detect(): LoopDetection | null {
    const errors = this.tail(ERROR_THRESHOLD);
    if (errors && errors[0]!.isError && errors.every((c) => same(c, errors[0]!))) {
      const error = errors[0]!.errorText;
      return {
        pattern: "error",
        summary: `${errors[0]!.label} failed ${ERROR_THRESHOLD} times in a row with the same error${
          error ? `: ${truncate(error, ERROR_SNIPPET)}` : ""
        }`,
      };
    }
    const repeats = this.tail(REPEAT_THRESHOLD);
    if (repeats && repeats.every((c) => same(c, repeats[0]!))) {
      return {
        pattern: "repeat",
        summary: `${repeats[0]!.label} repeated ${REPEAT_THRESHOLD} times with the same result`,
      };
    }
    const pairs = this.tail(ALTERNATE_THRESHOLD);
    if (pairs && !same(pairs[0]!, pairs[1]!) && pairs.every((c, i) => same(c, pairs[i % 2]!))) {
      return {
        pattern: "alternate",
        summary: `alternating between ${pairs[0]!.label} and ${pairs[1]!.label} ${ALTERNATE_THRESHOLD / 2} times`,
      };
    }
    return null;
  }

  /** The last `n` completed calls, or null if there are fewer. */
  private tail(n: number): Completed[] | null {
    return this.history.length >= n ? this.history.slice(-n) : null;
  }
}

/** The steer message sent on the first detection; the next loop fails the run. */
export function loopSteerMessage(detection: LoopDetection): string {
  return [
    `AgentMan loop detection: you are repeating yourself (${detection.summary}).`,
    "Repeating it will not give a different result. Try a different approach now, or if you are",
    "blocked, stop and explain what is blocking you. If you keep looping, this run will be stopped.",
  ].join(" ");
}

function same(a: Completed, b: Completed): boolean {
  return a.signature === b.signature && a.outcome === b.outcome;
}

/**
 * Some omp builds expose host tools as `xd://<tool>` devices called through `write` with the JSON
 * args as `content`; such a call counts as the device tool itself (so ignored tools stay ignored).
 */
function unwrapDeviceCall(name: string, args: Json): { name: string; args: Json } {
  const target = typeof args.path === "string" ? args.path : "";
  if (name !== "write" || !target.startsWith("xd://") || typeof args.content !== "string") return { name, args };
  const device = target.slice("xd://".length).split("/")[0];
  if (!device) return { name, args };
  try {
    const parsed: unknown = JSON.parse(args.content);
    return isObject(parsed) ? { name: device, args: parsed } : { name, args };
  } catch {
    return { name, args };
  }
}

function stripVolatile(args: Json): Json {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !Object.hasOwn(VOLATILE_ARGS, key)));
}

/** JSON with object keys sorted at every level, so equal args always serialize the same. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v,
  );
}

/** `read src/a.ts`, `bash npm test`, or the tool with its compact args. */
function describeCall(name: string, args: Json): string {
  const rest = stripVolatile(args);
  const detail =
    [args.path, args.command, args.pattern, args.url].find((v): v is string => typeof v === "string") ??
    (Object.keys(rest).length > 0 ? stableJson(rest) : "");
  const line = oneLine(detail);
  return line ? `${name} ${truncate(line, LABEL_TEXT)}` : name;
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  if (isObject(result) && Array.isArray(result.content)) {
    return result.content
      .map((block) => (isObject(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return stableJson(result);
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
