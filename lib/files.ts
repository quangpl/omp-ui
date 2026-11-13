// Shared files: one folder per card and one per board under DATA_DIR/files. Agents get these
// folders as extra workspace directories (`--add-dir`), so a person and the agents exchange files
// by reading and writing them; the API lists, uploads, serves and deletes them.
import { createReadStream, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { HttpError } from "@/lib/server/http";
import type { SharedFile, SharedFiles } from "@/lib/types";

export type FileScope = "tasks" | "boards";

/** Largest upload accepted through the API. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_LISTED = 1000;
const MAX_DEPTH = 6;
const MAX_NAME = 255;

/** Absolute DATA_DIR (default ./data), resolved like the SQLite path. */
export function dataDir(): string {
  return path.resolve(process.cwd(), process.env.DATA_DIR?.trim() || "./data");
}

/** Folder of a card's (`tasks`) or a board's (`boards`) shared files. Not created here. */
export function filesFolder(scope: FileScope, id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new HttpError(400, "Invalid id");
  return path.join(dataDir(), "files", scope, id);
}

/** Create the folder if missing and return it. */
export async function ensureFilesFolder(scope: FileScope, id: string): Promise<string> {
  const folder = filesFolder(scope, id);
  await fs.mkdir(folder, { recursive: true });
  return folder;
}

/** Write `content` to `name` in the folder (created if missing), replacing an existing file. */
export async function writeTextFile(scope: FileScope, id: string, name: string, content: string): Promise<void> {
  await ensureFilesFolder(scope, id);
  await fs.writeFile(resolveFile(scope, id, name), content);
}

/** Every regular file under the folder (recursive, hidden entries skipped), newest first. */
export async function listFiles(scope: FileScope, id: string): Promise<SharedFiles> {
  const folder = filesFolder(scope, id);
  const files: SharedFile[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_LISTED) return;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await fs.stat(full);
        files.push({
          name: path.relative(folder, full).split(path.sep).join("/"),
          path: full,
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        });
      } catch {
        // Removed while listing.
      }
    }
  }
  await walk(folder, 0);
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
  return { folder, files };
}

/** Absolute path of `name` (relative, `/`-separated) inside the folder; rejects escapes. */
export function resolveFile(scope: FileScope, id: string, name: string): string {
  const folder = filesFolder(scope, id);
  const parts = name.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === ".." || p.startsWith(".") || p.length > MAX_NAME)) {
    throw new HttpError(400, "Invalid file name");
  }
  const full = path.resolve(folder, ...parts);
  if (!full.startsWith(folder + path.sep)) throw new HttpError(400, "Invalid file name");
  return full;
}

/** A safe single-segment file name from an uploaded name (directories dropped). */
export function uploadName(raw: string | null): string {
  const base = (raw ?? "").split(/[\\/]/).pop()?.trim() ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "");
  if (!cleaned) throw new HttpError(400, "A file name is required (?name=...)");
  if (cleaned.length > MAX_NAME) throw new HttpError(400, "The file name is too long");
  return cleaned;
}

/** Stream the request body into the folder as `name`, replacing an existing file. */
export async function saveUpload(
  scope: FileScope,
  id: string,
  name: string,
  body: ReadableStream<Uint8Array> | null,
  declaredLength: number | null,
): Promise<void> {
  if (declaredLength !== null && declaredLength > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, `Files can be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  }
  if (!body) throw new HttpError(400, "The upload is empty");
  await ensureFilesFolder(scope, id);
  const target = resolveFile(scope, id, name);
  const temp = `${path.dirname(target)}/.upload-${process.pid}-${Date.now()}-${path.basename(target)}`;
  const handle = await fs.open(temp, "w");
  let written = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > MAX_UPLOAD_BYTES) {
        await reader.cancel();
        throw new HttpError(413, `Files can be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
      }
      await handle.write(value);
    }
    await handle.close();
    await fs.rename(temp, target);
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fs.rm(temp, { force: true });
    throw err;
  }
}

export async function deleteFile(scope: FileScope, id: string, name: string): Promise<void> {
  const target = resolveFile(scope, id, name);
  try {
    await fs.unlink(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, "File not found");
    throw err;
  }
}

/** Remove a card's or board's whole folder (card/board deleted). Never throws. */
export async function removeFilesFolder(scope: FileScope, id: string): Promise<void> {
  try {
    await fs.rm(filesFolder(scope, id), { recursive: true, force: true });
  } catch (err) {
    console.error(`[files] could not remove ${scope}/${id}:`, err);
  }
}

/**
 * Extensions served inline (with this content type) so the in-app viewer can preview them; anything
 * missing here is a download. Text-like formats the viewer parses itself (CSV/TSV, YAML, notebooks,
 * patches...) are sent as `text/plain` so the browser never interprets them.
 */
const INLINE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "text/plain; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".ndjson": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".tsv": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".toml": "text/plain; charset=utf-8",
  ".ini": "text/plain; charset=utf-8",
  ".diff": "text/plain; charset=utf-8",
  ".patch": "text/plain; charset=utf-8",
  ".ipynb": "text/plain; charset=utf-8",
};

/**
 * The byte range a `Range` header asks for in a file of `size` bytes: `null` = serve the whole file
 * (no header, another unit, several ranges or an empty file), `"unsatisfiable"` = answer 416.
 * Only a single `bytes=start-end`, `bytes=start-` or suffix `bytes=-N` range is honoured.
 */
function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header || size === 0) return null;
  const value = header.trim();
  if (!value.toLowerCase().startsWith("bytes=")) return null;
  const spec = value.slice("bytes=".length).trim();
  if (spec.includes(",")) return null;
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match || (match[1] === "" && match[2] === "")) return "unsatisfiable";
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Serve a file. Images, video, audio, PDFs and plain text open inline; everything else (HTML, SVG, scripts)
 * is always a download so uploaded content never runs on this origin. A single byte `range` (the
 * request's `Range` header) is answered with 206 so media can seek; an unsatisfiable one with 416.
 */
export async function fileResponse(
  scope: FileScope,
  id: string,
  name: string,
  download: boolean,
  range?: string | null,
): Promise<Response> {
  const target = resolveFile(scope, id, name);
  let size: number;
  try {
    const info = await fs.stat(target);
    if (!info.isFile()) throw new HttpError(404, "File not found");
    size = info.size;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(404, "File not found");
  }
  const inlineType = INLINE_TYPES[path.extname(target).toLowerCase()];
  const filename = path.basename(target);
  const disposition = `${download || !inlineType ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(filename)}`;
  const headers: Record<string, string> = {
    "content-type": inlineType ?? "application/octet-stream",
    "content-disposition": disposition,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    "cache-control": "no-store",
  };
  const slice = parseRange(range, size);
  if (slice === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
  }
  if (slice) {
    const stream = Readable.toWeb(createReadStream(target, slice)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 206,
      headers: {
        ...headers,
        "content-length": String(slice.end - slice.start + 1),
        "content-range": `bytes ${slice.start}-${slice.end}/${size}`,
      },
    });
  }
  const stream = Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>;
  return new Response(stream, { headers: { ...headers, "content-length": String(size) } });
}
