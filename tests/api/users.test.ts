import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_PASSWORD,
  api,
  call,
  createUser,
  freshEnv,
  loginAs,
  setupAdmin,
  teardown,
  tempDir,
  type Method,
  type RouteModule,
} from "./helpers";

import * as boardFileRoute from "@/app/api/v1/boards/[id]/files/[...path]/route";
import * as boardFilesRoute from "@/app/api/v1/boards/[id]/files/route";
import * as boardRoute from "@/app/api/v1/boards/[id]/route";
import * as boardTasksRoute from "@/app/api/v1/boards/[id]/tasks/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import * as commentRoute from "@/app/api/v1/comments/[id]/route";
import * as credentialRoute from "@/app/api/v1/credentials/[id]/route";
import * as credentialsRoute from "@/app/api/v1/credentials/route";
import * as dashboardRoute from "@/app/api/v1/dashboard/route";
import * as logsRoute from "@/app/api/v1/logs/route";
import * as runEventsRoute from "@/app/api/v1/runs/[id]/events/route";
import * as schedulerRoute from "@/app/api/v1/schedulers/[id]/route";
import * as schedulersRoute from "@/app/api/v1/schedulers/route";
import * as settingsRoute from "@/app/api/v1/settings/route";
import * as taskCommentsRoute from "@/app/api/v1/tasks/[id]/comments/route";
import * as taskFileRoute from "@/app/api/v1/tasks/[id]/files/[...path]/route";
import * as taskFilesRoute from "@/app/api/v1/tasks/[id]/files/route";
import * as taskRoute from "@/app/api/v1/tasks/[id]/route";
import * as taskRunsRoute from "@/app/api/v1/tasks/[id]/runs/route";
import * as userPasswordRoute from "@/app/api/v1/users/[id]/password/route";
import * as userRoute from "@/app/api/v1/users/[id]/route";
import * as usersRoute from "@/app/api/v1/users/route";
import type { CredentialsResponse, CredentialSummary } from "@/lib/credential-types";
import { getRepo } from "@/lib/db";
import type {
  Board,
  BoardWithCounts,
  Comment,
  Dashboard,
  DeleteUserResult,
  Run,
  RunEvent,
  Scheduler,
  SharedFiles,
  Task,
  User,
} from "@/lib/types";

interface Session {
  token: string;
  expiresAt: string;
  user: User;
}

const MISSING_ID = "00000000-0000-0000-0000-000000000000";
/** Every field of a public `User`: secrets (password hash, token epoch) never leave the server. */
const USER_KEYS = ["createdAt", "email", "id", "isActive", "role", "updatedAt", "username"];

afterAll(teardown);

async function listUsers(): Promise<User[]> {
  const res = await api<User[]>(usersRoute, "GET", "/users");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function postUser(body: Record<string, unknown>) {
  return api<User & { error?: string }>(usersRoute, "POST", "/users", { body });
}

async function patchUser(id: string, body: Record<string, unknown>) {
  return api<User & { error?: string }>(userRoute, "PATCH", `/users/${id}`, { body, params: { id } });
}

async function setUserPassword(id: string, password: unknown) {
  return api<{ ok?: true; error?: string } & Partial<Session>>(userPasswordRoute, "PATCH", `/users/${id}/password`, {
    body: { password },
    params: { id },
  });
}

async function deleteUser(id: string, reassignTo?: string) {
  const query = reassignTo === undefined ? "" : `?reassignTo=${encodeURIComponent(reassignTo)}`;
  return api<DeleteUserResult & { error?: string }>(userRoute, "DELETE", `/users/${id}${query}`, { params: { id } });
}

/** True while `token` still opens an authenticated route. */
async function signedIn(token: string): Promise<boolean> {
  const status = (await api(boardsRoute, "GET", "/boards", { token })).status;
  expect([200, 401]).toContain(status);
  return status === 200;
}

async function createBoard(token: string, name: string): Promise<Board> {
  const res = await api<Board>(boardsRoute, "POST", "/boards", {
    body: { name, workdir: tempDir(`project-${name}`), autoRun: false },
    token,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function createCredential(token: string, name: string): Promise<CredentialSummary> {
  const res = await api<CredentialSummary>(credentialsRoute, "POST", "/credentials", {
    body: { providerId: "mcp-http", name, fields: { url: "http://127.0.0.1:9/mcp", token: `${name}-secret` } },
    token,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function listCredentials(token: string): Promise<CredentialSummary[]> {
  const res = await api<CredentialsResponse>(credentialsRoute, "GET", "/credentials", { token });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.credentials;
}

async function boardIds(token: string): Promise<string[]> {
  const res = await api<BoardWithCounts[]>(boardsRoute, "GET", "/boards", { token });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.map((b) => b.id);
}

describe("user management", () => {
  let admin: User;

  beforeEach(async () => {
    await freshEnv();
    await setupAdmin();
    [admin] = await listUsers();
  });

  it("lists users oldest first and creates users (201) with normalized fields and the user role by default", async () => {
    expect(admin).toMatchObject({ username: "admin", email: null, role: "admin", isActive: true });
    expect(Object.keys(admin).sort()).toEqual(USER_KEYS);

    const alice = await postUser({ username: "  Alice ", email: " Alice@Example.COM ", password: "alice-password" });
    expect(alice.status).toBe(201);
    expect(alice.body).toMatchObject({ username: "alice", email: "alice@example.com", role: "user", isActive: true });
    expect(Object.keys(alice.body).sort()).toEqual(USER_KEYS);

    const boss = await postUser({ username: "boss", password: "boss-password", role: "admin" });
    expect(boss.status).toBe(201);
    expect(boss.body).toMatchObject({ username: "boss", email: null, role: "admin" });
    // Several accounts may have no email.
    const noMail = await postUser({ username: "no.mail_1", email: "", password: "nomail-password" });
    expect(noMail.status).toBe(201);
    expect(noMail.body.email).toBeNull();

    expect((await listUsers()).map((u) => u.username)).toEqual(["admin", "alice", "boss", "no.mail_1"]);

    const one = await api<User>(userRoute, "GET", `/users/${alice.body.id}`, { params: { id: alice.body.id } });
    expect(one.status).toBe(200);
    expect(one.body).toEqual(alice.body);
    const missing = await api(userRoute, "GET", `/users/${MISSING_ID}`, { params: { id: MISSING_ID } });
    expect(missing.status).toBe(404);

    expect(await signedIn(await loginAs("alice@example.com", "alice-password"))).toBe(true);
  });

  it("answers 409 for a username or email that is already taken, whatever its case", async () => {
    const alice = await createUser({ username: "alice", email: "alice@example.com", password: "alice-password" });
    const bob = await createUser({ username: "bob", password: "bob-password" });

    const sameName = await postUser({ username: "ALICE", password: "another-password" });
    expect(sameName.status).toBe(409);
    expect(sameName.body).toEqual({ error: "Username already taken" });
    expect((await postUser({ username: "admin", password: "another-password" })).status).toBe(409);

    const sameEmail = await postUser({ username: "alice2", email: "Alice@Example.com", password: "another-password" });
    expect(sameEmail.status).toBe(409);
    expect(sameEmail.body).toEqual({ error: "Email already in use" });

    expect((await patchUser(bob.id, { username: "alice" })).status).toBe(409);
    expect((await patchUser(bob.id, { email: "alice@example.com" })).status).toBe(409);
    // Re-sending a user's own username/email is not a conflict.
    expect((await patchUser(alice.id, { username: "alice", email: "alice@example.com" })).status).toBe(200);

    expect((await listUsers()).map((u) => u.username)).toEqual(["admin", "alice", "bob"]);
  });

  it("answers 400 for an invalid username, email, password or role without creating anything", async () => {
    const valid = { username: "valid", password: "valid-password" };
    for (const body of [
      { ...valid, username: undefined },
      { ...valid, username: "" },
      { ...valid, username: "a" },
      { ...valid, username: "-dash-first" },
      { ...valid, username: "has space" },
      { ...valid, username: "at@sign" },
      { ...valid, username: "x".repeat(33) },
      { ...valid, username: 42 },
      { ...valid, email: "not-an-email" },
      { ...valid, email: "a@b" },
      { ...valid, email: `${"x".repeat(250)}@example.com` },
      { ...valid, email: 7 },
      { ...valid, password: undefined },
      { ...valid, password: "short" },
      { ...valid, password: 123456789 },
      { ...valid, password: "x".repeat(1025) },
      { ...valid, role: "root" },
    ]) {
      const res = await postUser(body);
      expect(res.status, JSON.stringify(body).slice(0, 120)).toBe(400);
      expect(typeof res.body.error).toBe("string");
    }
    const invalidJson = await api(usersRoute, "POST", "/users", { rawBody: "{nope" });
    expect(invalidJson.status).toBe(400);

    expect(await listUsers()).toEqual([admin]);
  });

  it("edits username, email, role and active state with PATCH", async () => {
    const alice = await createUser({ username: "alice", email: "alice@example.com", password: "alice-password" });

    const renamed = await patchUser(alice.id, { username: " Alicia ", email: null });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ id: alice.id, username: "alicia", email: null, role: "user", isActive: true });
    expect(Date.parse(renamed.body.updatedAt)).toBeGreaterThanOrEqual(Date.parse(alice.updatedAt));
    expect((await api(userRoute, "GET", `/users/${alice.id}`, { params: { id: alice.id } })).body).toEqual(renamed.body);

    // The new name signs in; the old name and the removed email no longer do.
    expect(await signedIn(await loginAs("alicia", "alice-password"))).toBe(true);
    await expect(loginAs("alice", "alice-password")).rejects.toThrow(/401/);
    await expect(loginAs("alice@example.com", "alice-password")).rejects.toThrow(/401/);

    const promoted = await patchUser(alice.id, { role: "admin", email: "Alicia@Example.com" });
    expect(promoted.status).toBe(200);
    expect(promoted.body).toMatchObject({ role: "admin", email: "alicia@example.com" });

    const deactivated = await patchUser(alice.id, { isActive: false });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.isActive).toBe(false);

    for (const body of [{ username: "!" }, { email: "nope" }, { role: "owner" }, { isActive: "no" }]) {
      expect((await patchUser(alice.id, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await patchUser(MISSING_ID, { username: "ghost" })).status).toBe(404);
  });

  it("refuses to let an admin demote, deactivate or delete their own account (400)", async () => {
    const demote = await patchUser(admin.id, { role: "user" });
    expect(demote.status).toBe(400);
    expect(typeof demote.body.error).toBe("string");
    expect((await patchUser(admin.id, { isActive: false })).status).toBe(400);
    expect((await deleteUser(admin.id)).status).toBe(400);

    // Another admin present changes nothing: the rule is about your own account.
    await createUser({ username: "boss", password: "boss-password", role: "admin" });
    expect((await patchUser(admin.id, { role: "user" })).status).toBe(400);
    expect((await patchUser(admin.id, { isActive: false })).status).toBe(400);
    expect((await deleteUser(admin.id)).status).toBe(400);

    expect((await listUsers()).find((u) => u.id === admin.id)).toMatchObject({ role: "admin", isActive: true });
    // Harmless self-edits are fine.
    expect((await patchUser(admin.id, { email: "admin@example.com" })).status).toBe(200);
  });

  it("revokes a user's sessions when they are deactivated or their role changes, not on other edits", async () => {
    const alice = await createUser({ username: "alice", password: "alice-password" });
    let token = await loginAs("alice", "alice-password");

    expect((await patchUser(alice.id, { username: "alice2", email: "alice@example.com" })).status).toBe(200);
    expect(await signedIn(token)).toBe(true);

    expect((await patchUser(alice.id, { role: "admin" })).status).toBe(200);
    expect(await signedIn(token)).toBe(false);
    token = await loginAs("alice2", "alice-password");
    expect(await signedIn(token)).toBe(true);

    expect((await patchUser(alice.id, { role: "user" })).status).toBe(200);
    expect(await signedIn(token)).toBe(false);
    token = await loginAs("alice2", "alice-password");

    expect((await patchUser(alice.id, { isActive: false })).status).toBe(200);
    expect(await signedIn(token)).toBe(false);
    await expect(loginAs("alice2", "alice-password")).rejects.toThrow(/401/);

    expect((await patchUser(alice.id, { isActive: true })).status).toBe(200);
    expect(await signedIn(token)).toBe(false);
    expect(await signedIn(await loginAs("alice2", "alice-password"))).toBe(true);
  });

  it("sets another user's password, revoking their sessions (PATCH /users/:id/password)", async () => {
    const alice = await createUser({ username: "alice", password: "alice-password" });
    const aliceToken = await loginAs("alice", "alice-password");

    expect((await setUserPassword(alice.id, "short")).status).toBe(400);
    expect((await setUserPassword(alice.id, undefined)).status).toBe(400);
    expect((await setUserPassword(MISSING_ID, "whatever-password")).status).toBe(404);
    expect(await signedIn(aliceToken)).toBe(true);

    const res = await setUserPassword(alice.id, "reset-password-1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers.get("set-cookie")).toBeNull();

    expect(await signedIn(aliceToken)).toBe(false);
    await expect(loginAs("alice", "alice-password")).rejects.toThrow(/401/);
    expect(await signedIn(await loginAs("alice", "reset-password-1"))).toBe(true);
    // The admin doing it stays signed in.
    expect((await listUsers()).length).toBe(2);
  });

  it("answers its own password reset with a fresh session so the admin stays signed in", async () => {
    const oldToken = await loginAs("admin", ADMIN_PASSWORD);
    const res = await setUserPassword(admin.id, "admin-new-password");
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.user).toEqual(expect.objectContaining({ id: admin.id, username: "admin" }));
    expect(res.headers.get("set-cookie")).toContain(`omp_ui_token=${encodeURIComponent(res.body.token ?? "")}`);

    expect(await signedIn(oldToken)).toBe(false);
    expect(await signedIn(res.body.token ?? "")).toBe(true);
    await expect(loginAs("admin", ADMIN_PASSWORD)).rejects.toThrow(/401/);
    expect(await signedIn(await loginAs("admin", "admin-new-password"))).toBe(true);
  });

  it("validates DELETE targets and reassignTo", async () => {
    const alice = await createUser({ username: "alice", password: "alice-password" });
    const idle = await createUser({ username: "idle", password: "idle-password" });
    expect((await patchUser(idle.id, { isActive: false })).status).toBe(200);

    expect((await deleteUser(MISSING_ID)).status).toBe(404);
    expect((await deleteUser(alice.id, alice.id)).status).toBe(400);
    expect((await deleteUser(alice.id, MISSING_ID)).status).toBe(400);
    expect((await deleteUser(alice.id, idle.id)).status).toBe(400);
    expect((await listUsers()).map((u) => u.username)).toEqual(["admin", "alice", "idle"]);

    const deleted = await deleteUser(idle.id);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true, boards: 0, credentials: 0, reassignedTo: null });
    expect((await api(userRoute, "GET", `/users/${idle.id}`, { params: { id: idle.id } })).status).toBe(404);
  });
});

describe("admin-only routes", () => {
  let userToken = "";
  let other: User;

  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    await createUser({ username: "plain", password: "plain-password" });
    other = await createUser({ username: "other", password: "other-password" });
    userToken = await loginAs("plain", "plain-password");
  });

  it.each<[string, RouteModule, Method, () => string, () => Record<string, string> | undefined, unknown]>([
    ["GET /users", usersRoute, "GET", () => "/users", () => undefined, undefined],
    ["POST /users", usersRoute, "POST", () => "/users", () => undefined, { username: "sneaky", password: "sneaky-password" }],
    ["GET /users/:id", userRoute, "GET", () => `/users/${other.id}`, () => ({ id: other.id }), undefined],
    ["PATCH /users/:id", userRoute, "PATCH", () => `/users/${other.id}`, () => ({ id: other.id }), { role: "admin" }],
    ["DELETE /users/:id", userRoute, "DELETE", () => `/users/${other.id}`, () => ({ id: other.id }), undefined],
    [
      "PATCH /users/:id/password",
      userPasswordRoute,
      "PATCH",
      () => `/users/${other.id}/password`,
      () => ({ id: other.id }),
      { password: "taken-over-password" },
    ],
    ["PATCH /settings", settingsRoute, "PATCH", () => "/settings", () => undefined, { maxAgents: 1 }],
    ["GET /logs", logsRoute, "GET", () => "/logs", () => undefined, undefined],
  ])("%s answers 403 to a non-admin", async (_name, mod, method, routePath, params, body) => {
    const res = await call(mod, method, routePath(), { token: userToken, params: params(), body });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Admin only" });
  });

  it("left every account untouched and still serves open routes to the user", async () => {
    expect((await listUsers()).map((u) => [u.username, u.role])).toEqual([
      ["admin", "admin"],
      ["plain", "user"],
      ["other", "user"],
    ]);
    expect(await signedIn(await loginAs("other", "other-password"))).toBe(true);
    expect((await api(settingsRoute, "GET", "/settings", { token: userToken })).status).toBe(200);
  });
});

describe("per-user data isolation", () => {
  interface Owned {
    user: User;
    token: string;
    board: Board;
    task: Task;
    comment: Comment;
    run: Run;
    scheduler: Scheduler;
    credential: CredentialSummary;
  }

  let adminToken = "";
  let a: Owned;
  let b: Owned;

  /** A user with a board, a card, a comment, a finished run with one event, shared files, a scheduler and a credential. */
  async function populate(username: string): Promise<Owned> {
    const user = await createUser({ username, password: `${username}-password` });
    const token = await loginAs(username, `${username}-password`);
    const board = await createBoard(token, `${username}-board`);
    expect(board.userId).toBe(user.id);

    const taskRes = await api<Task>(boardTasksRoute, "POST", `/boards/${board.id}/tasks`, {
      body: { title: `${username} card` },
      params: { id: board.id },
      token,
    });
    expect(taskRes.status, JSON.stringify(taskRes.body)).toBe(201);
    const task = taskRes.body;
    expect(task.userId).toBe(user.id);

    const commentRes = await api<Comment>(taskCommentsRoute, "POST", `/tasks/${task.id}/comments`, {
      body: { body: `${username} feedback` },
      params: { id: task.id },
      token,
    });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);

    // Runs are created by the agent manager; a finished one written straight to the store is enough here.
    const repo = await getRepo();
    const started = await repo.createRun({ taskId: task.id, prompt: `${username} prompt` });
    await repo.appendRunEvent({ runId: started.id, taskId: task.id, kind: "text", text: `${username} run output` });
    const run = await repo.updateRun(started.id, { status: "succeeded", endedAt: new Date().toISOString() });
    expect(run?.userId).toBe(user.id);

    for (const [mod, scope, id] of [
      [boardFilesRoute, "boards", board.id],
      [taskFilesRoute, "tasks", task.id],
    ] as const) {
      const upload = await api<SharedFiles>(mod, "POST", `/${scope}/${id}/files?name=notes.txt`, {
        rawBody: `${username} notes`,
        params: { id },
        headers: { "content-type": "application/octet-stream" },
        token,
      });
      expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    }

    const schedulerRes = await api<Scheduler>(schedulersRoute, "POST", "/schedulers", {
      body: { boardId: board.id, prompt: `${username} nightly`, cron: "0 3 * * *", enabled: false },
      token,
    });
    expect(schedulerRes.status, JSON.stringify(schedulerRes.body)).toBe(201);
    expect(schedulerRes.body.userId).toBe(user.id);

    const credential = await createCredential(token, `${username}-mcp`);
    expect(credential.userId).toBe(user.id);

    return {
      user,
      token,
      board,
      task,
      comment: commentRes.body,
      run: run!,
      scheduler: schedulerRes.body,
      credential,
    };
  }

  beforeAll(async () => {
    await freshEnv();
    adminToken = await setupAdmin();
    a = await populate("usera");
    b = await populate("userb");
  });

  it("answers 404 to another user's board, card, comment, run, files and scheduler", async () => {
    const boardId = a.board.id;
    const taskId = a.task.id;
    const calls: [string, RouteModule, Method, string, Record<string, string>, unknown?][] = [
      ["GET board", boardRoute, "GET", `/boards/${boardId}`, { id: boardId }],
      ["PATCH board", boardRoute, "PATCH", `/boards/${boardId}`, { id: boardId }, { name: "Hijacked" }],
      ["DELETE board", boardRoute, "DELETE", `/boards/${boardId}`, { id: boardId }],
      ["GET board tasks", boardTasksRoute, "GET", `/boards/${boardId}/tasks`, { id: boardId }],
      ["POST board task", boardTasksRoute, "POST", `/boards/${boardId}/tasks`, { id: boardId }, { title: "Intruder" }],
      ["GET task", taskRoute, "GET", `/tasks/${taskId}`, { id: taskId }],
      ["PATCH task", taskRoute, "PATCH", `/tasks/${taskId}`, { id: taskId }, { title: "Hijacked" }],
      ["DELETE task", taskRoute, "DELETE", `/tasks/${taskId}`, { id: taskId }],
      ["GET task comments", taskCommentsRoute, "GET", `/tasks/${taskId}/comments`, { id: taskId }],
      ["POST task comment", taskCommentsRoute, "POST", `/tasks/${taskId}/comments`, { id: taskId }, { body: "Hi" }],
      ["PATCH comment", commentRoute, "PATCH", `/comments/${a.comment.id}`, { id: a.comment.id }, { resolved: true }],
      ["DELETE comment", commentRoute, "DELETE", `/comments/${a.comment.id}`, { id: a.comment.id }],
      ["GET task runs", taskRunsRoute, "GET", `/tasks/${taskId}/runs`, { id: taskId }],
      ["GET run events", runEventsRoute, "GET", `/runs/${a.run.id}/events`, { id: a.run.id }],
      ["GET board files", boardFilesRoute, "GET", `/boards/${boardId}/files`, { id: boardId }],
      ["GET board file", boardFileRoute, "GET", `/boards/${boardId}/files/notes.txt`, { id: boardId, path: "notes.txt" }],
      ["DELETE board file", boardFileRoute, "DELETE", `/boards/${boardId}/files/notes.txt`, { id: boardId, path: "notes.txt" }],
      ["GET task files", taskFilesRoute, "GET", `/tasks/${taskId}/files`, { id: taskId }],
      ["GET task file", taskFileRoute, "GET", `/tasks/${taskId}/files/notes.txt`, { id: taskId, path: "notes.txt" }],
      ["DELETE task file", taskFileRoute, "DELETE", `/tasks/${taskId}/files/notes.txt`, { id: taskId, path: "notes.txt" }],
      ["GET scheduler", schedulerRoute, "GET", `/schedulers/${a.scheduler.id}`, { id: a.scheduler.id }],
      ["PATCH scheduler", schedulerRoute, "PATCH", `/schedulers/${a.scheduler.id}`, { id: a.scheduler.id }, { name: "Mine" }],
      ["DELETE scheduler", schedulerRoute, "DELETE", `/schedulers/${a.scheduler.id}`, { id: a.scheduler.id }],
      ["GET schedulers of board", schedulersRoute, "GET", `/schedulers?boardId=${boardId}`, {}],
    ];
    for (const [name, mod, method, routePath, params, body] of calls) {
      const res = await call(mod, method, routePath, { token: b.token, params, body });
      expect(res.status, name).toBe(404);
    }

    // B cannot attach its own scheduler to A's board either.
    const moved = await api(schedulerRoute, "PATCH", `/schedulers/${b.scheduler.id}`, {
      body: { boardId },
      params: { id: b.scheduler.id },
      token: b.token,
    });
    expect(moved.status).toBe(404);
    const created = await api(schedulersRoute, "POST", "/schedulers", {
      body: { boardId, prompt: "Intrude", cron: "0 3 * * *", enabled: false },
      token: b.token,
    });
    expect(created.status).toBe(404);
  });

  it("left the owner's data intact after the other user's attempts", async () => {
    const detail = await api<{ task: Task; comments: Comment[]; runs: Run[] }>(taskRoute, "GET", `/tasks/${a.task.id}`, {
      params: { id: a.task.id },
      token: a.token,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.task.title).toBe("usera card");
    expect(detail.body.comments.map((c) => [c.id, c.resolved])).toEqual([[a.comment.id, false]]);
    expect(detail.body.runs.map((r) => r.id)).toEqual([a.run.id]);

    const board = await api<Board>(boardRoute, "GET", `/boards/${a.board.id}`, { params: { id: a.board.id }, token: a.token });
    expect(board.body.name).toBe("usera-board");

    const events = await api<RunEvent[]>(runEventsRoute, "GET", `/runs/${a.run.id}/events`, {
      params: { id: a.run.id },
      token: a.token,
    });
    expect(events.status).toBe(200);
    expect(events.body.map((e) => e.text)).toEqual(["usera run output"]);

    for (const [mod, scope, id] of [
      [boardFilesRoute, "boards", a.board.id],
      [taskFilesRoute, "tasks", a.task.id],
    ] as const) {
      const files = await api<SharedFiles>(mod, "GET", `/${scope}/${id}/files`, { params: { id }, token: a.token });
      expect(files.status).toBe(200);
      expect(files.body.files.map((f) => f.name)).toEqual(["notes.txt"]);
    }

    const scheduler = await api<Scheduler>(schedulerRoute, "GET", `/schedulers/${a.scheduler.id}`, {
      params: { id: a.scheduler.id },
      token: a.token,
    });
    expect(scheduler.body).toMatchObject({ name: a.scheduler.name, boardId: a.board.id });
  });

  it("lists only the user's own boards, dashboard projects and schedulers", async () => {
    expect(await boardIds(a.token)).toEqual([a.board.id]);
    expect(await boardIds(b.token)).toEqual([b.board.id]);

    const dashboard = await api<Dashboard>(dashboardRoute, "GET", "/dashboard", { token: b.token });
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.boards.map((board) => board.id)).toEqual([b.board.id]);
    expect(JSON.stringify(dashboard.body)).not.toContain(a.task.id);

    const schedulers = await api<Scheduler[]>(schedulersRoute, "GET", "/schedulers", { token: b.token });
    expect(schedulers.status).toBe(200);
    expect(schedulers.body.map((s) => s.id)).toEqual([b.scheduler.id]);
  });

  it("shows admins everyone's data", async () => {
    expect((await boardIds(adminToken)).sort()).toEqual([a.board.id, b.board.id].sort());

    const dashboard = await api<Dashboard>(dashboardRoute, "GET", "/dashboard", { token: adminToken });
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.boards.map((board) => board.id).sort()).toEqual([a.board.id, b.board.id].sort());

    const schedulers = await api<Scheduler[]>(schedulersRoute, "GET", "/schedulers", { token: adminToken });
    expect(schedulers.body.map((s) => s.id).sort()).toEqual([a.scheduler.id, b.scheduler.id].sort());

    for (const owned of [a, b]) {
      const task = await api(taskRoute, "GET", `/tasks/${owned.task.id}`, { params: { id: owned.task.id }, token: adminToken });
      expect(task.status).toBe(200);
      const events = await api<RunEvent[]>(runEventsRoute, "GET", `/runs/${owned.run.id}/events`, {
        params: { id: owned.run.id },
        token: adminToken,
      });
      expect(events.status).toBe(200);
      expect(events.body).toHaveLength(1);
    }

    expect((await listCredentials(adminToken)).map((c) => c.id).sort()).toEqual([a.credential.id, b.credential.id].sort());
  });

  it("keeps credentials private to their owner", async () => {
    expect((await listCredentials(a.token)).map((c) => c.id)).toEqual([a.credential.id]);
    expect((await listCredentials(b.token)).map((c) => c.id)).toEqual([b.credential.id]);

    const id = a.credential.id;
    const patched = await api(credentialRoute, "PATCH", `/credentials/${id}`, {
      body: { name: "Stolen" },
      params: { id },
      token: b.token,
    });
    expect(patched.status).toBe(404);
    const deleted = await api(credentialRoute, "DELETE", `/credentials/${id}`, { params: { id }, token: b.token });
    expect(deleted.status).toBe(404);

    const mine = await listCredentials(a.token);
    expect(mine.map((c) => [c.id, c.name])).toEqual([[id, "usera-mcp"]]);
  });
});

describe("deleting users with their data", () => {
  let adminToken = "";

  beforeEach(async () => {
    await freshEnv();
    adminToken = await setupAdmin();
  });

  it("transfers boards and credentials with ?reassignTo=", async () => {
    const carol = await createUser({ username: "carol", password: "carol-password" });
    const dave = await createUser({ username: "dave", password: "dave-password" });
    const carolToken = await loginAs("carol", "carol-password");
    const daveToken = await loginAs("dave", "dave-password");
    const board = await createBoard(carolToken, "carol-board");
    const credential = await createCredential(carolToken, "carol-mcp");
    expect(await boardIds(daveToken)).toEqual([]);

    const res = await deleteUser(carol.id, dave.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ok: true, boards: 1, credentials: 1, reassignedTo: dave.id });

    expect(await signedIn(carolToken)).toBe(false);
    await expect(loginAs("carol", "carol-password")).rejects.toThrow(/401/);
    expect((await api(userRoute, "GET", `/users/${carol.id}`, { params: { id: carol.id } })).status).toBe(404);

    expect(await boardIds(daveToken)).toEqual([board.id]);
    const moved = await api<Board>(boardRoute, "GET", `/boards/${board.id}`, { params: { id: board.id }, token: daveToken });
    expect(moved.status).toBe(200);
    expect(moved.body.userId).toBe(dave.id);
    expect((await listCredentials(daveToken)).map((c) => [c.id, c.userId])).toEqual([[credential.id, dave.id]]);
  });

  it("deletes boards and credentials without reassignTo", async () => {
    const erin = await createUser({ username: "erin", password: "erin-password" });
    const erinToken = await loginAs("erin", "erin-password");
    const board = await createBoard(erinToken, "erin-board");
    const taskRes = await api<Task>(boardTasksRoute, "POST", `/boards/${board.id}/tasks`, {
      body: { title: "Erin card" },
      params: { id: board.id },
      token: erinToken,
    });
    expect(taskRes.status).toBe(201);
    await createCredential(erinToken, "erin-mcp");
    const adminBoard = await createBoard(adminToken, "admin-board");

    const res = await deleteUser(erin.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ok: true, boards: 1, credentials: 1, reassignedTo: null });

    expect((await api(boardRoute, "GET", `/boards/${board.id}`, { params: { id: board.id } })).status).toBe(404);
    expect((await api(taskRoute, "GET", `/tasks/${taskRes.body.id}`, { params: { id: taskRes.body.id } })).status).toBe(404);
    expect(await boardIds(adminToken)).toEqual([adminBoard.id]);
    expect(await listCredentials(adminToken)).toEqual([]);
    expect((await listUsers()).map((u) => u.username)).toEqual(["admin"]);
  });
});
