import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFileOp } from "@/lib/project-file-ops";
import { searchProjectFiles } from "@/lib/project-files";

let root: string;
let workdir: string;
let extra: string;
let outside: string;
let board: { workdir: string; extraFolders: string[] };

async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(
    () => true,
    () => false,
  );
}

async function listed(query: string): Promise<string[]> {
  return (await searchProjectFiles(board, query, 1000)).map((hit) => hit.path);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ui-file-ops-"));
  workdir = path.join(root, "work");
  extra = path.join(root, "extra");
  outside = path.join(root, "outside");
  await fs.mkdir(path.join(workdir, "src", "nested"), { recursive: true });
  await fs.mkdir(path.join(extra, "lib"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workdir, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  await fs.writeFile(path.join(workdir, ".gitignore"), "node_modules/\n");
  await fs.writeFile(path.join(workdir, "src", "app.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(workdir, "src", "nested", "deep.ts"), "deep\n");
  await fs.writeFile(path.join(extra, "lib", "b.ts"), "b\n");
  await fs.writeFile(path.join(outside, "secret.txt"), "secret\n");
  board = { workdir, extraFolders: [extra] };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("applyFileOp: create", () => {
  it("creates an empty file, making missing parents", async () => {
    expect(await applyFileOp(board, { op: "create-file", path: "notes.md" })).toEqual({ path: "notes.md", kind: "file" });
    expect(await fs.readFile(path.join(workdir, "notes.md"), "utf8")).toBe("");
    expect(await applyFileOp(board, { op: "create-file", path: "a/b/c.ts" })).toEqual({ path: "a/b/c.ts", kind: "file" });
    expect((await fs.stat(path.join(workdir, "a", "b", "c.ts"))).isFile()).toBe(true);
  });

  it("creates folders, nested ones included", async () => {
    expect(await applyFileOp(board, { op: "create-dir", path: "docs" })).toEqual({ path: "docs/", kind: "dir" });
    expect(await applyFileOp(board, { op: "create-dir", path: "x/y/z/" })).toEqual({ path: "x/y/z/", kind: "dir" });
    expect((await fs.stat(path.join(workdir, "x", "y", "z"))).isDirectory()).toBe(true);
  });

  it("returns absolute ids for extra folders", async () => {
    const id = path.join(extra, "lib", "new.ts");
    expect(await applyFileOp(board, { op: "create-file", path: id })).toEqual({ path: id, kind: "file" });
    expect(await exists(id)).toBe(true);
  });

  it("refuses existing targets with 409", async () => {
    await expect(applyFileOp(board, { op: "create-file", path: "src/app.ts" })).rejects.toMatchObject({ status: 409 });
    await expect(applyFileOp(board, { op: "create-dir", path: "src" })).rejects.toMatchObject({ status: 409 });
    await expect(applyFileOp(board, { op: "create-dir", path: "src/app.ts" })).rejects.toMatchObject({ status: 409 });
    expect(await fs.readFile(path.join(workdir, "src", "app.ts"), "utf8")).toBe("export const a = 1;\n");
  });
});

describe("applyFileOp: rename", () => {
  it("renames a file, into a new subfolder too", async () => {
    expect(await applyFileOp(board, { op: "rename", from: "src/app.ts", to: "src/main.ts" })).toEqual({
      path: "src/main.ts",
      kind: "file",
    });
    expect(await applyFileOp(board, { op: "rename", from: "src/main.ts", to: "moved/here/main.ts" })).toEqual({
      path: "moved/here/main.ts",
      kind: "file",
    });
    expect(await exists(path.join(workdir, "src", "app.ts"))).toBe(false);
    expect(await fs.readFile(path.join(workdir, "moved", "here", "main.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  it("renames a folder with its content", async () => {
    expect(await applyFileOp(board, { op: "rename", from: "src/", to: "source" })).toEqual({
      path: "source/",
      kind: "dir",
    });
    expect(await exists(path.join(workdir, "src"))).toBe(false);
    expect(await fs.readFile(path.join(workdir, "source", "nested", "deep.ts"), "utf8")).toBe("deep\n");
  });

  it("moves between the workdir and an extra folder", async () => {
    const to = path.join(extra, "app.ts");
    expect(await applyFileOp(board, { op: "rename", from: "src/app.ts", to })).toEqual({ path: to, kind: "file" });
    expect(await applyFileOp(board, { op: "rename", from: path.join(extra, "lib", "b.ts"), to: "b.ts" })).toEqual({
      path: "b.ts",
      kind: "file",
    });
    expect(await exists(path.join(workdir, "b.ts"))).toBe(true);
  });

  it("refuses moving a folder into itself and onto an existing target", async () => {
    await expect(applyFileOp(board, { op: "rename", from: "src", to: "src/inner" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(applyFileOp(board, { op: "rename", from: "src/app.ts", to: "src/nested/deep.ts" })).rejects.toMatchObject(
      { status: 409 },
    );
    await expect(applyFileOp(board, { op: "rename", from: "missing.ts", to: "x.ts" })).rejects.toMatchObject({
      status: 404,
    });
    expect(await exists(path.join(workdir, "src", "nested", "deep.ts"))).toBe(true);
  });
});

describe("applyFileOp: copy", () => {
  it("copies a file and a folder", async () => {
    expect(await applyFileOp(board, { op: "copy", from: "src/app.ts", to: "src/app copy.ts" })).toEqual({
      path: "src/app copy.ts",
      kind: "file",
    });
    expect(await fs.readFile(path.join(workdir, "src", "app copy.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(await applyFileOp(board, { op: "copy", from: "src", to: "copies/src" })).toEqual({
      path: "copies/src/",
      kind: "dir",
    });
    expect(await fs.readFile(path.join(workdir, "copies", "src", "nested", "deep.ts"), "utf8")).toBe("deep\n");
    expect(await exists(path.join(workdir, "src", "nested", "deep.ts"))).toBe(true);
  });

  it("refuses copying a folder into itself and onto an existing target", async () => {
    await expect(applyFileOp(board, { op: "copy", from: "src", to: "src/nested/again" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(applyFileOp(board, { op: "copy", from: "src/app.ts", to: "src/nested/deep.ts" })).rejects.toMatchObject({
      status: 409,
    });
    expect(await fs.readFile(path.join(workdir, "src", "nested", "deep.ts"), "utf8")).toBe("deep\n");
  });
});

describe("applyFileOp: delete", () => {
  it("deletes a file and a folder recursively", async () => {
    expect(await applyFileOp(board, { op: "delete", path: "src/app.ts" })).toEqual({ path: "src/app.ts", kind: "file" });
    expect(await exists(path.join(workdir, "src", "app.ts"))).toBe(false);
    expect(await applyFileOp(board, { op: "delete", path: "src" })).toEqual({ path: "src/", kind: "dir" });
    expect(await exists(path.join(workdir, "src"))).toBe(false);
    await expect(applyFileOp(board, { op: "delete", path: "src" })).rejects.toMatchObject({ status: 404 });
  });

  it("deletes a symlink itself, not its target", async () => {
    await fs.symlink(outside, path.join(workdir, "link"));
    expect(await applyFileOp(board, { op: "delete", path: "link" })).toEqual({ path: "link", kind: "file" });
    expect(await exists(path.join(workdir, "link"))).toBe(false);
    expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret\n");
  });
});

describe("applyFileOp: confinement and validation", () => {
  it("refuses paths outside the project folders", async () => {
    await expect(applyFileOp(board, { op: "create-file", path: "../outside/x.txt" })).rejects.toMatchObject({
      status: 403,
    });
    await expect(applyFileOp(board, { op: "delete", path: path.join(outside, "secret.txt") })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      applyFileOp(board, { op: "rename", from: "src/app.ts", to: `${extra}/../outside/app.ts` }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await exists(path.join(outside, "x.txt"))).toBe(false);
    expect(await exists(path.join(outside, "secret.txt"))).toBe(true);
  });

  it("refuses .git and the project folders themselves", async () => {
    await expect(applyFileOp(board, { op: "create-file", path: ".git/hooks/x" })).rejects.toMatchObject({ status: 403 });
    await expect(applyFileOp(board, { op: "delete", path: ".git" })).rejects.toMatchObject({ status: 403 });
    await expect(applyFileOp(board, { op: "delete", path: "." })).rejects.toMatchObject({ status: 403 });
    await expect(applyFileOp(board, { op: "delete", path: workdir })).rejects.toMatchObject({ status: 403 });
    await expect(applyFileOp(board, { op: "rename", from: extra, to: "extra" })).rejects.toMatchObject({ status: 403 });
    expect(await exists(extra)).toBe(true);
  });

  it("refuses ops through a symlinked folder pointing outside", async () => {
    await fs.symlink(outside, path.join(workdir, "link"));
    await expect(applyFileOp(board, { op: "create-file", path: "link/new.txt" })).rejects.toMatchObject({ status: 403 });
    await expect(applyFileOp(board, { op: "delete", path: "link/secret.txt" })).rejects.toMatchObject({ status: 403 });
    await expect(applyFileOp(board, { op: "create-dir", path: "link/a/b" })).rejects.toMatchObject({ status: 403 });
    expect(await exists(path.join(outside, "new.txt"))).toBe(false);
    expect(await exists(path.join(outside, "a"))).toBe(false);
    expect(await exists(path.join(outside, "secret.txt"))).toBe(true);
  });

  it("rejects malformed ops with 400", async () => {
    for (const op of [
      null,
      { op: "chmod", path: "src/app.ts" },
      { op: "create-file" },
      { op: "create-file", path: 1 },
      { op: "create-file", path: "" },
      { op: "create-file", path: "a\0b" },
      { op: "create-file", path: "dir/" },
      { op: "create-file", path: "a\\b.txt" },
      { op: "create-file", path: "src/../x.txt" },
      { op: "create-file", path: "a//b.txt" },
      { op: "create-file", path: "x".repeat(256) },
      { op: "rename", from: "src/app.ts" },
    ]) {
      await expect(applyFileOp(board, op), JSON.stringify(op)).rejects.toMatchObject({ status: 400 });
    }
  });
});

describe("applyFileOp: listings", () => {
  it("shows new empty folders right away", async () => {
    // Prime the cached listings.
    expect(await listed("")).toEqual(["src/", ".gitignore"]);
    expect(await listed("src/")).toEqual(["src/nested/", "src/app.ts"]);

    await applyFileOp(board, { op: "create-dir", path: "empty" });
    await applyFileOp(board, { op: "create-dir", path: "src/sub" });
    await applyFileOp(board, { op: "create-file", path: "top.md" });
    expect(await listed("")).toEqual(["empty/", "src/", ".gitignore", "top.md"]);
    expect(await listed("src/")).toEqual(["src/nested/", "src/sub/", "src/app.ts"]);

    await applyFileOp(board, { op: "delete", path: "empty" });
    expect(await listed("")).toEqual(["src/", ".gitignore", "top.md"]);
  });

  it("hides git-ignored empty folders and .git", async () => {
    await fs.mkdir(path.join(workdir, "node_modules"));
    await applyFileOp(board, { op: "create-dir", path: "kept" });
    expect(await listed("")).toEqual(["kept/", "src/", ".gitignore"]);
  });

  it("shows empty folders of extra folders outside git, without hidden or generated ones", async () => {
    await fs.mkdir(path.join(extra, ".cache"));
    await fs.mkdir(path.join(extra, "node_modules"));
    const id = path.join(extra, "empty");
    expect(await applyFileOp(board, { op: "create-dir", path: id })).toEqual({ path: `${id}/`, kind: "dir" });
    expect(await listed(`${extra}/`)).toEqual(["empty/", "lib/"]);
  });

  it("never lists outside the folder for an escaping query", async () => {
    expect(await listed("../")).toEqual([]);
    await fs.symlink(outside, path.join(workdir, "link"));
    await fs.mkdir(path.join(outside, "inner"));
    expect(await listed("link/")).toEqual([]);
  });
});
