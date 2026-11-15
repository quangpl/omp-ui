import { describe, expect, it } from "vitest";
import { DEFAULT_PUSH_BRANCH, isValidBranchName, PUSH_BRANCH_MAX } from "@/lib/push-branch";

describe("isValidBranchName", () => {
  it("defaults to a valid branch", () => {
    expect(isValidBranchName(DEFAULT_PUSH_BRANCH)).toBe(true);
  });

  it.each([
    "main",
    "master",
    "develop",
    "release/1.x",
    "feature/foo-bar_baz",
    "v1.2.3",
    "user@work",
    "tính-năng/giỏ-hàng",
    "a".repeat(PUSH_BRANCH_MAX),
  ])("accepts %j", (name) => {
    expect(isValidBranchName(name)).toBe(true);
  });

  it.each([
    "",
    "-main",
    "--upload-pack=evil",
    "has space",
    "tab\tname",
    "a..b",
    "a~1",
    "a^",
    "a:b",
    "a?",
    "a*",
    "a[b",
    "a\\b",
    "feature/",
    "/main",
    "a//b",
    ".hidden",
    "feat/.x",
    "x.lock",
    "x.lock/y",
    "ends.",
    "@",
    "HEAD",
    "a@{1}",
    "a".repeat(PUSH_BRANCH_MAX + 1),
    "main\u200b",
    "a\u00a0b",
    "a\u202eb",
  ])("rejects %j", (name) => {
    expect(isValidBranchName(name)).toBe(false);
  });
});
