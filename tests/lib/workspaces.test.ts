// Card worktrees (lib/workspaces.ts): where a card's agent works, and the branch it starts from.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Board, Task } from "@/lib/types";
import { ensureWorkspace, shipTargets } from "@/lib/workspaces";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  ).trim();
}

let root: string;
let repo: string;
let mainSha: string;
let featureSha: string;
let developSha: string;
let previousDataDir: string | undefined;

function board(over: Partial<Board> = {}): Board {
  return {
    id: "b1",
    name: "Shop",
    workdir: repo,
    extraFolders: [],
    model: null,
    autoRun: true,
    worktrees: true,
    pushBranch: "main",
    defaultBranches: {},
    pinned: false,
    lastAccessedAt: null,
    userId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function task(id: string): Pick<Task, "id" | "title"> {
  return { id, title: "Fix the cart" };
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-workspaces-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = path.join(root, "data");
  repo = path.join(root, "backend");
  fs.mkdirSync(repo, { recursive: true });
  // A repo resting on a feature branch: cards must not inherit whatever HEAD happens to be.
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  mainSha = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-q", "-c", "feature");
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "feature work");
  featureSha = git(repo, "rev-parse", "HEAD");
  // Another branch the project can pick as its default branch.
  git(repo, "switch", "-q", "-c", "develop", "main");
  fs.writeFileSync(path.join(repo, "c.txt"), "c\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "develop work");
  developSha = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-q", "feature");
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("card worktrees", () => {
  it("starts each worktree from the repo's own default branch, not the checked-out branch", async () => {
    const card = task("11111111-1111-1111-1111-111111111111");
    const { workspace } = await ensureWorkspace(board(), card);

    const [folder] = workspace.folders;
    expect(folder.isolated).toBe(true);
    expect(folder.source).toBe(repo);
    expect(git(folder.path, "rev-parse", "HEAD")).toBe(mainSha);
    expect(git(folder.path, "rev-parse", "--abbrev-ref", "HEAD")).toMatch(/^omp\/fix-the-cart-/);
    // The commits made on the shared folder's feature branch stay out of the card.
    expect(git(folder.path, "rev-list", "--count", "HEAD")).toBe("1");
    expect(await shipTargets(board(), card)).toEqual([{ source: repo, path: folder.path }]);
  });

  it("starts the worktree from the project's configured default branch", async () => {
    const card = task("22222222-2222-2222-2222-222222222222");
    const { workspace } = await ensureWorkspace(board({ defaultBranches: { [repo]: "develop" } }), card);

    const [folder] = workspace.folders;
    expect(git(folder.path, "rev-parse", "HEAD")).toBe(developSha);
    expect(git(folder.path, "rev-list", "--count", "HEAD")).toBe("2");
  });

  it("falls back to the checked-out branch when the configured branch does not exist", async () => {
    const card = task("33333333-3333-3333-3333-333333333333");
    const { workspace } = await ensureWorkspace(board({ defaultBranches: { [repo]: "release/9" } }), card);

    const [folder] = workspace.folders;
    expect(folder.isolated).toBe(true);
    expect(git(folder.path, "rev-parse", "HEAD")).toBe(featureSha);
  });
});
