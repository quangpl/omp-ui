import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, freshEnv, setupAdmin, teardown, tempDir } from "./helpers";

import * as boardOpsRoute from "@/app/api/v1/boards/[id]/project-files/ops/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import * as fsOpsRoute from "@/app/api/v1/fs/ops/route";
import type { Board, FileOpResult } from "@/lib/types";

function write(root: string, rel: string, content = "x\n"): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

afterAll(teardown);

describe("POST /boards/:id/project-files/ops and /fs/ops", () => {
  let app: string;
  let plain: string;
  let board: Board;

  function boardOp(body: Record<string, unknown>, token?: null) {
    return api<FileOpResult & { error?: string }>(boardOpsRoute, "POST", `/boards/${board.id}/project-files/ops`, {
      params: { id: board.id },
      body,
      ...(token === null ? { token } : {}),
    });
  }

  function fsOp(body: Record<string, unknown>, token?: null) {
    return api<FileOpResult & { error?: string }>(fsOpsRoute, "POST", "/fs/ops", {
      body,
      ...(token === null ? { token } : {}),
    });
  }

  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    app = tempDir(path.join("projects", "app"));
    write(app, "README.md", "# app\n");
    plain = tempDir("plain");
    write(plain, "notes.md", "# notes\n");
    const res = await api<Board>(boardsRoute, "POST", "/boards", {
      body: { name: "Ops", workdir: app, autoRun: false },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    board = res.body;
  });

  it("requires authentication", async () => {
    expect((await boardOp({ op: "create-file", path: "x.md" }, null)).status).toBe(401);
    expect((await fsOp({ root: plain, op: "create-file", path: "x.md" }, null)).status).toBe(401);
    expect(existsSync(path.join(board.workdir, "x.md"))).toBe(false);
    expect(existsSync(path.join(plain, "x.md"))).toBe(false);
  });

  it("applies an op to a board's project folder", async () => {
    const res = await boardOp({ op: "create-dir", path: "docs/guides" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ path: "docs/guides/", kind: "dir" });
    expect(existsSync(path.join(board.workdir, "docs", "guides"))).toBe(true);
    expect((await boardOp({ op: "create-dir", path: "docs" })).status).toBe(409);
    expect((await boardOp({ op: "delete", path: "../outside" })).status).toBe(403);
  });

  it("applies an op to a standalone folder", async () => {
    const res = await fsOp({ root: plain, op: "rename", from: "notes.md", to: "archive/notes.md" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ path: "archive/notes.md", kind: "file" });
    expect(readFileSync(path.join(plain, "archive", "notes.md"), "utf8")).toBe("# notes\n");
    expect((await fsOp({ op: "create-file", path: "x.md" })).status).toBe(400);
    expect((await fsOp({ root: plain, op: "nope" })).status).toBe(400);
  });
});
