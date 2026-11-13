import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Repository } from "@/lib/db/types";
import type { Comment, Run, RunEvent, Task } from "@/lib/types";

/** One task with a comment, a run and a run event, used by the cascade tests. */
interface PopulatedTask {
  task: Task;
  comment: Comment;
  run: Run;
  event: RunEvent;
}

/**
 * Shared behavioural contract for every `Repository` driver.
 *
 * `makeRepo` must return a fresh, initialised repository backed by empty, isolated storage.
 * `cleanup` receives that repository after each test and must close it and discard its storage.
 */
export function runRepositoryContract(
  name: string,
  makeRepo: () => Promise<Repository>,
  cleanup: (repo: Repository) => Promise<void>,
): void {
  describe(`Repository contract: ${name}`, () => {
    let repo: Repository;
    // The repository created for the current test; null when makeRepo failed.
    let created: Repository | null = null;

    beforeEach(async () => {
      created = null;
      repo = await makeRepo();
      created = repo;
    });

    afterEach(async () => {
      if (created) await cleanup(created);
      created = null;
    });

    const newBoard = (suffix = "") =>
      repo.createBoard({ name: `Board${suffix}`, workdir: `/work/project${suffix}` });

    const ids = (items: { id: string }[]) => items.map((i) => i.id);

    // ------------------------------------------------------------------- init

    describe("init", () => {
      it("is idempotent and keeps existing data", async () => {
        const board = await newBoard();
        await repo.setSetting("k", "v");

        await repo.init();
        await repo.init();

        expect(await repo.getBoard(board.id)).toEqual(board);
        expect(await repo.getSetting("k")).toBe("v");
        const task = await repo.createTask({ boardId: board.id, title: "after re-init" });
        expect(await repo.getTask(task.id)).toEqual(task);
      });
    });

    // --------------------------------------------------------------- settings

    describe("settings", () => {
      it("returns null for an unknown key", async () => {
        expect(await repo.getSetting("missing")).toBeNull();
      });

      it("sets, overwrites and deletes a value", async () => {
        await repo.setSetting("ompPath", "/usr/bin/omp");
        expect(await repo.getSetting("ompPath")).toBe("/usr/bin/omp");

        await repo.setSetting("ompPath", "omp");
        expect(await repo.getSetting("ompPath")).toBe("omp");

        await repo.setSetting("other", "x");
        await repo.deleteSetting("ompPath");
        expect(await repo.getSetting("ompPath")).toBeNull();
        expect(await repo.getSetting("other")).toBe("x");
      });

      it("stores an empty string distinctly from a missing key", async () => {
        await repo.setSetting("defaultModel", "");
        expect(await repo.getSetting("defaultModel")).toBe("");
      });

      it("deleting an unknown key is a no-op", async () => {
        await expect(repo.deleteSetting("never-set")).resolves.toBeUndefined();
        expect(await repo.getSetting("never-set")).toBeNull();
      });
    });

    // ----------------------------------------------------------------- boards

    describe("boards", () => {
      it("creates a board with defaults", async () => {
        const board = await repo.createBoard({ name: "Alpha", workdir: "/work/alpha" });

        expect(board).toMatchObject({
          name: "Alpha",
          workdir: "/work/alpha",
          extraFolders: [],
          model: null,
          autoRun: true,
          worktrees: false,
        });
        expect(typeof board.id).toBe("string");
        expect(board.id.length).toBeGreaterThan(0);
        expect(board.createdAt).toBe(board.updatedAt);
        expect(Number.isNaN(Date.parse(board.createdAt))).toBe(false);
        expect(await repo.getBoard(board.id)).toEqual(board);
      });

      it("round-trips explicit fields including extraFolders and worktrees", async () => {
        const board = await repo.createBoard({
          name: "Full",
          workdir: "/work/front",
          extraFolders: ["/work/back", "/work/shared lib"],
          model: "sonnet",
          autoRun: false,
          worktrees: true,
        });

        expect(board).toMatchObject({
          extraFolders: ["/work/back", "/work/shared lib"],
          model: "sonnet",
          autoRun: false,
          worktrees: true,
        });
        expect(await repo.getBoard(board.id)).toEqual(board);

        const off = await repo.updateBoard(board.id, { worktrees: false });
        expect(off).toMatchObject({ worktrees: false, autoRun: false });
        expect(await repo.getBoard(board.id)).toEqual(off);
      });

      it("assigns distinct ids", async () => {
        const a = await newBoard("a");
        const b = await newBoard("b");
        expect(a.id).not.toBe(b.id);
      });

      it("updates only patched fields and refreshes updatedAt", async () => {
        const board = await repo.createBoard({
          name: "Before",
          workdir: "/work/before",
          extraFolders: ["/work/x"],
          model: "sonnet",
        });

        const renamed = await repo.updateBoard(board.id, { name: "After" });
        expect(renamed).toMatchObject({
          id: board.id,
          name: "After",
          workdir: "/work/before",
          extraFolders: ["/work/x"],
          model: "sonnet",
          autoRun: true,
          createdAt: board.createdAt,
        });
        expect(renamed!.updatedAt > board.updatedAt).toBe(true);

        const changed = await repo.updateBoard(board.id, {
          workdir: "/work/after",
          extraFolders: ["/work/y", "/work/z"],
          model: null,
          autoRun: false,
        });
        expect(changed).toMatchObject({
          name: "After",
          workdir: "/work/after",
          extraFolders: ["/work/y", "/work/z"],
          model: null,
          autoRun: false,
        });
        expect(changed!.updatedAt > renamed!.updatedAt).toBe(true);
        expect(await repo.getBoard(board.id)).toEqual(changed);

        const cleared = await repo.updateBoard(board.id, { extraFolders: [], autoRun: true });
        expect(cleared).toMatchObject({ extraFolders: [], autoRun: true });
        expect(await repo.getBoard(board.id)).toEqual(cleared);
      });

      it("returns null / false for unknown ids", async () => {
        expect(await repo.getBoard("no-such-board")).toBeNull();
        expect(await repo.updateBoard("no-such-board", { name: "x" })).toBeNull();
        expect(await repo.deleteBoard("no-such-board")).toBe(false);
      });

      it("lists boards newest first with zero counts when empty", async () => {
        expect(await repo.listBoards()).toEqual([]);

        const first = await newBoard("1");
        const second = await newBoard("2");
        const third = await newBoard("3");
        // Updating an older board must not change the creation-based order.
        await repo.updateBoard(first.id, { name: "touched" });

        const boards = await repo.listBoards();
        expect(ids(boards)).toEqual([third.id, second.id, first.id]);
        for (const b of boards) {
          expect(b.counts).toEqual({ todo: 0, in_progress: 0, done: 0 });
          expect(b.runningCount).toBe(0);
        }
        expect(boards[2]).toMatchObject({ name: "touched", workdir: first.workdir });
      });

      it("lists per-status counts and queued+running agents per board", async () => {
        const a = await newBoard("a");
        const b = await newBoard("b");

        const a1 = await repo.createTask({ boardId: a.id, title: "a1" });
        const a2 = await repo.createTask({ boardId: a.id, title: "a2" });
        await repo.createTask({ boardId: a.id, title: "a3" });
        const a4 = await repo.createTask({ boardId: a.id, title: "a4", status: "in_progress" });
        const a5 = await repo.createTask({ boardId: a.id, title: "a5", status: "done" });
        await repo.updateTask(a1.id, { agentState: "queued" });
        await repo.updateTask(a2.id, { agentState: "error", agentError: "boom" });
        await repo.updateTask(a4.id, { agentState: "running" });
        await repo.updateTask(a5.id, { agentState: "idle" });

        const b1 = await repo.createTask({ boardId: b.id, title: "b1", status: "done" });
        await repo.updateTask(b1.id, { agentState: "running" });

        const boards = await repo.listBoards();
        const byId = new Map(boards.map((x) => [x.id, x]));
        expect(byId.get(a.id)).toMatchObject({
          counts: { todo: 3, in_progress: 1, done: 1 },
          runningCount: 2,
        });
        expect(byId.get(b.id)).toMatchObject({
          counts: { todo: 0, in_progress: 0, done: 1 },
          runningCount: 1,
        });
      });

      it("deletes a board", async () => {
        const keep = await newBoard("keep");
        const drop = await newBoard("drop");

        expect(await repo.deleteBoard(drop.id)).toBe(true);
        expect(await repo.getBoard(drop.id)).toBeNull();
        expect(ids(await repo.listBoards())).toEqual([keep.id]);
        expect(await repo.deleteBoard(drop.id)).toBe(false);
      });
    });

    // ------------------------------------------------------------------ tasks

    describe("tasks", () => {
      it("creates a task with defaults", async () => {
        const board = await newBoard();
        const task = await repo.createTask({ boardId: board.id, title: "Write tests" });

        expect(task).toMatchObject({
          boardId: board.id,
          title: "Write tests",
          description: "",
          status: "todo",
          position: 1024,
          agentState: "idle",
          agentError: null,
          sessionFile: null,
          lastRunId: null,
          blockedBy: [],
          createdByTaskId: null,
          schedulerId: null,
          todos: [],
          commentCount: 0,
          openCommentCount: 0,
        });
        expect(task.createdAt).toBe(task.updatedAt);
        expect(await repo.getTask(task.id)).toEqual(task);
      });

      it("round-trips blockedBy and createdByTaskId, and updates blockedBy", async () => {
        const board = await newBoard();
        const parent = await repo.createTask({ boardId: board.id, title: "parent" });
        const dep = await repo.createTask({ boardId: board.id, title: "dep" });
        const child = await repo.createTask({
          boardId: board.id,
          title: "child",
          blockedBy: [dep.id, parent.id],
          createdByTaskId: parent.id,
        });

        expect(child).toMatchObject({ blockedBy: [dep.id, parent.id], createdByTaskId: parent.id });
        expect(await repo.getTask(child.id)).toEqual(child);
        expect((await repo.listTasks(board.id)).find((t) => t.id === child.id)).toEqual(child);

        const narrowed = await repo.updateTask(child.id, { blockedBy: [dep.id] });
        expect(narrowed).toMatchObject({ blockedBy: [dep.id], createdByTaskId: parent.id });
        expect(await repo.getTask(child.id)).toEqual(narrowed);

        const cleared = await repo.updateTask(child.id, { blockedBy: [] });
        expect(cleared!.blockedBy).toEqual([]);
        expect(await repo.getTask(child.id)).toEqual(cleared);
      });

      it("round-trips the agent's todo list", async () => {
        const board = await newBoard();
        const task = await repo.createTask({ boardId: board.id, title: "Plan" });
        const todos = [
          { name: "Build", tasks: [{ content: "Write code", status: "completed" as const }] },
          { name: "", tasks: [{ content: "Ship", status: "in_progress" as const }] },
        ];

        const updated = await repo.updateTask(task.id, { todos });
        expect(updated!.todos).toEqual(todos);
        expect(await repo.getTask(task.id)).toEqual(updated);
        expect((await repo.listTasks(board.id))[0]).toEqual(updated);
        expect((await repo.updateTask(task.id, { todos: [] }))!.todos).toEqual([]);
      });

      it("appends to the end of each column by default (step 1024, per board and status)", async () => {
        const board = await newBoard();
        const other = await newBoard("other");

        const t1 = await repo.createTask({ boardId: board.id, title: "t1" });
        const t2 = await repo.createTask({ boardId: board.id, title: "t2" });
        const t3 = await repo.createTask({ boardId: board.id, title: "t3" });
        const p1 = await repo.createTask({ boardId: board.id, title: "p1", status: "in_progress" });
        const d1 = await repo.createTask({ boardId: board.id, title: "d1", status: "done" });
        const o1 = await repo.createTask({ boardId: other.id, title: "o1" });

        expect([t1.position, t2.position, t3.position]).toEqual([1024, 2048, 3072]);
        expect(p1.position).toBe(1024);
        expect(d1.position).toBe(1024);
        expect(o1.position).toBe(1024);

        // Appends after the current maximum, including explicit positions.
        await repo.createTask({ boardId: board.id, title: "explicit", position: 10_000 });
        const after = await repo.createTask({ boardId: board.id, title: "after" });
        expect(after.position).toBe(10_000 + 1024);

        // A card moved into a column keeps its position; the next append goes after it.
        await repo.updateTask(t3.id, { status: "in_progress" });
        const p2 = await repo.createTask({ boardId: board.id, title: "p2", status: "in_progress" });
        expect(p2.position).toBe(3072 + 1024);
      });

      it("keeps explicit fractional positions exactly", async () => {
        const board = await newBoard();
        const task = await repo.createTask({ boardId: board.id, title: "mid", position: 1536.5 });
        expect(task.position).toBe(1536.5);
        expect((await repo.getTask(task.id))!.position).toBe(1536.5);
      });

      it("lists tasks ordered by status (todo, in_progress, done) then position", async () => {
        const board = await newBoard();
        const other = await newBoard("other");

        const done1 = await repo.createTask({ boardId: board.id, title: "done1", status: "done", position: 1 });
        const prog2 = await repo.createTask({ boardId: board.id, title: "prog2", status: "in_progress", position: 2000 });
        const todo2 = await repo.createTask({ boardId: board.id, title: "todo2", position: 2048 });
        const todo1 = await repo.createTask({ boardId: board.id, title: "todo1", position: 1024 });
        const prog1 = await repo.createTask({ boardId: board.id, title: "prog1", status: "in_progress", position: 5 });
        const todoMid = await repo.createTask({ boardId: board.id, title: "todoMid", position: 1536.25 });
        const done0 = await repo.createTask({ boardId: board.id, title: "done0", status: "done", position: 0.5 });
        await repo.createTask({ boardId: other.id, title: "elsewhere" });

        const tasks = await repo.listTasks(board.id);
        expect(ids(tasks)).toEqual([
          todo1.id,
          todoMid.id,
          todo2.id,
          prog1.id,
          prog2.id,
          done0.id,
          done1.id,
        ]);
        expect(tasks.every((t) => t.boardId === board.id)).toBe(true);

        // Reordering via a position update is reflected in the listing.
        await repo.updateTask(todo2.id, { position: 1 });
        expect(ids(await repo.listTasks(board.id)).slice(0, 3)).toEqual([todo2.id, todo1.id, todoMid.id]);
      });

      it("returns an empty list for a board without tasks", async () => {
        const board = await newBoard();
        expect(await repo.listTasks(board.id)).toEqual([]);
        expect(await repo.listTasks("no-such-board")).toEqual([]);
      });

      it("updates patched fields, keeps the rest, and refreshes updatedAt", async () => {
        const board = await newBoard();
        const task = await repo.createTask({
          boardId: board.id,
          title: "Original",
          description: "desc",
        });
        expect(task.question).toBeNull();
        expect(task.pushedAt).toBeNull();

        const updated = await repo.updateTask(task.id, {
          title: "Renamed",
          status: "in_progress",
          position: 42.5,
          agentState: "error",
          agentError: "omp crashed",
          question: "Ship it?",
          sessionFile: "/sessions/abc.jsonl",
          lastRunId: "run-1",
          pushedAt: "2026-01-02T03:04:05.000Z",
        });
        expect(updated).toMatchObject({
          id: task.id,
          boardId: board.id,
          title: "Renamed",
          description: "desc",
          status: "in_progress",
          position: 42.5,
          agentState: "error",
          agentError: "omp crashed",
          question: "Ship it?",
          sessionFile: "/sessions/abc.jsonl",
          lastRunId: "run-1",
          pushedAt: "2026-01-02T03:04:05.000Z",
          createdAt: task.createdAt,
        });
        expect(updated!.updatedAt > task.updatedAt).toBe(true);
        expect(await repo.getTask(task.id)).toEqual(updated);

        const cleared = await repo.updateTask(task.id, {
          description: "",
          agentState: "idle",
          agentError: null,
          question: null,
        });
        expect(cleared).toMatchObject({
          title: "Renamed",
          description: "",
          agentState: "idle",
          agentError: null,
          question: null,
          sessionFile: "/sessions/abc.jsonl",
          lastRunId: "run-1",
          pushedAt: "2026-01-02T03:04:05.000Z",
        });
        expect(await repo.getTask(task.id)).toEqual(cleared);
      });

      it("returns null / false for unknown task ids", async () => {
        expect(await repo.getTask("no-such-task")).toBeNull();
        expect(await repo.updateTask("no-such-task", { title: "x" })).toBeNull();
        expect(await repo.deleteTask("no-such-task")).toBe(false);
      });

      it("deletes a task", async () => {
        const board = await newBoard();
        const keep = await repo.createTask({ boardId: board.id, title: "keep" });
        const drop = await repo.createTask({ boardId: board.id, title: "drop" });

        expect(await repo.deleteTask(drop.id)).toBe(true);
        expect(await repo.getTask(drop.id)).toBeNull();
        expect(ids(await repo.listTasks(board.id))).toEqual([keep.id]);
        expect(await repo.deleteTask(drop.id)).toBe(false);
      });

      it("lists tasks by agent state across boards", async () => {
        const a = await newBoard("a");
        const b = await newBoard("b");
        const queued = await repo.createTask({ boardId: a.id, title: "queued" });
        const running = await repo.createTask({ boardId: b.id, title: "running", status: "in_progress" });
        const errored = await repo.createTask({ boardId: a.id, title: "errored" });
        await repo.createTask({ boardId: b.id, title: "idle" });
        await repo.updateTask(queued.id, { agentState: "queued" });
        await repo.updateTask(running.id, { agentState: "running" });
        await repo.updateTask(errored.id, { agentState: "error", agentError: "x" });
        await repo.addComment({ taskId: queued.id, author: "user", body: "feedback" });

        const active = await repo.listTasksByAgentState(["queued", "running"]);
        expect(ids(active).sort()).toEqual([queued.id, running.id].sort());
        const queuedTask = active.find((t) => t.id === queued.id);
        expect(queuedTask).toMatchObject({ agentState: "queued", commentCount: 1, openCommentCount: 1 });
        expect(active.find((t) => t.id === running.id)).toMatchObject({
          agentState: "running",
          status: "in_progress",
          boardId: b.id,
        });

        expect(ids(await repo.listTasksByAgentState(["error"]))).toEqual([errored.id]);
        expect(await repo.listTasksByAgentState([])).toEqual([]);
      });

      it("derives commentCount and openCommentCount (only unresolved user comments are open)", async () => {
        const board = await newBoard();
        const task = await repo.createTask({ boardId: board.id, title: "t" });
        const other = await repo.createTask({ boardId: board.id, title: "other" });

        const open = await repo.addComment({ taskId: task.id, author: "user", body: "please fix" });
        await repo.addComment({ taskId: task.id, author: "user", body: "already done", resolved: true });
        await repo.addComment({ taskId: task.id, author: "agent", body: "summary" });
        await repo.addComment({ taskId: task.id, author: "agent", body: "unresolved agent", resolved: false });
        await repo.addComment({ taskId: other.id, author: "user", body: "elsewhere" });

        const expectCounts = (t: Task | null | undefined, commentCount: number, openCommentCount: number) =>
          expect(t).toMatchObject({ commentCount, openCommentCount });

        expectCounts(await repo.getTask(task.id), 4, 1);
        expectCounts(await repo.getTask(other.id), 1, 1);
        const listed = await repo.listTasks(board.id);
        expectCounts(listed.find((t) => t.id === task.id), 4, 1);
        expectCounts(listed.find((t) => t.id === other.id), 1, 1);
        expectCounts(await repo.updateTask(task.id, { title: "t2" }), 4, 1);

        await repo.setCommentResolved(open.id, true);
        expectCounts(await repo.getTask(task.id), 4, 0);

        await repo.setCommentResolved(open.id, false);
        expectCounts(await repo.getTask(task.id), 4, 1);

        await repo.deleteComment(open.id);
        expectCounts(await repo.getTask(task.id), 3, 0);
      });
    });

    // --------------------------------------------------------------- comments

    describe("comments", () => {
      async function setupTask() {
        const board = await newBoard();
        return repo.createTask({ boardId: board.id, title: "t" });
      }

      it("creates user comments unresolved and agent comments resolved by default", async () => {
        const task = await setupTask();

        const user = await repo.addComment({ taskId: task.id, author: "user", body: "fix the bug" });
        expect(user).toMatchObject({
          taskId: task.id,
          author: "user",
          body: "fix the bug",
          resolved: false,
          resolvedAt: null,
          resolvedByRunId: null,
          fromTaskId: null,
        });
        expect(await repo.getComment(user.id)).toEqual(user);

        const agent = await repo.addComment({ taskId: task.id, author: "agent", body: "done" });
        expect(agent).toMatchObject({ author: "agent", resolved: true, resolvedByRunId: null });
        expect(typeof agent.resolvedAt).toBe("string");
        expect(await repo.getComment(agent.id)).toEqual(agent);

        const explicit = await repo.addComment({ taskId: task.id, author: "user", body: "x", resolved: true });
        expect(explicit.resolved).toBe(true);
        expect(typeof explicit.resolvedAt).toBe("string");
      });

      it("round-trips fromTaskId for agent-to-agent messages", async () => {
        const task = await setupTask();
        const sender = await repo.createTask({ boardId: task.boardId, title: "sender" });

        const message = await repo.addComment({
          taskId: task.id,
          author: "user",
          body: "please review",
          fromTaskId: sender.id,
        });
        expect(message).toMatchObject({ author: "user", resolved: false, fromTaskId: sender.id });
        expect(await repo.getComment(message.id)).toEqual(message);
        expect(await repo.listComments(task.id)).toEqual([message]);
      });

      it("lists comments oldest first, scoped to the task", async () => {
        const task = await setupTask();
        const other = await repo.createTask({ boardId: task.boardId, title: "other" });

        const c1 = await repo.addComment({ taskId: task.id, author: "user", body: "1" });
        const c2 = await repo.addComment({ taskId: task.id, author: "agent", body: "2" });
        await repo.addComment({ taskId: other.id, author: "user", body: "other" });
        const c3 = await repo.addComment({ taskId: task.id, author: "user", body: "3" });

        const listed = await repo.listComments(task.id);
        expect(listed).toEqual([c1, c2, c3]);
        expect(await repo.listComments("no-such-task")).toEqual([]);
      });

      it("sets and clears the resolved flag", async () => {
        const task = await setupTask();
        const run = await repo.createRun({ taskId: task.id, prompt: "p" });
        const comment = await repo.addComment({ taskId: task.id, author: "user", body: "b" });

        const resolvedManually = await repo.setCommentResolved(comment.id, true);
        expect(resolvedManually).toMatchObject({ id: comment.id, resolved: true, resolvedByRunId: null });
        expect(typeof resolvedManually!.resolvedAt).toBe("string");

        const resolvedByRun = await repo.setCommentResolved(comment.id, true, run.id);
        expect(resolvedByRun).toMatchObject({ resolved: true, resolvedByRunId: run.id });
        expect(typeof resolvedByRun!.resolvedAt).toBe("string");
        expect(await repo.getComment(comment.id)).toEqual(resolvedByRun);

        const reopened = await repo.setCommentResolved(comment.id, false);
        expect(reopened).toEqual({
          ...comment,
          resolved: false,
          resolvedAt: null,
          resolvedByRunId: null,
        });
        expect(await repo.getComment(comment.id)).toEqual(reopened);

        expect(await repo.setCommentResolved("no-such-comment", true)).toBeNull();
        expect(await repo.setCommentResolved("no-such-comment", false)).toBeNull();
      });

      it("resolveComments only touches unresolved comments and returns them", async () => {
        const task = await setupTask();
        const earlierRun = await repo.createRun({ taskId: task.id, prompt: "first" });
        const run = await repo.createRun({ taskId: task.id, prompt: "second" });

        const a = await repo.addComment({ taskId: task.id, author: "user", body: "a" });
        const b = await repo.addComment({ taskId: task.id, author: "user", body: "b" });
        const already = await repo.addComment({ taskId: task.id, author: "user", body: "c" });
        const alreadyResolved = await repo.setCommentResolved(already.id, true, earlierRun.id);
        const agent = await repo.addComment({ taskId: task.id, author: "agent", body: "d" });
        const untouched = await repo.addComment({ taskId: task.id, author: "user", body: "e" });

        const result = await repo.resolveComments(
          [a.id, b.id, already.id, agent.id, a.id, "no-such-comment"],
          run.id,
        );

        expect(ids(result).sort()).toEqual([a.id, b.id].sort());
        for (const c of result) {
          expect(c).toMatchObject({ resolved: true, resolvedByRunId: run.id, taskId: task.id });
          expect(typeof c.resolvedAt).toBe("string");
          expect(await repo.getComment(c.id)).toEqual(c);
        }
        expect(result.find((c) => c.id === a.id)).toMatchObject({ body: "a", author: "user", createdAt: a.createdAt });

        expect(await repo.getComment(already.id)).toEqual(alreadyResolved);
        expect(await repo.getComment(agent.id)).toEqual(agent);
        expect(await repo.getComment(untouched.id)).toEqual(untouched);
        expect((await repo.getTask(task.id))!.openCommentCount).toBe(1);

        // Second call is a no-op: everything requested is already resolved.
        expect(await repo.resolveComments([a.id, b.id], run.id)).toEqual([]);
        expect(await repo.resolveComments([], run.id)).toEqual([]);
      });

      it("deletes a comment", async () => {
        const task = await setupTask();
        const keep = await repo.addComment({ taskId: task.id, author: "user", body: "keep" });
        const drop = await repo.addComment({ taskId: task.id, author: "user", body: "drop" });

        expect(await repo.deleteComment(drop.id)).toBe(true);
        expect(await repo.getComment(drop.id)).toBeNull();
        expect(await repo.listComments(task.id)).toEqual([keep]);
        expect(await repo.deleteComment(drop.id)).toBe(false);
        expect(await repo.getComment("no-such-comment")).toBeNull();
      });
    });

    // ------------------------------------------------------------------- runs

    describe("runs", () => {
      async function setupTask(title = "t") {
        const board = await newBoard(title);
        return repo.createTask({ boardId: board.id, title });
      }

      it("creates a running run", async () => {
        const task = await setupTask();
        const run = await repo.createRun({ taskId: task.id, prompt: "do the thing" });

        expect(run).toMatchObject({
          taskId: task.id,
          status: "running",
          prompt: "do the thing",
          summary: null,
          error: null,
          endedAt: null,
        });
        expect(Number.isNaN(Date.parse(run.startedAt))).toBe(false);
        expect(await repo.getRun(run.id)).toEqual(run);
      });

      it("updates patched fields only", async () => {
        const task = await setupTask();
        const run = await repo.createRun({ taskId: task.id, prompt: "p" });
        const endedAt = new Date(Date.parse(run.startedAt) + 5_000).toISOString();

        const done = await repo.updateRun(run.id, { status: "succeeded", summary: "All good", endedAt });
        expect(done).toEqual({ ...run, status: "succeeded", summary: "All good", endedAt });
        expect(await repo.getRun(run.id)).toEqual(done);

        const failed = await repo.updateRun(run.id, { status: "failed", error: "exit 1", summary: null });
        expect(failed).toEqual({ ...run, status: "failed", error: "exit 1", summary: null, endedAt });

        expect(await repo.updateRun(run.id, {})).toEqual(failed);
      });

      it("returns null for unknown run ids", async () => {
        expect(await repo.getRun("no-such-run")).toBeNull();
        expect(await repo.updateRun("no-such-run", { status: "failed" })).toBeNull();
        expect(await repo.updateRun("no-such-run", {})).toBeNull();
      });

      it("lists runs newest first, scoped to the task", async () => {
        const task = await setupTask("a");
        const other = await setupTask("b");

        const r1 = await repo.createRun({ taskId: task.id, prompt: "1" });
        const r2 = await repo.createRun({ taskId: task.id, prompt: "2" });
        await repo.createRun({ taskId: other.id, prompt: "other" });
        const r3 = await repo.createRun({ taskId: task.id, prompt: "3" });
        await repo.updateRun(r1.id, { status: "succeeded" });

        const runs = await repo.listRuns(task.id);
        expect(ids(runs)).toEqual([r3.id, r2.id, r1.id]);
        expect(runs[2].status).toBe("succeeded");
        expect(await repo.listRuns("no-such-task")).toEqual([]);
      });

      it("abortRunningRuns aborts only running runs and returns the count", async () => {
        const task = await setupTask("a");
        const other = await setupTask("b");

        const running1 = await repo.createRun({ taskId: task.id, prompt: "1" });
        const succeeded = await repo.updateRun((await repo.createRun({ taskId: task.id, prompt: "2" })).id, {
          status: "succeeded",
          summary: "ok",
          endedAt: new Date().toISOString(),
        });
        const failed = await repo.updateRun((await repo.createRun({ taskId: other.id, prompt: "3" })).id, {
          status: "failed",
          error: "nope",
        });
        const running2 = await repo.createRun({ taskId: other.id, prompt: "4" });

        expect(await repo.abortRunningRuns("server restarted")).toBe(2);

        for (const original of [running1, running2]) {
          const aborted = await repo.getRun(original.id);
          expect(aborted).toMatchObject({
            id: original.id,
            taskId: original.taskId,
            prompt: original.prompt,
            startedAt: original.startedAt,
            status: "aborted",
            error: "server restarted",
            summary: null,
          });
          expect(typeof aborted!.endedAt).toBe("string");
        }
        expect(await repo.getRun(succeeded!.id)).toEqual(succeeded);
        expect(await repo.getRun(failed!.id)).toEqual(failed);

        expect(await repo.abortRunningRuns("again")).toBe(0);
        expect((await repo.getRun(running1.id))!.error).toBe("server restarted");
      });
    });

    // ------------------------------------------------------------- run events

    describe("run events", () => {
      async function setupRun() {
        const board = await newBoard();
        const task = await repo.createTask({ boardId: board.id, title: "t" });
        const run = await repo.createRun({ taskId: task.id, prompt: "p" });
        return { task, run };
      }

      it("appends events with strictly increasing integer seq", async () => {
        const { task, run } = await setupRun();
        const other = await repo.createRun({ taskId: task.id, prompt: "other" });

        const e1 = await repo.appendRunEvent({ runId: run.id, taskId: task.id, kind: "status", text: "started" });
        const e2 = await repo.appendRunEvent({ runId: other.id, taskId: task.id, kind: "text", text: "x" });
        const e3 = await repo.appendRunEvent({ runId: run.id, taskId: task.id, kind: "thinking", text: "hmm" });
        const e4 = await repo.appendRunEvent({ runId: run.id, taskId: task.id, kind: "tool", text: "bash ls" });

        expect(e1).toMatchObject({ runId: run.id, taskId: task.id, kind: "status", text: "started" });
        for (const e of [e1, e2, e3, e4]) {
          expect(typeof e.seq).toBe("number");
          expect(Number.isInteger(e.seq)).toBe(true);
          expect(e.seq).toBeGreaterThan(0);
          expect(Number.isNaN(Date.parse(e.createdAt))).toBe(false);
        }
        expect(e2.seq).toBeGreaterThan(e1.seq);
        expect(e3.seq).toBeGreaterThan(e2.seq);
        expect(e4.seq).toBeGreaterThan(e3.seq);

        expect(await repo.listRunEvents(run.id)).toEqual([e1, e3, e4]);
        expect(await repo.listRunEvents(other.id)).toEqual([e2]);
        expect(await repo.listRunEvents("no-such-run")).toEqual([]);
      });

      it("paginates with the after cursor and limit", async () => {
        const { task, run } = await setupRun();
        const events = [];
        for (let i = 0; i < 5; i++) {
          events.push(await repo.appendRunEvent({ runId: run.id, taskId: task.id, kind: "text", text: `e${i}` }));
        }

        const page1 = await repo.listRunEvents(run.id, 0, 2);
        expect(page1).toEqual(events.slice(0, 2));
        const page2 = await repo.listRunEvents(run.id, page1[1].seq, 2);
        expect(page2).toEqual(events.slice(2, 4));
        const page3 = await repo.listRunEvents(run.id, page2[1].seq, 2);
        expect(page3).toEqual(events.slice(4));
        expect(await repo.listRunEvents(run.id, page3[0].seq, 2)).toEqual([]);

        expect(await repo.listRunEvents(run.id, events[2].seq)).toEqual(events.slice(3));
        // Negative / non-finite cursors mean "from the start".
        expect(await repo.listRunEvents(run.id, -10)).toEqual(events);
        expect(await repo.listRunEvents(run.id, Number.NaN)).toEqual(events);
      });

      it("clamps the limit to at least 1 and floors fractional limits", async () => {
        const { task, run } = await setupRun();
        const events = [];
        for (let i = 0; i < 4; i++) {
          events.push(await repo.appendRunEvent({ runId: run.id, taskId: task.id, kind: "text", text: `e${i}` }));
        }

        expect(await repo.listRunEvents(run.id, 0, 0)).toEqual(events.slice(0, 1));
        expect(await repo.listRunEvents(run.id, 0, -5)).toEqual(events.slice(0, 1));
        expect(await repo.listRunEvents(run.id, 0, 2.9)).toEqual(events.slice(0, 2));
        expect(await repo.listRunEvents(run.id, 0, Number.NaN)).toEqual(events);
        expect(await repo.listRunEvents(run.id, 0, 1_000_000)).toEqual(events);
      });

      it("defaults the limit to 500 and caps it at 2000", async () => {
        const { task, run } = await setupRun();
        const total = 2_050;
        // First append sequentially (initialises any sequence counter), the rest in parallel batches.
        await repo.appendRunEvent({ runId: run.id, taskId: task.id, kind: "text", text: "0" });
        for (let start = 1; start < total; start += 100) {
          const batch = [];
          for (let i = start; i < Math.min(start + 100, total); i++) {
            batch.push(repo.appendRunEvent({ runId: run.id, taskId: task.id, kind: "text", text: String(i) }));
          }
          await Promise.all(batch);
        }

        const byDefault = await repo.listRunEvents(run.id);
        expect(byDefault).toHaveLength(500);
        const capped = await repo.listRunEvents(run.id, 0, 100_000);
        expect(capped).toHaveLength(2_000);
        const seqs = capped.map((e) => e.seq);
        expect(seqs.every((s, i) => i === 0 || s > seqs[i - 1])).toBe(true);
        expect(byDefault).toEqual(capped.slice(0, 500));
        expect(await repo.listRunEvents(run.id, capped[1_999].seq, 100_000)).toHaveLength(total - 2_000);
      });
    });

    // ------------------------------------------------------------- schedulers

    describe("schedulers", () => {
      const newScheduler = (boardId: string, name = "Daily report") =>
        repo.createScheduler({
          boardId,
          name,
          prompt: `${name}: summarise yesterday's commits`,
          cron: "0 9 * * 1-5",
          timezone: "Europe/Berlin",
        });

      it("creates a scheduler with defaults", async () => {
        const board = await newBoard();
        const scheduler = await newScheduler(board.id);

        expect(scheduler).toMatchObject({
          boardId: board.id,
          name: "Daily report",
          prompt: "Daily report: summarise yesterday's commits",
          cron: "0 9 * * 1-5",
          timezone: "Europe/Berlin",
          enabled: true,
          maxRuns: null,
          runCount: 0,
          lastRunAt: null,
          nextRunAt: null,
          lastStatus: null,
          lastTaskId: null,
          lastError: null,
        });
        expect(typeof scheduler.id).toBe("string");
        expect(scheduler.id.length).toBeGreaterThan(0);
        expect(scheduler.createdAt).toBe(scheduler.updatedAt);
        expect(Number.isNaN(Date.parse(scheduler.createdAt))).toBe(false);
        expect(await repo.getScheduler(scheduler.id)).toEqual(scheduler);
      });

      it("round-trips explicit enabled, maxRuns and nextRunAt", async () => {
        const board = await newBoard();
        const nextRunAt = "2026-11-16T08:00:00.000Z";
        const scheduler = await repo.createScheduler({
          boardId: board.id,
          name: "Once",
          prompt: "p",
          cron: "@daily",
          timezone: "UTC",
          enabled: false,
          maxRuns: 3,
          nextRunAt,
        });

        expect(scheduler).toMatchObject({ enabled: false, maxRuns: 3, nextRunAt, runCount: 0 });
        expect(await repo.getScheduler(scheduler.id)).toEqual(scheduler);
      });

      it("lists schedulers newest first, optionally per board", async () => {
        const a = await newBoard("a");
        const b = await newBoard("b");
        expect(await repo.listSchedulers()).toEqual([]);

        const s1 = await newScheduler(a.id, "s1");
        const s2 = await newScheduler(b.id, "s2");
        const s3 = await newScheduler(a.id, "s3");
        // Updating an older scheduler must not change the creation-based order.
        const touched = await repo.updateScheduler(s1.id, { name: "touched" });

        expect(ids(await repo.listSchedulers())).toEqual([s3.id, s2.id, s1.id]);
        expect(await repo.listSchedulers(a.id)).toEqual([s3, touched]);
        expect(ids(await repo.listSchedulers(b.id))).toEqual([s2.id]);
        expect(await repo.listSchedulers("no-such-board")).toEqual([]);
      });

      it("updates patched fields only and refreshes updatedAt", async () => {
        const a = await newBoard("a");
        const b = await newBoard("b");
        const scheduler = await newScheduler(a.id);

        const edited = await repo.updateScheduler(scheduler.id, {
          boardId: b.id,
          name: "Weekly",
          prompt: "new prompt",
          cron: "0 9 * * 1",
          timezone: "UTC",
          enabled: false,
          maxRuns: 5,
        });
        expect(edited).toEqual({
          ...scheduler,
          boardId: b.id,
          name: "Weekly",
          prompt: "new prompt",
          cron: "0 9 * * 1",
          timezone: "UTC",
          enabled: false,
          maxRuns: 5,
          updatedAt: edited!.updatedAt,
        });
        expect(edited!.updatedAt > scheduler.updatedAt).toBe(true);
        expect(await repo.getScheduler(scheduler.id)).toEqual(edited);

        const task = await repo.createTask({ boardId: b.id, title: "made", schedulerId: scheduler.id });
        const ran = await repo.updateScheduler(scheduler.id, {
          runCount: 1,
          lastRunAt: "2026-11-16T08:00:00.000Z",
          nextRunAt: "2026-11-23T08:00:00.000Z",
          lastStatus: "created",
          lastTaskId: task.id,
          lastError: null,
        });
        expect(ran).toMatchObject({
          name: "Weekly",
          enabled: false,
          maxRuns: 5,
          runCount: 1,
          lastRunAt: "2026-11-16T08:00:00.000Z",
          nextRunAt: "2026-11-23T08:00:00.000Z",
          lastStatus: "created",
          lastTaskId: task.id,
          lastError: null,
          createdAt: scheduler.createdAt,
        });
        expect(ran!.updatedAt > edited!.updatedAt).toBe(true);
        expect(await repo.getScheduler(scheduler.id)).toEqual(ran);

        const failed = await repo.updateScheduler(scheduler.id, {
          enabled: true,
          maxRuns: null,
          nextRunAt: null,
          lastStatus: "failed",
          lastTaskId: null,
          lastError: "card writer failed",
        });
        expect(failed).toMatchObject({
          enabled: true,
          maxRuns: null,
          runCount: 1,
          nextRunAt: null,
          lastStatus: "failed",
          lastTaskId: null,
          lastError: "card writer failed",
        });
        expect(await repo.getScheduler(scheduler.id)).toEqual(failed);
      });

      it("returns null / false for unknown ids", async () => {
        expect(await repo.getScheduler("no-such-scheduler")).toBeNull();
        expect(await repo.updateScheduler("no-such-scheduler", { name: "x" })).toBeNull();
        expect(await repo.deleteScheduler("no-such-scheduler")).toBe(false);
        expect(await repo.listSchedulerRuns("no-such-scheduler")).toEqual([]);
      });

      it("round-trips Task.schedulerId (default null)", async () => {
        const board = await newBoard();
        const scheduler = await newScheduler(board.id);
        const manual = await repo.createTask({ boardId: board.id, title: "manual" });
        const scheduled = await repo.createTask({
          boardId: board.id,
          title: "scheduled",
          status: "in_progress",
          schedulerId: scheduler.id,
        });

        expect(manual.schedulerId).toBeNull();
        expect(scheduled.schedulerId).toBe(scheduler.id);
        expect(await repo.getTask(scheduled.id)).toEqual(scheduled);
        expect(await repo.listTasks(board.id)).toEqual([manual, scheduled]);
        // Patching other fields keeps the link.
        expect((await repo.updateTask(scheduled.id, { title: "renamed" }))!.schedulerId).toBe(scheduler.id);
      });

      it("creates scheduler runs and lists them newest first, scoped and limited", async () => {
        const board = await newBoard();
        const scheduler = await newScheduler(board.id, "a");
        const other = await newScheduler(board.id, "b");
        const task = await repo.createTask({ boardId: board.id, title: "t", schedulerId: scheduler.id });

        const r1 = await repo.createSchedulerRun({
          schedulerId: scheduler.id,
          taskId: task.id,
          trigger: "scheduled",
          scheduledFor: "2026-11-16T08:00:00.000Z",
          status: "created",
        });
        expect(r1).toMatchObject({
          schedulerId: scheduler.id,
          taskId: task.id,
          trigger: "scheduled",
          scheduledFor: "2026-11-16T08:00:00.000Z",
          status: "created",
          error: null,
        });
        expect(typeof r1.id).toBe("string");
        expect(Number.isNaN(Date.parse(r1.createdAt))).toBe(false);

        const r2 = await repo.createSchedulerRun({
          schedulerId: scheduler.id,
          taskId: null,
          trigger: "manual",
          scheduledFor: "2026-11-16T10:30:00.000Z",
          status: "failed",
          error: "board is gone",
        });
        expect(r2).toMatchObject({ taskId: null, trigger: "manual", status: "failed", error: "board is gone" });
        await repo.createSchedulerRun({
          schedulerId: other.id,
          taskId: null,
          trigger: "manual",
          scheduledFor: "2026-11-16T10:31:00.000Z",
          status: "failed",
          error: "x",
        });
        const r3 = await repo.createSchedulerRun({
          schedulerId: scheduler.id,
          taskId: null,
          trigger: "scheduled",
          scheduledFor: "2026-11-17T08:00:00.000Z",
          status: "failed",
          error: "y",
        });

        expect(await repo.listSchedulerRuns(scheduler.id)).toEqual([r3, r2, r1]);
        expect(ids(await repo.listSchedulerRuns(scheduler.id, 2))).toEqual([r3.id, r2.id]);
        expect(ids(await repo.listSchedulerRuns(scheduler.id, 0))).toEqual([r3.id]);
        expect(ids(await repo.listSchedulerRuns(other.id))).toHaveLength(1);

        // History outlives the card it created.
        await repo.deleteTask(task.id);
        expect(await repo.listSchedulerRuns(scheduler.id)).toEqual([r3, r2, r1]);
      });

      it("deleteScheduler removes its runs and unlinks (but keeps) its cards", async () => {
        const board = await newBoard();
        const doomed = await newScheduler(board.id, "doomed");
        const survivor = await newScheduler(board.id, "survivor");
        const doomedTask = await repo.createTask({ boardId: board.id, title: "d", schedulerId: doomed.id });
        const survivorTask = await repo.createTask({ boardId: board.id, title: "s", schedulerId: survivor.id });
        const run = {
          trigger: "scheduled" as const,
          scheduledFor: "2026-11-16T08:00:00.000Z",
          status: "created" as const,
        };
        await repo.createSchedulerRun({ ...run, schedulerId: doomed.id, taskId: doomedTask.id });
        const survivorRun = await repo.createSchedulerRun({
          ...run,
          schedulerId: survivor.id,
          taskId: survivorTask.id,
        });

        expect(await repo.deleteScheduler(doomed.id)).toBe(true);

        expect(await repo.getScheduler(doomed.id)).toBeNull();
        expect(await repo.listSchedulerRuns(doomed.id)).toEqual([]);
        expect(await repo.getTask(doomedTask.id)).toMatchObject({ id: doomedTask.id, schedulerId: null });
        expect(await repo.getTask(survivorTask.id)).toEqual(survivorTask);
        expect(await repo.listSchedulerRuns(survivor.id)).toEqual([survivorRun]);
        expect(ids(await repo.listSchedulers())).toEqual([survivor.id]);
        expect(await repo.deleteScheduler(doomed.id)).toBe(false);
      });

      it("deleteBoard removes its schedulers and their runs", async () => {
        const board = await newBoard("doomed");
        const keepBoard = await newBoard("keep");
        const doomed = await newScheduler(board.id, "doomed");
        const survivor = await newScheduler(keepBoard.id, "survivor");
        const run = {
          taskId: null,
          trigger: "manual" as const,
          scheduledFor: "2026-11-16T08:00:00.000Z",
          status: "failed" as const,
        };
        await repo.createSchedulerRun({ ...run, schedulerId: doomed.id });
        const survivorRun = await repo.createSchedulerRun({ ...run, schedulerId: survivor.id });

        expect(await repo.deleteBoard(board.id)).toBe(true);

        expect(await repo.getScheduler(doomed.id)).toBeNull();
        expect(await repo.listSchedulers(board.id)).toEqual([]);
        expect(await repo.listSchedulerRuns(doomed.id)).toEqual([]);
        expect(await repo.listSchedulers()).toEqual([survivor]);
        expect(await repo.listSchedulerRuns(survivor.id)).toEqual([survivorRun]);
      });
    });

    // --------------------------------------------------------------- cascades

    describe("cascading deletes", () => {
      async function populate(boardId: string, title: string): Promise<PopulatedTask> {
        const task = await repo.createTask({ boardId, title });
        const comment = await repo.addComment({ taskId: task.id, author: "user", body: `${title} comment` });
        const run = await repo.createRun({ taskId: task.id, prompt: `${title} prompt` });
        const event = await repo.appendRunEvent({ runId: run.id, taskId: task.id, kind: "text", text: title });
        return { task, comment, run, event };
      }

      async function expectGone(p: PopulatedTask) {
        expect(await repo.getTask(p.task.id)).toBeNull();
        expect(await repo.getComment(p.comment.id)).toBeNull();
        expect(await repo.listComments(p.task.id)).toEqual([]);
        expect(await repo.getRun(p.run.id)).toBeNull();
        expect(await repo.listRuns(p.task.id)).toEqual([]);
        expect(await repo.listRunEvents(p.run.id)).toEqual([]);
      }

      async function expectIntact(p: PopulatedTask) {
        expect(await repo.getTask(p.task.id)).toMatchObject({ id: p.task.id, commentCount: 1 });
        expect(await repo.getComment(p.comment.id)).toEqual(p.comment);
        expect(await repo.getRun(p.run.id)).toEqual(p.run);
        expect(await repo.listRunEvents(p.run.id)).toEqual([p.event]);
      }

      it("deleteTask removes the task's comments, runs and run events", async () => {
        const board = await newBoard();
        const doomed = await populate(board.id, "doomed");
        const survivor = await populate(board.id, "survivor");

        expect(await repo.deleteTask(doomed.task.id)).toBe(true);

        await expectGone(doomed);
        await expectIntact(survivor);
        expect(ids(await repo.listTasks(board.id))).toEqual([survivor.task.id]);
      });

      it("deleteBoard removes its tasks, comments, runs and run events", async () => {
        const board = await newBoard("doomed");
        const keepBoard = await newBoard("keep");
        const doomed1 = await populate(board.id, "d1");
        const doomed2 = await populate(board.id, "d2");
        await repo.updateTask(doomed2.task.id, { agentState: "running" });
        const survivor = await populate(keepBoard.id, "survivor");

        expect(await repo.deleteBoard(board.id)).toBe(true);

        await expectGone(doomed1);
        await expectGone(doomed2);
        expect(await repo.listTasks(board.id)).toEqual([]);
        expect(await repo.listTasksByAgentState(["running"])).toEqual([]);
        await expectIntact(survivor);
        const boards = await repo.listBoards();
        expect(ids(boards)).toEqual([keepBoard.id]);
        expect(boards[0].counts).toEqual({ todo: 1, in_progress: 0, done: 0 });
      });
    });
  });
}
