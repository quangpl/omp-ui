// Create, rename/move, copy and delete files and folders of a board's project folders (or of a
// standalone folder) for the Files tree. Paths are "@" mention ids: relative to the workdir, or
// absolute inside an extra project folder. Every path is confined to its project folder (no `..`
// or symlink escape through a parent directory, never inside `.git`, never the folder itself); the
// final component is not resolved, so a symlink is renamed/deleted as the link itself.
import fs from "node:fs/promises";
import path from "node:path";
import { invalidateProjectFiles } from "@/lib/project-files";
import { HttpError } from "@/lib/server/http";
import type { Board, FileOpResult } from "@/lib/types";

type ProjectFolders = Pick<Board, "workdir" | "extraFolders">;

/** Longest file or folder name most filesystems accept, in bytes. */
const MAX_NAME_BYTES = 255;

/** One op path, resolved and confined. */
interface Target {
  /** Containing project folder as configured (the listing cache key). */
  folder: string;
  /** Absolute path: real path of the nearest existing ancestor + the remaining names, unresolved. */
  abs: string;
  /** Canonical id without a trailing "/": workdir-relative posix, or absolute in an extra folder. */
  id: string;
}

/** `rel` (from path.relative) names something strictly inside its base folder. */
function isInside(rel: string): boolean {
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/** Errno failures as user-facing HTTP errors; anything else is rethrown. */
function toHttpError(err: unknown): unknown {
  if (err instanceof HttpError) return err;
  switch (errnoCode(err)) {
    case "ENOENT":
      return new HttpError(404, "File or folder not found");
    case "EEXIST":
    case "ENOTEMPTY":
    case "ERR_FS_CP_EEXIST":
      return new HttpError(409, "The target already exists");
    case "ENOTDIR":
    case "ERR_FS_CP_DIR_TO_NON_DIR":
    case "ERR_FS_CP_NON_DIR_TO_DIR":
      return new HttpError(400, "A parent of that path is not a folder");
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return new HttpError(403, "Permission denied");
    case "EBUSY":
      return new HttpError(409, "The file or folder is busy");
    case "ENAMETOOLONG":
      return new HttpError(400, "Path is too long");
    case "EINVAL":
    case "ERR_FS_CP_EINVAL":
      return new HttpError(400, "Invalid file operation");
    default:
      return err;
  }
}

/** Resolve one op path (see the file comment). 400 malformed, 403 outside/`.git`/project folder, 404 folder missing. */
async function resolveTarget(folders: ProjectFolders, input: unknown, label: string): Promise<Target> {
  if (typeof input !== "string" || !input.trim()) throw new HttpError(400, `${label} is required`);
  if (input.includes("\0")) throw new HttpError(400, `Invalid ${label.toLowerCase()}`);
  const raw = input.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!raw) throw new HttpError(403, "Project folders themselves can't be changed here");

  let folder: string;
  let target: string;
  if (path.isAbsolute(raw)) {
    target = path.resolve(raw);
    let best: string | null = null;
    for (const candidate of [folders.workdir, ...folders.extraFolders]) {
      const rel = path.relative(path.resolve(candidate), target);
      const contains = rel === "" || isInside(rel);
      if (contains && (best === null || path.resolve(candidate).length > path.resolve(best).length)) best = candidate;
    }
    if (best === null) throw new HttpError(403, "Path is outside the project folders");
    folder = best;
  } else {
    folder = folders.workdir;
    target = path.resolve(folder, raw);
  }
  const root = path.resolve(folder);
  const rel = path.relative(root, target);
  if (rel === "") throw new HttpError(403, "Project folders themselves can't be changed here");
  if (!isInside(rel)) throw new HttpError(403, "Path is outside the project folders");
  const names = rel.split(path.sep);
  if (names.includes(".git")) throw new HttpError(403, "Files inside .git can't be changed");

  for (const name of (path.isAbsolute(raw) ? raw.slice(1) : raw).split("/")) {
    if (!name || name === "." || name === "..") throw new HttpError(400, `Invalid ${label.toLowerCase()}`);
  }
  for (const name of names) {
    if (name.includes("\\")) throw new HttpError(400, `"${name}" contains a backslash`);
    if (Buffer.byteLength(name, "utf8") > MAX_NAME_BYTES) throw new HttpError(400, "Name is too long");
  }

  // Real path of the nearest existing ancestor must stay inside the real folder (symlink escape).
  let realFolder: string;
  try {
    realFolder = await fs.realpath(root);
  } catch (err) {
    if (errnoCode(err) === "ENOENT" || errnoCode(err) === "ENOTDIR") throw new HttpError(404, "Project folder not found");
    throw err;
  }
  let ancestor = path.dirname(target);
  let realAncestor: string;
  for (;;) {
    try {
      realAncestor = await fs.realpath(ancestor);
      break;
    } catch (err) {
      if (errnoCode(err) !== "ENOENT" || ancestor === root) throw toHttpError(err);
      ancestor = path.dirname(ancestor);
    }
  }
  const realRel = path.relative(realFolder, realAncestor);
  if (realRel !== "" && !isInside(realRel)) throw new HttpError(403, "Path is outside the project folders");
  if (realRel.split(path.sep).includes(".git")) throw new HttpError(403, "Files inside .git can't be changed");

  const abs = path.join(realAncestor, path.relative(ancestor, target));
  const id = folder === folders.workdir ? rel.split(path.sep).join("/") : target;
  return { folder, abs, id };
}

/** lstat of a path; null when it doesn't exist. */
async function lstatOrNull(abs: string) {
  try {
    return await fs.lstat(abs);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    throw toHttpError(err);
  }
}

async function requireSource(target: Target) {
  const stat = await lstatOrNull(target.abs);
  if (!stat) throw new HttpError(404, `${path.basename(target.abs)} not found`);
  return stat;
}

function result(target: Target, dir: boolean): FileOpResult {
  return dir ? { path: `${target.id}/`, kind: "dir" } : { path: target.id, kind: "file" };
}

async function copyTree(from: string, to: string): Promise<void> {
  await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
}

/**
 * Apply one Files-tree operation (`FileOp`) inside the project folders. Missing parents of a new
 * path are created; targets must not exist (409). Returns the produced item (for delete, the
 * removed one) with a canonical id, and drops the affected folders' cached listings.
 */
export async function applyFileOp(folders: ProjectFolders, op: unknown): Promise<FileOpResult> {
  if (!op || typeof op !== "object" || Array.isArray(op)) throw new HttpError(400, "Expected a file operation");
  const body = op as Record<string, unknown>;
  // Folders whose disk content may change (even when the op fails part-way).
  const touched: string[] = [];
  try {
    switch (body.op) {
      case "create-file":
      case "create-dir": {
        const dir = body.op === "create-dir";
        if (!dir && typeof body.path === "string" && body.path.endsWith("/")) {
          throw new HttpError(400, "A file name can't end with /");
        }
        const target = await resolveTarget(folders, body.path, dir ? "Folder path" : "File path");
        if (await lstatOrNull(target.abs)) throw new HttpError(409, `${path.basename(target.abs)} already exists`);
        touched.push(target.folder);
        await fs.mkdir(path.dirname(target.abs), { recursive: true });
        try {
          if (dir) await fs.mkdir(target.abs);
          else await fs.writeFile(target.abs, "", { flag: "wx" });
        } catch (err) {
          if (errnoCode(err) === "EEXIST") throw new HttpError(409, `${path.basename(target.abs)} already exists`);
          throw err;
        }
        return result(target, dir);
      }
      case "rename":
      case "copy": {
        const rename = body.op === "rename";
        const from = await resolveTarget(folders, body.from, "Source path");
        const to = await resolveTarget(folders, body.to, "Target path");
        const stat = await requireSource(from);
        const dir = stat.isDirectory();
        const existing = await lstatOrNull(to.abs);
        // A case-only rename on a case-insensitive filesystem finds the source itself at the target.
        const caseOnly =
          rename &&
          existing !== null &&
          from.abs !== to.abs &&
          from.abs.toLowerCase() === to.abs.toLowerCase() &&
          existing.dev === stat.dev &&
          existing.ino === stat.ino;
        if (existing && !caseOnly) throw new HttpError(409, `${path.basename(to.abs)} already exists`);
        if (dir && (to.abs === from.abs || to.abs.startsWith(`${from.abs}${path.sep}`))) {
          throw new HttpError(400, `Can't ${rename ? "move" : "copy"} a folder into itself`);
        }
        if (rename) touched.push(from.folder);
        touched.push(to.folder);
        await fs.mkdir(path.dirname(to.abs), { recursive: true });
        if (!rename) {
          await copyTree(from.abs, to.abs);
        } else {
          try {
            await fs.rename(from.abs, to.abs);
          } catch (err) {
            if (errnoCode(err) !== "EXDEV") throw err;
            // Across filesystems (an extra folder on another mount).
            await copyTree(from.abs, to.abs);
            await fs.rm(from.abs, { recursive: true, force: false });
          }
        }
        return result(to, dir);
      }
      case "delete": {
        const target = await resolveTarget(folders, body.path, "Path");
        const stat = await requireSource(target);
        touched.push(target.folder);
        await fs.rm(target.abs, { recursive: true, force: false });
        return result(target, stat.isDirectory());
      }
      default:
        throw new HttpError(400, "Unknown file operation");
    }
  } catch (err) {
    throw toHttpError(err);
  } finally {
    if (touched.length) invalidateProjectFiles(touched);
  }
}
