import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, env, freshEnv, setupAdmin, teardown, tempDir, waitFor } from "./helpers";

import * as boardGitRoute from "@/app/api/v1/boards/[id]/git/route";
import * as boardRoute from "@/app/api/v1/boards/[id]/route";
import * as boardPushRoute from "@/app/api/v1/boards/[id]/git/push/route";
import * as boardBranchesRoute from "@/app/api/v1/boards/[id]/git/branches/route";
import * as boardTasksRoute from "@/app/api/v1/boards/[id]/tasks/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import * as browseRoute from "@/app/api/v1/fs/browse/route";
import * as mkdirRoute from "@/app/api/v1/fs/mkdir/route";
import * as cloneRoute from "@/app/api/v1/git/clone/route";
import * as initRoute from "@/app/api/v1/git/init/route";
import * as repoRoute from "@/app/api/v1/git/repo/route";
import * as taskPrRoute from "@/app/api/v1/tasks/[id]/git/pr/route";
import * as taskPushRoute from "@/app/api/v1/tasks/[id]/git/push/route";
import * as taskRoute from "@/app/api/v1/tasks/[id]/route";
import * as taskRunRoute from "@/app/api/v1/tasks/[id]/run/route";
import * as taskStopRoute from "@/app/api/v1/tasks/[id]/stop/route";
import type {
  Board,
  BoardPushResult,
  Comment,
  FsBrowseResult,
  FsEntry,
  GitActionResult,
  GitBranches,
  GitStatus,
  GitSwitchResult,
  Task,
} from "@/lib/types";

interface Repo {
  work: string;
  bare: string;
}

const MISSING_ID = "00000000-0000-0000-0000-000000000000";
const SHA = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT = 60_000;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  ).trim();
}

/** Work tree `projects/<name>` on `main`, with one commit pushed to a bare `remotes/<name>.git` origin. */
function makeRepo(name: string): Repo {
  const bare = path.join(tempDir("remotes"), `${name}.git`);
  git(env().root, "init", "--bare", "-b", "main", bare);
  const work = tempDir(path.join("projects", name));
  git(work, "init", "-b", "main");
  writeFileSync(path.join(work, "README.md"), `# ${name}\n`);
  git(work, "add", "-A");
  git(work, "commit", "-m", "Initial commit");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-u", "origin", "main");
  git(work, "remote", "set-head", "origin", "main");
  return { work, bare };
}

/** `<subject>|<author name> <author email>` of the newest commit on `ref` in a bare repo. */
function remoteHead(bare: string, ref: string): { sha: string; subject: string; author: string } {
  const [sha, subject, author] = git(bare, "--git-dir", bare, "log", "-1", "--format=%H%x09%s%x09%an <%ae>", ref).split("\t");
  return { sha, subject, author };
}

async function createBoard(input: Record<string, unknown>): Promise<Board> {
  const res = await api<Board>(boardsRoute, "POST", "/boards", { body: input });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function createTask(boardId: string, title: string): Promise<Task> {
  const res = await api<Task>(boardTasksRoute, "POST", `/boards/${boardId}/tasks`, {
    body: { title },
    params: { id: boardId },
  });
  expect(res.status).toBe(201);
  return res.body;
}

async function gitAction(action: "push" | "pr", taskId: string, body: Record<string, unknown> = {}) {
  return api<GitActionResult & { error?: string }>(
    action === "push" ? taskPushRoute : taskPrRoute,
    "POST",
    `/tasks/${taskId}/git/${action}`,
    { body, params: { id: taskId } },
  );
}

async function boardGit(boardId: string) {
  return api<GitStatus[] & { error?: string }>(boardGitRoute, "GET", `/boards/${boardId}/git`, {
    params: { id: boardId },
  });
}

async function boardPush(boardId: string) {
  return api<BoardPushResult & { error?: string }>(boardPushRoute, "POST", `/boards/${boardId}/git/push`, {
    body: {},
    params: { id: boardId },
  });
}

async function taskDetail(taskId: string): Promise<{ task: Task; comments: Comment[] }> {
  const res = await api<{ task: Task; comments: Comment[] }>(taskRoute, "GET", `/tasks/${taskId}`, {
    params: { id: taskId },
  });
  return res.body;
}

afterAll(teardown);

// ---------------------------------------------------------------------------------------------

describe("git status and quick actions", () => {
  let app: Repo;
  let lib: Repo;
  let notes: string;
  let board: Board;
  let task: Task;

  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    app = makeRepo("app");
    lib = makeRepo("lib");
    notes = tempDir(path.join("projects", "notes"));
    board = await createBoard({ name: "Repos", workdir: app.work, extraFolders: [lib.work, notes], autoRun: false });
    task = await createTask(board.id, "Add greeting feature");
  });

  it("GET /boards/:id/git reports one status per project folder, workdir first", async () => {
    writeFileSync(path.join(app.work, "greeting.txt"), "hello\n");
    writeFileSync(path.join(app.work, "README.md"), "# app\n\nchanged\n");
    // An unpushed local commit in the extra repo.
    writeFileSync(path.join(lib.work, "lib.txt"), "lib\n");
    git(lib.work, "add", "-A");
    git(lib.work, "commit", "-m", "Local lib change");

    const res = await boardGit(board.id);
    expect(res.status).toBe(200);
    expect(res.body.map((s) => s.folder)).toEqual([app.work, lib.work, notes]);

    expect(res.body[0]).toEqual({
      folder: app.work,
      isRepo: true,
      branch: "main",
      defaultBranch: "main",
      remoteUrl: app.bare,
      webUrl: null,
      provider: "other",
      dirty: true,
      changedFiles: 2,
      ahead: 0,
      behind: 0,
      prCliAvailable: false,
    });
    expect(res.body[1]).toMatchObject({ isRepo: true, branch: "main", dirty: false, changedFiles: 0, ahead: 1, behind: 0 });
    expect(res.body[2]).toMatchObject({
      folder: notes,
      isRepo: false,
      branch: null,
      defaultBranch: null,
      remoteUrl: null,
      dirty: false,
      changedFiles: 0,
    });

    const missing = await boardGit(MISSING_ID);
    expect(missing.status).toBe(404);
  });

  it("validates the folders, message and task of a push", async () => {
    const outside = tempDir("outside");
    const cases: [Record<string, unknown>, string][] = [
      [{ folders: app.work }, "folders must be a list of folder paths."],
      [{ folders: [app.work, 3] }, "folders must be a list of folder paths."],
      [{ folders: [outside] }, `This folder is not part of the project: ${outside}`],
      [{ folders: [] }, "Choose at least one folder."],
      [{ folders: [notes] }, "This project folder is not a git repository, so there is nothing to push."],
      [{ message: "m".repeat(5001) }, "message must be at most 5000 characters."],
      [{ message: 42 }, "message must be text."],
    ];
    for (const [body, error] of cases) {
      const res = await gitAction("push", task.id, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.body.error).toBe(error);
    }
    const prTitle = await gitAction("pr", task.id, { title: "t".repeat(201) });
    expect(prTitle.status).toBe(400);
    expect(prTitle.body.error).toBe("title must be at most 200 characters.");

    expect((await gitAction("push", MISSING_ID)).status).toBe(404);
    expect((await gitAction("pr", MISSING_ID)).status).toBe(404);
    // Nothing was committed by the rejected requests.
    expect((await boardGit(board.id)).body[0].changedFiles).toBe(2);
    expect((await taskDetail(task.id)).task.pushedAt).toBeNull();
  });

  it(
    "Push to main commits and pushes every repo folder, then posts an agent comment",
    async () => {
      const appBefore = remoteHead(app.bare, "main").sha;
      const localLibCommit = git(lib.work, "rev-parse", "HEAD");

      const res = await gitAction("push", task.id, { message: "Add greeting" });
      expect(res.status).toBe(200);
      expect(res.body.action).toBe("push");
      const [appResult, libResult, notesResult] = res.body.results;
      expect(res.body.results.map((r) => r.folder)).toEqual([app.work, lib.work, notes]);

      // A local remote has no web page to link to.
      expect(appResult).toMatchObject({ branch: "main", error: null, skipped: false, url: null });
      expect(appResult.commit).toMatch(SHA);
      expect(typeof appResult.output).toBe("string");
      const pushed = remoteHead(app.bare, "main");
      expect(pushed.sha).toBe(appResult.commit);
      expect(pushed.sha).not.toBe(appBefore);
      expect(pushed.subject).toBe("Add greeting");
      // No git identity configured on the "server": the documented fallback is used.
      expect(pushed.author).toBe("AgentMan <agentman@localhost>");
      expect(git(app.work, "status", "--porcelain")).toBe("");

      // Clean tree but unpushed commit: pushed without a new commit.
      expect(libResult).toMatchObject({ branch: "main", commit: null, error: null, skipped: false });
      expect(remoteHead(lib.bare, "main").sha).toBe(localLibCommit);

      expect(notesResult.skipped).toBe(true);
      expect(notesResult.error).toBeNull();

      const comment = res.body.comment;
      expect(comment).toMatchObject({ taskId: task.id, author: "agent", resolved: true });
      expect(comment.body).toContain("Push to main");
      expect(comment.body).toContain("Pushed to main in app/");
      expect(comment.body).toContain("Pushed to main in lib/");
      const detail = await taskDetail(task.id);
      expect(detail.comments.map((c) => c.id)).toContain(comment.id);
      // A clean push marks the card as pushed (struck-through title).
      expect(detail.task.pushedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const status = await boardGit(board.id);
      expect(status.body[0]).toMatchObject({ dirty: false, ahead: 0 });
      expect(status.body[1]).toMatchObject({ dirty: false, ahead: 0 });
    },
    GIT_TIMEOUT,
  );

  it(
    "Push to main skips folders with nothing to push and uses the task title as the default message",
    async () => {
      const nothing = await gitAction("push", task.id);
      expect(nothing.status).toBe(200);
      expect(nothing.body.results.every((r) => r.skipped)).toBe(true);
      expect(nothing.body.results.every((r) => r.commit === null && r.error === null)).toBe(true);
      expect(nothing.body.comment.body).toContain("Nothing to push");

      writeFileSync(path.join(app.work, "more.txt"), "more\n");
      const only = await gitAction("push", task.id, { folders: [`${app.work}/`] });
      expect(only.status).toBe(200);
      expect(only.body.results).toHaveLength(1);
      expect(only.body.results[0].folder).toBe(app.work);
      expect(remoteHead(app.bare, "main")).toMatchObject({
        sha: only.body.results[0].commit,
        subject: "Add greeting feature",
      });
    },
    GIT_TIMEOUT,
  );

  it(
    "Create PR pushes a new omp/... branch (no PR CLI for this host) and leaves main untouched",
    async () => {
      const mainBefore = remoteHead(app.bare, "main").sha;
      writeFileSync(path.join(app.work, "pr.txt"), "pull request change\n");

      const res = await gitAction("pr", task.id, { title: "Greeting PR" });
      expect(res.status).toBe(200);
      expect(res.body.action).toBe("pr");
      const [appResult, libResult, notesResult] = res.body.results;

      expect(appResult.error).toBeNull();
      expect(appResult.skipped).toBe(false);
      expect(appResult.branch).toMatch(/^omp\/add-greeting-feature-[0-9a-f]{6}$/);
      expect(appResult.commit).toMatch(SHA);
      expect(appResult.url).toBeNull();
      const branch = appResult.branch as string;

      const remoteBranch = remoteHead(app.bare, `refs/heads/${branch}`);
      expect(remoteBranch.sha).toBe(appResult.commit);
      expect(remoteBranch.subject).toBe("Greeting PR");
      expect(remoteHead(app.bare, "main").sha).toBe(mainBefore);
      // The folder stays on the new branch.
      expect(git(app.work, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);

      expect(libResult.skipped).toBe(true);
      expect(notesResult.skipped).toBe(true);
      expect(res.body.comment.author).toBe("agent");
      expect(res.body.comment.body).toContain("Create PR");
      expect(res.body.comment.body).toContain(`Pushed branch ${branch} in app/`);

      const nothing = await gitAction("pr", task.id, { folders: [lib.work] });
      expect(nothing.status).toBe(200);
      expect(nothing.body.results).toEqual([expect.objectContaining({ folder: lib.work, skipped: true })]);
      expect(nothing.body.comment.body).toContain("Nothing to put in a pull request");
    },
    GIT_TIMEOUT,
  );

  it(
    "answers 409 while the task's agent is running",
    async () => {
      const busy = await createTask(board.id, "Busy agent [fake:slow]");
      const started = await api<Task>(taskRunRoute, "POST", `/tasks/${busy.id}/run`, { params: { id: busy.id } });
      expect(started.status).toBe(200);
      await waitFor(async () => {
        const res = await api<{ task: Task }>(taskRoute, "GET", `/tasks/${busy.id}`, { params: { id: busy.id } });
        return res.body.task.agentState === "running";
      }, 20_000);
      writeFileSync(path.join(lib.work, "busy.txt"), "agent at work\n");
      const libBefore = remoteHead(lib.bare, "main").sha;

      for (const action of ["push", "pr"] as const) {
        const res = await gitAction(action, busy.id);
        expect(res.status, action).toBe(409);
        expect(res.body).toEqual({ error: "Wait for the agent to finish first." });
      }
      expect(remoteHead(lib.bare, "main").sha).toBe(libBefore);

      const stopped = await api<Task>(taskStopRoute, "POST", `/tasks/${busy.id}/stop`, { params: { id: busy.id } });
      expect(stopped.body.agentState).toBe("idle");
      const after = await gitAction("push", busy.id, { folders: [lib.work], message: "After the agent" });
      expect(after.status).toBe(200);
      expect(remoteHead(lib.bare, "main").subject).toBe("After the agent");
    },
    GIT_TIMEOUT,
  );

  it("answers 400 when no project folder is a git repository", async () => {
    const plain = await createBoard({ name: "Plain", workdir: tempDir("plain-project"), autoRun: false });
    const plainTask = await createTask(plain.id, "No repo here");
    for (const action of ["push", "pr"] as const) {
      const res = await gitAction(action, plainTask.id);
      expect(res.status, action).toBe(400);
      expect(res.body.error).toBe("This project folder is not a git repository, so there is nothing to push.");
    }
    const status = await boardGit(plain.id);
    expect(status.body).toEqual([expect.objectContaining({ isRepo: false })]);
  });

  it(
    "quick push commits and pushes every project repo, and waits for running agents",
    async () => {
      const web = makeRepo("quick-web");
      const api2 = makeRepo("quick-api");
      const docs = tempDir(path.join("projects", "quick-docs"));
      const quick = await createBoard({ name: "Quick", workdir: web.work, extraFolders: [api2.work, docs], autoRun: false });
      writeFileSync(path.join(web.work, "a.txt"), "a\n");
      writeFileSync(path.join(web.work, "b.txt"), "b\n");
      writeFileSync(path.join(api2.work, "c.txt"), "c\n");

      const busy = await createTask(quick.id, "Busy agent [fake:slow]");
      await api<Task>(taskRunRoute, "POST", `/tasks/${busy.id}/run`, { params: { id: busy.id } });
      await waitFor(async () => (await taskDetail(busy.id)).task.agentState === "running", 20_000);
      const blocked = await boardPush(quick.id);
      expect(blocked.status).toBe(409);
      expect(blocked.body).toEqual({ error: "Wait for the agent to finish first." });
      expect(git(web.work, "status", "--porcelain")).not.toBe("");
      await api<Task>(taskStopRoute, "POST", `/tasks/${busy.id}/stop`, { params: { id: busy.id } });

      const res = await boardPush(quick.id);
      expect(res.status).toBe(200);
      // Only git repos are pushed; the plain folder is left out.
      expect(res.body.results.map((r) => r.folder)).toEqual([web.work, api2.work]);
      for (const [result, repo] of [[res.body.results[0], web], [res.body.results[1], api2]] as const) {
        expect(result).toMatchObject({ branch: "main", error: null, skipped: false });
        expect(remoteHead(repo.bare, "main")).toMatchObject({ sha: result.commit, subject: "Update from AgentMan (3 files)" });
      }
      expect((await boardGit(quick.id)).body.slice(0, 2).every((s) => !s.dirty && s.ahead === 0)).toBe(true);

      const nothing = await boardPush(quick.id);
      expect(nothing.body.results.every((r) => r.skipped && !r.error)).toBe(true);

      const plain = await createBoard({ name: "Quick plain", workdir: tempDir("quick-plain"), autoRun: false });
      const none = await boardPush(plain.id);
      expect(none.status).toBe(400);
      expect(none.body.error).toBe("This project's folders aren't git repositories, so there is nothing to push.");
      expect((await boardPush(MISSING_ID)).status).toBe(404);
    },
    GIT_TIMEOUT,
  );

  it(
    "Push to main and the quick push land on the project's push branch, creating it on the remote",
    async () => {
      const repo = makeRepo("release-train");
      const releaseBoard = await createBoard({ name: "Release train", workdir: repo.work, autoRun: false });
      expect(releaseBoard.pushBranch).toBe("main");
      const patched = await api<Board>(boardRoute, "PATCH", `/boards/${releaseBoard.id}`, {
        body: { pushBranch: "release" },
        params: { id: releaseBoard.id },
      });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expect(patched.body.pushBranch).toBe("release");
      const mainBefore = remoteHead(repo.bare, "main").sha;

      const releaseTask = await createTask(releaseBoard.id, "Cut the release");
      writeFileSync(path.join(repo.work, "release.txt"), "v1\n");
      const res = await gitAction("push", releaseTask.id);
      expect(res.status).toBe(200);
      const [result] = res.body.results;
      expect(result).toMatchObject({ branch: "release", error: null, skipped: false });
      expect(result.commit).toMatch(SHA);
      // The branch didn't exist on the remote: the push created it; main is untouched.
      expect(remoteHead(repo.bare, "refs/heads/release")).toMatchObject({ sha: result.commit, subject: "Cut the release" });
      expect(remoteHead(repo.bare, "main").sha).toBe(mainBefore);
      expect(res.body.comment.body).toContain("**Push to release**");
      expect(res.body.comment.body).toContain("Pushed to release in release-train/");
      expect((await taskDetail(releaseTask.id)).task.pushedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      writeFileSync(path.join(repo.work, "notes.txt"), "notes\n");
      const quick = await boardPush(releaseBoard.id);
      expect(quick.status).toBe(200);
      const [quickResult] = quick.body.results;
      expect(quickResult).toMatchObject({ branch: "release", error: null, skipped: false });
      expect(remoteHead(repo.bare, "refs/heads/release")).toMatchObject({
        sha: quickResult.commit,
        subject: "Update from AgentMan (1 file)",
      });
      expect(remoteHead(repo.bare, "main").sha).toBe(mainBefore);
    },
    GIT_TIMEOUT,
  );

  it(
    "explains a rejected push when the remote has newer commits",
    async () => {
      const repo = makeRepo("diverged");
      const other = path.join(env().root, "other-clone");
      git(env().root, "clone", repo.bare, other);
      writeFileSync(path.join(other, "theirs.txt"), "theirs\n");
      git(other, "add", "-A");
      git(other, "commit", "-m", "Someone else's change");
      git(other, "push", "origin", "main");
      const theirs = remoteHead(repo.bare, "main").sha;

      const divergedBoard = await createBoard({ name: "Diverged", workdir: repo.work, autoRun: false });
      const divergedTask = await createTask(divergedBoard.id, "Conflicting change");
      writeFileSync(path.join(repo.work, "mine.txt"), "mine\n");

      const res = await gitAction("push", divergedTask.id);
      expect(res.status).toBe(200);
      const [result] = res.body.results;
      expect(result.skipped).toBe(false);
      expect(result.error).toBe("The remote branch has newer commits. Pull them first, or use “Create PR” instead.");
      expect(result.commit).toMatch(SHA);
      expect(remoteHead(repo.bare, "main").sha).toBe(theirs);
      expect(res.body.comment.body).toContain("Couldn't push diverged/");
      expect((await taskDetail(divergedTask.id)).task.pushedAt).toBeNull();
    },
    GIT_TIMEOUT,
  );

  it(
    "Create PR without the gh CLI still pushes the branch and links GitHub's compare page",
    async () => {
      const repo = makeRepo("widgets");
      // Looks like GitHub to the server, but pushes go to the local bare repo (no network).
      git(repo.work, "remote", "set-url", "origin", "ssh://git@github.invalid/acme/widgets.git");
      git(repo.work, "remote", "set-url", "--push", "origin", repo.bare);
      // A push branch other than main: Create PR still targets the repo's default branch.
      const ghBoard = await createBoard({ name: "Widgets", workdir: repo.work, autoRun: false, pushBranch: "release" });
      const ghTask = await createTask(ghBoard.id, "Widget polish");
      writeFileSync(path.join(repo.work, "widget.txt"), "shiny\n");

      // PATH without gh/glab; git itself is still reachable.
      const bin = tempDir("bin-without-gh");
      const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      if (!existsSync(path.join(bin, "git"))) symlinkSync(realGit, path.join(bin, "git"));
      const originalPath = process.env.PATH;
      process.env.PATH = bin;
      try {
        const status = await boardGit(ghBoard.id);
        expect(status.body[0]).toMatchObject({
          provider: "github",
          // The ssh login name is not a secret: it stays in the displayed remote.
          remoteUrl: "ssh://git@github.invalid/acme/widgets.git",
          webUrl: "https://github.invalid/acme/widgets",
          prCliAvailable: false,
        });

        const res = await gitAction("pr", ghTask.id);
        expect(res.status).toBe(200);
        const [result] = res.body.results;
        expect(result.error).toBeNull();
        const branch = result.branch as string;
        expect(branch).toMatch(/^omp\/widget-polish-[0-9a-f]{6}$/);
        expect(result.url).toBe(`https://github.invalid/acme/widgets/compare/main...${branch}?expand=1`);
        expect(remoteHead(repo.bare, `refs/heads/${branch}`)).toMatchObject({
          sha: result.commit,
          subject: "Widget polish",
        });
        expect(res.body.comment.body).toContain(result.url);
      } finally {
        process.env.PATH = originalPath;
      }
    },
    GIT_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------------------------

describe("branch switching", () => {
  let shop: Repo;
  let notes: string;
  let board: Board;

  async function branches(folder: string) {
    return api<GitBranches & { error?: string }>(
      boardBranchesRoute,
      "GET",
      `/boards/${board.id}/git/branches?folder=${encodeURIComponent(folder)}`,
      { params: { id: board.id } },
    );
  }

  async function switchTo(body: Record<string, unknown>) {
    return api<GitSwitchResult & { error?: string }>(boardBranchesRoute, "POST", `/boards/${board.id}/git/branches`, {
      body,
      params: { id: board.id },
    });
  }

  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    shop = makeRepo("shop");
    // `release` exists only on origin.
    git(shop.work, "push", "origin", "main:release");
    git(shop.work, "fetch", "origin");
    // `feature/cart` is local-only and changes README.md.
    git(shop.work, "switch", "-c", "feature/cart");
    writeFileSync(path.join(shop.work, "README.md"), "# shop\n\ncart\n");
    git(shop.work, "commit", "-am", "Cart");
    git(shop.work, "switch", "main");
    notes = tempDir(path.join("projects", "branch-notes"));
    board = await createBoard({ name: "Branches", workdir: shop.work, extraFolders: [notes], autoRun: false });
  });

  it("lists local branches newest first, then origin-only ones", async () => {
    const res = await branches(shop.work);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      folder: shop.work,
      current: "main",
      branches: [
        { name: "feature/cart", remoteOnly: false },
        { name: "main", remoteOnly: false },
        { name: "release", remoteOnly: true },
      ],
    });
  });

  it("switches to a local branch and to an origin-only branch", async () => {
    const toFeature = await switchTo({ folder: shop.work, branch: "feature/cart" });
    expect(toFeature.status, JSON.stringify(toFeature.body)).toBe(200);
    expect(toFeature.body).toMatchObject({
      folder: shop.work,
      branch: "feature/cart",
      dirty: false,
      pulled: 0,
      pullError: null,
    });
    expect(git(shop.work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/cart");

    const toRelease = await switchTo({ folder: shop.work, branch: "release" });
    expect(toRelease.status, JSON.stringify(toRelease.body)).toBe(200);
    expect(toRelease.body.branch).toBe("release");
    expect(git(shop.work, "rev-parse", "--abbrev-ref", "release@{upstream}")).toBe("origin/release");
    expect((await branches(shop.work)).body.branches).toContainEqual({ name: "release", remoteOnly: false });
  });

  it("refuses a switch that would overwrite uncommitted changes, leaving the folder as it was", async () => {
    writeFileSync(path.join(shop.work, "README.md"), "# shop\n\nlocal edit\n");
    const res = await switchTo({ folder: shop.work, branch: "feature/cart" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Uncommitted changes would be overwritten by switching. Commit or discard them first.");
    expect(git(shop.work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("release");
    git(shop.work, "checkout", "--", "README.md");
  });

  it(
    "pulls the latest commits after switching, and keeps the switch when the pull can't fast-forward",
    async () => {
      const other = tempDir(path.join("clones", "shop"));
      git(env().root, "clone", shop.bare, other);
      writeFileSync(path.join(other, "NEWS.md"), "one\n");
      git(other, "add", "-A");
      git(other, "commit", "-m", "Remote one");
      git(other, "push", "origin", "main");

      const toMain = await switchTo({ folder: shop.work, branch: "main" });
      expect(toMain.status, JSON.stringify(toMain.body)).toBe(200);
      expect(toMain.body).toMatchObject({ branch: "main", pulled: 1, pullError: null, behind: 0 });
      expect(git(shop.work, "rev-parse", "HEAD")).toBe(remoteHead(shop.bare, "main").sha);

      // Local and remote both gain a commit: no fast-forward, so the branch stays as it was.
      writeFileSync(path.join(shop.work, "LOCAL.md"), "local\n");
      git(shop.work, "add", "-A");
      git(shop.work, "commit", "-m", "Local");
      const local = git(shop.work, "rev-parse", "HEAD");
      writeFileSync(path.join(other, "NEWS.md"), "two\n");
      git(other, "commit", "-am", "Remote two");
      git(other, "push", "origin", "main");
      expect((await switchTo({ folder: shop.work, branch: "release" })).body.pulled).toBe(0);

      const diverged = await switchTo({ folder: shop.work, branch: "main" });
      expect(diverged.status, JSON.stringify(diverged.body)).toBe(200);
      expect(diverged.body).toMatchObject({
        branch: "main",
        pulled: 0,
        pullError:
          "The branch has local commits that aren't on the remote, so it wasn't updated. Merge or rebase it yourself.",
      });
      expect(git(shop.work, "rev-parse", "HEAD")).toBe(local);

      expect((await switchTo({ folder: shop.work, branch: "release" })).status).toBe(200);
    },
    GIT_TIMEOUT,
  );

  it("validates the folder and branch", async () => {
    const outside = tempDir("branch-outside");
    const cases: [Record<string, unknown>, string][] = [
      [{ branch: "main" }, "folder is required."],
      [{ folder: outside, branch: "main" }, `This folder is not part of the project: ${outside}`],
      [{ folder: notes, branch: "main" }, "This project folder is not a git repository."],
      [{ folder: shop.work }, "branch is required."],
      [{ folder: shop.work, branch: "--orphan" }, "There is no branch named “--orphan”."],
      [{ folder: shop.work, branch: "nope" }, "There is no branch named “nope”."],
    ];
    for (const [body, error] of cases) {
      const res = await switchTo(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toEqual({ error });
    }
    expect((await branches(notes)).status).toBe(400);
    expect(git(shop.work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("release");
  });

  it(
    "answers 409 while an agent on the board is running",
    async () => {
      const busy = await createTask(board.id, "Busy agent [fake:slow]");
      await api<Task>(taskRunRoute, "POST", `/tasks/${busy.id}/run`, { params: { id: busy.id } });
      await waitFor(async () => {
        const res = await api<{ task: Task }>(taskRoute, "GET", `/tasks/${busy.id}`, { params: { id: busy.id } });
        return res.body.task.agentState === "running";
      }, 20_000);
      const res = await switchTo({ folder: shop.work, branch: "main" });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "Wait for the agent to finish first." });
      expect(git(shop.work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("release");
      await api<Task>(taskStopRoute, "POST", `/tasks/${busy.id}/stop`, { params: { id: busy.id } });
    },
    GIT_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------------------------

describe("folder browser", () => {
  let base: string;

  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    base = tempDir("browse");
    for (const dir of ["alpha", "Beta", "gamma/.git", ".hidden", "my folder"]) {
      mkdirSync(path.join(base, dir), { recursive: true });
    }
    writeFileSync(path.join(base, "file.txt"), "not a folder\n");
    symlinkSync(path.join(base, "alpha"), path.join(base, "link-to-alpha"));
    symlinkSync(path.join(base, "missing-target"), path.join(base, "broken-link"));
  });

  async function browse(query = "") {
    return api<FsBrowseResult & { error?: string }>(browseRoute, "GET", `/fs/browse${query}`);
  }

  it("defaults to WORKSPACE_DIR and creates it", async () => {
    const { workspaceDir } = env();
    expect(existsSync(workspaceDir)).toBe(false);
    const res = await browse();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      path: workspaceDir,
      parent: path.dirname(workspaceDir),
      workspaceRoot: workspaceDir,
      entries: [],
    });
    expect(existsSync(workspaceDir)).toBe(true);
  });

  it("lists only visible sub-folders, sorted by name, marking git repositories", async () => {
    const res = await browse(`?path=${encodeURIComponent(base)}`);
    expect(res.status).toBe(200);
    expect(res.body.path).toBe(base);
    expect(res.body.parent).toBe(path.dirname(base));
    expect(res.body.workspaceRoot).toBe(env().workspaceDir);
    expect(res.body.entries).toEqual([
      { name: "alpha", path: path.join(base, "alpha"), isGitRepo: false },
      { name: "Beta", path: path.join(base, "Beta"), isGitRepo: false },
      { name: "gamma", path: path.join(base, "gamma"), isGitRepo: true },
      { name: "link-to-alpha", path: path.join(base, "link-to-alpha"), isGitRepo: false },
      { name: "my folder", path: path.join(base, "my folder"), isGitRepo: false },
    ]);
  });

  it("normalizes the path and reports no parent at the filesystem root", async () => {
    const res = await browse(`?path=${encodeURIComponent(`${base}/alpha/../`)}`);
    expect(res.status).toBe(200);
    expect(res.body.path).toBe(base);

    const root = await browse("?path=%2F");
    expect(root.status).toBe(200);
    expect(root.body.path).toBe("/");
    expect(root.body.parent).toBeNull();
  });

  it("rejects relative, nonexistent and non-folder paths with 400", async () => {
    const relative = await browse("?path=projects");
    expect(relative.status).toBe(400);
    expect(relative.body.error).toContain('full folder path starting with "/"');

    const ghost = path.join(base, "ghost");
    const missing = await browse(`?path=${encodeURIComponent(ghost)}`);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain(ghost);

    const file = path.join(base, "file.txt");
    const notDir = await browse(`?path=${encodeURIComponent(file)}`);
    expect(notDir.status).toBe(400);
    expect(notDir.body.error).toContain(file);
  });
});

// ---------------------------------------------------------------------------------------------

describe("create folder", () => {
  let base: string;

  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    base = tempDir("mkdir");
    mkdirSync(path.join(base, "existing"));
    writeFileSync(path.join(base, "file.txt"), "not a folder\n");
  });

  async function mkdir(body: Record<string, unknown>) {
    return api<FsEntry & { error?: string }>(mkdirRoute, "POST", "/fs/mkdir", { body });
  }

  it("creates the folder, returns 201 with its entry, and it shows up in the browser", async () => {
    const res = await mkdir({ parent: base, name: "projects" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ name: "projects", path: path.join(base, "projects"), isGitRepo: false });
    expect(statSync(path.join(base, "projects")).isDirectory()).toBe(true);

    const listed = await api<FsBrowseResult>(browseRoute, "GET", `/fs/browse?path=${encodeURIComponent(base)}`);
    expect(listed.body.entries).toContainEqual({
      name: "projects",
      path: path.join(base, "projects"),
      isGitRepo: false,
    });
  });

  it("trims the name", async () => {
    const res = await mkdir({ parent: base, name: "  my folder  " });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ name: "my folder", path: path.join(base, "my folder"), isGitRepo: false });
    expect(existsSync(path.join(base, "my folder"))).toBe(true);
  });

  it("answers 409 when something with that name already exists", async () => {
    const folder = await mkdir({ parent: base, name: "existing" });
    expect(folder.status).toBe(409);
    expect(folder.body.error).toContain(path.join(base, "existing"));

    const file = await mkdir({ parent: base, name: "file.txt" });
    expect(file.status).toBe(409);
    expect(file.body.error).toContain(path.join(base, "file.txt"));
  });

  it("rejects a relative, missing or nonexistent parent with 400", async () => {
    const relative = await mkdir({ parent: "projects", name: "new" });
    expect(relative.status).toBe(400);
    expect(relative.body.error).toContain('full folder path starting with "/"');

    const absent = await mkdir({ name: "new" });
    expect(absent.status).toBe(400);
    expect(absent.body.error).toContain('full folder path starting with "/"');

    const ghost = path.join(base, "ghost");
    const missing = await mkdir({ parent: ghost, name: "new" });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain(ghost);
    expect(existsSync(ghost)).toBe(false);

    const file = path.join(base, "file.txt");
    const notDir = await mkdir({ parent: file, name: "new" });
    expect(notDir.status).toBe(400);
    expect(notDir.body.error).toContain(file);
  });

  it("rejects empty, nested, dot and hidden names with 400", async () => {
    for (const name of ["", "   ", "a/b", "/abs", ".", "..", ".hidden", "x".repeat(256)]) {
      const res = await mkdir({ parent: base, name });
      expect(res.status, JSON.stringify(name)).toBe(400);
      expect(res.body.error).toBeTruthy();
    }
    expect(existsSync(path.join(base, "a"))).toBe(false);
    expect(existsSync(path.join(base, ".hidden"))).toBe(false);

    const missingName = await mkdir({ parent: base });
    expect(missingName.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------

describe("git clone", () => {
  let source: Repo;

  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    source = makeRepo("library");
    git(source.work, "push", "origin", "main:feature");
  });

  async function clone(body: Record<string, unknown>) {
    return api<{ path: string; output: string; error?: string }>(cloneRoute, "POST", "/git/clone", { body });
  }

  it(
    "clones a local bare repository into WORKSPACE_DIR/<repo name>",
    async () => {
      const res = await clone({ url: source.bare });
      expect(res.status).toBe(201);
      const target = path.join(env().workspaceDir, "library");
      expect(res.body.path).toBe(target);
      expect(typeof res.body.output).toBe("string");
      expect(existsSync(path.join(target, "README.md"))).toBe(true);
      expect(git(target, "remote", "get-url", "origin")).toBe(source.bare);
      expect(git(target, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");

      const listed = await api<FsBrowseResult>(browseRoute, "GET", "/fs/browse");
      expect(listed.body.entries).toEqual([{ name: "library", path: target, isGitRepo: true }]);
    },
    GIT_TIMEOUT,
  );

  it("answers 409 when the target folder already exists", async () => {
    const res = await clone({ url: source.bare });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('"library" already exists');
  });

  it(
    "uses a sanitized custom folder name and an optional branch",
    async () => {
      const named = await clone({ url: source.bare, name: "My Copy!" });
      expect(named.status).toBe(201);
      expect(named.body.path).toBe(path.join(env().workspaceDir, "My-Copy"));

      const branched = await clone({ url: source.bare, name: "feature-copy", branch: "feature" });
      expect(branched.status).toBe(201);
      expect(git(branched.body.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
    },
    GIT_TIMEOUT,
  );

  it("rejects addresses that are not git repository URLs", async () => {
    const missing = await clone({});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("Please enter the repository address to clone.");
    expect((await clone({ url: "   " })).status).toBe(400);
    expect((await clone({ url: 42 })).status).toBe(400);

    for (const url of [
      "not a url",
      "relative/repo.git",
      path.join(env().root, "remotes", "library"),
      "http://example.com/repo.git",
      "-uhttps://example.com/repo.git",
      "file:///tmp/repo.git",
    ]) {
      const res = await clone({ url });
      expect(res.status, url).toBe(400);
      expect(res.body.error, url).toMatch(/^That doesn't look like a git repository address/);
    }
  });

  it("rejects invalid branch and folder names", async () => {
    const branch = await clone({ url: source.bare, name: "x1", branch: "bad branch" });
    expect(branch.status).toBe(400);
    expect(branch.body.error).toBe('"bad branch" is not a valid branch name.');
    expect((await clone({ url: source.bare, name: "x2", branch: "-oops" })).status).toBe(400);

    const name = await clone({ url: source.bare, name: "!!!" });
    expect(name.status).toBe(400);
    expect(name.body.error).toBe("Please choose a folder name for the cloned repository.");

    const nameType = await clone({ url: source.bare, name: 5 });
    expect(nameType.status).toBe(400);
    expect(nameType.body.error).toBe("name must be text.");
    expect(existsSync(path.join(env().workspaceDir, "x1"))).toBe(false);
  });

  it(
    "answers 400 with a plain reason when the clone fails, leaving no folder behind",
    async () => {
      const ghost = path.join(env().root, "remotes", "ghost.git");
      const res = await clone({ url: ghost });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/^Clone failed: /);
      expect(existsSync(path.join(env().workspaceDir, "ghost"))).toBe(false);

      const missingBranch = await clone({ url: source.bare, name: "no-branch", branch: "does-not-exist" });
      expect(missingBranch.status).toBe(400);
      expect(missingBranch.body.error).toMatch(/^Clone failed: /);
      expect(existsSync(path.join(env().workspaceDir, "no-branch"))).toBe(false);
    },
    GIT_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------------------------

describe("git init", () => {
  let base: string;
  let existing: Repo;

  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    base = tempDir("init");
    for (const dir of ["plain", "main", "extra", "locked"]) mkdirSync(path.join(base, dir), { recursive: true });
    writeFileSync(path.join(base, "file.txt"), "not a folder\n");
    existing = makeRepo("existing");
    mkdirSync(path.join(existing.work, "nested"), { recursive: true });
  });

  async function check(folder: string) {
    return api<{ path: string; isGitRepo: boolean; error?: string }>(
      repoRoute,
      "GET",
      `/git/repo?path=${encodeURIComponent(folder)}`,
    );
  }

  async function init(body?: Record<string, unknown>) {
    return api<{ path: string; output: string; error?: string }>(
      initRoute,
      "POST",
      "/git/init",
      body ? { body } : {},
    );
  }

  it("reports whether a folder is inside a git repository", async () => {
    const plain = await check(path.join(base, "plain"));
    expect(plain.status).toBe(200);
    expect(plain.body).toEqual({ path: path.join(base, "plain"), isGitRepo: false });

    expect((await check(existing.work)).body).toEqual({ path: existing.work, isGitRepo: true });
    const nested = path.join(existing.work, "nested");
    expect((await check(nested)).body).toEqual({ path: nested, isGitRepo: true });

    const normalized = await check(`${base}/plain/../plain/`);
    expect(normalized.status).toBe(200);
    expect(normalized.body.path).toBe(path.join(base, "plain"));
  });

  it("rejects a missing, relative, nonexistent or non-folder path when checking", async () => {
    const missing = await api<{ error?: string }>(repoRoute, "GET", "/git/repo");
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("Please choose a folder.");
    expect((await check("  ")).status).toBe(400);

    const relative = await check("projects");
    expect(relative.status).toBe(400);
    expect(relative.body.error).toContain('full folder path starting with "/"');

    const ghost = path.join(base, "ghost");
    const notFound = await check(ghost);
    expect(notFound.status).toBe(400);
    expect(notFound.body.error).toBe(`This folder doesn't exist (or isn't a folder): ${ghost}`);

    const file = path.join(base, "file.txt");
    const notDir = await check(file);
    expect(notDir.status).toBe(400);
    expect(notDir.body.error).toContain(file);
  });

  it("initializes a plain folder as a git repository", async () => {
    const folder = path.join(base, "plain");
    const res = await init({ path: folder });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.path).toBe(folder);
    expect(typeof res.body.output).toBe("string");
    expect(existsSync(path.join(folder, ".git"))).toBe(true);
    expect(git(folder, "rev-parse", "--is-inside-work-tree")).toBe("true");
    expect((await check(folder)).body).toEqual({ path: folder, isGitRepo: true });
  });

  it("answers 409 when the folder is already inside a git repository", async () => {
    const again = await init({ path: path.join(base, "plain") });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe(`This folder is already a git repository: ${path.join(base, "plain")}`);

    const nested = path.join(existing.work, "nested");
    const sub = await init({ path: nested });
    expect(sub.status).toBe(409);
    expect(sub.body.error).toBe(`This folder is already a git repository: ${nested}`);
    expect(existsSync(path.join(nested, ".git"))).toBe(false);
  });

  it("rejects a missing, relative, nonexistent or non-folder path", async () => {
    const noBody = await init();
    expect(noBody.status).toBe(400);
    expect(noBody.body.error).toBe("Please choose the folder to initialize.");
    expect((await init({ path: "   " })).status).toBe(400);
    expect((await init({ path: 42 })).body.error).toBe("Please choose the folder to initialize.");

    const relative = await init({ path: "init/extra" });
    expect(relative.status).toBe(400);
    expect(relative.body.error).toContain('full folder path starting with "/"');

    const ghost = path.join(base, "ghost");
    const notFound = await init({ path: ghost });
    expect(notFound.status).toBe(400);
    expect(notFound.body.error).toBe(`This folder doesn't exist (or isn't a folder): ${ghost}`);
    expect(existsSync(ghost)).toBe(false);

    const file = path.join(base, "file.txt");
    const notDir = await init({ path: file });
    expect(notDir.status).toBe(400);
    expect(notDir.body.error).toContain(file);
  });

  it.skipIf(process.getuid?.() === 0)("answers 400 with a plain reason when git init fails", async () => {
    const locked = path.join(base, "locked");
    chmodSync(locked, 0o555);
    try {
      const res = await init({ path: locked });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Couldn't initialize git: The server isn't allowed to write to this folder.");
      expect(existsSync(path.join(locked, ".git"))).toBe(false);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("initialized workdir and extra folders show up as repositories on the board", async () => {
    const main = path.join(base, "main");
    const extra = path.join(base, "extra");
    expect((await init({ path: main })).status).toBe(201);
    expect((await init({ path: extra })).status).toBe(201);

    const board = await createBoard({ name: "Fresh repos", workdir: main, extraFolders: [extra], autoRun: false });
    const res = await boardGit(board.id);
    expect(res.status).toBe(200);
    expect(res.body.map((s) => s.folder)).toEqual([main, extra]);
    expect(res.body[0]).toMatchObject({ folder: main, isRepo: true, remoteUrl: null, dirty: false });
    expect(res.body[1]).toMatchObject({ folder: extra, isRepo: true, remoteUrl: null, dirty: false });
  });
});
