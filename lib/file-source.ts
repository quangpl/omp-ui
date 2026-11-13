// Where the Files editor reads and saves: a project (board: workdir plus extra folders, the card
// panel's Files tab and the Files page) or one folder on the server (Files page). File ids are
// `ProjectFileHit.insert` values: relative to the project workdir / the folder, or absolute inside
// a project's extra folder.
import { api } from "@/lib/api-client";
import type { FileOp, FileOpResult, ProjectFileContent, ProjectFileHit } from "@/lib/types";

export type FileSource =
  | { kind: "board"; boardId: string; workdir: string; extraFolders: string[] }
  | { kind: "folder"; root: string };

/** Stable identity of a source, for cache keys and effect dependencies. */
export function fileSourceKey(source: FileSource): string {
  return source.kind === "board"
    ? `board\n${source.boardId}\n${source.workdir}\n${source.extraFolders.join("\n")}`
    : `folder\n${source.root}`;
}

/** The source's top folder plus any extra folders (absolute). */
export function fileSourceFolders(source: FileSource): { workdir: string; extraFolders: string[] } {
  return source.kind === "board"
    ? { workdir: source.workdir, extraFolders: source.extraFolders }
    : { workdir: source.root, extraFolders: [] };
}

/** Entries for `query` ("" or ending in "/" lists a directory; otherwise a fuzzy search). */
export function listSourceFiles(
  source: FileSource,
  query: string,
  init?: { signal?: AbortSignal; limit?: number },
): Promise<{ files: ProjectFileHit[] }> {
  return source.kind === "board"
    ? api.boards.projectFiles(source.boardId, query, init)
    : api.fs.files(source.root, query, init);
}

export function readSourceFile(
  source: FileSource,
  path: string,
  init?: { signal?: AbortSignal },
): Promise<ProjectFileContent> {
  return source.kind === "board"
    ? api.boards.readProjectFile(source.boardId, path, init)
    : api.fs.readFile(source.root, path, init);
}

export function writeSourceFile(
  source: FileSource,
  input: { path: string; content: string; baseMtimeMs: number },
): Promise<ProjectFileContent> {
  return source.kind === "board"
    ? api.boards.writeProjectFile(source.boardId, input)
    : api.fs.writeFile({ root: source.root, ...input });
}

/** Create, rename/move, copy or delete a file or folder (Files tree context menu). */
export function applySourceFileOp(source: FileSource, op: FileOp): Promise<FileOpResult> {
  return source.kind === "board" ? api.boards.projectFileOp(source.boardId, op) : api.fs.fileOp(source.root, op);
}

/** Absolute path of a file id (workdir-relative ids are joined onto the source's top folder). */
export function absoluteSourcePath(source: FileSource, id: string): string {
  if (id.startsWith("/")) return id;
  const base = fileSourceFolders(source).workdir.replace(/\/+$/, "");
  return `${base}/${id}`;
}
