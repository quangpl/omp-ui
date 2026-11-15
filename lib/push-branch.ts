// The branch "Push to main" lands on (Board.pushBranch). Client-safe: the board form validates with it too.

/** Board.pushBranch of new projects and of projects created before it was configurable. */
export const DEFAULT_PUSH_BRANCH = "main";

export const PUSH_BRANCH_MAX = 200;

/**
 * True when `name` is a branch name git accepts (`git check-ref-format --branch` rules) and is safe
 * to pass as a command argument: no leading "-", no whitespace, control, invisible format (e.g.
 * zero-width, bidi override) or `~^:?*[\` characters,
 * no "..", "@{", "//", leading/trailing "/", components starting with "." or ending in ".lock",
 * no trailing ".", and not "@" or "HEAD".
 */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > PUSH_BRANCH_MAX) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\\p{Cc}\p{Cf}\p{Z}]/u.test(name)) return false;
  if (name.startsWith("-") || name === "@" || name === "HEAD") return false;
  if (name.includes("..") || name.includes("@{") || name.endsWith(".")) return false;
  return name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}
