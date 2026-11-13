// Read and save one text file of a board's project folders for the card's Files tab. A file is
// addressed by its "@" mention id: relative to the workdir, or absolute inside an extra project
// folder. Ids are confined to those folders (no `..` or symlink escape, never inside `.git`), only
// existing regular files are served, and saves are atomic and refused when the file changed on disk.
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "@/lib/server/http";
import type { Board, ProjectFileContent } from "@/lib/types";

/** Largest file the editor opens or saves. */
export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
/** Leading bytes scanned for a NUL byte to tell binary files apart. */
const BINARY_SNIFF_BYTES = 8192;

type ProjectFolders = Pick<Board, "workdir" | "extraFolders">;

/** `rel` (from path.relative) names something strictly inside its base folder. */
function isInside(rel: string): boolean {
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Resolve a file id to its real absolute path, confined to the board's project folders
 * (the longest containing folder wins for absolute ids). 400 malformed id, 403 outside a
 * folder / inside `.git` / symlink escape, 404 missing or not a regular file.
 * The returned id is normalized: posix relative for workdir ids, absolute otherwise.
 */
export async function resolveProjectFile(board: ProjectFolders, id: string): Promise<{ abs: string; id: string }> {
  if (typeof id !== "string" || !id.trim()) throw new HttpError(400, "A file path is required");
  if (id.includes("\0")) throw new HttpError(400, "Invalid file path");
  if (id.endsWith("/") || id.endsWith(path.sep)) throw new HttpError(400, "Not a file");

  let folder: string;
  let target: string;
  if (path.isAbsolute(id)) {
    target = path.resolve(id);
    let best: string | null = null;
    for (const candidate of [board.workdir, ...board.extraFolders]) {
      const root = path.resolve(candidate);
      if (isInside(path.relative(root, target)) && (best === null || root.length > best.length)) best = root;
    }
    if (best === null) throw new HttpError(403, "Path is outside the project folders");
    folder = best;
  } else {
    folder = path.resolve(board.workdir);
    target = path.resolve(folder, id);
  }
  const rel = path.relative(folder, target);
  if (!isInside(rel)) throw new HttpError(403, "Path is outside the project folders");
  if (rel.split(path.sep).includes(".git")) throw new HttpError(403, "Files inside .git cannot be opened");

  let realFolder: string;
  let realTarget: string;
  try {
    realFolder = await fs.realpath(folder);
    realTarget = await fs.realpath(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") throw new HttpError(404, "File not found");
    throw err;
  }
  const realRel = path.relative(realFolder, realTarget);
  if (!isInside(realRel)) throw new HttpError(403, "Path is outside the project folders");
  if (realRel.split(path.sep).includes(".git")) throw new HttpError(403, "Files inside .git cannot be opened");

  const stat = await fs.stat(realTarget);
  if (!stat.isFile()) throw new HttpError(404, "File not found");
  return { abs: realTarget, id: path.isAbsolute(id) ? target : rel.split(path.sep).join("/") };
}

/** Text content of a project file. 413 over MAX_EDIT_BYTES, 415 binary. */
export async function readProjectFile(board: ProjectFolders, id: string): Promise<ProjectFileContent> {
  const file = await resolveProjectFile(board, id);
  const stat = await fs.stat(file.abs);
  if (stat.size > MAX_EDIT_BYTES) throw new HttpError(413, "File is larger than 2 MB");
  const buf = await fs.readFile(file.abs);
  if (buf.byteLength > MAX_EDIT_BYTES) throw new HttpError(413, "File is larger than 2 MB");
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw new HttpError(415, "Binary file");
  return { path: file.id, content: buf.toString("utf8"), size: buf.byteLength, mtimeMs: stat.mtimeMs };
}

/**
 * Save an existing project file. `baseMtimeMs` is the mtime the editor loaded; a different
 * mtime on disk answers 409. Written to a temp file beside the real target (keeping its mode),
 * then renamed over it, so readers never see a partial file.
 */
export async function writeProjectFile(
  board: ProjectFolders,
  input: { path?: unknown; content?: unknown; baseMtimeMs?: unknown },
): Promise<ProjectFileContent> {
  const { path: id, content, baseMtimeMs } = input;
  if (typeof id !== "string") throw new HttpError(400, "A file path is required");
  if (typeof content !== "string") throw new HttpError(400, "content must be a string");
  if (typeof baseMtimeMs !== "number" || !Number.isFinite(baseMtimeMs)) {
    throw new HttpError(400, "baseMtimeMs must be a number");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_EDIT_BYTES) throw new HttpError(413, "File is larger than 2 MB");

  const file = await resolveProjectFile(board, id);
  const current = await fs.stat(file.abs);
  if (current.mtimeMs !== baseMtimeMs) throw new HttpError(409, "The file changed on disk; reload it first");

  const mode = current.mode & 0o7777;
  const tmp = path.join(path.dirname(file.abs), `.${path.basename(file.abs)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmp, content, { encoding: "utf8", mode, flag: "wx" });
    // The umask may have narrowed the mode passed to writeFile.
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, file.abs);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  const saved = await fs.stat(file.abs);
  return { path: file.id, content, size: saved.size, mtimeMs: saved.mtimeMs };
}
