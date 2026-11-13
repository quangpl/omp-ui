// Server-side folder browser rooted at WORKSPACE_DIR (also the clone destination).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HttpError } from "@/lib/server/http";
import type { FsBrowseResult, FsEntry } from "@/lib/types";

const MAX_ENTRIES = 500;

/** Absolute WORKSPACE_DIR (default `~/omp-workspace`), created if missing. */
export function getWorkspaceRoot(): string {
  const root = path.resolve(process.env.WORKSPACE_DIR || path.join(os.homedir(), "omp-workspace"));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** List the readable, non-hidden sub-directories of `dir` (default: the workspace root). */
export async function browse(dir?: string | null): Promise<FsBrowseResult> {
  const workspaceRoot = getWorkspaceRoot();
  const raw = dir?.trim();
  if (raw && !path.isAbsolute(raw)) {
    throw new HttpError(400, `Please use a full folder path starting with "/" (got "${raw}").`);
  }
  const target = raw ? path.resolve(raw) : workspaceRoot;
  if (!(await isDirectory(target))) {
    throw new HttpError(400, `This folder doesn't exist (or isn't a folder): ${target}`);
  }

  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(target, { withFileTypes: true });
  } catch {
    throw new HttpError(400, `The server isn't allowed to open this folder: ${target}`);
  }

  const candidates = dirents.filter(
    (d) => !d.name.startsWith(".") && (d.isDirectory() || d.isSymbolicLink()),
  );
  const entries = (
    await Promise.all(
      candidates.map(async (d): Promise<FsEntry | null> => {
        const full = path.join(target, d.name);
        if (d.isSymbolicLink() && !(await isDirectory(full))) return null;
        try {
          await fs.promises.access(full, fs.constants.R_OK | fs.constants.X_OK);
        } catch {
          return null;
        }
        return { name: d.name, path: full, isGitRepo: fs.existsSync(path.join(full, ".git")) };
      }),
    )
  ).filter((e): e is FsEntry => e !== null);

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    workspaceRoot,
    entries: entries.slice(0, MAX_ENTRIES),
  };
}

/** Create the single folder `name` directly inside the existing absolute folder `parent`. */
export async function createFolder(parent: unknown, name: unknown): Promise<FsEntry> {
  const rawParent = typeof parent === "string" ? parent.trim() : "";
  if (!rawParent || !path.isAbsolute(rawParent)) {
    throw new HttpError(
      400,
      `Please use a full folder path starting with "/" (got "${typeof parent === "string" ? parent : ""}").`,
    );
  }
  const target = path.resolve(rawParent);
  if (!(await isDirectory(target))) {
    throw new HttpError(400, `This folder doesn't exist (or isn't a folder): ${target}`);
  }

  const folderName = typeof name === "string" ? name.trim() : "";
  if (!folderName) throw new HttpError(400, "Please enter a name for the new folder.");
  if (folderName.includes("/") || folderName.includes("\0")) {
    throw new HttpError(400, 'A folder name can\'t contain "/".');
  }
  if (folderName === "." || folderName === "..") {
    throw new HttpError(400, `"${folderName}" isn't a valid folder name.`);
  }
  if (folderName.startsWith(".")) {
    throw new HttpError(400, 'Folder names starting with "." are hidden and can\'t be created here.');
  }
  if (Buffer.byteLength(folderName, "utf8") > 255) {
    throw new HttpError(400, "This folder name is too long (max 255 bytes).");
  }

  const full = path.join(target, folderName);
  try {
    await fs.promises.mkdir(full);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new HttpError(409, `Something with this name already exists: ${full}`);
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      throw new HttpError(400, `The server isn't allowed to create a folder in: ${target}`);
    }
    throw new HttpError(400, `Couldn't create the folder ${full}: ${(err as Error).message}`);
  }
  return { name: folderName, path: full, isGitRepo: false };
}
