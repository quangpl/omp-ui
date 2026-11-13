import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_EDIT_BYTES, readProjectFile, resolveProjectFile, writeProjectFile } from "@/lib/project-file-content";

let root: string;
let workdir: string;
let extra: string;
let outside: string;
let board: { workdir: string; extraFolders: string[] };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ui-file-content-"));
  workdir = path.join(root, "work");
  extra = path.join(root, "extra");
  outside = path.join(root, "outside");
  await fs.mkdir(path.join(workdir, "src"), { recursive: true });
  await fs.mkdir(path.join(workdir, ".git"), { recursive: true });
  await fs.mkdir(path.join(extra, "lib"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(workdir, "src", "app.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(workdir, ".git", "config"), "[core]\n");
  await fs.writeFile(path.join(extra, "lib", "a.ts"), "export const b = 2;\n");
  await fs.writeFile(path.join(outside, "secret.txt"), "secret\n");
  board = { workdir, extraFolders: [extra] };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("readProjectFile", () => {
  it("reads a workdir file by relative id", async () => {
    const file = await readProjectFile(board, "src/app.ts");
    const stat = await fs.stat(path.join(workdir, "src", "app.ts"));
    expect(file).toEqual({ path: "src/app.ts", content: "export const a = 1;\n", size: stat.size, mtimeMs: stat.mtimeMs });
    // Redundant segments normalize to the canonical id.
    expect((await readProjectFile(board, "./src/../src/app.ts")).path).toBe("src/app.ts");
  });

  it("reads an extra-folder file by absolute id", async () => {
    const id = path.join(extra, "lib", "a.ts");
    const file = await readProjectFile(board, id);
    expect(file.path).toBe(id);
    expect(file.content).toBe("export const b = 2;\n");
  });

  it("rejects ids escaping the project folders", async () => {
    await expect(readProjectFile(board, "../outside/secret.txt")).rejects.toMatchObject({ status: 403 });
    await expect(readProjectFile(board, path.join(outside, "secret.txt"))).rejects.toMatchObject({ status: 403 });
    await expect(readProjectFile(board, `${extra}/../outside/secret.txt`)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects files inside .git", async () => {
    await expect(readProjectFile(board, ".git/config")).rejects.toMatchObject({ status: 403 });
    await expect(readProjectFile(board, "src/../.git/config")).rejects.toMatchObject({ status: 403 });
  });

  it("rejects symlinks pointing outside the folder", async () => {
    await fs.symlink(path.join(outside, "secret.txt"), path.join(workdir, "leak.txt"));
    await fs.symlink(outside, path.join(workdir, "leakdir"));
    await expect(readProjectFile(board, "leak.txt")).rejects.toMatchObject({ status: 403 });
    await expect(readProjectFile(board, "leakdir/secret.txt")).rejects.toMatchObject({ status: 403 });
  });

  it("follows symlinks that stay inside the folder", async () => {
    await fs.symlink(path.join(workdir, "src", "app.ts"), path.join(workdir, "alias.ts"));
    const resolved = await resolveProjectFile(board, "alias.ts");
    expect(resolved.id).toBe("alias.ts");
    expect(resolved.abs).toBe(await fs.realpath(path.join(workdir, "src", "app.ts")));
  });

  it("rejects malformed ids, directories and missing files", async () => {
    await expect(readProjectFile(board, "")).rejects.toMatchObject({ status: 400 });
    await expect(readProjectFile(board, "src/app.ts\0")).rejects.toMatchObject({ status: 400 });
    await expect(readProjectFile(board, "src/")).rejects.toMatchObject({ status: 400 });
    await expect(readProjectFile(board, "src")).rejects.toMatchObject({ status: 404 });
    await expect(readProjectFile(board, "src/missing.ts")).rejects.toMatchObject({ status: 404 });
  });

  it("refuses files over the size limit", async () => {
    await fs.writeFile(path.join(workdir, "big.txt"), Buffer.alloc(MAX_EDIT_BYTES + 1, "a"));
    await expect(readProjectFile(board, "big.txt")).rejects.toMatchObject({ status: 413 });
  });

  it("refuses binary files", async () => {
    await fs.writeFile(path.join(workdir, "image.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await expect(readProjectFile(board, "image.bin")).rejects.toMatchObject({ status: 415 });
  });
});

describe("writeProjectFile", () => {
  it("saves content and returns the new mtime", async () => {
    const abs = path.join(workdir, "src", "app.ts");
    await fs.chmod(abs, 0o640);
    // Back-date the file so the save visibly moves the mtime.
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(abs, past, past);
    const loaded = await readProjectFile(board, "src/app.ts");

    const saved = await writeProjectFile(board, {
      path: "src/app.ts",
      content: "export const a = 42;\n",
      baseMtimeMs: loaded.mtimeMs,
    });
    const stat = await fs.stat(abs);
    expect(await fs.readFile(abs, "utf8")).toBe("export const a = 42;\n");
    expect(saved).toEqual({ path: "src/app.ts", content: "export const a = 42;\n", size: stat.size, mtimeMs: stat.mtimeMs });
    expect(saved.mtimeMs).not.toBe(loaded.mtimeMs);
    expect(stat.mode & 0o777).toBe(0o640);
    // No temp file is left behind.
    expect(await fs.readdir(path.join(workdir, "src"))).toEqual(["app.ts"]);

    const again = await readProjectFile(board, "src/app.ts");
    expect(again.content).toBe("export const a = 42;\n");
    expect(again.mtimeMs).toBe(saved.mtimeMs);
  });

  it("refuses a stale baseMtimeMs", async () => {
    const loaded = await readProjectFile(board, "src/app.ts");
    await expect(
      writeProjectFile(board, { path: "src/app.ts", content: "x", baseMtimeMs: loaded.mtimeMs - 1000 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await fs.readFile(path.join(workdir, "src", "app.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  it("refuses to create files", async () => {
    await expect(writeProjectFile(board, { path: "src/new.ts", content: "x", baseMtimeMs: 0 })).rejects.toMatchObject({
      status: 404,
    });
    await expect(fs.stat(path.join(workdir, "src", "new.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates the body", async () => {
    await expect(writeProjectFile(board, { path: "src/app.ts", content: 1, baseMtimeMs: 0 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(writeProjectFile(board, { path: "src/app.ts", content: "x" })).rejects.toMatchObject({ status: 400 });
    await expect(
      writeProjectFile(board, { path: "src/app.ts", content: "a".repeat(MAX_EDIT_BYTES + 1), baseMtimeMs: 0 }),
    ).rejects.toMatchObject({ status: 413 });
  });
});
