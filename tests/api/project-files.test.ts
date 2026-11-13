import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, freshEnv, setupAdmin, teardown, tempDir } from "./helpers";

import * as projectFilesRoute from "@/app/api/v1/boards/[id]/project-files/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import { searchProjectFiles } from "@/lib/project-files";
import type { Board, ProjectFileHit } from "@/lib/types";

const MISSING_ID = "00000000-0000-0000-0000-000000000000";

function write(root: string, rel: string, content = "x\n"): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

async function search(boardId: string, query: string, limit?: number) {
  const params = new URLSearchParams({ q: query });
  if (limit !== undefined) params.set("limit", String(limit));
  return api<{ files: ProjectFileHit[]; error?: string }>(
    projectFilesRoute,
    "GET",
    `/boards/${boardId}/project-files?${params}`,
    { params: { id: boardId } },
  );
}

async function paths(boardId: string, query: string): Promise<string[]> {
  const res = await search(boardId, query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.files.map((f) => f.path);
}

afterAll(teardown);

describe("GET /boards/:id/project-files", () => {
  let app: string;
  let docs: string;
  let board: Board;

  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    // Workdir: a git repo with tracked, untracked and ignored files.
    app = tempDir(path.join("projects", "app"));
    git(app, "init", "-b", "main");
    write(app, ".gitignore", "*.log\nignored/\n");
    for (const rel of [
      "README.md",
      "src/app.ts",
      "src/components/AppShell.tsx",
      "src/components/button.tsx",
      "src/lib/mapping.ts",
      "webapp/index.ts",
      "assets/print/plan.md",
    ]) {
      write(app, rel);
    }
    git(app, "add", "-A");
    write(app, "notes.txt");
    write(app, "debug.log");
    write(app, "ignored/thing.ts");
    // Extra folder outside git: listed by walking, without vendor and hidden directories.
    docs = tempDir(path.join("projects", "docs"));
    write(docs, "guide/intro.md");
    write(docs, "changelog.txt");
    write(docs, "node_modules/pkg/index.js");
    write(docs, ".hidden/secret.md");

    const res = await api<Board>(boardsRoute, "POST", "/boards", {
      body: { name: "Files", workdir: app, extraFolders: [docs], autoRun: false },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    board = res.body;
  });

  it("lists untracked files and never gitignored ones", async () => {
    expect(await paths(board.id, "notes")).toEqual(["notes.txt"]);
    expect(await paths(board.id, "debug.log")).toEqual([]);
    expect(await paths(board.id, "thing")).toEqual([]);
    expect(await paths(board.id, "ignored/")).toEqual([]);
  });

  it("ranks basename matches above path substrings and subsequences", async () => {
    const res = await search(board.id, "app");
    expect(res.status).toBe(200);
    expect(res.body.files.map((f) => f.path)).toEqual([
      "src/app.ts",
      "src/components/AppShell.tsx",
      "webapp/",
      "src/lib/mapping.ts",
      "webapp/index.ts",
      "assets/print/plan.md",
    ]);
    expect(res.body.files[0]).toEqual({ path: "src/app.ts", kind: "file", insert: "src/app.ts" });
    expect(res.body.files[2]).toEqual({ path: "webapp/", kind: "dir", insert: "webapp/" });
    // An exact basename beats shorter prefix matches.
    expect((await paths(board.id, "button.tsx"))[0]).toBe("src/components/button.tsx");
  });

  it("browses direct children of a directory, directories first", async () => {
    expect(await paths(board.id, "src/")).toEqual(["src/components/", "src/lib/", "src/app.ts"]);
    expect(await paths(board.id, "src/components/")).toEqual([
      "src/components/AppShell.tsx",
      "src/components/button.tsx",
    ]);
  });

  it("lists the workdir's top level for an empty query and honours the limit", async () => {
    expect(await paths(board.id, "")).toEqual(["assets/", "src/", "webapp/", ".gitignore", "notes.txt", "README.md"]);
    const limited = await search(board.id, "", 2);
    expect(limited.body.files.map((f) => f.path)).toEqual(["assets/", "src/"]);
  });

  it("returns extra-folder hits with absolute inserts, skipping vendor and hidden directories", async () => {
    const extra = board.extraFolders[0];
    const intro = await search(board.id, "intro");
    expect(intro.body.files).toEqual([
      { path: "guide/intro.md", kind: "file", insert: path.join(extra, "guide/intro.md"), folder: "docs" },
    ]);
    expect(await paths(board.id, "index")).toEqual(["webapp/index.ts"]);
    expect(await paths(board.id, "secret")).toEqual([]);

    const browse = await search(board.id, `${extra}/`);
    expect(browse.body.files).toEqual([
      { path: "guide/", kind: "dir", insert: `${path.join(extra, "guide")}/`, folder: "docs" },
      { path: "changelog.txt", kind: "file", insert: path.join(extra, "changelog.txt"), folder: "docs" },
    ]);
    expect((await search(board.id, `${extra}/guide/in`)).body.files.map((f) => f.insert)).toEqual([
      path.join(extra, "guide/intro.md"),
    ]);
  });

  it("answers 404 for an unknown board", async () => {
    const res = await search(MISSING_ID, "app");
    expect(res.status).toBe(404);
  });

  it("returns nothing for a missing folder instead of failing", async () => {
    const missing = path.join(app, "does-not-exist");
    expect(await searchProjectFiles({ workdir: missing, extraFolders: [] }, "")).toEqual([]);
    expect(await searchProjectFiles({ workdir: missing, extraFolders: [] }, "app")).toEqual([]);
  });
});
