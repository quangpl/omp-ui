import { existsSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, call, env, freshEnv, setupAdmin, teardown, tempDir } from "./helpers";

import * as boardFilesRoute from "@/app/api/v1/boards/[id]/files/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import * as boardTasksRoute from "@/app/api/v1/boards/[id]/tasks/route";
import * as queueRoute from "@/app/api/v1/queue/route";
import * as taskFileRoute from "@/app/api/v1/tasks/[id]/files/[...path]/route";
import * as taskFilesRoute from "@/app/api/v1/tasks/[id]/files/route";
import * as taskRoute from "@/app/api/v1/tasks/[id]/route";
import type { Board, QueueSnapshot, SharedFiles, Task } from "@/lib/types";

let board: Board;

async function createTask(title: string, extra: Record<string, unknown> = {}): Promise<Task> {
  const res = await api<Task>(boardTasksRoute, "POST", `/boards/${board.id}/tasks`, {
    body: { title, ...extra },
    params: { id: board.id },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

function upload(taskId: string, name: string, content: string) {
  return api<SharedFiles>(taskFilesRoute, "POST", `/tasks/${taskId}/files?name=${encodeURIComponent(name)}`, {
    rawBody: content,
    params: { id: taskId },
    headers: { "content-type": "application/octet-stream" },
  });
}

beforeAll(async () => {
  await freshEnv();
  await setupAdmin();
  const res = await api<Board>(boardsRoute, "POST", "/boards", {
    body: { name: "Files", workdir: tempDir("files-project"), autoRun: false },
  });
  board = res.body;
});

afterAll(teardown);

describe("shared files", () => {
  it("uploads, lists, serves and deletes a card's files under DATA_DIR", async () => {
    const task = await createTask("With files");
    const created = await upload(task.id, "../notes.txt", "hello agent");
    expect(created.status).toBe(201);
    const folder = path.join(env().dataDir, "files", "tasks", task.id);
    expect(created.body.folder).toBe(folder);
    // Directories in the uploaded name are dropped.
    expect(created.body.files).toEqual([
      expect.objectContaining({ name: "notes.txt", path: path.join(folder, "notes.txt"), size: 11 }),
    ]);

    const served = await call(taskFileRoute, "GET", `/tasks/${task.id}/files/notes.txt`, {
      params: { id: task.id, path: "notes.txt" },
    });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(await served.text()).toBe("hello agent");

    const removed = await api<SharedFiles>(taskFileRoute, "DELETE", `/tasks/${task.id}/files/notes.txt`, {
      params: { id: task.id, path: "notes.txt" },
    });
    expect(removed.status).toBe(200);
    expect(removed.body.files).toEqual([]);
  });

  it("never serves active content inline and rejects paths outside the folder", async () => {
    const task = await createTask("Unsafe files");
    await upload(task.id, "page.html", "<script>alert(1)</script>");
    const html = await call(taskFileRoute, "GET", `/tasks/${task.id}/files/page.html`, {
      params: { id: task.id, path: "page.html" },
    });
    expect(html.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(html.headers.get("content-type")).toBe("application/octet-stream");

    const escape = await api(taskFileRoute, "GET", `/tasks/${task.id}/files/x`, {
      params: { id: task.id, path: "../../omp-ui.db" },
    });
    expect(escape.status).toBe(400);
  });

  it("removes a card's files when the card is deleted", async () => {
    const task = await createTask("Doomed");
    const { body } = await upload(task.id, "a.txt", "x");
    expect(existsSync(body.folder)).toBe(true);
    await api(taskRoute, "DELETE", `/tasks/${task.id}`, { params: { id: task.id } });
    expect(existsSync(body.folder)).toBe(false);
  });

  it("keeps board-wide shared files separately", async () => {
    const res = await api<SharedFiles>(boardFilesRoute, "GET", `/boards/${board.id}/files`, {
      params: { id: board.id },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ folder: path.join(env().dataDir, "files", "boards", board.id), files: [] });
  });
});

describe("task queue dependencies", () => {
  it("accepts cards of the same board and rejects itself, unknown cards and cycles", async () => {
    const a = await createTask("A");
    const b = await createTask("B", { blockedBy: [a.id] });
    expect(b.blockedBy).toEqual([a.id]);

    const patch = (task: Task, blockedBy: string[]) =>
      api<Task & { error?: string }>(taskRoute, "PATCH", `/tasks/${task.id}`, {
        body: { blockedBy },
        params: { id: task.id },
      });
    expect((await patch(a, [a.id])).status).toBe(400);
    expect((await patch(a, ["00000000-0000-0000-0000-000000000000"])).status).toBe(400);
    const cycle = await patch(a, [b.id]);
    expect(cycle.status).toBe(400);
    expect(cycle.body.error).toMatch(/wait for each other/);
    expect((await patch(b, [])).body.blockedBy).toEqual([]);
  });

  it("reports the queue and refuses to move a card that is not queued", async () => {
    const res = await api<QueueSnapshot>(queueRoute, "GET", "/queue");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ running: [], queued: [] });
    const task = await createTask("Idle");
    const move = await api(queueRoute, "POST", "/queue", { body: { taskId: task.id, position: 0 } });
    expect(move.status).toBe(409);
  });
});
