// Token detection and completion shared by the new-card form and the inline composer, mirroring
// the OMP CLI chat editor: "/" opens skills + shortcuts, "@" opens project-file mentions and
// `skill://` completes skill names. Pure string logic so the popup hook stays thin and testable.

export type AutocompleteTrigger = "slash" | "mention" | "skill-url" | "env";

/** The token being typed: `[start, end)` spans it (including its "/", "@" or "skill://" prefix); `query` is the part after the prefix. */
export interface AutocompleteToken {
  trigger: AutocompleteTrigger;
  start: number;
  end: number;
  query: string;
}

const SKILL_URL = /(^|\s)skill:\/\/([A-Za-z0-9_-]*)$/;
// The "/" must start the text or follow whitespace, so URL paths (`https://…`, `a/b`) never trigger.
const SLASH = /(^|\s)\/([A-Za-z0-9_-]*)$/;
// Same rule for "@", so emails (`me@x.com`) never trigger.
const MENTION = /(^|\s)@([^\s@"'`]*)$/;
// `@"…` mentions paths with spaces; the query runs until the closing quote or end of line.
const QUOTED_MENTION = /(^|\s)@"([^"\n]*)$/;
// "$" must start the text or follow whitespace (so `a$b` and `5$` never trigger); `${` is the braced form.
const ENV = /(^|\s)\$([A-Za-z0-9_]*)$/;
const ENV_BRACED = /\$\{([A-Za-z0-9_]*)$/;

/** The autocomplete token ending at `caret`, or null when the caret is not inside one. */
export function autocompleteTokenAt(text: string, caret: number): AutocompleteToken | null {
  const before = text.slice(0, caret);

  const skillUrl = SKILL_URL.exec(before);
  if (skillUrl) {
    const query = skillUrl[2];
    return {
      trigger: "skill-url",
      start: caret - query.length - "skill://".length,
      end: caret,
      query,
    };
  }

  const envBraced = ENV_BRACED.exec(before);
  if (envBraced) {
    const query = envBraced[1];
    return {
      trigger: "env",
      start: caret - query.length - 2,
      end: caret,
      query,
    };
  }

  const env = ENV.exec(before);
  if (env) {
    const query = env[2];
    return {
      trigger: "env",
      start: caret - query.length - 1,
      end: caret,
      query,
    };
  }

  const slash = SLASH.exec(before);
  if (slash) {
    const query = slash[2];
    return {
      trigger: "slash",
      start: caret - query.length - 1,
      end: caret,
      query,
    };
  }

  const mention = MENTION.exec(before);
  if (mention) {
    const query = mention[2];
    return {
      trigger: "mention",
      start: caret - query.length - 1,
      end: caret,
      query,
    };
  }

  const quoted = QUOTED_MENTION.exec(before);
  if (quoted) {
    const query = quoted[2];
    return {
      trigger: "mention",
      start: caret - query.length - 2,
      end: caret,
      query,
    };
  }

  return null;
}

/**
 * `text` with the token replaced by `replacement`, plus a trailing space unless disabled (directory
 * mentions keep completing) or one already follows the token, in which case the caret skips it.
 */
export function applyCompletion(
  text: string,
  token: AutocompleteToken,
  replacement: string,
  options: { trailingSpace?: boolean } = {},
): { text: string; caret: number } {
  const { trailingSpace = true } = options;
  const head = text.slice(0, token.start) + replacement;
  const tail = text.slice(token.end);
  if (!trailingSpace) return { text: head + tail, caret: head.length };
  if (/^\s/.test(tail)) return { text: head + tail, caret: head.length + 1 };
  return { text: `${head} ${tail}`, caret: head.length + 1 };
}

/** "@" + insert, quoting with `@"…"` when `insert` contains whitespace. */
export function mentionText(insert: string): string {
  return /\s/.test(insert) ? `@"${insert}"` : `@${insert}`;
}
