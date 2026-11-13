import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, freshEnv, setupAdmin, teardown, tempDir } from "./helpers";

import * as fileRoute from "@/app/api/v1/fs/file/route";
import * as filesRoute from "@/app/api/v1/fs/files/route";
import type { ProjectFileContent, ProjectFileHit } from "@/lib/types";

// The test helpers know GET/POST/PATCH/DELETE; the handler ignores the request method.
const putRoute = { PATCH: fileRoute.PUT };

function write(root: string, rel: string, content = "x\n"): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

function list(root: string, q = "", limit?: number) {
  const params = new URLSearchParams({ root, q });
  if (limit !== undefined) params.set("limit", String(limit));
  return api<{ files: ProjectFileHit[]; error?: string }>(filesRoute, "GET", `/fs/files?${params}`);
}

function read(root: string, file: string) {
  return api<ProjectFileContent & { error?: string }>(
    fileRoute,
    "GET",
    `/fs/file?${new URLSearchParams({ root, path: file })}`,
  );
}

function save(body: Record<string, unknown>) {
  return api<ProjectFileContent & { error?: string }>(putRoute, "PATCH", "/fs/file", { body });
}

afterAll(teardown);

describe("/fs/files and /fs/file", () => {
  let plain: string;
  let repo: string;

  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    plain = tempDir("plain");
    write(plain, "notes.md", "# notes\n");
    write(plain, "src/app.ts", "export const a = 1;\n");
    write(plain, "src/lib/util.ts");
    repo = tempDir("repo");
    git(repo, "init", "-b", "main");
    write(repo, ".gitignore", "*.log\n");
    write(repo, "README.md");
    write(repo, "debug.log");
  });

  it("requires authentication", async () => {
    expect((await api(filesRoute, "GET", `/fs/files?root=${plain}`, { token: null })).status).toBe(401);
    expect((await api(fileRoute, "GET", `/fs/file?root=${plain}&path=notes.md`, { token: null })).status).toBe(401);
    const res = await api(putRoute, "PATCH", "/fs/file", {
      token: null,
      body: { root: plain, path: "notes.md", content: "x", baseMtimeMs: 0 },
    });
    expect(res.status).toBe(401);
  });

  it("lists a folder's top level, directory children and search hits relative to the root", async () => {
    const top = await list(plain);
    expect(top.status, JSON.stringify(top.body)).toBe(200);
    expect(top.body.files.map((f) => f.path)).toEqual(["src/", "notes.md"]);
    expect((await list(plain, "src/")).body.files.map((f) => f.path)).toEqual(["src/lib/", "src/app.ts"]);
    expect((await list(plain, "util")).body.files).toEqual([
      { path: "src/lib/util.ts", kind: "file", insert: "src/lib/util.ts" },
    ]);
    expect((await list(plain, "", 1)).body.files.map((f) => f.path)).toEqual(["src/"]);
  });

  it("hides gitignored files when the folder is a git repo", async () => {
    expect((await list(repo)).body.files.map((f) => f.path)).toEqual([".gitignore", "README.md"]);
    expect((await list(repo, "debug")).body.files).toEqual([]);
  });

  it("validates the root", async () => {
    expect((await list("relative/dir")).status).toBe(400);
    expect((await list("")).status).toBe(400);
    expect((await list(path.join(plain, "missing"))).status).toBe(404);
    expect((await list(path.join(plain, "notes.md"))).status).toBe(400);
    expect((await list(path.join(repo, ".git"))).status).toBe(403);
    expect((await read("relative/dir", "notes.md")).status).toBe(400);
    expect((await read(path.join(plain, "missing"), "notes.md")).status).toBe(404);
    expect((await save({ path: "notes.md", content: "x", baseMtimeMs: 0 })).status).toBe(400);
  });

  it("reads and saves a file round-trip", async () => {
    const loaded = await read(plain, "src/app.ts");
    expect(loaded.status, JSON.stringify(loaded.body)).toBe(200);
    expect(loaded.body).toMatchObject({ path: "src/app.ts", content: "export const a = 1;\n", size: 20 });

    const saved = await save({
      root: plain,
      path: "src/app.ts",
      content: "export const a = 2;\n",
      baseMtimeMs: loaded.body.mtimeMs,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ path: "src/app.ts", content: "export const a = 2;\n" });
    expect(readFileSync(path.join(plain, "src/app.ts"), "utf8")).toBe("export const a = 2;\n");

    const reloaded = await read(plain, "src/app.ts");
    expect(reloaded.body).toMatchObject({ content: "export const a = 2;\n", mtimeMs: saved.body.mtimeMs });
  });

  it("refuses a stale save with 409", async () => {
    const loaded = await read(plain, "notes.md");
    const res = await save({ root: plain, path: "notes.md", content: "stale", baseMtimeMs: loaded.body.mtimeMs - 1000 });
    expect(res.status).toBe(409);
    expect(readFileSync(path.join(plain, "notes.md"), "utf8")).toBe("# notes\n");
  });

  it("confines paths to the root", async () => {
    write(path.dirname(plain), "outside.txt", "secret\n");
    expect((await read(plain, "../outside.txt")).status).toBe(403);
    expect((await read(plain, path.join(path.dirname(plain), "outside.txt"))).status).toBe(403);
    expect((await save({ root: plain, path: "../outside.txt", content: "x", baseMtimeMs: 0 })).status).toBe(403);
    expect((await read(repo, ".git/HEAD")).status).toBe(403);
    expect((await read(plain, "missing.txt")).status).toBe(404);
  });

  it("resolves a symlinked root to its real folder", async () => {
    const link = path.join(path.dirname(plain), "plain-link");
    symlinkSync(plain, link);
    const res = await read(link, "notes.md");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.content).toBe("# notes\n");
  });
});
